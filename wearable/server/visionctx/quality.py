"""Cheap per-frame quality signals used as an automatic first pass on "useful frame"."""

import io
from dataclasses import dataclass

import numpy as np
from PIL import Image


@dataclass
class Quality:
    brightness: float
    sharpness: float  # variance of Laplacian on a 320px-wide grayscale copy


def measure(jpeg: bytes) -> Quality:
    img = Image.open(io.BytesIO(jpeg))
    img.draft("L", (320, 240))  # fast JPEG downscale while decoding
    img = img.convert("L")
    if img.width > 320:
        img = img.resize((320, max(1, img.height * 320 // img.width)))
    a = np.asarray(img, dtype=np.float32)
    lap = (a[:-2, 1:-1] + a[2:, 1:-1] + a[1:-1, :-2] + a[1:-1, 2:] - 4 * a[1:-1, 1:-1])
    return Quality(brightness=float(a.mean()), sharpness=float(lap.var()) if lap.size else 0.0)


def auto_ok(q: Quality, blur_threshold: float, dark: float, bright: float) -> bool:
    return q.sharpness >= blur_threshold and dark <= q.brightness <= bright
