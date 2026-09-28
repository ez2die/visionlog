"""SQLite + filesystem persistence for devices, frames, sessions, marks and annotations."""

import json
import sqlite3
import threading
import time
from pathlib import Path

from .protocol import Frame
from .quality import Quality

SCHEMA = """
CREATE TABLE IF NOT EXISTS devices (
  device_id TEXT PRIMARY KEY,
  name TEXT,
  config_json TEXT NOT NULL,
  fw TEXT,
  sensor TEXT,
  first_seen_ms INTEGER NOT NULL,
  last_seen_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY,
  device_id TEXT NOT NULL,
  participant TEXT NOT NULL,
  mount TEXT NOT NULL,
  task TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  keep_frames INTEGER NOT NULL DEFAULT 1,
  started_ms INTEGER NOT NULL,
  ended_ms INTEGER
);
CREATE TABLE IF NOT EXISTS frames (
  id INTEGER PRIMARY KEY,
  device_id TEXT NOT NULL,
  session_id INTEGER REFERENCES sessions(id) ON DELETE SET NULL,
  seq INTEGER NOT NULL,
  device_ts_ms INTEGER NOT NULL,
  server_ts_ms INTEGER NOT NULL,
  ts_ms INTEGER NOT NULL,
  capture INTEGER NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  bytes INTEGER NOT NULL,
  path TEXT NOT NULL,
  brightness REAL NOT NULL,
  sharpness REAL NOT NULL,
  auto_ok INTEGER NOT NULL,
  keep INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS frames_device_ts ON frames(device_id, ts_ms);
CREATE INDEX IF NOT EXISTS frames_session ON frames(session_id, ts_ms);
CREATE TABLE IF NOT EXISTS marks (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  ts_ms INTEGER NOT NULL,
  kind TEXT NOT NULL,
  target TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS marks_session ON marks(session_id, ts_ms);
CREATE TABLE IF NOT EXISTS annotations (
  mark_id INTEGER PRIMARY KEY REFERENCES marks(id) ON DELETE CASCADE,
  frame_id INTEGER REFERENCES frames(id) ON DELETE SET NULL,
  target_in_frame INTEGER,
  centered INTEGER,
  occluded INTEGER,
  useful INTEGER,
  updated_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  task_text TEXT NOT NULL DEFAULT '',
  created_ms INTEGER NOT NULL,
  updated_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS turns (
  id INTEGER PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  session_id INTEGER REFERENCES sessions(id) ON DELETE SET NULL,
  retry_of INTEGER REFERENCES turns(id) ON DELETE SET NULL,
  source TEXT NOT NULL DEFAULT 'voice',
  speech_start_ms INTEGER NOT NULL,
  speech_end_ms INTEGER,
  transcript TEXT,
  intent TEXT,
  task_text TEXT,
  frame_ids TEXT,
  frame_labels TEXT,
  answer TEXT,
  speech_path TEXT,
  speech_type TEXT,
  providers TEXT,
  timings TEXT,
  error TEXT,
  status TEXT NOT NULL DEFAULT 'listening',
  correct INTEGER,
  described_scene INTEGER,
  judge_note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS turns_session ON turns(session_id, speech_start_ms);
CREATE INDEX IF NOT EXISTS turns_conversation ON turns(conversation_id, speech_start_ms);
"""

TURN_JSON = ("frame_ids", "frame_labels", "providers", "timings")

MARK_KINDS = ("gaze", "reposition", "phone", "note")


def now_ms() -> int:
    return int(time.time() * 1000)


