#pragma once
// Board-level settings. Runtime camera settings come from the server.

// Privacy indicator: on while the pod is sending frames.
// XIAO ESP32S3 user LED is GPIO21, active LOW (shared with the Sense SD card CS; SD is unused).
#define LED_PIN 21
#define LED_ACTIVE_LOW 1

// Battery voltage: XIAO ESP32S3 has no built-in battery sense. Wire a 1:2 divider
// (e.g. 2 x 200k) from BAT+ to an ADC pin and set the pin here; -1 disables.
#define BATTERY_ADC_PIN -1
#define BATTERY_DIVIDER 2.0f

#define STATUS_INTERVAL_MS 5000
#define TIME_SYNC_INTERVAL_MS 60000
#define MDNS_SERVICE "visionctx"
