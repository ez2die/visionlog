"""Live connections to camera pods: config push, time sync, captures and live-view fan-out."""

import asyncio
import itertools
import time
from dataclasses import dataclass, field

from fastapi import WebSocket

ONLINE_TIMEOUT_S = 15


@dataclass
class LiveFrame:
    frame_id: int
    jpeg: bytes
    ts_ms: int


@dataclass
class DeviceConn:
    device_id: str
    ws: WebSocket
    connected_at: float = field(default_factory=time.time)
    last_msg_at: float = field(default_factory=time.time)
    status: dict = field(default_factory=dict)
    ack_config: dict = field(default_factory=dict)
    recent_frames: list[float] = field(default_factory=list)  # server receive times, last 10 s
    pending_captures: dict[str, asyncio.Future] = field(default_factory=dict)
    capture_frames: dict[int, int] = field(default_factory=dict)  # pod seq -> stored frame id
    send_lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    async def send(self, msg: dict) -> None:
        async with self.send_lock:
            await self.ws.send_json(msg)

    def note_frame(self) -> None:
        t = time.time()
        self.recent_frames.append(t)
        cutoff = t - 10
        while self.recent_frames and self.recent_frames[0] < cutoff:
            self.recent_frames.pop(0)

    @property
    def fps(self) -> float:
        if len(self.recent_frames) < 2:
            return 0.0
        span = self.recent_frames[-1] - self.recent_frames[0]
        return round((len(self.recent_frames) - 1) / span, 2) if span > 0 else 0.0


class DeviceRegistry:
    def __init__(self) -> None:
        self.conns: dict[str, DeviceConn] = {}
        self._latest: dict[str, LiveFrame] = {}
        self._events: dict[str, asyncio.Event] = {}
        self._capture_ids = itertools.count(1)

    def attach(self, device_id: str, ws: WebSocket) -> DeviceConn:
        conn = DeviceConn(device_id, ws)
        self.conns[device_id] = conn
        return conn

    def detach(self, conn: DeviceConn) -> None:
        if self.conns.get(conn.device_id) is conn:
            del self.conns[conn.device_id]
        for fut in conn.pending_captures.values():
            if not fut.done():
                fut.set_exception(ConnectionError("device disconnected"))

    def get(self, device_id: str) -> DeviceConn | None:
        conn = self.conns.get(device_id)
        if conn and time.time() - conn.last_msg_at > ONLINE_TIMEOUT_S:
            return None
        return conn

    def summary(self, device_id: str) -> dict:
        conn = self.get(device_id)
        if not conn:
            return {"online": False}
        return {
            "online": True,
            "connected_at_ms": int(conn.connected_at * 1000),
            "status": conn.status,
            "applied_config": conn.ack_config,
            "fps": conn.fps,
        }

    # --- live view ---------------------------------------------------------

    def publish(self, device_id: str, frame: LiveFrame) -> None:
        self._latest[device_id] = frame
        event = self._events.pop(device_id, None)
        if event:
            event.set()

    def latest(self, device_id: str) -> LiveFrame | None:
        return self._latest.get(device_id)

    async def next_frame(self, device_id: str, timeout: float = 10) -> LiveFrame | None:
        event = self._events.setdefault(device_id, asyncio.Event())
        try:
            await asyncio.wait_for(event.wait(), timeout)
        except asyncio.TimeoutError:
            return None
        return self._latest.get(device_id)

    # --- high-resolution capture ----------------------------------------------

    async def capture(self, device_id: str, framesize: str, quality: int, timeout: float = 10) -> int:
        """Ask the pod for one high-resolution frame; resolves to the stored frame id."""
        conn = self.get(device_id)
        if not conn:
            raise ConnectionError("device offline")
        cid = f"c{next(self._capture_ids)}"
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        conn.pending_captures[cid] = fut
        try:
            await conn.send({"type": "capture", "id": cid, "framesize": framesize, "quality": quality})
            return await asyncio.wait_for(fut, timeout)
        finally:
            conn.pending_captures.pop(cid, None)
