package ai.visionctx.app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.withTimeoutOrNull

/**
 * Routes microphone input (and voice playback) through the Bluetooth earbuds' SCO link.
 * Falls back to the phone's own mic/speaker when no headset is connected.
 */
class AudioRoute(private val context: Context) {
    private val am = context.getSystemService(AudioManager::class.java)

    var active = false
        private set

    /** True when audio is actually flowing over a Bluetooth headset. */
    var bluetooth = false
        private set

    suspend fun open(): Boolean {
        if (active) return bluetooth
        am.mode = AudioManager.MODE_IN_COMMUNICATION
        bluetooth = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) openModern() else openLegacy()
        active = true
        return bluetooth
    }

    fun close() {
        if (!active) return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            am.clearCommunicationDevice()
        } else {
            @Suppress("DEPRECATION")
            am.isBluetoothScoOn = false
            @Suppress("DEPRECATION")
            am.stopBluetoothSco()
        }
        am.mode = AudioManager.MODE_NORMAL
        active = false
        bluetooth = false
    }

    private fun openModern(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return false
        val device = am.availableCommunicationDevices.firstOrNull {
            it.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO || it.type == AudioDeviceInfo.TYPE_BLE_HEADSET
        } ?: return false
        return am.setCommunicationDevice(device)
    }

    @Suppress("DEPRECATION")
    private suspend fun openLegacy(): Boolean {
        if (!am.isBluetoothScoAvailableOffCall) return false
        val connected = CompletableDeferred<Boolean>()
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(c: Context, i: Intent) {
                when (i.getIntExtra(AudioManager.EXTRA_SCO_AUDIO_STATE, -1)) {
                    AudioManager.SCO_AUDIO_STATE_CONNECTED -> connected.complete(true)
                    AudioManager.SCO_AUDIO_STATE_ERROR -> connected.complete(false)
                }
            }
        }
        context.registerReceiver(receiver, IntentFilter(AudioManager.ACTION_SCO_AUDIO_STATE_UPDATED))
        try {
            am.startBluetoothSco()
            am.isBluetoothScoOn = true
            return withTimeoutOrNull(3000) { connected.await() } ?: false
        } finally {
            context.unregisterReceiver(receiver)
        }
    }
}
