import os
from dataclasses import dataclass, field
from pathlib import Path


def _env(name: str, default: str) -> str:
    return os.environ.get(f"VISIONCTX_{name}", default)


@dataclass
class Settings:
    data_dir: Path = field(default_factory=lambda: Path(_env("DATA", "./data")))
    host: str = field(default_factory=lambda: _env("HOST", "0.0.0.0"))
    port: int = field(default_factory=lambda: int(_env("PORT", "8000")))
    # Frames outside a kept experiment session are deleted after this many minutes.
    retention_minutes: float = field(default_factory=lambda: float(_env("RETENTION_MINUTES", "30")))
    # Frames within +/- this window of a mark are offered as annotation candidates.
    mark_window_ms: int = field(default_factory=lambda: int(_env("MARK_WINDOW_MS", "1500")))
    blur_threshold: float = field(default_factory=lambda: float(_env("BLUR_THRESHOLD", "60")))
    dark_threshold: float = 40.0
    bright_threshold: float = 225.0
    mdns: bool = field(default_factory=lambda: _env("MDNS", "1") == "1")

    # Same optics/exposure profile on every mount: only body position changes.
    default_camera: dict = field(
        default_factory=lambda: {
            "framesize": "VGA",
            "quality": 12,
            "fps": 2.0,
            "streaming": True,
            "brightness": 0,
            "contrast": 0,
            "saturation": 0,
            "ae_level": 0,
            "hmirror": False,
            "vflip": False,
        }
    )
