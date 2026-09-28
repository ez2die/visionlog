package ai.visionctx.app

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull
import kotlin.coroutines.resume

/** Finds the VisionCtx server on the LAN via mDNS (_visionctx._tcp), like the camera pod does. */
object Discovery {
    private const val SERVICE = "_visionctx._tcp."

    suspend fun find(context: Context, timeoutMs: Long = 5000): String? = withTimeoutOrNull(timeoutMs) {
        val nsd = context.getSystemService(NsdManager::class.java)
        val found = suspendCancellableCoroutine<NsdServiceInfo?> { cont ->
            val listener = object : NsdManager.DiscoveryListener {
                override fun onServiceFound(info: NsdServiceInfo) {
                    if (cont.isActive) cont.resume(info)
                    runCatching { nsd.stopServiceDiscovery(this) }
                }
                override fun onStartDiscoveryFailed(type: String, code: Int) { if (cont.isActive) cont.resume(null) }
                override fun onStopDiscoveryFailed(type: String, code: Int) {}
                override fun onDiscoveryStarted(type: String) {}
                override fun onDiscoveryStopped(type: String) {}
                override fun onServiceLost(info: NsdServiceInfo) {}
            }
            nsd.discoverServices(SERVICE, NsdManager.PROTOCOL_DNS_SD, listener)
            cont.invokeOnCancellation { runCatching { nsd.stopServiceDiscovery(listener) } }
        } ?: return@withTimeoutOrNull null
        suspendCancellableCoroutine<String?> { cont ->
            @Suppress("DEPRECATION")
            nsd.resolveService(found, object : NsdManager.ResolveListener {
                override fun onResolveFailed(info: NsdServiceInfo, code: Int) { if (cont.isActive) cont.resume(null) }
                override fun onServiceResolved(info: NsdServiceInfo) {
                    @Suppress("DEPRECATION")
                    val host = info.host?.hostAddress
                    if (cont.isActive) cont.resume(host?.let { "http://$it:${info.port}" })
                }
            })
        }
    }
}
