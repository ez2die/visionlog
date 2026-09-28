package ai.visionctx.app

import android.annotation.SuppressLint
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.sqrt

/**
 * 16 kHz mono PCM recorder with a simple energy VAD:
 * stops after [silenceMs] of quiet once speech has been heard, or after [maxMs].
 */
class Recorder(
    private val silenceMs: Int = 1200,
    private val maxMs: Int = 15_000,
    private val noSpeechMs: Int = 6000,
) {
    companion object {
        const val SAMPLE_RATE = 16_000
        private const val FRAME_MS = 30
        private const val SPEECH_RMS = 900.0
    }

    private var record: AudioRecord? = null
    private var job: Job? = null
    private val pcm = ByteArrayOutputStream()

    @Volatile var heardSpeech = false
        private set

    @SuppressLint("MissingPermission") // checked by the activity before the service starts
    fun start(scope: CoroutineScope, onAutoStop: (reason: String) -> Unit) {
        val minBuf = AudioRecord.getMinBufferSize(SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        val r = AudioRecord(
            MediaRecorder.AudioSource.VOICE_COMMUNICATION, SAMPLE_RATE,
            AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, maxOf(minBuf, SAMPLE_RATE),
        )
        check(r.state == AudioRecord.STATE_INITIALIZED) { "microphone unavailable" }
        record = r
        pcm.reset()
        heardSpeech = false
        r.startRecording()
        job = scope.launch(Dispatchers.IO) {
            val frame = ShortArray(SAMPLE_RATE * FRAME_MS / 1000)
            val bytes = ByteBuffer.allocate(frame.size * 2).order(ByteOrder.LITTLE_ENDIAN)
            var elapsed = 0
            var quiet = 0
            while (isActive) {
                val n = r.read(frame, 0, frame.size)
                if (n <= 0) continue
                bytes.clear()
                var sum = 0.0
                for (i in 0 until n) {
                    bytes.putShort(frame[i])
                    sum += frame[i].toDouble() * frame[i]
                }
                synchronized(pcm) { pcm.write(bytes.array(), 0, n * 2) }
                val rms = sqrt(sum / n)
                elapsed += FRAME_MS
                if (rms > SPEECH_RMS) {
                    heardSpeech = true
                    quiet = 0
                } else {
                    quiet += FRAME_MS
                }
                val reason = when {
                    heardSpeech && quiet >= silenceMs -> "silence"
                    !heardSpeech && elapsed >= noSpeechMs -> "no_speech"
                    elapsed >= maxMs -> "max_length"
                    else -> null
                }
                if (reason != null) {
                    onAutoStop(reason)
                    break
                }
            }
        }
    }

    /** Stops recording and returns a WAV file, or null if nothing was recorded. */
    fun stop(): ByteArray? {
        job?.cancel()
        job = null
        record?.run {
            runCatching { stop() }
            release()
        }
        record = null
        val data = synchronized(pcm) { pcm.toByteArray() }
        return if (data.isEmpty()) null else wav(data)
    }

    val durationMs: Int get() = synchronized(pcm) { pcm.size() } / 2 * 1000 / SAMPLE_RATE

    private fun wav(data: ByteArray): ByteArray {
        val header = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN).apply {
            put("RIFF".toByteArray()); putInt(36 + data.size); put("WAVE".toByteArray())
            put("fmt ".toByteArray()); putInt(16); putShort(1); putShort(1)
            putInt(SAMPLE_RATE); putInt(SAMPLE_RATE * 2); putShort(2); putShort(16)
            put("data".toByteArray()); putInt(data.size)
        }
        return header.array() + data
    }
}
