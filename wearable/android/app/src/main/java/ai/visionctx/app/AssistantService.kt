package ai.visionctx.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.os.IBinder
import android.util.Log
import android.view.KeyEvent
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.util.UUID

enum class Phase { STOPPED, IDLE, LISTENING, THINKING, SPEAKING }

data class UiState(
    val phase: Phase = Phase.STOPPED,
    val bluetooth: Boolean = false,
    val session: ExperimentSession? = null,
    val taskText: String = "",
    val conversationId: String = "",
    val message: String = "",
    val turns: List<Turn> = emptyList(),
)

/** Shared between the service (writer) and the activity (reader). */
object Assistant {
    val state = MutableStateFlow(UiState())
    val ui: StateFlow<UiState> get() = state
}

/**
 * Foreground service that owns the voice loop so it keeps working with the screen off:
 * earbud button -> record -> /api/turns -> play answer.
 */
class AssistantService : Service() {
    companion object {
        private const val TAG = "VisionCtx"
        private const val CHANNEL = "assistant"
        private const val NOTIFICATION_ID = 1
        const val ACTION_START = "start"
        const val ACTION_STOP = "stop"
        const val ACTION_TRIGGER = "trigger"
        const val ACTION_RETRY = "retry"
        const val ACTION_ASK_TEXT = "ask_text"
        const val ACTION_SET_TASK = "set_task"
        const val ACTION_NEW_CONVERSATION = "new_conversation"
        const val EXTRA_SERVER = "server"
        const val EXTRA_DEVICE = "device"
        const val EXTRA_KEEP_ROUTE = "keep_route"
        const val EXTRA_TEXT = "text"

        fun send(context: Context, action: String, extras: Intent.() -> Unit = {}) {
            val intent = Intent(context, AssistantService::class.java).setAction(action).apply(extras)
            if (action == ACTION_START) context.startForegroundService(intent) else context.startService(intent)
        }
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private lateinit var route: AudioRoute
    private lateinit var speaker: Speaker
    private lateinit var media: MediaSession
    private var api: Api? = null
    private var deviceId = ""
    private var keepRoute = true
    private var recorder: Recorder? = null
    private var pendingTurn: Deferred<Turn>? = null
    private var answerJob: Job? = null
    private var sessionPoll: Job? = null

    private val state get() = Assistant.state

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        route = AudioRoute(this)
        speaker = Speaker(this)
        media = MediaSession(this, TAG).apply {
            setCallback(object : MediaSession.Callback() {
                override fun onMediaButtonEvent(intent: Intent): Boolean {
                    @Suppress("DEPRECATION")
                    val key = intent.getParcelableExtra<KeyEvent>(Intent.EXTRA_KEY_EVENT) ?: return false
                    if (key.action != KeyEvent.ACTION_DOWN || key.repeatCount > 0) return true
                    return when (key.keyCode) {
                        KeyEvent.KEYCODE_HEADSETHOOK, KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE,
                        KeyEvent.KEYCODE_MEDIA_PLAY, KeyEvent.KEYCODE_MEDIA_PAUSE -> { trigger(); true }
                        KeyEvent.KEYCODE_MEDIA_NEXT -> { retry(); true }
                        else -> false
                    }
                }
            })
            setPlaybackState(
                PlaybackState.Builder()
                    .setActions(PlaybackState.ACTION_PLAY_PAUSE or PlaybackState.ACTION_PLAY or
                        PlaybackState.ACTION_PAUSE or PlaybackState.ACTION_SKIP_TO_NEXT)
                    .setState(PlaybackState.STATE_PLAYING, 0, 1f)
                    .build()
            )
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> start(
                intent.getStringExtra(EXTRA_SERVER).orEmpty(),
                intent.getStringExtra(EXTRA_DEVICE).orEmpty(),
                intent.getBooleanExtra(EXTRA_KEEP_ROUTE, true),
            )
            ACTION_STOP -> stopAll()
            ACTION_TRIGGER -> trigger()
            ACTION_RETRY -> retry()
            ACTION_ASK_TEXT -> askText(intent.getStringExtra(EXTRA_TEXT).orEmpty())
            ACTION_SET_TASK -> setTask(intent.getStringExtra(EXTRA_TEXT).orEmpty())
            ACTION_NEW_CONVERSATION -> state.update {
                it.copy(conversationId = newConversationId(), taskText = "", turns = emptyList(), message = "新对话")
            }
        }
        return START_NOT_STICKY
    }