class Store:
    def __init__(self, data_dir: Path):
        self.data_dir = data_dir
        self.frames_dir = data_dir / "frames"
        self.frames_dir.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._db = sqlite3.connect(data_dir / "visionctx.db", check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        self._db.execute("PRAGMA journal_mode=WAL")
        self._db.execute("PRAGMA foreign_keys=ON")
        self._db.executescript(SCHEMA)

    def close(self) -> None:
        self._db.close()

    def _q(self, sql: str, args=()) -> list[dict]:
        with self._lock:
            return [dict(r) for r in self._db.execute(sql, args).fetchall()]

    def _one(self, sql: str, args=()) -> dict | None:
        rows = self._q(sql, args)
        return rows[0] if rows else None

    def _x(self, sql: str, args=()) -> int:
        with self._lock, self._db:
            cur = self._db.execute(sql, args)
            return cur.lastrowid if cur.lastrowid else cur.rowcount

    # --- devices ---------------------------------------------------------

    def upsert_device(self, device_id: str, fw: str, sensor: str, default_config: dict) -> dict:
        t = now_ms()
        with self._lock, self._db:
            self._db.execute(
                "INSERT INTO devices(device_id, name, config_json, fw, sensor, first_seen_ms, last_seen_ms)"
                " VALUES (?,?,?,?,?,?,?) ON CONFLICT(device_id) DO UPDATE SET"
                " fw=excluded.fw, sensor=excluded.sensor, last_seen_ms=excluded.last_seen_ms",
                (device_id, device_id, json.dumps(default_config), fw, sensor, t, t),
            )
        return self.get_device(device_id)

    def get_device(self, device_id: str) -> dict | None:
        row = self._one("SELECT * FROM devices WHERE device_id=?", (device_id,))
        if row:
            row["config"] = json.loads(row.pop("config_json"))
        return row

    def list_devices(self) -> list[dict]:
        rows = self._q("SELECT * FROM devices ORDER BY last_seen_ms DESC")
        for row in rows:
            row["config"] = json.loads(row.pop("config_json"))
        return rows

    def update_device(self, device_id: str, config: dict | None = None, name: str | None = None) -> None:
        if config is not None:
            self._x("UPDATE devices SET config_json=? WHERE device_id=?", (json.dumps(config), device_id))
        if name is not None:
            self._x("UPDATE devices SET name=? WHERE device_id=?", (name, device_id))

    def touch_device(self, device_id: str) -> None:
        self._x("UPDATE devices SET last_seen_ms=? WHERE device_id=?", (now_ms(), device_id))

    # --- frames ----------------------------------------------------------

    def save_frame(self, device_id: str, frame: Frame, server_ts_ms: int, quality: Quality,
                   auto_ok: bool, session_id: int | None, keep: bool) -> dict:
        ts = frame.ts_ms or server_ts_ms
        day = time.strftime("%Y%m%d", time.localtime(ts / 1000))
        rel = Path(device_id) / day / f"{ts}_{frame.seq}{'_cap' if frame.is_capture else ''}.jpg"
        path = self.frames_dir / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(frame.jpeg)
        fid = self._x(
            "INSERT INTO frames(device_id, session_id, seq, device_ts_ms, server_ts_ms, ts_ms, capture,"
            " width, height, bytes, path, brightness, sharpness, auto_ok, keep)"
            " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (device_id, session_id, frame.seq, frame.ts_ms, server_ts_ms, ts, int(frame.is_capture),
             frame.width, frame.height, len(frame.jpeg), str(rel), quality.brightness,
             quality.sharpness, int(auto_ok), int(keep or frame.is_capture)),
        )
        return self.get_frame(fid)

    def get_frame(self, frame_id: int) -> dict | None:
        return self._one("SELECT * FROM frames WHERE id=?", (frame_id,))

    def frame_path(self, frame: dict) -> Path:
        return self.frames_dir / frame["path"]

    def list_frames(self, device_id: str | None = None, session_id: int | None = None,
                    start_ms: int | None = None, end_ms: int | None = None, limit: int = 500) -> list[dict]:
        where, args = [], []
        for cond, val in (("device_id=?", device_id), ("session_id=?", session_id),
                          ("ts_ms>=?", start_ms), ("ts_ms<=?", end_ms)):
            if val is not None:
                where.append(cond)
                args.append(val)
        sql = "SELECT * FROM frames"
        if where:
            sql += " WHERE " + " AND ".join(where)
        return self._q(sql + " ORDER BY ts_ms LIMIT ?", (*args, limit))

    def delete_expired_frames(self, older_than_ms: int) -> int:
        rows = self._q("SELECT id, path FROM frames WHERE keep=0 AND ts_ms<?", (older_than_ms,))
        return self._delete_frames(rows)

    def _delete_frames(self, rows: list[dict]) -> int:
        for r in rows:
            (self.frames_dir / r["path"]).unlink(missing_ok=True)
        with self._lock, self._db:
            self._db.executemany("DELETE FROM frames WHERE id=?", [(r["id"],) for r in rows])
        return len(rows)

    # --- sessions --------------------------------------------------------

    def create_session(self, device_id: str, participant: str, mount: str, task: str,
                       notes: str = "", keep_frames: bool = True) -> dict:
        sid = self._x(
            "INSERT INTO sessions(device_id, participant, mount, task, notes, keep_frames, started_ms)"
            " VALUES (?,?,?,?,?,?,?)",
            (device_id, participant, mount, task, notes, int(keep_frames), now_ms()),
        )
        return self.get_session(sid)

    def get_session(self, session_id: int) -> dict | None:
        return self._one(
            "SELECT s.*, (SELECT COUNT(*) FROM frames f WHERE f.session_id=s.id) AS frame_count,"
            " (SELECT COUNT(*) FROM marks m WHERE m.session_id=s.id) AS mark_count"
            " FROM sessions s WHERE s.id=?", (session_id,))

    def list_sessions(self) -> list[dict]:
        return self._q(
            "SELECT s.*, (SELECT COUNT(*) FROM frames f WHERE f.session_id=s.id) AS frame_count,"
            " (SELECT COUNT(*) FROM marks m WHERE m.session_id=s.id) AS mark_count"
            " FROM sessions s ORDER BY s.started_ms DESC")

    def active_session(self, device_id: str) -> dict | None:
        return self._one("SELECT * FROM sessions WHERE device_id=? AND ended_ms IS NULL"
                         " ORDER BY started_ms DESC LIMIT 1", (device_id,))

    def end_session(self, session_id: int) -> dict | None:
        self._x("UPDATE sessions SET ended_ms=? WHERE id=? AND ended_ms IS NULL", (now_ms(), session_id))
        return self.get_session(session_id)

    def delete_session(self, session_id: int) -> None:
        self._delete_frames(self._q("SELECT id, path FROM frames WHERE session_id=?", (session_id,)))
        for t in self._q("SELECT speech_path FROM turns WHERE session_id=? AND speech_path IS NOT NULL",
                         (session_id,)):
            (self.data_dir / t["speech_path"]).unlink(missing_ok=True)
        self._x("DELETE FROM turns WHERE session_id=?", (session_id,))
        self._x("DELETE FROM sessions WHERE id=?", (session_id,))

    # --- marks & annotations ----------------------------------------------

    def add_mark(self, session_id: int, kind: str, ts_ms: int, target: str = "", note: str = "") -> dict:
        if kind not in MARK_KINDS:
            raise ValueError(f"kind must be one of {MARK_KINDS}")
        mid = self._x("INSERT INTO marks(session_id, ts_ms, kind, target, note) VALUES (?,?,?,?,?)",
                      (session_id, ts_ms, kind, target, note))
        return self._one("SELECT * FROM marks WHERE id=?", (mid,))

    def get_mark(self, mark_id: int) -> dict | None:
        return self._one("SELECT * FROM marks WHERE id=?", (mark_id,))

    def delete_mark(self, mark_id: int) -> None:
        self._x("DELETE FROM marks WHERE id=?", (mark_id,))

    def list_marks(self, session_id: int) -> list[dict]:
        return self._q(
            "SELECT m.*, a.frame_id, a.target_in_frame, a.centered, a.occluded, a.useful"
            " FROM marks m LEFT JOIN annotations a ON a.mark_id=m.id"
            " WHERE m.session_id=? ORDER BY m.ts_ms", (session_id,))

    def annotate(self, mark_id: int, frame_id: int | None, target_in_frame: bool | None,
                 centered: bool | None, occluded: bool | None, useful: bool | None) -> None:
        def b(v):
            return None if v is None else int(v)

        self._x(
            "INSERT INTO annotations(mark_id, frame_id, target_in_frame, centered, occluded, useful, updated_ms)"
            " VALUES (?,?,?,?,?,?,?) ON CONFLICT(mark_id) DO UPDATE SET frame_id=excluded.frame_id,"
            " target_in_frame=excluded.target_in_frame, centered=excluded.centered,"
            " occluded=excluded.occluded, useful=excluded.useful, updated_ms=excluded.updated_ms",
            (mark_id, frame_id, b(target_in_frame), b(centered), b(occluded), b(useful), now_ms()),
        )

    # --- conversations & turns ---------------------------------------------

    def ensure_conversation(self, conversation_id: str, device_id: str) -> dict:
        t = now_ms()
        with self._lock, self._db:
            self._db.execute(
                "INSERT INTO conversations(id, device_id, created_ms, updated_ms) VALUES (?,?,?,?)"
                " ON CONFLICT(id) DO UPDATE SET device_id=excluded.device_id, updated_ms=excluded.updated_ms",
                (conversation_id, device_id, t, t))
        return self.get_conversation(conversation_id)

    def get_conversation(self, conversation_id: str) -> dict | None:
        return self._one("SELECT * FROM conversations WHERE id=?", (conversation_id,))

    def set_conversation_task(self, conversation_id: str, task_text: str) -> None:
        self._x("UPDATE conversations SET task_text=?, updated_ms=? WHERE id=?",
                (task_text, now_ms(), conversation_id))

    def create_turn(self, conversation_id: str, device_id: str, session_id: int | None,
                    speech_start_ms: int, retry_of: int | None, source: str) -> dict:
        tid = self._x(
            "INSERT INTO turns(conversation_id, device_id, session_id, retry_of, source, speech_start_ms)"
            " VALUES (?,?,?,?,?,?)",
            (conversation_id, device_id, session_id, retry_of, source, speech_start_ms))
        return self.get_turn(tid)

    def update_turn(self, turn_id: int, **fields) -> None:
        if not fields:
            return
        for k in TURN_JSON:
            if k in fields and fields[k] is not None:
                fields[k] = json.dumps(fields[k], ensure_ascii=False)
        cols = ", ".join(f"{k}=?" for k in fields)
        self._x(f"UPDATE turns SET {cols} WHERE id=?", (*fields.values(), turn_id))

    @staticmethod
    def _turn(row: dict | None) -> dict | None:
        if row:
            for k in TURN_JSON:
                row[k] = json.loads(row[k]) if row[k] else None
        return row

    def get_turn(self, turn_id: int) -> dict | None:
        return self._turn(self._one("SELECT * FROM turns WHERE id=?", (turn_id,)))

    def list_turns(self, session_id: int | None = None, conversation_id: str | None = None,
                   limit: int = 200) -> list[dict]:
        where, args = [], []
        if session_id is not None:
            where.append("session_id=?")
            args.append(session_id)
        if conversation_id is not None:
            where.append("conversation_id=?")
            args.append(conversation_id)
        sql = "SELECT * FROM turns" + (" WHERE " + " AND ".join(where) if where else "")
        rows = self._q(sql + " ORDER BY speech_start_ms DESC LIMIT ?", (*args, limit))
        return [self._turn(r) for r in rows]

    def recent_dialogue(self, conversation_id: str, since_ms: int, limit: int) -> list[tuple[str, str]]:
        rows = self._q(
            "SELECT transcript, answer FROM turns WHERE conversation_id=? AND status='done'"
            " AND speech_start_ms>=? ORDER BY speech_start_ms DESC LIMIT ?",
            (conversation_id, since_ms, limit))
        return [(r["transcript"], r["answer"]) for r in reversed(rows)]

    def judge_turn(self, turn_id: int, correct: bool | None, described_scene: bool | None, note: str) -> None:
        b = lambda v: None if v is None else int(v)  # noqa: E731
        self._x("UPDATE turns SET correct=?, described_scene=?, judge_note=? WHERE id=?",
                (b(correct), b(described_scene), note, turn_id))

    def old_speech_files(self, older_than_ms: int) -> list[dict]:
        return self._q("SELECT id, speech_path FROM turns WHERE speech_path IS NOT NULL AND speech_start_ms<?"
                       " AND (session_id IS NULL OR session_id NOT IN (SELECT id FROM sessions WHERE keep_frames=1))",
                       (older_than_ms,))

    # --- reporting inputs -------------------------------------------------

    def report_rows(self) -> tuple[list[dict], list[dict], list[dict]]:
        """Sessions, marks joined with annotations, and per-session frame stats."""
        sessions = self._q("SELECT * FROM sessions")
        marks = self._q(
            "SELECT m.id, m.session_id, m.kind, m.target, a.target_in_frame, a.centered, a.occluded, a.useful"
            " FROM marks m LEFT JOIN annotations a ON a.mark_id=m.id")
        frames = self._q(
            "SELECT session_id, COUNT(*) AS n, SUM(auto_ok) AS auto_ok, MIN(ts_ms) AS t0, MAX(ts_ms) AS t1"
            " FROM frames WHERE session_id IS NOT NULL AND capture=0 GROUP BY session_id")
        return sessions, marks, frames

    def turn_report_rows(self) -> list[dict]:
        return self._q(
            "SELECT t.id, t.session_id, t.retry_of, t.status, t.correct, t.described_scene, t.timings, t.intent"
            " FROM turns t WHERE t.session_id IS NOT NULL")
