import io
import time
from contextlib import contextmanager

import pytest
from fastapi.testclient import TestClient
from PIL import Image, ImageDraw

from visionctx import metrics
from visionctx.app import create_app
from visionctx.config import Settings
from visionctx.protocol import FLAG_CAPTURE, Frame, ProtocolError, encode_frame, parse_frame
from visionctx.store import now_ms


def jpeg(color=(120, 120, 120), size=(320, 240), pattern=True) -> bytes:
    img = Image.new("RGB", size, color)
    if pattern:
        d = ImageDraw.Draw(img)
        for x in range(0, size[0], 16):
            d.line([(x, 0), (x, size[1])], fill=(255, 255, 255), width=2)
    buf = io.BytesIO()
    img.save(buf, "JPEG")
    return buf.getvalue()


def frame(seq, ts_ms, flags=0, **kw) -> bytes:
    return encode_frame(Frame(seq, ts_ms, flags, 8, 320, 240, jpeg(**kw)))


@pytest.fixture
def client(tmp_path):
    settings = Settings(data_dir=tmp_path, mdns=False)
    with TestClient(create_app(settings)) as c:
        yield c


@contextmanager
def connect_pod(client, device_id="aabbccddeeff"):
    with client.websocket_connect("/ws/device") as ws:
        ws.send_json({"type": "hello", "device_id": device_id, "fw": "0.1.0", "sensor": "OV2640"})
        assert ws.receive_json()["type"] == "config"
        yield ws


def test_protocol_roundtrip():
    f = Frame(7, 1234567890123, FLAG_CAPTURE, 13, 1600, 1200, jpeg())
    g = parse_frame(encode_frame(f))
    assert (g.seq, g.ts_ms, g.width, g.height, g.is_capture) == (7, 1234567890123, 1600, 1200, True)
    with pytest.raises(ProtocolError):
        parse_frame(b"XXXX" + encode_frame(f)[4:])


def test_pod_handshake_config_and_time(client):
    with client.websocket_connect("/ws/device") as ws:
        _handshake(client, ws)


def _handshake(client, ws):
    ws.send_json({"type": "hello", "device_id": "pod1"})
    cfg = ws.receive_json()
    assert cfg == {"type": "config", **Settings().default_camera}
    ws.send_json({"type": "time_req", "t0": 42})
    t = ws.receive_json()
    assert t["type"] == "time" and t["t0"] == 42 and abs(t["epoch_ms"] - now_ms()) < 5000

    ws.send_json({"type": "status", "rssi": -50})
    ws.send_json({"type": "config_ack", "framesize": "VGA"})
    ws.send_bytes(frame(0, now_ms()))
    time.sleep(0.2)
    [dev] = client.get("/api/devices").json()
    assert dev["online"] and dev["status"]["rssi"] == -50 and dev["applied_config"]["framesize"] == "VGA"
    assert client.get("/api/devices/pod1/latest.jpg").status_code == 200

    # config changes are persisted and pushed to the pod
    r = client.patch("/api/devices/pod1", json={"camera": {"fps": 1.0}})
    assert r.json()["config"]["fps"] == 1.0
    assert ws.receive_json() == {"type": "config", "fps": 1.0}
    assert client.patch("/api/devices/pod1", json={"camera": {"iso": 1}}).status_code == 422


def test_session_marks_annotation_and_report(client):
    with connect_pod(client) as ws:
        _run_session(client, ws)


def _run_session(client, ws):
    r = client.post("/api/sessions", json={"device_id": "aabbccddeeff", "participant": "P1",
                                           "mount": "chest", "task": "p1-desk"})
    assert r.status_code == 201
    sid = r.json()["id"]
    assert client.post("/api/sessions", json={"device_id": "aabbccddeeff", "participant": "P1",
                                              "mount": "ear", "task": "p1-desk"}).status_code == 409

    t = now_ms()
    for i in range(4):
        ws.send_bytes(frame(i, t + i * 500))
    ws.send_bytes(frame(4, t + 2000, color=(5, 5, 5), pattern=False))  # dark -> not auto_ok
    time.sleep(0.3)

    m1 = client.post(f"/api/sessions/{sid}/marks", json={"target": "手机", "ts_ms": t + 400}).json()
    m2 = client.post(f"/api/sessions/{sid}/marks", json={"target": "网线", "ts_ms": t + 1400}).json()
    client.post(f"/api/sessions/{sid}/marks", json={"kind": "reposition", "ts_ms": t + 1500})
    assert client.post(f"/api/sessions/{sid}/marks", json={"kind": "bogus"}).status_code == 422

    marks = client.get(f"/api/sessions/{sid}/marks?candidates=true").json()
    cands = marks[0]["candidates"]
    assert cands and min(abs(c["dt_ms"]) for c in cands) == 100

    fid = cands[0]["id"]
    client.put(f"/api/marks/{m1['id']}/annotation",
               json={"frame_id": fid, "target_in_frame": True, "centered": True,
                     "occluded": False, "useful": True})
    client.put(f"/api/marks/{m2['id']}/annotation",
               json={"frame_id": fid, "target_in_frame": False, "centered": False,
                     "occluded": True, "useful": False})

    [row] = client.get("/api/report").json()
    assert row["mount"] == "chest"
    assert row["gaze_marks"] == 2 and row["annotated"] == 2
    assert row["target_in_frame_rate"] == 0.5 and row["target_in_frame_band"] == "unacceptable"
    assert row["reposition_rate"] == 0.5 and row["reposition_over_limit"] is True
    assert row["frames"] == 5 and row["auto_ok_rate"] == 0.8
    assert "target_in_frame_rate" in client.get("/api/report.csv").text

    client.post(f"/api/sessions/{sid}/end")
    assert client.post(f"/api/sessions/{sid}/marks", json={}).status_code == 409
    client.delete(f"/api/sessions/{sid}")
    assert client.get("/api/frames", params={"device_id": "aabbccddeeff"}).json() == []


def test_retention_keeps_session_and_capture_frames(client):
    with connect_pod(client) as ws:
        _run_retention(client, ws)


def _run_retention(client, ws):
    old = now_ms() - 3_600_000
    ws.send_bytes(frame(0, old))                       # expires
    ws.send_bytes(frame(1, old, flags=FLAG_CAPTURE))   # explicit capture: kept
    time.sleep(0.2)
    sid = client.post("/api/sessions", json={"device_id": "aabbccddeeff", "participant": "P",
                                             "mount": "ear", "task": "p1-walk"}).json()["id"]
    ws.send_bytes(frame(2, old))                       # in kept session: kept
    time.sleep(0.2)
    store = client.app.state.store
    assert store.delete_expired_frames(now_ms() - 60_000) == 1
    left = store.list_frames(device_id="aabbccddeeff")
    assert [(f["seq"], f["capture"], f["session_id"]) for f in left] == [(1, 1, None), (2, 0, sid)]


def test_metrics_bands():
    assert metrics.band(0.9) == "candidate"
    assert metrics.band(0.7) == "marginal"
    assert metrics.band(0.5) == "unacceptable"
    assert metrics.band(None) is None
