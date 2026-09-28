package ai.visionctx.app

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioManager
import android.media.MediaPlayer
import android.media.ToneGenerator
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import kotlinx.coroutines.suspendCancellableCoroutine
import java.util.Locale
import kotlin.coroutines.resume

/** Plays answers: server TTS audio when available, otherwise the phone's own TTS engine. */
class Speaker(context: Context) {
    private var player: MediaPlayer? = null
    private var ttsReady = false
    private val tts = TextToSpeech(context) { status ->
        ttsReady = status == TextToSpeech.SUCCESS
        if (ttsReady) configureTts()
    }
    private val tones = ToneGenerator(AudioManager.STREAM_VOICE_CALL, 80)

    /** Voice-call attributes follow the SCO route to the earbuds while it is open. */
    var voiceRoute = true
        set(value) {
            field = value
            if (ttsReady) configureTts()
        }

    private fun attributes(): AudioAttributes = AudioAttributes.Builder()
        .setUsage(if (voiceRoute) AudioAttributes.USAGE_VOICE_COMMUNICATION else AudioAttributes.USAGE_ASSISTANT)
        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
        .build()

    private fun configureTts() {
        tts.language = Locale.SIMPLIFIED_CHINESE
        tts.setAudioAttributes(attributes())
    }

    fun toneListen() = tones.startTone(ToneGenerator.TONE_PROP_BEEP, 120)
    fun toneSend() = tones.startTone(ToneGenerator.TONE_PROP_ACK, 150)
    fun toneError() = tones.startTone(ToneGenerator.TONE_PROP_NACK, 250)

    suspend fun playUrl(url: String): Boolean = suspendCancellableCoroutine { cont ->
        stop()
        val mp = MediaPlayer()
        player = mp
        try {
            mp.setAudioAttributes(attributes())
            mp.setDataSource(url)
            mp.setOnPreparedListener { it.start() }
            mp.setOnCompletionListener { if (cont.isActive) cont.resume(true) }
            mp.setOnErrorListener { _, _, _ -> if (cont.isActive) cont.resume(false); true }
            mp.prepareAsync()
        } catch (e: Exception) {
            if (cont.isActive) cont.resume(false)
        }
        cont.invokeOnCancellation { stop() }
    }

    suspend fun say(text: String): Boolean = suspendCancellableCoroutine { cont ->
        if (!ttsReady) {
            cont.resume(false)
            return@suspendCancellableCoroutine
        }
        val id = "u" + System.nanoTime()
        tts.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
            override fun onStart(utteranceId: String?) {}
            override fun onDone(utteranceId: String?) { if (utteranceId == id && cont.isActive) cont.resume(true) }
            @Deprecated("Deprecated in Java")
            override fun onError(utteranceId: String?) { if (utteranceId == id && cont.isActive) cont.resume(false) }
        })
        tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, id)
        cont.invokeOnCancellation { tts.stop() }
    }

    fun stop() {
        player?.run {
            runCatching { stop() }
            release()
        }
        player = null
        if (ttsReady) tts.stop()
    }

    fun release() {
        stop()
        tts.shutdown()
        tones.release()
    }
}
