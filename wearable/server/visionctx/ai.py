"""Vendor-neutral ASR / VLM / TTS interfaces.

Each capability is picked by env var (VISIONCTX_{ASR,VLM,TTS}_PROVIDER):

  mock    deterministic stand-in, no network; lets the whole loop run before a vendor is chosen
  openai  any OpenAI-compatible HTTP API (/audio/transcriptions, /chat/completions, /audio/speech);
          most hosted and self-hosted vendors expose this shape
  none    (TTS only) server returns text; the Android app speaks it with the on-device engine

Add a vendor by implementing the matching Protocol and registering it in build_providers().
"""

import base64
import os
from dataclasses import dataclass, field
from typing import Protocol

import httpx


@dataclass
class ImageInput:
    label: str  # e.g. "T-3s", shown to the model next to the image
    jpeg: bytes


@dataclass
class VLMRequest:
    system: str
    user_text: str
    images: list[ImageInput] = field(default_factory=list)
    history: list[tuple[str, str]] = field(default_factory=list)  # (user, assistant)


@dataclass
class Speech:
    audio: bytes
    media_type: str


class ASR(Protocol):
    name: str

    async def transcribe(self, audio: bytes, media_type: str) -> str: ...


class VLM(Protocol):
    name: str

    async def answer(self, req: VLMRequest) -> str: ...


class TTS(Protocol):
    name: str

    async def synthesize(self, text: str) -> Speech | None: ...


# --- mock -----------------------------------------------------------------------------


class MockASR:
    name = "mock"

    def __init__(self, text: str = "这个是什么？"):
        self.text = text

    async def transcribe(self, audio: bytes, media_type: str) -> str:
        return self.text


class MockVLM:
    name = "mock"

    async def answer(self, req: VLMRequest) -> str:
        labels = "、".join(i.label for i in req.images) or "无"
        return f"演示模式：收到「{req.user_text}」，参考了 {len(req.images)} 帧画面（{labels}）。"


class NoTTS:
    name = "none"

    async def synthesize(self, text: str) -> Speech | None:
        return None


# --- OpenAI-compatible ------------------------------------------------------------------


@dataclass
class HttpConfig:
    base_url: str
    api_key: str
    model: str
    timeout: float = 30.0

    def headers(self) -> dict:
        return {"Authorization": f"Bearer {self.api_key}"} if self.api_key else {}


class OpenAICompatASR:
    name = "openai"

    def __init__(self, cfg: HttpConfig, language: str = "zh"):
        self.cfg, self.language = cfg, language

    async def transcribe(self, audio: bytes, media_type: str) -> str:
        ext = {"audio/wav": "wav", "audio/x-wav": "wav", "audio/mpeg": "mp3", "audio/mp4": "m4a",
               "audio/ogg": "ogg", "audio/webm": "webm"}.get(media_type, "wav")
        async with httpx.AsyncClient(timeout=self.cfg.timeout) as c:
            r = await c.post(f"{self.cfg.base_url}/audio/transcriptions", headers=self.cfg.headers(),
                             data={"model": self.cfg.model, "language": self.language},
                             files={"file": (f"speech.{ext}", audio, media_type)})
            r.raise_for_status()
            return r.json()["text"].strip()


class OpenAICompatVLM:
    name = "openai"

    def __init__(self, cfg: HttpConfig, max_tokens: int = 300):
        self.cfg, self.max_tokens = cfg, max_tokens

    def build_messages(self, req: VLMRequest) -> list[dict]:
        messages: list[dict] = [{"role": "system", "content": req.system}]
        for user, assistant in req.history:
            messages += [{"role": "user", "content": user}, {"role": "assistant", "content": assistant}]
        content: list[dict] = []
        for img in req.images:
            content.append({"type": "text", "text": f"[画面 {img.label}]"})
            content.append({"type": "image_url", "image_url": {
                "url": "data:image/jpeg;base64," + base64.b64encode(img.jpeg).decode()}})
        content.append({"type": "text", "text": req.user_text})
        messages.append({"role": "user", "content": content})
        return messages

    async def answer(self, req: VLMRequest) -> str:
        body = {"model": self.cfg.model, "messages": self.build_messages(req), "max_tokens": self.max_tokens}
        async with httpx.AsyncClient(timeout=self.cfg.timeout) as c:
            r = await c.post(f"{self.cfg.base_url}/chat/completions", headers=self.cfg.headers(), json=body)
            r.raise_for_status()
            return r.json()["choices"][0]["message"]["content"].strip()


class OpenAICompatTTS:
    name = "openai"

    def __init__(self, cfg: HttpConfig, voice: str, fmt: str = "mp3"):
        self.cfg, self.voice, self.fmt = cfg, voice, fmt

    async def synthesize(self, text: str) -> Speech | None:
        async with httpx.AsyncClient(timeout=self.cfg.timeout) as c:
            r = await c.post(f"{self.cfg.base_url}/audio/speech", headers=self.cfg.headers(),
                             json={"model": self.cfg.model, "voice": self.voice, "input": text,
                                   "response_format": self.fmt})
            r.raise_for_status()
            return Speech(r.content, r.headers.get("content-type", f"audio/{self.fmt}"))


# --- wiring ---------------------------------------------------------------------------------


@dataclass
class Providers:
    asr: ASR
    vlm: VLM
    tts: TTS

    def describe(self) -> dict:
        return {"asr": self.asr.name, "vlm": self.vlm.name, "tts": self.tts.name}


def _http(env: dict, kind: str) -> HttpConfig:
    def get(key: str, default: str = "") -> str:
        return env.get(f"VISIONCTX_{kind}_{key}", default)

    base = get("BASE_URL")
    if not base:
        raise ValueError(f"VISIONCTX_{kind}_BASE_URL is required for the openai provider")
    return HttpConfig(base.rstrip("/"), get("API_KEY"), get("MODEL"), float(get("TIMEOUT", "30")))


def build_providers(env: dict | None = None) -> Providers:
    env = dict(os.environ) if env is None else env
    kind = {k: env.get(f"VISIONCTX_{k}_PROVIDER", "mock").lower() for k in ("ASR", "VLM", "TTS")}

    asr: ASR = (OpenAICompatASR(_http(env, "ASR"), env.get("VISIONCTX_ASR_LANGUAGE", "zh"))
                if kind["ASR"] == "openai" else MockASR())
    vlm: VLM = (OpenAICompatVLM(_http(env, "VLM"), int(env.get("VISIONCTX_VLM_MAX_TOKENS", "300")))
                if kind["VLM"] == "openai" else MockVLM())
    tts: TTS = (OpenAICompatTTS(_http(env, "TTS"), env.get("VISIONCTX_TTS_VOICE", "alloy"),
                                env.get("VISIONCTX_TTS_FORMAT", "mp3"))
                if kind["TTS"] == "openai" else NoTTS())
    return Providers(asr, vlm, tts)
