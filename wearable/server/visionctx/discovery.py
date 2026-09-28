"""mDNS advertisement so pods can find the server without a hard-coded IP."""

import logging
import socket

from zeroconf import ServiceInfo, Zeroconf

log = logging.getLogger("visionctx")
SERVICE = "_visionctx._tcp.local."


def lan_ip() -> str:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))  # no packets sent; picks the outbound interface
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


class Advert:
    def __init__(self, zc: Zeroconf, info: ServiceInfo):
        self.zc, self.info = zc, info

    def close(self) -> None:
        self.zc.unregister_service(self.info)
        self.zc.close()


def advertise(port: int) -> Advert | None:
    ip = lan_ip()
    info = ServiceInfo(SERVICE, f"visionctx-{socket.gethostname()}.{SERVICE}",
                       addresses=[socket.inet_aton(ip)], port=port, properties={"path": "/ws/device"})
    try:
        zc = Zeroconf()
        zc.register_service(info)
    except Exception as e:  # mDNS is a convenience; pods can use a fixed SERVER_HOST instead
        log.warning("mDNS advertisement failed: %s", e)
        return None
    log.info("mDNS: %s at %s:%d", SERVICE, ip, port)
    return Advert(zc, info)
