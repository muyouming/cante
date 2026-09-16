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
# It renders TWO screens:
#   1. a first run, which lands on the wizard;
#   2. a provisioned machine (`window.__CANTE_PROVISIONED__`, the marker the
#      packaging path already documents), which lands on the home screen — so the
#      task cards and the ability-centre entry are asserted in a real browser
#      too, not just in unit tests.
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

# A static server with one extra route: `/?provisioned=1` returns the same
# index.html with the provisioning marker injected before the bundle runs. That
# is the documented way an administrator pre-sets a machine, so the smoke
# exercises a real code path rather than a test-only hook.
cat > "$WORK/serve.py" <<'PY'
import http.server, os, socketserver, sys, urllib.parse

root, port = sys.argv[1], int(sys.argv[2])


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=root, **kwargs)

    def do_GET(self):  # noqa: N802 (the stdlib's spelling)
        parsed = urllib.parse.urlparse(self.path)
        provisioned = "provisioned=1" in parsed.query
        if provisioned and parsed.path in ("/", "/index.html"):
            html = open(os.path.join(root, "index.html"), encoding="utf-8").read()
            html = html.replace(
                "<head>",
                "<head><script>window.__CANTE_PROVISIONED__=true;</script>",
                1,
            )
            body = html.encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()

    def log_message(self, *args):  # quiet
        pass


socketserver.TCPServer.allow_reuse_address = True
with socketserver.TCPServer(("127.0.0.1", port), Handler) as httpd:
    httpd.serve_forever()
PY

echo "==> serving $APP_DIR/dist on :$PORT"
python3 "$WORK/serve.py" "$APP_DIR/dist" "$PORT" >/dev/null 2>&1 &
SERVER_PID=$!
sleep 1

# `$1` url path, `$2` output file. No --virtual-time-budget: the app keeps a
# reconcile interval alive, so virtual time never settles and Chrome hangs.
# --dump-dom after load is enough — Solid renders during module evaluation.
dump() {
  "$CHROME" --headless=new --disable-gpu --no-first-run \
    --user-data-dir="$WORK/chrome-$3" --dump-dom "http://127.0.0.1:$PORT$1" > "$2" 2>/dev/null &
  local pid=$!
  for _ in $(seq 1 40); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 1
  done
  kill -9 "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
}

echo "==> dumping the first-run DOM"
dump "/" "$WORK/dom-first-run.html" first-run

echo "==> dumping the provisioned DOM (home screen)"
dump "/?provisioned=1" "$WORK/dom-home.html" home

python3 - "$WORK/dom-first-run.html" "$WORK/dom-home.html" <<'PY'
import html, re, sys

SCREENS = {
    "first run (wizard)": (
        sys.argv[1],
        {
            # Always on screen (the header is above every screen in simple mode).
            "app name": "Cante",
            "history entry": "历史",
            "privacy entry": "隐私",
            # A first run lands on the wizard, which is the screen the product
            # promises a non-technical user: three plain steps.
            "wizard step 1": "欢迎",
            "wizard step 2": "检查电脑",
            "wizard step 3": "开始使用",
            # The product promise itself — if this sentence ever disappears, the
            # safety story is gone with it.
            "no-touch promise": "原文件我不会乱动",
        },
    ),
    "provisioned (home)": (
        sys.argv[2],
        {
            # A provisioned machine skips the wizard and lands where the work is.
            "home greeting": "需要我帮你做什么",
            # The ability centre (#74) — the answer to "there are too few tools":
            # every task is searchable, not just the ones on the first screen.
            "ability centre entry": "看看能做什么",
            # The free-text door: she may not recognise herself in any card.
            "free-text box": "直接说一句话",
            # Cards and the home promise.
            "task card group": "表格",
            # Both doors are on screen: the cards, and the sentence box.
            "card-or-sentence hint": "点一张卡片",
        },
    ),
}

exit_code = 0
for name, (path, required) in SCREENS.items():
    dom = open(path, encoding="utf-8", errors="replace").read()
    if len(dom) < 500:
        sys.exit(f"dom-smoke: Chrome produced no DOM for {name} ({len(dom)} bytes)")

    body = re.sub(r"<script.*?</script>", " ", dom, flags=re.S)
    text = html.unescape(re.sub(r"<[^>]+>", "\n", body))
    lines = [line.strip() for line in text.split("\n") if line.strip()]

    missing = [key for key, needle in required.items() if not any(needle in line for line in lines)]
    print(f"dom-smoke: {name}: {len(lines)} text node(s) rendered")
    for line in lines[:8]:
        print("  |", line[:88])
    if missing:
        print(f"dom-smoke: {name}: missing " + ", ".join(missing), file=sys.stderr)
        exit_code = 1

if exit_code:
    sys.exit(exit_code)
print("dom-smoke: OK — both screens rendered with every required element")
PY
