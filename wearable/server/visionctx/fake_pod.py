"""Simulated camera pod speaking the same protocol as the ESP32 firmware.

    python -m visionctx.fake_pod                       # synthetic frames
    python -m visionctx.fake_pod --images ./photos     # loop over JPEGs in a folder
"""

import argparse
import asyncio
import io
import itertools
import json
import time
from pathlib import Path

import websockets
from PIL import Image, ImageDraw

from .protocol import FLAG_CAPTURE, Frame, encode_frame

SIZES = {"QVGA": (320, 240, 5), "VGA": (640, 480, 8), "SVGA": (800, 600, 9), "XGA": (1024, 768, 10),
         "HD": (1280, 720, 11), "SXGA": (1280, 1024, 12), "UXGA": (1600, 1200, 13)}


class FakePod:
    def __init__(self, device_id: str, images: list[Path]):
        self.device_id = device_id
        self.images = itertools.cycle(images) if images else None
        self.cfg = {"framesize": "VGA", "quality": 12, "fps": 2.0, "streaming": True}
        self.seq = 0
        self.offset_ms = None
        self.sent = 0

    def now(self) -> int:
        return int(time.monotonic() * 1000)

    def render(self, framesize: str, quality: int) -> tuple[bytes, int, int, int]:
        w, h, code = SIZES.get(framesize, SIZES["VGA"])
        if self.images:
            img = Image.open(next(self.images)).convert("RGB")
            img.thumbnail((w, h))
        else:
            img = Image.new("RGB", (w, h), (40, 44, 52))
            d = ImageDraw.Draw(img)
            t = time.time()
            x = int((t * 60) % w)
            d.rectangle([x, h // 3, x + w // 6, h // 3 + h // 4], fill=(230, 120, 40))
            for gx in range(0, w, 40):
                d.line([(gx, 0), (gx, h)], fill=(70, 76, 88))
            d.text((10, 10), f"fake pod {self.device_id}  #{self.seq}  {time.strftime('%H:%M:%S')}",
                   fill=(255, 255, 255))
        buf = io.BytesIO()
        img.save(buf, "JPEG", quality=max(10, 100 - quality))
        return buf.getvalue(), img.width, img.height, code

    def frame(self, flags: int, framesize: str, quality: int) -> bytes:
        jpeg, w, h, code = self.render(framesize, quality)
        ts = self.now() + self.offset_ms if self.offset_ms is not None else 0
        f = Frame(self.seq, ts, flags, code, w, h, jpeg)
        self.seq += 1
        return encode_frame(f)

    async def run(self, url: str) -> None:
        while True:
            try:
                async with websockets.connect(url, max_size=None) as ws:
                    print(f"connected to {url}")
                    await self.session(ws)
            except (OSError, websockets.ConnectionClosed) as e:
                print(f"disconnected ({e}); retrying in 2s")
                await asyncio.sleep(2)

    async def session(self, ws) -> None:
        await ws.send(json.dumps({"type": "hello", "device_id": self.device_id, "fw": "fake-0.1",
                                  "sensor": "FAKE", "psram": True}))
        await ws.send(json.dumps({"type": "time_req", "t0": self.now()}))

        async def reader():
            async for raw in ws:
                msg = json.loads(raw)
                if msg["type"] == "config":
                    self.cfg.update({k: v for k, v in msg.items() if k != "type"})
                    await ws.send(json.dumps({"type": "config_ack", **self.cfg}))
                elif msg["type"] == "time":
                    rtt = self.now() - msg["t0"]
                    self.offset_ms = msg["epoch_ms"] + rtt // 2 - self.now()
                elif msg["type"] == "capture":
                    seq = self.seq
                    await ws.send(self.frame(FLAG_CAPTURE, msg.get("framesize", "UXGA"), msg.get("quality", 8)))
                    await ws.send(json.dumps({"type": "capture_done", "id": msg["id"], "ok": True, "seq": seq}))

        async def writer():
            last_status = 0.0
            while True:
                if self.cfg.get("streaming", True):
                    await ws.send(self.frame(0, self.cfg["framesize"], self.cfg["quality"]))
                    self.sent += 1
                if time.time() - last_status > 5:
                    last_status = time.time()
                    await ws.send(json.dumps({"type": "status", "rssi": -48, "temp_c": 41.0,
                                              "frames_sent": self.sent, "frames_dropped": 0,
                                              "time_synced": self.offset_ms is not None,
                                              "streaming": self.cfg.get("streaming", True)}))
                await asyncio.sleep(1 / max(0.1, float(self.cfg["fps"])))

        await asyncio.gather(reader(), writer())


def main() -> None:
    p = argparse.ArgumentParser(prog="fake_pod")
    p.add_argument("--url", default="ws://127.0.0.1:8000/ws/device")
    p.add_argument("--id", default="fakepod00001")
    p.add_argument("--images", type=Path, help="folder of JPEG files to loop over")
    a = p.parse_args()
    images = sorted(a.images.glob("*.jp*g")) if a.images else []
    asyncio.run(FakePod(a.id, images).run(a.url))


if __name__ == "__main__":
    main()
