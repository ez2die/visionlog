// VisionCtx Camera Pod firmware.
// Streams JPEG frames to the VisionCtx server over WebSocket. All buffering,
// memory and AI live on the server; the pod only captures and transmits.
// Wire protocol: wearable/docs/protocol.md

#include <Arduino.h>
#include <ArduinoJson.h>
#include <ESPmDNS.h>
#include <WebSocketsClient.h>
#include <WiFi.h>

#include "camera_pins.h"
#include "esp_camera.h"
#include "esp_timer.h"
#include "pod_config.h"

#if __has_include("secrets.h")
#include "secrets.h"
#else
#warning "include/secrets.h not found; using secrets.example.h"
#include "secrets.example.h"
#endif

#define FW_VERSION "0.1.0"
#define FLAG_CAPTURE 0x01

struct __attribute__((packed)) FrameHeader {
  char magic[4];  // "VCF1"
  uint32_t seq;
  uint64_t ts_ms;  // server-epoch ms, 0 if the clock is not synced yet
  uint8_t flags;
  uint8_t framesize;
  uint16_t width;
  uint16_t height;
  uint16_t reserved;
};
static_assert(sizeof(FrameHeader) == 24, "header must be 24 bytes");

struct FramesizeName {
  const char *name;
  framesize_t size;
};
static const FramesizeName kFramesizes[] = {
    {"QVGA", FRAMESIZE_QVGA}, {"VGA", FRAMESIZE_VGA},   {"SVGA", FRAMESIZE_SVGA},
    {"XGA", FRAMESIZE_XGA},   {"HD", FRAMESIZE_HD},     {"SXGA", FRAMESIZE_SXGA},
    {"UXGA", FRAMESIZE_UXGA},
};

struct PodState {
  framesize_t framesize = FRAMESIZE_VGA;
  int quality = 12;
  float fps = 1.0f;
  bool streaming = true;
  bool connected = false;
  bool time_synced = false;
  int64_t clock_offset_ms = 0;
  uint32_t seq = 0;
  uint32_t frames_sent = 0;
  uint32_t frames_dropped = 0;
  uint64_t last_frame_ms = 0;
  uint64_t last_status_ms = 0;
  uint64_t last_time_sync_ms = 0;
  // Pending high-resolution capture request.
  bool capture_pending = false;
  framesize_t capture_framesize = FRAMESIZE_UXGA;
  int capture_quality = 8;
  String capture_id;
};

static PodState state;
static WebSocketsClient ws;
static String device_id;
static uint8_t *send_buf = nullptr;
static size_t send_buf_cap = 0;

static uint64_t nowMs() { return esp_timer_get_time() / 1000ULL; }

static uint64_t epochMs() {
  return state.time_synced ? (uint64_t)((int64_t)nowMs() + state.clock_offset_ms) : 0;
}

static const char *framesizeName(framesize_t fs) {
  for (const auto &f : kFramesizes)
    if (f.size == fs) return f.name;
  return "?";
}

static bool parseFramesize(const char *name, framesize_t *out) {
  if (!name) return false;
  for (const auto &f : kFramesizes) {
    if (strcasecmp(f.name, name) == 0) {
      *out = f.size;
      return true;
    }
  }
  return false;
}

static void setLed(bool on) {
  if (LED_PIN < 0) return;
  digitalWrite(LED_PIN, (on ^ LED_ACTIVE_LOW) ? HIGH : LOW);
}

static void sendJson(JsonDocument &doc) {
  String out;
  serializeJson(doc, out);
  ws.sendTXT(out);
}

static bool initCamera() {
  camera_config_t c = {};
  c.ledc_channel = LEDC_CHANNEL_0;
  c.ledc_timer = LEDC_TIMER_0;
  c.pin_d0 = Y2_GPIO_NUM;
  c.pin_d1 = Y3_GPIO_NUM;
  c.pin_d2 = Y4_GPIO_NUM;
  c.pin_d3 = Y5_GPIO_NUM;
  c.pin_d4 = Y6_GPIO_NUM;
  c.pin_d5 = Y7_GPIO_NUM;
  c.pin_d6 = Y8_GPIO_NUM;
  c.pin_d7 = Y9_GPIO_NUM;
  c.pin_xclk = XCLK_GPIO_NUM;
  c.pin_pclk = PCLK_GPIO_NUM;
  c.pin_vsync = VSYNC_GPIO_NUM;
  c.pin_href = HREF_GPIO_NUM;
  c.pin_sccb_sda = SIOD_GPIO_NUM;
  c.pin_sccb_scl = SIOC_GPIO_NUM;
  c.pin_pwdn = PWDN_GPIO_NUM;
  c.pin_reset = RESET_GPIO_NUM;
  c.xclk_freq_hz = 20000000;
  c.pixel_format = PIXFORMAT_JPEG;
  // Allocate buffers for the largest size so capture can switch up at runtime.
  c.frame_size = FRAMESIZE_UXGA;
  c.jpeg_quality = state.quality;
  c.fb_count = 2;
  c.fb_location = CAMERA_FB_IN_PSRAM;
  c.grab_mode = CAMERA_GRAB_LATEST;

  esp_err_t err = esp_camera_init(&c);
  if (err != ESP_OK) {
    Serial.printf("camera init failed: 0x%x\n", err);
    return false;
  }
  sensor_t *s = esp_camera_sensor_get();
  s->set_framesize(s, state.framesize);
  s->set_quality(s, state.quality);
  return true;
}