    private fun newConversationId() = "android-" + UUID.randomUUID().toString().take(8)

    private fun start(server: String, device: String, keep: Boolean) {
        startForeground(
            NOTIFICATION_ID, notification("按耳机键提问"),
            ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE or ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK,
        )
        api = Api(server)
        deviceId = device
        keepRoute = keep
        media.isActive = true
        claimMediaButtons()
        state.update {
            it.copy(phase = Phase.IDLE, conversationId = it.conversationId.ifEmpty { newConversationId() },
                message = "已启动")
        }
        scope.launch {
            if (keepRoute) setBluetooth(route.open())
        }
        sessionPoll?.cancel()
        sessionPoll = scope.launch {
            while (isActive) {
                val session = runCatching { api?.activeSession(deviceId) }.getOrNull()
                state.update { it.copy(session = session) }
                delay(10_000)
            }
        }
    }

    /** Android routes media buttons to the session that most recently played audio. */
    private fun claimMediaButtons() {
        val track = AudioTrack.Builder()
            .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).build())
            .setAudioFormat(AudioFormat.Builder().setSampleRate(16_000)
                .setEncoding(AudioFormat.ENCODING_PCM_16BIT).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build())
            .setBufferSizeInBytes(3200)
            .setTransferMode(AudioTrack.MODE_STATIC)
            .build()
        track.write(ByteArray(3200), 0, 3200)
        track.play()
        scope.launch {
            delay(300)
            track.release()
        }
    }

    private fun setBluetooth(on: Boolean) {
        speaker.voiceRoute = route.active
        state.update { it.copy(bluetooth = on) }
    }

    // --- voice loop ------------------------------------------------------------------------------

    private fun trigger() {
        when (state.value.phase) {
            Phase.IDLE, Phase.SPEAKING -> startListening(retryOf = null)
            Phase.LISTENING -> finishListening()
            Phase.THINKING, Phase.STOPPED -> Unit
        }
    }

    private fun retry() {
        val last = state.value.turns.firstOrNull() ?: return
        if (state.value.phase == Phase.IDLE || state.value.phase == Phase.SPEAKING) {
            startListening(retryOf = last.retryOf ?: last.id)
        }
    }

    private fun startListening(retryOf: Int?) {
        val api = api ?: return
        answerJob?.cancel()
        speaker.stop()
        val conv = state.value.conversationId
        // Pin speech start on the server right away so frames from before the question are used.
        pendingTurn = scope.async(Dispatchers.IO) { api.startTurn(conv, deviceId, retryOf) }
        state.update { it.copy(phase = Phase.LISTENING, message = if (retryOf != null) "重问中…" else "在听…") }
        updateNotification("在听…")
        scope.launch {
            if (!route.active) setBluetooth(route.open())
            speaker.toneListen()
            delay(150) // keep the beep out of the recording
            if (state.value.phase != Phase.LISTENING) return@launch
            val rec = Recorder()
            recorder = rec
            try {
                rec.start(scope) { reason ->
                    scope.launch { if (recorder === rec) finishListening(cancel = reason == "no_speech") }
                }
            } catch (e: Exception) {
                recorder = null
                fail("麦克风不可用：${e.message}")
            }
        }
    }

    private fun finishListening(cancel: Boolean = false) {
        val rec = recorder ?: return
        recorder = null
        val wav = rec.stop()
        val turn = pendingTurn ?: return
        pendingTurn = null
        if (cancel || wav == null || !rec.heardSpeech) {
            state.update { it.copy(phase = Phase.IDLE, message = "没听到说话") }
            scope.launch { runCatching { api?.cancelTurn(turn.await().id) } }
            releaseRouteIfIdle()
            updateNotification("按耳机键提问")
            return
        }
        speaker.toneSend()
        state.update { it.copy(phase = Phase.THINKING, message = "思考中…") }
        updateNotification("思考中…")
        answerJob = scope.launch {
            try {
                val t = api!!.sendAudio(turn.await().id, wav)
                deliver(t)
            } catch (e: Exception) {
                fail("请求失败：${e.message}")
            }
        }
    }

    private fun askText(text: String) {
        val api = api ?: return
        if (text.isBlank() || state.value.phase == Phase.THINKING || state.value.phase == Phase.LISTENING) return
        answerJob?.cancel()
        speaker.stop()
        state.update { it.copy(phase = Phase.THINKING, message = "思考中…") }
        answerJob = scope.launch {
            try {
                val turn = api.startTurn(state.value.conversationId, deviceId, null)
                deliver(api.sendText(turn.id, text))
            } catch (e: Exception) {
                fail("请求失败：${e.message}")
            }
        }
    }

    private suspend fun deliver(t: Turn) {
        state.update {
            it.copy(turns = (listOf(t) + it.turns).take(30), taskText = t.taskText ?: it.taskText,
                message = t.totalMs?.let { ms -> "用时 %.1f 秒".format(ms / 1000.0) } ?: "")
        }
        if (t.status != "done") {
            fail(t.error ?: "出错了")
            return
        }
        state.update { it.copy(phase = Phase.SPEAKING) }
        updateNotification(t.answer.orEmpty())
        val played = if (t.hasSpeech) speaker.playUrl(api!!.speechUrl(t.id)) else false
        if (!played) speaker.say(t.answer.orEmpty())
        if (state.value.phase == Phase.SPEAKING) {
            state.update { it.copy(phase = Phase.IDLE) }
            releaseRouteIfIdle()
        }
    }

    private fun fail(message: String) {
        Log.w(TAG, message)
        speaker.toneError()
        state.update { it.copy(phase = Phase.IDLE, message = message) }
        updateNotification(message)
        releaseRouteIfIdle()
    }

    private fun releaseRouteIfIdle() {
        if (!keepRoute && state.value.phase == Phase.IDLE) {
            route.close()
            setBluetooth(false)
        }
    }

    private fun setTask(task: String) {
        val api = api ?: return
        val conv = state.value.conversationId
        scope.launch {
            try {
                api.setTask(conv, deviceId, task.trim())
                state.update { it.copy(taskText = task.trim(), message = "任务已更新") }
            } catch (e: Exception) {
                state.update { it.copy(message = "设置任务失败：${e.message}") }
            }
        }
    }

    private fun stopAll() {
        recorder?.stop()
        recorder = null
        answerJob?.cancel()
        sessionPoll?.cancel()
        speaker.stop()
        route.close()
        media.isActive = false
        state.update { it.copy(phase = Phase.STOPPED, bluetooth = false, message = "已停止") }
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    override fun onDestroy() {
        scope.cancel()
        route.close()
        speaker.release()
        media.release()
        if (state.value.phase != Phase.STOPPED) state.update { it.copy(phase = Phase.STOPPED) }
        super.onDestroy()
    }

    // --- notification ------------------------------------------------------------------------------

    private fun notification(text: String): Notification {
        val nm = getSystemService(NotificationManager::class.java)
        if (nm.getNotificationChannel(CHANNEL) == null) {
            nm.createNotificationChannel(NotificationChannel(CHANNEL, "视觉助手", NotificationManager.IMPORTANCE_LOW))
        }
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE,
        )
        val ask = PendingIntent.getService(
            this, 1, Intent(this, AssistantService::class.java).setAction(ACTION_TRIGGER), PendingIntent.FLAG_IMMUTABLE,
        )
        return Notification.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setContentTitle("VisionCtx")
            .setContentText(text)
            .setContentIntent(open)
            .setOngoing(true)
            .addAction(Notification.Action.Builder(null, "提问", ask).build())
            .build()
    }

    private fun updateNotification(text: String) {
        if (state.value.phase == Phase.STOPPED) return
        getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, notification(text))
    }
}
