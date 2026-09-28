"""Binary frame format sent by the camera pod. See docs/protocol.md."""

import struct
from dataclasses import dataclass

MAGIC = b"VCF1"
HEADER = struct.Struct("<4sIQBBHHH")
FLAG_CAPTURE = 0x01


class ProtocolError(ValueError):
    pass


@dataclass
class Frame:
    seq: int
    ts_ms: int
    flags: int
    framesize: int
    width: int
    height: int
    jpeg: bytes

    @property
    def is_capture(self) -> bool:
        return bool(self.flags & FLAG_CAPTURE)


def parse_frame(data: bytes) -> Frame:
    if len(data) < HEADER.size + 4:
        raise ProtocolError("frame too short")
    magic, seq, ts_ms, flags, framesize, width, height, _ = HEADER.unpack_from(data)
    if magic != MAGIC:
        raise ProtocolError(f"bad magic {magic!r}")
    jpeg = data[HEADER.size:]
    if jpeg[:2] != b"\xff\xd8":
        raise ProtocolError("payload is not a JPEG")
    return Frame(seq, ts_ms, flags, framesize, width, height, jpeg)


def encode_frame(frame: Frame) -> bytes:
    header = HEADER.pack(MAGIC, frame.seq, frame.ts_ms, frame.flags, frame.framesize,
                         frame.width, frame.height, 0)
    return header + frame.jpeg
