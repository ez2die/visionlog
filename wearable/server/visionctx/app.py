"""HTTP + WebSocket API for camera pods and the experiment dashboard."""

import asyncio
import csv
import io
import json
import logging
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import metrics, quality
from .ai import Providers, build_providers
from .assistant import Assistant
from .config import Settings
from .devices import DeviceConn, DeviceRegistry, LiveFrame
from .protocol import ProtocolError, parse_frame
from .store import Store, now_ms

log = logging.getLogger("visionctx")
PKG = Path(__file__).parent
CAMERA_KEYS = {"framesize", "quality", "fps", "streaming", "brightness", "contrast",
               "saturation", "ae_level", "hmirror", "vflip"}


class ConfigPatch(BaseModel):
    name: str | None = None
    camera: dict | None = None


class CaptureRequest(BaseModel):
    framesize: str = "UXGA"
    quality: int = 8


class SessionCreate(BaseModel):
    device_id: str
    participant: str
    mount: str
    task: str
    notes: str = ""
    keep_frames: bool = True


class MarkCreate(BaseModel):
    kind: str = "gaze"
    target: str = ""
    note: str = ""
    ts_ms: int | None = None
    # Operator reaction delay compensation: mark time = server receive time - offset.
    offset_ms: int = 0


class TurnStart(BaseModel):
    conversation_id: str
    device_id: str
    retry_of: int | None = None
    source: str = "voice"


class TurnText(BaseModel):
    text: str


class TextAsk(BaseModel):
    conversation_id: str
    device_id: str
    text: str


class ConversationPatch(BaseModel):
    task_text: str
    device_id: str | None = None  # creates the conversation if it does not exist yet


class Judgement(BaseModel):
    correct: bool | None = None
    described_scene: bool | None = None
    note: str = ""


class Annotation(BaseModel):
    frame_id: int | None = None
    target_in_frame: bool | None = None
    centered: bool | None = None
    occluded: bool | None = None
    useful: bool | None = None


