"""Voice turn pipeline: intent routing, frame selection, context assembly, ASR -> VLM -> TTS.

A turn starts when the user starts talking (the app calls /api/turns/start) so the frames
from just before the question are pinned by time, and finishes when the audio arrives.
"""

import asyncio
import re
import time
from dataclasses import dataclass

from .ai import ImageInput, Providers, VLMRequest
from .devices import DeviceRegistry
from .store import Store, now_ms

HISTORY_WINDOW_MS = 15 * 60_000
HISTORY_TURNS = 6
MEMORY_WINDOW_MS = 5 * 60_000
MEMORY_FRAMES = 8

INTENTS = ("current", "task", "check", "memory", "capture")
_RULES = [
    ("capture", r"(拍下来|拍一张|拍个照|拍照|记下来|记住这个)"),
    ("memory", r"(刚才|刚刚|之前|上次|放哪|放在哪|哪去了|经过的|看到过|见过)"),
    ("check", r"(漏了|漏掉|少了|还少|还有什么|还有没有|齐了吗|检查|有没有忘)"),
    ("task", r"(下一步|接下来|然后呢|怎么弄|怎么装|怎么接|怎么办|怎么用|对吗|对不对|哪里不对|有问题|装反)"),
]
_SET_TASK = re.compile(r"(?:我|现在)(?:现在)?(?:要|在|准备|正在|想)(?:开始)?(.{2,30}?)(?:[，,。.？?！!]|$)")
_TASK_VERBS = ("装", "安装", "组装", "修", "配置", "接", "收拾", "整理", "做", "打包", "准备", "设置", "换")

SYSTEM_PROMPT = """你是一个戴在用户身上的视觉助手。用户通过耳机跟你说话，你能看到用户身上摄像头最近拍到的几帧画面，每帧标了相对用户开口时刻的时间。

规则：
1. 回答会被朗读：用口语，一到三句话，不要列表、标题、markdown 或表情。
2. "这个""那个"指用户正在看或手里拿的东西，通常在最新画面的中央附近。
3. 只依据画面里确实看到的内容回答。看不清或画面里没有，就直说，并告诉用户怎么调整，比如"再靠近一点""把标签转过来"。
4. 有当前任务时，结合任务和对话历史判断进度，直接指出做错或漏掉的地方。"""

INTENT_HINTS = {
    "current": "",
    "task": "用户在做一件事，想知道当前状态下该怎么做。先判断现在做到哪一步，再给出下一步。",
    "check": "用户想确认有没有遗漏。对照任务目标逐项检查画面，只说缺少或有问题的项。",
    "memory": "用户在问之前看到过的东西。画面按时间从早到晚排列，找到相关的那一帧，说清是哪个时刻看到的。",
}


def route(text: str) -> str:
    for intent, pattern in _RULES:
        if re.search(pattern, text):
            return intent
    return "current"


def detect_task(text: str) -> str | None:
    """'我现在要装路由器' -> '装路由器'."""
    m = _SET_TASK.search(text)
    if m and any(v in m.group(1) for v in _TASK_VERBS):
        return m.group(1).strip()
    return None


@dataclass
class Selected:
    frame_ids: list[int]
    labels: list[str]


def _rel_label(ts: int, anchor: int) -> str:
    d = (ts - anchor) / 1000
    return "开口时" if abs(d) < 0.25 else f"T{d:+.1f}s"


def select_frames(store: Store, device_id: str, intent: str, speech_start: int, speech_end: int,
                  max_frames: int = 4) -> Selected:
    if intent == "memory":
        frames = [f for f in store.list_frames(device_id, None, speech_start - MEMORY_WINDOW_MS, speech_end, 2000)
                  if not f["capture"]]
        good = [f for f in frames if f["auto_ok"]] or frames
        if len(good) > MEMORY_FRAMES:
            step = len(good) / MEMORY_FRAMES
            good = [good[int(i * step)] for i in range(MEMORY_FRAMES)]
        return Selected([f["id"] for f in good], [_rel_label(f["ts_ms"], speech_start) for f in good])

    # Visual state right before and while the user speaks, plus the newest frame.
    anchors = [speech_start - 3000, speech_start - 1000, speech_start, speech_end + 1000]
    window = store.list_frames(device_id, None, speech_start - 4000, speech_end + 2000, 500)
    window = [f for f in window if not f["capture"]]
    picked: list[dict] = []
    for a in anchors[-max_frames:]:
        near = [f for f in window if abs(f["ts_ms"] - a) <= 700 and f not in picked]
        if not near:
            near = [f for f in window if abs(f["ts_ms"] - a) <= 2000 and f not in picked]
        if near:
            picked.append(max(near, key=lambda f: (f["auto_ok"], f["sharpness"] - abs(f["ts_ms"] - a) / 10)))
    picked.sort(key=lambda f: f["ts_ms"])
    return Selected([f["id"] for f in picked], [_rel_label(f["ts_ms"], speech_start) for f in picked])


