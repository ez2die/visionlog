#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${VISIONLOG_APP_DIR:-$PWD}"
DATA_DIR="${VISIONLOG_DATA_DIR:-$HOME/Library/Application Support/VisionLog Test}"
PORT="${VISIONLOG_PORT:-4173}"
LABEL="app.visionlog.test"
PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST_PATH="$PLIST_DIR/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/VisionLog"

if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: Node.js is required (recommended Node 22 or newer)." >&2
  exit 2
fi

if command -v corepack >/dev/null 2>&1; then
  corepack enable >/dev/null 2>&1 || true
fi

if ! command -v pnpm >/dev/null 2>&1; then
  echo "ERROR: pnpm is required. Run: corepack prepare pnpm@10.15.0 --activate" >&2
  exit 2
fi

mkdir -p "$DATA_DIR" "$PLIST_DIR" "$LOG_DIR"
cd "$APP_DIR"
pnpm install --frozen-lockfile --prod

NODE_BIN="$(command -v node)"
cat > "$PLIST_PATH" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$NODE_BIN</string><string>$APP_DIR/src/server.js</string></array>
  <key>WorkingDirectory</key><string>$APP_DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>NODE_ENV</key><string>production</string>
    <key>VISIONLOG_HOST</key><string>0.0.0.0</string>
    <key>VISIONLOG_PORT</key><string>$PORT</string>
    <key>VISIONLOG_DATA_DIR</key><string>$DATA_DIR</string>
    <key>VISIONLOG_TIMEZONE</key><string>Asia/Shanghai</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>$LOG_DIR/server.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/server-error.log</string>
</dict>
</plist>
PLIST

plutil -lint "$PLIST_PATH"
DOMAIN="gui/$(id -u)"
launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
launchctl bootstrap "$DOMAIN" "$PLIST_PATH"
launchctl kickstart -k "$DOMAIN/$LABEL"

for attempt in {1..30}; do
  if curl --fail --silent "http://127.0.0.1:$PORT/api/health"; then
    printf '\nVisionLog is ready at http://127.0.0.1:%s\n' "$PORT"
    printf 'UAT guide: http://127.0.0.1:%s/uat.html\n' "$PORT"
    exit 0
  fi
  sleep 1
done

echo "ERROR: VisionLog did not become healthy. See $LOG_DIR/server-error.log" >&2
exit 1
