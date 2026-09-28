import time

import pytest
from fastapi.testclient import TestClient

from visionctx.ai import MockASR, MockVLM, NoTTS, OpenAICompatVLM, Providers, Speech, VLMRequest, \
    ImageInput, HttpConfig, build_providers
from visionctx.app import create_app
from visionctx.assistant import detect_task, route
from visionctx.config import Settings
from visionctx.store import now_ms

from test_server import connect_pod, frame


class RecordingVLM:
    name = "rec"

    def __init__(self):
        self.requests: list[VLMRequest] = []

    async def answer(self, req):
        self.requests.append(req)
        return f"答{len(self.requests)}"


class FakeTTS:
    name = "fake"

    async def synthesize(self, text):
        return Speech(b"ID3fake", "audio/mpeg")


@pytest.fixture
def vlm():
    return RecordingVLM()


@pytest.fixture
def client(tmp_path, vlm):
    providers = Providers(MockASR("下一步怎么弄？"), vlm, FakeTTS())
    with TestClient(create_app(Settings(data_dir=tmp_path, mdns=False), providers)) as c:
        yield c


@pytest.mark.parametrize("text,intent", [
    ("这个是什么？", "current"),
    ("下一步呢", "task"),
    ("这样接对吗", "task"),
    ("还有什么没弄", "check"),
    ("刚才那家店叫什么", "memory"),
    ("我把钥匙放哪了", "memory"),
    ("拍下来", "capture"),
])
def test_route(text, intent):
    assert route(text) == intent


def test_detect_task():
    assert detect_task("我现在要装路由器，先从哪开始") == "装路由器"
    assert detect_task("我在收拾出差的包") == "收拾出差的包"
    assert detect_task("这个是什么") is None
    assert detect_task("我想吃饭") is None


def test_voice_turn_pipeline(client, vlm):
    with connect_pod(client) as ws:
        t0 = now_ms()
        for i in range(10):
            ws.send_bytes(frame(i, t0 - 4000 + i * 500))
        time.sleep(0.3)
        turn = client.post("/api/turns/start", json={"conversation_id": "c1", "device_id": "aabbccddeeff"}).json()
        assert turn["status"] == "listening"
        r = client.post(f"/api/turns/{turn['id']}/audio", content=b"RIFFfake", headers={"Content-Type": "audio/wav"})
        t = r.json()
        assert t["status"] == "done", t["error"]
        assert t["transcript"] == "下一步怎么弄？" and t["intent"] == "task"
        assert t["answer"] == "答1"
        assert 2 <= len(t["frame_ids"]) <= 4 and len(t["frame_labels"]) == len(t["frame_ids"])
        assert {"asr_ms", "vlm_ms", "tts_ms", "total_ms"} <= set(t["timings"])
        assert client.get(f"/api/turns/{t['id']}/speech").content == b"ID3fake"
        req = vlm.requests[0]
        assert "当前状态" in req.system and len(req.images) == len(t["frame_ids"])

        # set a task by voice; dialogue history carries into the next turn
        a = client.post("/api/ask", json={"conversation_id": "c1", "device_id": "aabbccddeeff",
                                          "text": "我现在要装路由器"}).json()
        assert a["intent"] == "task" and a["task_text"] == "装路由器"
        b = client.post("/api/ask", json={"conversation_id": "c1", "device_id": "aabbccddeeff",
                                          "text": "刚才那个标签写的什么"}).json()
        req = vlm.requests[-1]
        assert b["intent"] == "memory" and "当前任务：装路由器" in req.system
        assert req.history == [("下一步怎么弄？", "答1"), ("我现在要装路由器", "答2")]

        # task can be set explicitly, even before the first turn of a conversation
        assert client.put("/api/conversations/c2", json={"task_text": "x"}).status_code == 404
        r = client.put("/api/conversations/c2", json={"task_text": "打包出差行李", "device_id": "aabbccddeeff"})
        assert r.json()["task_text"] == "打包出差行李"

        # finished turns cannot be reused
        assert client.post(f"/api/turns/{t['id']}/text", json={"text": "x"}).status_code == 409


def test_qa_report(client):
    with connect_pod(client) as ws:
        ws.send_bytes(frame(0, now_ms()))
        time.sleep(0.2)
        sid = client.post("/api/sessions", json={"device_id": "aabbccddeeff", "participant": "P1",
                                                 "mount": "glasses", "task": "p2-what"}).json()["id"]
        ids = []
        for _ in range(3):
            ids.append(client.post("/api/ask", json={"conversation_id": "c", "device_id": "aabbccddeeff",
                                                     "text": "这个是什么"}).json()["id"])
        retry = client.post("/api/turns/start", json={"conversation_id": "c", "device_id": "aabbccddeeff",
                                                      "retry_of": ids[2]}).json()
        client.post(f"/api/turns/{retry['id']}/text", json={"text": "这个到底是什么"})
        for tid, ok in zip(ids + [retry["id"]], [True, True, False, True]):
            client.put(f"/api/turns/{tid}/judgement", json={"correct": ok, "described_scene": not ok})
        client.post(f"/api/sessions/{sid}/marks", json={"kind": "phone"})
        [row] = client.get("/api/report/qa").json()
        assert row["mount"] == "glasses" and row["turns"] == 4
        assert row["first_answer_accuracy"] == pytest.approx(2 / 3, abs=1e-3)
        assert row["answer_accuracy"] == 0.75 and row["rephrase_rate"] == pytest.approx(1 / 3, abs=1e-3)
        assert row["described_scene_rate"] == 0.25 and row["phone_uses"] == 1
        assert row["latency_p50_ms"] is not None


def test_openai_compat_message_shape():
    v = OpenAICompatVLM(HttpConfig("http://x", "k", "m"))
    msgs = v.build_messages(VLMRequest("sys", "问题", [ImageInput("T-1.0s", b"\xff\xd8")], [("a", "b")]))
    assert [m["role"] for m in msgs] == ["system", "user", "assistant", "user"]
    content = msgs[-1]["content"]
    assert content[0]["text"] == "[画面 T-1.0s]"
    assert content[1]["image_url"]["url"].startswith("data:image/jpeg;base64,")
    assert content[-1]["text"] == "问题"


def test_build_providers():
    p = build_providers({})
    assert p.describe() == {"asr": "mock", "vlm": "mock", "tts": "none"}
    p = build_providers({"VISIONCTX_VLM_PROVIDER": "openai", "VISIONCTX_VLM_BASE_URL": "http://h/v1/",
                         "VISIONCTX_VLM_MODEL": "m"})
    assert p.vlm.name == "openai" and p.vlm.cfg.base_url == "http://h/v1"
    with pytest.raises(ValueError):
        build_providers({"VISIONCTX_ASR_PROVIDER": "openai"})