class Assistant:
    def __init__(self, store: Store, registry: DeviceRegistry, providers: Providers):
        self.store, self.registry, self.providers = store, registry, providers

    def start(self, conversation_id: str, device_id: str, retry_of: int | None = None,
              source: str = "voice", speech_start_ms: int | None = None) -> dict:
        self.store.ensure_conversation(conversation_id, device_id)
        session = self.store.active_session(device_id)
        return self.store.create_turn(conversation_id, device_id, session["id"] if session else None,
                                      speech_start_ms or now_ms(), retry_of, source)

    async def finish(self, turn_id: int, audio: bytes | None = None, media_type: str = "audio/wav",
                     text: str | None = None) -> dict:
        turn = self.store.get_turn(turn_id)
        speech_end = now_ms()
        timings: dict[str, int] = {}
        self.store.update_turn(turn_id, speech_end_ms=speech_end, status="thinking",
                               providers=self.providers.describe())
        try:
            if text is None:
                t = time.perf_counter()
                text = await self.providers.asr.transcribe(audio or b"", media_type)
                timings["asr_ms"] = round((time.perf_counter() - t) * 1000)
            text = text.strip()
            intent = route(text)
            conv = self.store.get_conversation(turn["conversation_id"])
            task_text = conv["task_text"]
            new_task = detect_task(text)
            if new_task:
                task_text = new_task
                self.store.set_conversation_task(conv["id"], task_text)
                if intent == "current":
                    intent = "task"
            self.store.update_turn(turn_id, transcript=text, intent=intent, task_text=task_text)

            if intent == "capture":
                answer, sel = await self._capture(turn["device_id"])
            else:
                t = time.perf_counter()
                sel = select_frames(self.store, turn["device_id"], intent, turn["speech_start_ms"], speech_end)
                images = [ImageInput(label, self.store.frame_path(self.store.get_frame(fid)).read_bytes())
                          for fid, label in zip(sel.frame_ids, sel.labels)]
                history = self.store.recent_dialogue(conv["id"], now_ms() - HISTORY_WINDOW_MS, HISTORY_TURNS)
                req = VLMRequest(system=self._system(intent, task_text), user_text=text or "（没听清）",
                                 images=images, history=history)
                timings["context_ms"] = round((time.perf_counter() - t) * 1000)
                t = time.perf_counter()
                answer = await self.providers.vlm.answer(req)
                timings["vlm_ms"] = round((time.perf_counter() - t) * 1000)

            self.store.update_turn(turn_id, answer=answer, frame_ids=sel.frame_ids, frame_labels=sel.labels)
            t = time.perf_counter()
            speech = await self.providers.tts.synthesize(answer)
            timings["tts_ms"] = round((time.perf_counter() - t) * 1000)
            fields: dict = {}
            if speech:
                ext = {"audio/mpeg": "mp3", "audio/wav": "wav", "audio/ogg": "ogg"}.get(speech.media_type, "bin")
                rel = f"speech/{turn_id}.{ext}"
                path = self.store.data_dir / rel
                path.parent.mkdir(parents=True, exist_ok=True)
                await asyncio.to_thread(path.write_bytes, speech.audio)
                fields = {"speech_path": rel, "speech_type": speech.media_type}
            timings["total_ms"] = now_ms() - speech_end
            self.store.update_turn(turn_id, status="done", timings=timings, **fields)
        except Exception as e:  # recorded on the turn so the app and logger see the failure
            timings["total_ms"] = now_ms() - speech_end
            self.store.update_turn(turn_id, status="error", error=f"{type(e).__name__}: {e}", timings=timings)
        return self.store.get_turn(turn_id)

    def _system(self, intent: str, task_text: str) -> str:
        parts = [SYSTEM_PROMPT]
        if task_text:
            parts.append(f"当前任务：{task_text}")
        if INTENT_HINTS.get(intent):
            parts.append(INTENT_HINTS[intent])
        return "\n\n".join(parts)

    async def _capture(self, device_id: str) -> tuple[str, Selected]:
        try:
            fid = await self.registry.capture(device_id, "UXGA", 8)
        except (ConnectionError, RuntimeError, asyncio.TimeoutError):
            return "没拍成，摄像头好像没连上。", Selected([], [])
        return "拍好了。", Selected([fid], ["高清拍摄"])