static void discardFrames(int n) {
  for (int i = 0; i < n; i++) {
    camera_fb_t *fb = esp_camera_fb_get();
    if (fb) esp_camera_fb_return(fb);
  }
}

static bool sendFrame(camera_fb_t *fb, uint8_t flags, framesize_t fs) {
  size_t total = sizeof(FrameHeader) + fb->len;
  if (total > send_buf_cap) {
    free(send_buf);
    send_buf_cap = total + 16 * 1024;
    send_buf = (uint8_t *)ps_malloc(send_buf_cap);
    if (!send_buf) {
      send_buf_cap = 0;
      return false;
    }
  }
  FrameHeader h = {};
  memcpy(h.magic, "VCF1", 4);
  h.seq = state.seq++;
  h.ts_ms = epochMs();
  h.flags = flags;
  h.framesize = (uint8_t)fs;
  h.width = fb->width;
  h.height = fb->height;
  memcpy(send_buf, &h, sizeof(h));
  memcpy(send_buf + sizeof(h), fb->buf, fb->len);
  return ws.sendBIN(send_buf, total);
}

static void streamFrame() {
  camera_fb_t *fb = esp_camera_fb_get();
  if (!fb) {
    state.frames_dropped++;
    return;
  }
  bool ok = sendFrame(fb, 0, state.framesize);
  esp_camera_fb_return(fb);
  if (ok)
    state.frames_sent++;
  else
    state.frames_dropped++;
}

static void doCapture() {
  state.capture_pending = false;
  sensor_t *s = esp_camera_sensor_get();
  s->set_framesize(s, state.capture_framesize);
  s->set_quality(s, state.capture_quality);
  discardFrames(2);  // let exposure settle and flush stale buffers
  camera_fb_t *fb = esp_camera_fb_get();
  uint32_t seq = state.seq;
  bool ok = fb && sendFrame(fb, FLAG_CAPTURE, state.capture_framesize);
  if (fb) esp_camera_fb_return(fb);
  s->set_framesize(s, state.framesize);
  s->set_quality(s, state.quality);
  discardFrames(1);

  JsonDocument doc;
  doc["type"] = "capture_done";
  doc["id"] = state.capture_id;
  doc["ok"] = ok;
  if (ok) doc["seq"] = seq;
  sendJson(doc);
}

static void sendConfigAck() {
  sensor_t *s = esp_camera_sensor_get();
  JsonDocument doc;
  doc["type"] = "config_ack";
  doc["framesize"] = framesizeName(state.framesize);
  doc["quality"] = state.quality;
  doc["fps"] = state.fps;
  doc["streaming"] = state.streaming;
  doc["brightness"] = s->status.brightness;
  doc["contrast"] = s->status.contrast;
  doc["saturation"] = s->status.saturation;
  doc["ae_level"] = s->status.ae_level;
  doc["hmirror"] = (bool)s->status.hmirror;
  doc["vflip"] = (bool)s->status.vflip;
  sendJson(doc);
}

static void applyConfig(JsonDocument &doc) {
  sensor_t *s = esp_camera_sensor_get();
  framesize_t fs;
  if (parseFramesize(doc["framesize"] | (const char *)nullptr, &fs)) {
    state.framesize = fs;
    s->set_framesize(s, fs);
  }
  if (doc["quality"].is<int>()) {
    state.quality = constrain(doc["quality"].as<int>(), 4, 63);
    s->set_quality(s, state.quality);
  }
  if (doc["fps"].is<float>()) state.fps = constrain(doc["fps"].as<float>(), 0.1f, 10.0f);
  if (doc["streaming"].is<bool>()) state.streaming = doc["streaming"].as<bool>();
  if (doc["brightness"].is<int>()) s->set_brightness(s, doc["brightness"].as<int>());
  if (doc["contrast"].is<int>()) s->set_contrast(s, doc["contrast"].as<int>());
  if (doc["saturation"].is<int>()) s->set_saturation(s, doc["saturation"].as<int>());
  if (doc["ae_level"].is<int>()) s->set_ae_level(s, doc["ae_level"].as<int>());
  if (doc["hmirror"].is<bool>()) s->set_hmirror(s, doc["hmirror"].as<bool>());
  if (doc["vflip"].is<bool>()) s->set_vflip(s, doc["vflip"].as<bool>());
  sendConfigAck();
}

static void requestTimeSync() {
  JsonDocument doc;
  doc["type"] = "time_req";
  doc["t0"] = nowMs();
  sendJson(doc);
  state.last_time_sync_ms = nowMs();
}

