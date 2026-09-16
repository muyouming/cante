#!/usr/bin/env bash
# Headless UI smoke test: render the shell in Chrome and read it back as text.
#
#   bash gui/scripts/dom-smoke.sh
#
# The desktop window cannot be asserted on from a terminal, and screenshots are
# unreadable to a reviewer (and to a coding agent). This instead builds the web
# assets, serves them, lets Chrome dump the rendered DOM, and greps for the
# chrome that must always be there. It catches "the shell painted nothing" and
# "the empty state disappeared" regressions in one second.
#
# Outside Tauri the bridge is unavailable by design, so this also pins the
# browser-preview fallback: the app must explain itself instead of going blank.
#
# Chrome is required and is deliberately NOT part of `scripts/e2e.sh` (CI has no
# Chrome, and this is a developer/agent aid rather than a release gate).
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"

CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
PORT="${PORT:-8099}"
WORK="$(mktemp -d)"
SERVER_PID=""

cleanup() {
  if [ -n "$SERVER_PID" ]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true   # silence bash's "Terminated" report
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

if [ ! -x "$CHROME" ]; then
  echo "dom-smoke: no Chrome at $CHROME (set CHROME=… to point at one)" >&2
  exit 2
fi

echo "==> building web assets"
bun run build:web >/dev/null

echo "==> serving $APP_DIR/dist on :$PORT"
python3 -m http.server "$PORT" -d "$APP_DIR/dist" >/dev/null 2>&1 &
SERVER_PID=$!
sleep 1

echo "==> dumping the rendered DOM"
# No --virtual-time-budget: the app keeps a reconcile interval alive, so virtual
# time never settles and Chrome hangs. --dump-dom after load is enough — Solid
# renders the shell during module evaluation.
"$CHROME" --headless=new --disable-gpu --no-first-run \
  --user-data-dir="$WORK/chrome" --dump-dom "http://127.0.0.1:$PORT/" > "$WORK/dom.html" 2>/dev/null &
CHROME_PID=$!
for _ in $(seq 1 40); do
  kill -0 "$CHROME_PID" 2>/dev/null || break
  sleep 1
done
kill -9 "$CHROME_PID" 2>/dev/null || true
wait "$CHROME_PID" 2>/dev/null || true

python3 - "$WORK/dom.html" <<'PY'
import html, re, sys

path = sys.argv[1]
dom = open(path, encoding="utf-8", errors="replace").read()
if len(dom) < 500:
    sys.exit(f"dom-smoke: Chrome produced no DOM ({len(dom)} bytes)")

body = re.sub(r"<script.*?</script>", " ", dom, flags=re.S)
text = html.unescape(re.sub(r"<[^>]+>", "\n", body))
lines = [line.strip() for line in text.split("\n") if line.strip()]

required = {
    # Always on screen (the header is above every screen in simple mode).
    "app name": "Cante",
    "history entry": "历史",
    "privacy entry": "隐私",
    # A first run (fresh Chrome profile) lands on the wizard, which is the
    # screen the product promises a non-technical user: three plain steps.
    "wizard step 1": "欢迎",
    "wizard step 2": "检查电脑",
    "wizard step 3": "开始使用",
    # The product promise itself — if this sentence ever disappears, the
    # safety story is gone with it.
    "no-touch promise": "原文件我不会乱动",
}
missing = [name for name, needle in required.items() if not any(needle in line for line in lines)]
print(f"dom-smoke: {len(lines)} text node(s) rendered")
for line in lines[:12]:
    print("  |", line[:88])
if missing:
    sys.exit("dom-smoke: missing from the rendered shell: " + ", ".join(missing))
print("dom-smoke: OK — the simple shell rendered with every required element")
PY
