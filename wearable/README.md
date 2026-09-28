# VisionCtx — 可穿戴视觉上下文 Demo

验证"持续视觉上下文 + 语音 AI"的实验原型。与仓库根目录的 VisionLog 无关，独立运行。
产品背景见 `../wearable-vision-context/`，任务进度见 `docs/dev-tasks.md`。

```
firmware/   ESP32S3 Sense 摄像头模组固件（PlatformIO）
server/     Python 后端 + 实验台网页
docs/       协议、指标定义、开发任务
```

当前完成 **Phase 1（摄像头位置测试）** 所需的全部软件：模组推流、实时预览、现场打标、事后标注、三位置对比报告。

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

## 2. 烧录模组

```bash
cd wearable/firmware
cp include/secrets.example.h include/secrets.h     # 填 Wi-Fi；SERVER_HOST 留空走 mDNS
pio run -t upload && pio device monitor
```

模组、笔记本需在同一 Wi-Fi（手机热点也可以）。部分路由器会拦截 mDNS，此时在 `secrets.h` 填笔记本 IP。
板载 LED（GPIO21）亮 = 正在推流。电池电压需要外接分压电阻，见 `include/pod_config.h`。

## 3. 跑一轮 Phase 1

1. **设备**页：看实时画面调好夹具角度；三种位置保持同一套摄像头参数。
2. **实验**页：填受试者、佩戴位置、任务 → 开始。用户自然看向目标的瞬间，主持人按对应数字键；用户为了让摄像头看到而调整头或身体时按 `R`。
3. **标注**页：逐条判断目标是否入画、居中、遮挡、可用（全键盘：`Y`/`N`/`C`/`O`/`U`/`Enter`）。
4. **报告**页：按位置对比，可导出 CSV。

指标定义与判定分档见 `docs/metrics.md`，协议见 `docs/protocol.md`。

## 隐私

- 不属于任何实验轮次的画面 30 分钟后自动删除（`VISIONCTX_RETENTION_MINUTES`）。
- 勾选"保留本轮画面"的实验轮次和手动高清拍摄会长期保存；删除轮次会连同画面一起删除。
- 模组推流时 LED 常亮。
