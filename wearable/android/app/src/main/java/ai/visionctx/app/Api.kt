package ai.visionctx.app

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit

data class Device(val id: String, val name: String, val online: Boolean)

data class ExperimentSession(val id: Int, val participant: String, val mount: String, val task: String)

data class Turn(
    val id: Int,
    val status: String,
    val transcript: String?,
    val intent: String?,
    val taskText: String?,
    val answer: String?,
    val error: String?,
    val hasSpeech: Boolean,
    val totalMs: Int?,
    val retryOf: Int?,
) {
    companion object {
        fun from(o: JSONObject) = Turn(
            id = o.getInt("id"),
            status = o.getString("status"),
            transcript = o.optStringOrNull("transcript"),
            intent = o.optStringOrNull("intent"),
            taskText = o.optStringOrNull("task_text"),
            answer = o.optStringOrNull("answer"),
            error = o.optStringOrNull("error"),
            hasSpeech = !o.isNull("speech_path"),
            totalMs = o.optJSONObject("timings")?.let { if (it.has("total_ms")) it.getInt("total_ms") else null },
            retryOf = if (o.isNull("retry_of")) null else o.getInt("retry_of"),
        )
    }
}

private fun JSONObject.optStringOrNull(key: String): String? = if (isNull(key)) null else getString(key)

class ApiException(message: String) : IOException(message)

/** Thin client for the VisionCtx server (see wearable/server/visionctx/app.py). */
class Api(baseUrl: String) {
    val base = baseUrl.trimEnd('/')

    private val http = OkHttpClient.Builder()
        .connectTimeout(5, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .build()

    private val json = "application/json".toMediaType()

    private suspend fun call(method: String, path: String, body: RequestBody? = null): String =
        withContext(Dispatchers.IO) {
            val req = Request.Builder().url("$base/api/$path").method(method, body).build()
            http.newCall(req).execute().use { res ->
                val text = res.body?.string().orEmpty()
                if (!res.isSuccessful) {
                    val detail = runCatching { JSONObject(text).optString("detail") }.getOrNull()
                    throw ApiException("HTTP ${res.code}: ${detail?.ifEmpty { null } ?: res.message}")
                }
                text
            }
        }

    private fun JSONObject.body() = toString().toRequestBody(json)

    suspend fun devices(): List<Device> {
        val arr = JSONArray(call("GET", "devices"))
        return (0 until arr.length()).map { i ->
            val o = arr.getJSONObject(i)
            Device(o.getString("device_id"), o.optString("name", o.getString("device_id")), o.optBoolean("online"))
        }
    }

    suspend fun activeSession(deviceId: String): ExperimentSession? {
        val arr = JSONArray(call("GET", "sessions"))
        for (i in 0 until arr.length()) {
            val o = arr.getJSONObject(i)
            if (o.getString("device_id") == deviceId && o.isNull("ended_ms")) {
                return ExperimentSession(o.getInt("id"), o.getString("participant"), o.getString("mount"), o.getString("task"))
            }
        }
        return null
    }

    suspend fun startTurn(conversationId: String, deviceId: String, retryOf: Int?): Turn {
        val body = JSONObject()
            .put("conversation_id", conversationId)
            .put("device_id", deviceId)
            .put("retry_of", retryOf ?: JSONObject.NULL)
        return Turn.from(JSONObject(call("POST", "turns/start", body.body())))
    }

    suspend fun sendAudio(turnId: Int, wav: ByteArray): Turn =
        Turn.from(JSONObject(call("POST", "turns/$turnId/audio", wav.toRequestBody("audio/wav".toMediaType()))))

    suspend fun sendText(turnId: Int, text: String): Turn =
        Turn.from(JSONObject(call("POST", "turns/$turnId/text", JSONObject().put("text", text).body())))

    suspend fun cancelTurn(turnId: Int) {
        call("POST", "turns/$turnId/cancel", ByteArray(0).toRequestBody(null))
    }

    suspend fun setTask(conversationId: String, deviceId: String, task: String) {
        val body = JSONObject().put("task_text", task).put("device_id", deviceId)
        call("PUT", "conversations/$conversationId", body.body())
    }

    fun speechUrl(turnId: Int) = "$base/api/turns/$turnId/speech"
}
