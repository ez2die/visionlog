# Pod ↔ Server 协议 v1

传输：WebSocket，`ws://<server>:8000/ws/device`。Pod 用 mDNS 查找 `_visionctx._tcp`，或在 `secrets.h` 写死 `SERVER_HOST`。

## 二进制帧（Pod → Server）

每条 binary 消息 = 24 字节小端头 + 完整 JPEG。

| 偏移 | 类型 | 字段 | 说明 |
|---|---|---|---|
| 0 | char[4] | magic | `VCF1` |
| 4 | u32 | seq | 单调递增，重启归零 |
| 8 | u64 | ts_ms | 服务器时钟下的采集时刻（epoch ms）；未对时为 0，此时服务器用接收时间 |
| 16 | u8 | flags | bit0 = 高清拍摄（Capture Mode） |
| 17 | u8 | framesize | esp32-camera `framesize_t` 枚举值 |
| 18 | u16 | width | |
| 20 | u16 | height | |
| 22 | u16 | reserved | 0 |

## JSON 文本消息

Pod → Server

| type | 字段 | 时机 |
|---|---|---|
| `hello` | device_id（MAC）, fw, sensor, psram, ip | 连接后第一条，10 秒内必须发送 |
| `time_req` | t0（pod 本地 ms） | 连接后与每 60 秒 |
| `status` | rssi, temp_c, battery_mv?, heap, psram, uptime_ms, frames_sent, frames_dropped, time_synced, streaming | 每 5 秒 |
| `config_ack` | 当前生效的摄像头参数 | 每次收到 config 后 |
| `capture_done` | id, ok, seq | 高清帧发送后 |

Server → Pod

| type | 字段 | 说明 |
|---|---|---|
| `config` | framesize, quality, fps, streaming, brightness, contrast, saturation, ae_level, hmirror, vflip（均可选） | hello 后下发完整配置；之后只下发变更项 |
| `time` | epoch_ms, t0 | 对时回复。Pod：offset = epoch_ms + rtt/2 − now |
| `capture` | id, framesize, quality | 请求一张高清帧 |

## 对时

所有时间以**服务器时钟**为准（Pod 帧时间戳、主持人打标都落在同一时钟上），不依赖外网 NTP。局域网 RTT 通常 < 20 ms，误差远小于 1–2 fps 的帧间隔。