static void handleTime(JsonDocument &doc) {
  // NTP-style: offset = server_time + rtt/2 - local_now
  uint64_t t0 = doc["t0"].as<uint64_t>();
  uint64_t server = doc["epoch_ms"].as<uint64_t>();
  uint64_t t1 = nowMs();
  if (t0 == 0 || server == 0 || t1 < t0) return;
  int64_t rtt = (int64_t)(t1 - t0);
  state.clock_offset_ms = (int64_t)server + rtt / 2 - (int64_t)t1;
  state.time_synced = true;
}

static void sendHello() {
  sensor_t *s = esp_camera_sensor_get();
  camera_sensor_info_t *info = esp_camera_sensor_get_info(&s->id);
  JsonDocument doc;
  doc["type"] = "hello";
  doc["device_id"] = device_id;
  doc["fw"] = FW_VERSION;
  doc["sensor"] = info ? info->name : "unknown";
  doc["psram"] = psramFound();
  doc["ip"] = WiFi.localIP().toString();
  sendJson(doc);
}

static void sendStatus() {
  JsonDocument doc;
  doc["type"] = "status";
  doc["rssi"] = WiFi.RSSI();
  doc["temp_c"] = temperatureRead();
  if (BATTERY_ADC_PIN >= 0)
    doc["battery_mv"] = (int)(analogReadMilliVolts(BATTERY_ADC_PIN) * BATTERY_DIVIDER);
  doc["heap"] = ESP.getFreeHeap();
  doc["psram"] = ESP.getFreePsram();
  doc["uptime_ms"] = nowMs();
  doc["frames_sent"] = state.frames_sent;
  doc["frames_dropped"] = state.frames_dropped;
  doc["time_synced"] = state.time_synced;
  doc["streaming"] = state.streaming;
  sendJson(doc);
  state.last_status_ms = nowMs();
}

static void onText(uint8_t *payload, size_t len) {
  JsonDocument doc;
  if (deserializeJson(doc, payload, len)) return;
  const char *type = doc["type"] | "";
  if (!strcmp(type, "config")) {
    applyConfig(doc);
  } else if (!strcmp(type, "time")) {
    handleTime(doc);
  } else if (!strcmp(type, "capture")) {
    framesize_t fs = FRAMESIZE_UXGA;
    parseFramesize(doc["framesize"] | (const char *)nullptr, &fs);
    state.capture_framesize = fs;
    state.capture_quality = constrain(doc["quality"] | 8, 4, 63);
    state.capture_id = String(doc["id"] | "");
    state.capture_pending = true;
  }
}

static void onWsEvent(WStype_t type, uint8_t *payload, size_t len) {
  switch (type) {
    case WStype_CONNECTED:
      Serial.println("ws connected");
      state.connected = true;
      sendHello();
      requestTimeSync();
      break;
    case WStype_DISCONNECTED:
      if (state.connected) Serial.println("ws disconnected");
      state.connected = false;
      break;
    case WStype_TEXT:
      onText(payload, len);
      break;
    default:
      break;
  }
}

static void connectWifi() {
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);  // lower latency; power is not optimised in the demo
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.printf("wifi: connecting to %s", WIFI_SSID);
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.printf("\nwifi: %s\n", WiFi.localIP().toString().c_str());
}

static void connectServer() {
  String host = SERVER_HOST;
  uint16_t port = SERVER_PORT;
  if (host.isEmpty()) {
    MDNS.begin(("vcpod-" + device_id.substring(6)).c_str());
    while (true) {
      Serial.println("mdns: looking for _" MDNS_SERVICE "._tcp");
      int n = MDNS.queryService(MDNS_SERVICE, "tcp");
      if (n > 0) {
        host = MDNS.IP(0).toString();
        port = MDNS.port(0);
        break;
      }
      delay(2000);
    }
  }
  Serial.printf("server: ws://%s:%u/ws/device\n", host.c_str(), port);
  ws.begin(host, port, "/ws/device");
  ws.onEvent(onWsEvent);
  ws.setReconnectInterval(2000);
  ws.enableHeartbeat(15000, 3000, 2);
}

void setup() {
  Serial.begin(115200);
  if (LED_PIN >= 0) pinMode(LED_PIN, OUTPUT);
  setLed(false);

  uint8_t mac[6];
  WiFi.macAddress(mac);
  char buf[13];
  snprintf(buf, sizeof(buf), "%02x%02x%02x%02x%02x%02x", mac[0], mac[1], mac[2], mac[3], mac[4],
           mac[5]);
  device_id = buf;
  Serial.printf("VisionCtx pod %s fw %s\n", device_id.c_str(), FW_VERSION);

  if (!psramFound()) Serial.println("warning: PSRAM not found");
  while (!initCamera()) delay(1000);

  connectWifi();
  connectServer();
}

void loop() {
  ws.loop();
  uint64_t now = nowMs();

  bool active = state.connected && state.streaming;
  setLed(active);
  if (!state.connected) return;

  if (state.capture_pending) doCapture();

  uint64_t period = (uint64_t)(1000.0f / state.fps);
  if (active && now - state.last_frame_ms >= period) {
    state.last_frame_ms = now;
    streamFrame();
  }
  if (now - state.last_status_ms >= STATUS_INTERVAL_MS) sendStatus();
  if (now - state.last_time_sync_ms >= TIME_SYNC_INTERVAL_MS) requestTimeSync();
}
