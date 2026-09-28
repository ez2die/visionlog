# VisionCtx — 可穿戴视觉上下文 Demo

验证"持续视觉上下文 + 语音 AI"的实验原型。与仓库根目录的 VisionLog 无关，独立运行。
产品背景见 `../wearable-vision-context/`，任务进度见 `docs/dev-tasks.md`。

```
firmware/   ESP32S3 Sense 摄像头模组固件（PlatformIO）
server/     Python 后端 + 实验台网页
android/    手机 App：蓝牙耳机语音问答
docs/       协议、指标定义、开发任务
```

已完成：
- **Phase 1（摄像头位置测试）**：模组推流、实时预览、现场打标、事后标注、三位置对比报告。
- **Phase 2（实时视觉问答）**：耳机提问 → 语音识别 → 按开口时刻选帧 → 视觉大模型 → 语音回答；问答回放、正确性判定、问答指标。

## 1. 启动后端

```bash
cd wearable/server
python -m venv .venv && . .venv/bin/activate
pip install -e '.[dev]'
python -m visionctx            # http://<笔记本IP>:8000
pytest                         # 测试
```

数据写在 `./data`（`--data` 可改）。后端通过 mDNS 广播自己，模组无需填 IP。

没有硬件时，可用模拟模组跑通全流程：

```bash
python -m visionctx.fake_pod                      # 合成画面
python -m visionctx.fake_pod --images ./photos    # 循环播放一个文件夹的 JPEG
```

### 接入 AI 服务

默认全部是 `mock`：不联网也能跑通整条链路（回答会注明"演示模式"，语音由手机本地 TTS 朗读）。
选定厂商后用环境变量切换，任何兼容 OpenAI 接口格式的服务都能直接用：

```bash
export VISIONCTX_VLM_PROVIDER=openai
export VISIONCTX_VLM_BASE_URL=https://<厂商>/v1      # 调 /chat/completions，图片以 base64 传入
export VISIONCTX_VLM_API_KEY=...
export VISIONCTX_VLM_MODEL=<支持图片的模型>

export VISIONCTX_ASR_PROVIDER=openai                 # /audio/transcriptions
export VISIONCTX_ASR_BASE_URL=... VISIONCTX_ASR_API_KEY=... VISIONCTX_ASR_MODEL=...

export VISIONCTX_TTS_PROVIDER=openai                 # /audio/speech；设为 none 则用手机本地 TTS
export VISIONCTX_TTS_BASE_URL=... VISIONCTX_TTS_API_KEY=... VISIONCTX_TTS_MODEL=... VISIONCTX_TTS_VOICE=...
```

接口格式不兼容的厂商：在 `server/visionctx/ai.py` 实现对应的 `ASR` / `VLM` / `TTS` 类并在 `build_providers()` 注册即可，其余代码不用动。
API Key 只在服务器上，不会发给手机或模组。

## 2. 烧录模组

```bash
cd wearable/firmware
cp include/secrets.example.h include/secrets.h     # 填 Wi-Fi；SERVER_HOST 留空走 mDNS
pio run -t upload && pio device monitor
```

模组、笔记本需在同一 Wi-Fi（手机热点也可以）。部分路由器会拦截 mDNS，此时在 `secrets.h` 填笔记本 IP。
板载 LED（GPIO21）亮 = 正在推流。电池电压需要外接分压电阻，见 `include/pod_config.h`。

## 3. 安装手机 App

用 Android Studio 打开 `wearable/android/`，或 `./gradlew assembleDebug`（需要 Android SDK 35）。要求 Android 11 及以上。

1. 手机与笔记本在同一网络。点"自动发现"或手填 `http://<笔记本IP>:8000`，选择摄像头模组。
2. 连好蓝牙耳机，点"启动助手"。之后可以锁屏放进口袋。
3. 耳机单击 = 开始提问，停顿约 1.2 秒自动结束（也可以再按一次）。耳机"下一曲" = 重问。
4. 说"我现在要装路由器"会自动设定任务；也可以在 App 里手动填写。

每副耳机按键的上报方式不同，第一次使用时请确认单击能触发（App 里的大按钮和通知栏"提问"按钮始终可用）。

## 4. 跑一轮 Phase 1

1. **设备**页：看实时画面调好夹具角度；三种位置保持同一套摄像头参数。
2. **实验**页：填受试者、佩戴位置、任务 → 开始。用户自然看向目标的瞬间，主持人按对应数字键；用户为了让摄像头看到而调整头或身体时按 `R`。
3. **标注**页：逐条判断目标是否入画、居中、遮挡、可用（全键盘：`Y`/`N`/`C`/`O`/`U`/`Enter`）。
4. **报告**页：按位置对比，可导出 CSV。

## 5. 跑一轮 Phase 2

1. **实验**页选 Test A–D 之一开始一轮，受试者戴上模组和耳机，用 App 提问。用户掏出手机时，主持人按 `P`。
2. **问答**页逐条回放：用了哪几帧、转写、回答、各环节耗时；按 `1` 答对、`2` 答错、`D` 用户描述了画面。
3. **报告**页下半部分看首次回答正确率、重问率、延迟等。

没有手机时，可以在**问答**页直接键入问题测试整条链路。

指标定义与判定分档见 `docs/metrics.md`，协议见 `docs/protocol.md`。

## 隐私

- 不属于任何实验轮次的画面 30 分钟后自动删除（`VISIONCTX_RETENTION_MINUTES`）。
- 勾选"保留本轮画面"的实验轮次和手动高清拍摄会长期保存；删除轮次会连同画面一起删除。
- 模组推流时 LED 常亮。
- 用户的语音不落盘，只保存转写文字；服务器 TTS 音频随画面一起按保留期删除。
