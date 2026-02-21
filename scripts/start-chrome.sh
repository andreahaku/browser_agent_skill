#!/usr/bin/env bash
set -euo pipefail

PORT="${CHROME_DEBUG_PORT:-9222}"
PROFILE_DIR="${CHROME_PROFILE_DIR:-$HOME/.browser-agent-profile}"
KILL_EXISTING="${CHROME_KILL_EXISTING:-0}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --kill-existing)
      KILL_EXISTING=1
      shift
      ;;
    --port)
      if [[ $# -lt 2 ]]; then
        echo "Missing value for --port"
        exit 1
      fi
      PORT="$2"
      shift 2
      ;;
    --port=*)
      PORT="${1#--port=}"
      shift
      ;;
    *)
      if [[ "$1" =~ ^[0-9]+$ ]]; then
        PORT="$1"
        shift
      else
        echo "Unknown argument: $1"
        echo "Usage: bash scripts/start-chrome.sh [--port <n>] [--kill-existing]"
        exit 1
      fi
      ;;
  esac
done

mkdir -p "$PROFILE_DIR"

pick_chrome_bin() {
  if [[ "${OSTYPE:-}" == "darwin"* ]]; then
    if [[ -x "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ]]; then
      echo "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
      return
    fi
  fi

  for candidate in google-chrome google-chrome-stable chromium chromium-browser; do
    if command -v "$candidate" >/dev/null 2>&1; then
      command -v "$candidate"
      return
    fi
  done

  echo ""
}

CHROME_BIN="${CHROME_BIN:-}"
if [[ -n "$CHROME_BIN" && ! -x "$CHROME_BIN" ]]; then
  CHROME_BIN="$(command -v "$CHROME_BIN" || true)"
fi

if [[ -z "$CHROME_BIN" ]]; then
  CHROME_BIN="$(pick_chrome_bin)"
fi

if [[ -z "$CHROME_BIN" ]]; then
  echo "Could not find a Chrome binary."
  echo "Set CHROME_BIN manually and retry:"
  echo "  CHROME_BIN=/path/to/chrome bash scripts/start-chrome.sh"
  exit 1
fi

if [[ -z "${CHROME_BIN:-}" ]]; then
  echo "Could not resolve CHROME_BIN."
  exit 1
fi

echo "Starting Chrome:"
echo "  binary: $CHROME_BIN"
echo "  port:   $PORT"
echo "  profile:$PROFILE_DIR"

if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  PIDS="$(lsof -tiTCP:"$PORT" -sTCP:LISTEN | tr '\n' ' ' | xargs)"
  if [[ "$KILL_EXISTING" == "1" ]]; then
    echo "Port $PORT is in use by pid(s): $PIDS"
    echo "Stopping existing process(es)..."
    # shellcheck disable=SC2086
    kill $PIDS >/dev/null 2>&1 || true
    sleep 1
    if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
      PIDS="$(lsof -tiTCP:"$PORT" -sTCP:LISTEN | tr '\n' ' ' | xargs)"
      echo "Force-killing remaining pid(s): $PIDS"
      # shellcheck disable=SC2086
      kill -9 $PIDS >/dev/null 2>&1 || true
      sleep 0.5
    fi
  else
    echo "Port $PORT is already in use by pid(s): $PIDS"
    echo "Use --kill-existing to stop old listener(s), e.g.:"
    echo "  bash scripts/start-chrome.sh --kill-existing"
    echo "Or use a different port:"
    echo "  bash scripts/start-chrome.sh --port 9333"
    exit 1
  fi
fi

"$CHROME_BIN" \
  --remote-debugging-port="$PORT" \
  --remote-debugging-address=127.0.0.1 \
  --remote-allow-origins=* \
  --user-data-dir="$PROFILE_DIR" \
  --no-first-run \
  --no-default-browser-check \
  --new-window \
  about:blank >/dev/null 2>&1 &
CHROME_PID=$!

if command -v curl >/dev/null 2>&1; then
  for _ in {1..100}; do
    if curl -fsS "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1; then
      echo "Chrome launched (pid $CHROME_PID). CDP endpoint: http://127.0.0.1:$PORT"
      exit 0
    fi
    sleep 0.1
  done
fi

echo "Chrome launched (pid $CHROME_PID), but CDP readiness was not confirmed yet."
echo "CDP endpoint (expected): http://127.0.0.1:$PORT"
