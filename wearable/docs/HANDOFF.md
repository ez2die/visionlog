# 交接说明（云端 session → 本地 session）

分支：`claude/inspiring-franklin-ds6yqw`。产品背景见 `wearable-vision-context/`，任务状态见 `docs/dev-tasks.md`，运行方法见 `wearable/README.md`。

## 已验证
- 服务器：`cd wearable/server && pip install -e '.[dev]' && pytest`，17 个测试通过。
- 实验台网页：用 `python -m visionctx.fake_pod` 在浏览器里跑通了 Phase 1（打标、标注、报告）和 Phase 2（键入提问、回放、判定、问答报告）。
- 固件：用 arduino-esp32 2.0.17 编译通过，flash 占用 28%（云端 PlatformIO 下载源被拦，没用 `pio run` 编过）。
- Android：用 kotlinc 对照 android-35 的 `android.jar` 做了编译检查，没有错误；`Api.kt` 在 JVM 上连真服务器跑通了开始、发送、重问、取消和设任务。

## 没验证过（云端做不了，本地要先做）
1. **Android 完整构建**：`cd wearable/android && ./gradlew assembleDebug`（AGP 8.7.3、Kotlin 2.0.21、Gradle 8.11.1、compileSdk 35、minSdk 30）。云端访问不了 Google Maven，AGP 一次都没解析过，第一次构建可能要调版本号。
2. **固件用 PlatformIO 构建**：`cd wearable/firmware && pio run`。
3. **真机、真耳机**：
   - 蓝牙 SCO 录音能不能用（`AudioRoute.kt`）。
   - 耳机单击能不能触发提问（`AssistantService.kt` 里的 `MediaSession`）。SCO 开着时，有些机型会把按键交给系统电话处理。
   - 锁屏后前台服务还能不能录音。
   - 回答走通话通道时的音量。
4. **真实 ESP32 硬件**：画面方向、mDNS 发现、长时间推流发热、帧率稳不稳。

## 下一步
- 第 3 周：B11 视觉记忆（给每帧生成描述、识别文字、向量索引、检索后重排）和 D6 记忆测试题库与自动判分。现在"回忆"类问题只是取最近 5 分钟里的 8 帧（`assistant.py` 里的 `select_frames`）。
- ASR / VLM / TTS 选型定了之后，用环境变量配置（见 README）。TTS 改成边生成边播（B9 剩下的部分）。

## 容易踩的坑
- 所有时间都以服务器时钟为准：模组和服务器对时，打标也在服务器打时间戳。
- 实验原则：三个佩戴位置用同一套摄像头参数，只允许设置镜像和翻转。