def create_app(settings: Settings | None = None, providers: Providers | None = None) -> FastAPI:
    settings = settings or Settings()
    store = Store(settings.data_dir)
    registry = DeviceRegistry()
    providers = providers or build_providers()
    assistant = Assistant(store, registry, providers)
    tasks = json.loads((PKG / "tasks.json").read_text(encoding="utf-8"))

    async def sweeper():
        while True:
            cutoff = now_ms() - int(settings.retention_minutes * 60_000)
            n = await asyncio.to_thread(store.delete_expired_frames, cutoff)
            if n:
                log.info("retention: deleted %d frames", n)
            for t in await asyncio.to_thread(store.old_speech_files, cutoff):
                (settings.data_dir / t["speech_path"]).unlink(missing_ok=True)
                store.update_turn(t["id"], speech_path=None)
            await asyncio.sleep(60)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        sweep = asyncio.create_task(sweeper())
        advert = None
        if settings.mdns:
            from .discovery import advertise
            advert = await asyncio.to_thread(advertise, settings.port)
        try:
            yield
        finally:
            sweep.cancel()
            if advert:
                await asyncio.to_thread(advert.close)
            store.close()

    app = FastAPI(title="VisionCtx", lifespan=lifespan)
    app.state.store = store
    app.state.registry = registry
    app.state.settings = settings
    app.state.assistant = assistant
    log.info("providers: %s", providers.describe())

    # --- camera pod -----------------------------------------------------------

    def camera_config(device: dict) -> dict:
        return {**settings.default_camera, **device["config"]}

    async def ingest(conn: DeviceConn, data: bytes) -> None:
        frame = parse_frame(data)
        server_ts = now_ms()
        session = store.active_session(conn.device_id)
        q = await asyncio.to_thread(quality.measure, frame.jpeg)
        ok = quality.auto_ok(q, settings.blur_threshold, settings.dark_threshold, settings.bright_threshold)
        row = await asyncio.to_thread(
            store.save_frame, conn.device_id, frame, server_ts, q, ok,
            session["id"] if session else None, bool(session and session["keep_frames"]))
        if frame.is_capture:
            conn.capture_frames[frame.seq] = row["id"]
        else:
            conn.note_frame()
            registry.publish(conn.device_id, LiveFrame(row["id"], frame.jpeg, row["ts_ms"]))

    async def on_text(conn: DeviceConn, msg: dict) -> None:
        kind = msg.get("type")
        if kind == "time_req":
            await conn.send({"type": "time", "epoch_ms": now_ms(), "t0": msg.get("t0", 0)})
        elif kind == "status":
            conn.status = {k: v for k, v in msg.items() if k != "type"}
        elif kind == "config_ack":
            conn.ack_config = {k: v for k, v in msg.items() if k != "type"}
        elif kind == "capture_done":
            fut = conn.pending_captures.get(msg.get("id", ""))
            if fut and not fut.done():
                frame_id = conn.capture_frames.pop(msg.get("seq", -1), None)
                if msg.get("ok") and frame_id:
                    fut.set_result(frame_id)
                else:
                    fut.set_exception(RuntimeError("capture failed on device"))

    @app.websocket("/ws/device")
    async def device_ws(ws: WebSocket):
        await ws.accept()
        try:
            hello = await asyncio.wait_for(ws.receive_json(), 10)
        except (asyncio.TimeoutError, WebSocketDisconnect, ValueError):
            await ws.close(code=1008)
            return
        if hello.get("type") != "hello" or not hello.get("device_id"):
            await ws.close(code=1008)
            return
        device_id = str(hello["device_id"])
        device = store.upsert_device(device_id, hello.get("fw", ""), hello.get("sensor", ""),
                                     {})
        conn = registry.attach(device_id, ws)
        log.info("pod %s connected (fw %s, %s)", device_id, hello.get("fw"), hello.get("sensor"))
        await conn.send({"type": "config", **camera_config(device)})
        try:
            while True:
                msg = await ws.receive()
                if msg["type"] == "websocket.disconnect":
                    break
                conn.last_msg_at = time.time()
                if msg.get("bytes") is not None:
                    try:
                        await ingest(conn, msg["bytes"])
                    except ProtocolError as e:
                        log.warning("pod %s: %s", device_id, e)
                elif msg.get("text") is not None:
                    try:
                        await on_text(conn, json.loads(msg["text"]))
                    except ValueError:
                        log.warning("pod %s: bad json", device_id)
        except WebSocketDisconnect:
            pass
        finally:
            registry.detach(conn)
            store.touch_device(device_id)
            log.info("pod %s disconnected", device_id)

    # --- devices --------------------------------------------------------------

    def device_view(device: dict) -> dict:
        return {**device, "config": camera_config(device), **registry.summary(device["device_id"])}

    def require_device(device_id: str) -> dict:
        device = store.get_device(device_id)
        if not device:
            raise HTTPException(404, "unknown device")
        return device

    @app.get("/api/devices")
    def list_devices():
        return [device_view(d) for d in store.list_devices()]

    @app.patch("/api/devices/{device_id}")
    async def patch_device(device_id: str, patch: ConfigPatch):
        device = require_device(device_id)
        if patch.camera:
            unknown = set(patch.camera) - CAMERA_KEYS
            if unknown:
                raise HTTPException(422, f"unknown camera keys: {sorted(unknown)}")
            store.update_device(device_id, config={**device["config"], **patch.camera})
            conn = registry.get(device_id)
            if conn:
                await conn.send({"type": "config", **patch.camera})
        if patch.name is not None:
            store.update_device(device_id, name=patch.name)
        return device_view(store.get_device(device_id))

    @app.post("/api/devices/{device_id}/capture")
    async def capture(device_id: str, req: CaptureRequest):
        require_device(device_id)
        try:
            frame_id = await registry.capture(device_id, req.framesize, req.quality)
        except ConnectionError as e:
            raise HTTPException(409, str(e))
        except (RuntimeError, asyncio.TimeoutError):
            raise HTTPException(504, "capture failed or timed out")
        return store.get_frame(frame_id)

    @app.get("/api/devices/{device_id}/latest.jpg")
    def latest(device_id: str):
        frame = registry.latest(device_id)
        if not frame:
            raise HTTPException(404, "no frame yet")
        return Response(frame.jpeg, media_type="image/jpeg", headers={"Cache-Control": "no-store"})

    @app.get("/api/devices/{device_id}/live.mjpg")
    async def live(device_id: str):
        async def stream():
            frame = registry.latest(device_id)
            while True:
                if frame:
                    yield (b"--frame\r\nContent-Type: image/jpeg\r\nContent-Length: "
                           + str(len(frame.jpeg)).encode() + b"\r\n\r\n" + frame.jpeg + b"\r\n")
                frame = await registry.next_frame(device_id) or frame

        return StreamingResponse(stream(), media_type="multipart/x-mixed-replace; boundary=frame")

    # --- frames -----------------------------------------------------------------

    @app.get("/api/frames")
    def list_frames(device_id: str | None = None, session_id: int | None = None,
                    start_ms: int | None = None, end_ms: int | None = None,
                    limit: int = Query(500, le=5000)):
        return store.list_frames(device_id, session_id, start_ms, end_ms, limit)

    @app.get("/api/frames/{frame_id}.jpg")
    def frame_jpeg(frame_id: int):
        frame = store.get_frame(frame_id)
        if not frame or not store.frame_path(frame).exists():
            raise HTTPException(404, "frame not found")
        return FileResponse(store.frame_path(frame), media_type="image/jpeg")

    # --- experiment sessions ------------------------------------------------------

    @app.get("/api/tasks")
    def list_tasks():
        return tasks

    @app.get("/api/sessions")
    def list_sessions():
        return store.list_sessions()

    @app.post("/api/sessions", status_code=201)
    def create_session(req: SessionCreate):
        require_device(req.device_id)
        if store.active_session(req.device_id):
            raise HTTPException(409, "device already has an active session")
        if req.mount not in tasks["mounts"]:
            raise HTTPException(422, f"mount must be one of {list(tasks['mounts'])}")
        return store.create_session(req.device_id, req.participant.strip(), req.mount, req.task,
                                    req.notes, req.keep_frames)

    def require_session(session_id: int) -> dict:
        session = store.get_session(session_id)
        if not session:
            raise HTTPException(404, "unknown session")
        return session

    @app.get("/api/sessions/{session_id}")
    def get_session(session_id: int):
        return require_session(session_id)

    @app.post("/api/sessions/{session_id}/end")
    def end_session(session_id: int):
        require_session(session_id)
        return store.end_session(session_id)

    @app.delete("/api/sessions/{session_id}", status_code=204)
    def delete_session(session_id: int):
        require_session(session_id)
        store.delete_session(session_id)

    @app.post("/api/sessions/{session_id}/marks", status_code=201)
    def add_mark(session_id: int, req: MarkCreate):
        session = require_session(session_id)
        if session["ended_ms"] and req.ts_ms is None:
            raise HTTPException(409, "session has ended")
        ts = req.ts_ms if req.ts_ms is not None else now_ms() - max(0, req.offset_ms)
        try:
            return store.add_mark(session_id, req.kind, ts, req.target, req.note)
        except ValueError as e:
            raise HTTPException(422, str(e))

    @app.get("/api/sessions/{session_id}/marks")
    def list_marks(session_id: int, candidates: bool = False):
        session = require_session(session_id)
        marks = store.list_marks(session_id)
        if candidates:
            w = settings.mark_window_ms
            for m in marks:
                frames = store.list_frames(session["device_id"], None, m["ts_ms"] - w, m["ts_ms"] + w, 50)
                m["candidates"] = [
                    {"id": f["id"], "dt_ms": f["ts_ms"] - m["ts_ms"], "auto_ok": bool(f["auto_ok"])}
                    for f in frames if not f["capture"]
                ]
        return marks

    @app.delete("/api/marks/{mark_id}", status_code=204)
    def delete_mark(mark_id: int):
        if not store.get_mark(mark_id):
            raise HTTPException(404, "unknown mark")
        store.delete_mark(mark_id)

    @app.put("/api/marks/{mark_id}/annotation")
    def annotate(mark_id: int, a: Annotation):
        if not store.get_mark(mark_id):
            raise HTTPException(404, "unknown mark")
        if a.frame_id is not None and not store.get_frame(a.frame_id):
            raise HTTPException(422, "unknown frame")
        store.annotate(mark_id, a.frame_id, a.target_in_frame, a.centered, a.occluded, a.useful)
        return {"ok": True}

    # --- voice turns ----------------------------------------------------------------

    @app.get("/api/providers")
    def get_providers():
        return providers.describe()

    @app.post("/api/turns/start", status_code=201)
    def start_turn(req: TurnStart):
        require_device(req.device_id)
        if req.retry_of is not None and not store.get_turn(req.retry_of):
            raise HTTPException(422, "unknown retry_of turn")
        return assistant.start(req.conversation_id, req.device_id, req.retry_of, req.source)

    def require_turn(turn_id: int) -> dict:
        turn = store.get_turn(turn_id)
        if not turn:
            raise HTTPException(404, "unknown turn")
        return turn

    def open_turn(turn_id: int) -> dict:
        turn = require_turn(turn_id)
        if turn["status"] != "listening":
            raise HTTPException(409, f"turn is {turn['status']}")
        return turn

    @app.post("/api/turns/{turn_id}/audio")
    async def turn_audio(turn_id: int, request: Request):
        open_turn(turn_id)
        audio = await request.body()
        if not audio:
            raise HTTPException(422, "empty audio")
        media_type = request.headers.get("content-type", "audio/wav").split(";")[0]
        return await assistant.finish(turn_id, audio=audio, media_type=media_type)

    @app.post("/api/turns/{turn_id}/text")
    async def turn_text(turn_id: int, req: TurnText):
        open_turn(turn_id)
        return await assistant.finish(turn_id, text=req.text)

    @app.post("/api/turns/{turn_id}/cancel")
    def cancel_turn(turn_id: int):
        open_turn(turn_id)
        store.update_turn(turn_id, status="cancelled")
        return store.get_turn(turn_id)

    @app.post("/api/ask")
    async def ask(req: TextAsk):
        """Typed question from the dashboard: same pipeline, no ASR."""
        require_device(req.device_id)
        turn = assistant.start(req.conversation_id, req.device_id, source="text")
        return await assistant.finish(turn["id"], text=req.text)

    @app.get("/api/turns")
    def list_turns(session_id: int | None = None, conversation_id: str | None = None,
                   limit: int = Query(200, le=2000)):
        return store.list_turns(session_id, conversation_id, limit)

    @app.get("/api/turns/{turn_id}")
    def get_turn(turn_id: int):
        return require_turn(turn_id)

    @app.get("/api/turns/{turn_id}/speech")
    def turn_speech(turn_id: int):
        turn = require_turn(turn_id)
        if not turn["speech_path"] or not (settings.data_dir / turn["speech_path"]).exists():
            raise HTTPException(404, "no speech for this turn")
        return FileResponse(settings.data_dir / turn["speech_path"], media_type=turn["speech_type"])

    @app.put("/api/turns/{turn_id}/judgement")
    def judge_turn(turn_id: int, j: Judgement):
        require_turn(turn_id)
        store.judge_turn(turn_id, j.correct, j.described_scene, j.note)
        return store.get_turn(turn_id)

    @app.get("/api/conversations/{conversation_id}")
    def get_conversation(conversation_id: str):
        conv = store.get_conversation(conversation_id)
        if not conv:
            raise HTTPException(404, "unknown conversation")
        return conv

    @app.put("/api/conversations/{conversation_id}")
    def set_task(conversation_id: str, patch: ConversationPatch):
        if not store.get_conversation(conversation_id):
            if not patch.device_id:
                raise HTTPException(404, "unknown conversation")
            require_device(patch.device_id)
            store.ensure_conversation(conversation_id, patch.device_id)
        store.set_conversation_task(conversation_id, patch.task_text.strip())
        return store.get_conversation(conversation_id)

    # --- report -------------------------------------------------------------------

    def report(group: str) -> list[dict]:
        keys = tuple(k for k in group.split(",") if k in ("mount", "task", "participant"))
        return metrics.compute(*store.report_rows(), group_by=keys or ("mount",))

    @app.get("/api/report")
    def get_report(group: str = "mount"):
        return report(group)

    @app.get("/api/report/qa")
    def get_qa_report(group: str = "mount"):
        keys = tuple(k for k in group.split(",") if k in ("mount", "task", "participant"))
        sessions, marks, _ = store.report_rows()
        return metrics.compute_qa(sessions, marks, store.turn_report_rows(), group_by=keys or ("mount",))

    @app.get("/api/report.csv")
    def get_report_csv(group: str = "mount"):
        rows = report(group)
        buf = io.StringIO()
        if rows:
            w = csv.DictWriter(buf, fieldnames=list(rows[0]))
            w.writeheader()
            w.writerows(rows)
        return Response(buf.getvalue(), media_type="text/csv",
                        headers={"Content-Disposition": "attachment; filename=visionctx-report.csv"})

    app.mount("/", StaticFiles(directory=PKG / "static", html=True), name="static")
    return app
