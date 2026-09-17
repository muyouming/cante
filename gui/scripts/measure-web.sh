#!/usr/bin/env bash
# Startup-cost measurement for the web frontend: how big is what we ship, and
# how long does the first screen take to appear?
#
#   bash gui/scripts/measure-web.sh
#
# This is a *scale*, not a gate: it prints numbers and exits 0 (a missing Chrome
# is the one exception — see below). Nothing here asserts a threshold, because
# no threshold has been agreed yet; the point is to make "did this round make
# startup worse?" answerable with a command instead of a feeling.
#
# What it measures, and what it deliberately does not:
#
#   * bundle weight — every dist/assets/*.js and *.css, raw and gzip -9;
#   * first screen  — headless Chrome loads the built app from a local static
#                      server, and an injected probe records when the first
#                      screen's key sentence appears, plus the DOM node count;
#   * helper binaries— src-tauri/target/release/cante-gui and cante-sheets, when
#                      a release build exists.
#
# It does NOT measure what the person actually feels on a 16GB Windows machine:
# WebView2 process start, Windows Defender scanning the install, cold disk. The
# in-page numbers start at HTML parse time; everything before that is invisible
# here. See gui/README.md ("Measure startup cost") for how to read the output.
#
# Chrome is required for the browser half and deliberately NOT part of
# scripts/e2e.sh (CI has no Chrome). Set CHROME=… to point at another binary,
# SKIP_BROWSER=1 to print bundle sizes only, SKIP_BUILD=1 to reuse dist/.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"

CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
PORT="${PORT:-8127}"
RUNS="${RUNS:-5}"            # per screen; the script prints every run and the median
CHROME_TIMEOUT="${CHROME_TIMEOUT:-30}"   # seconds allowed for one --dump-dom
SKIP_BUILD="${SKIP_BUILD:-0}"
SKIP_BROWSER="${SKIP_BROWSER:-0}"

WORK="$(mktemp -d)"
SERVER_PID=""

cleanup() {
  if [ -n "$SERVER_PID" ]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

kb() { awk -v n="$1" 'BEGIN { printf "%.1f", n / 1024 }'; }

# ---------------------------------------------------------------------------
# 1. Build
# ---------------------------------------------------------------------------

if [ "$SKIP_BUILD" = "1" ]; then
  echo "==> reusing existing dist/ (SKIP_BUILD=1)"
else
  echo "==> building web assets (bun run build:web)"
  bun run build:web
fi

if [ ! -f dist/index.html ]; then
  echo "measure-web: dist/index.html is missing — run bun run build:web first" >&2
  exit 2
fi

# ---------------------------------------------------------------------------
# 2. Bundle weight — raw and gzip, straight from the bytes on disk
# ---------------------------------------------------------------------------

echo
echo "==> bundle weight (dist/assets, gzip -9)"
total_raw=0
total_gz=0
for asset in dist/assets/*.js dist/assets/*.css; do
  [ -f "$asset" ] || continue
  raw="$(wc -c < "$asset" | tr -d ' ')"
  gz="$(gzip -9 -c "$asset" | wc -c | tr -d ' ')"
  total_raw=$((total_raw + raw))
  total_gz=$((total_gz + gz))
  printf '  %-34s %9s B raw  %9s B gzip (%s kB / %s kB)\n' \
    "$(basename "$asset")" "$raw" "$gz" "$(kb "$raw")" "$(kb "$gz")"
done
printf '  %-34s %9s B raw  %9s B gzip (%s kB / %s kB)\n' \
  "TOTAL" "$total_raw" "$total_gz" "$(kb "$total_raw")" "$(kb "$total_gz")"
html_raw="$(wc -c < dist/index.html | tr -d ' ')"
html_gz="$(gzip -9 -c dist/index.html | wc -c | tr -d ' ')"
printf '  %-34s %9s B raw  %9s B gzip\n' "index.html" "$html_raw" "$html_gz"

# ---------------------------------------------------------------------------
# 3. Rust helper binaries (only if a release build is already on disk)
# ---------------------------------------------------------------------------

echo
echo "==> helper binaries (src-tauri/target/release)"
for bin in cante-gui cante-sheets; do
  path="src-tauri/target/release/$bin"
  if [ -f "$path" ]; then
    size="$(wc -c < "$path" | tr -d ' ')"
    printf '  %-34s %9s B (%s MB)\n' "$bin" "$size" "$(awk -v n="$size" 'BEGIN { printf "%.1f", n / 1048576 }')"
  else
    printf '  %-34s not built — run: cargo build --release --manifest-path src-tauri/Cargo.toml --bin cante-gui --bin cante-sheets\n' "$bin"
  fi
done

if [ "$SKIP_BROWSER" = "1" ]; then
  echo
  echo "measure-web: skipped the browser half (SKIP_BROWSER=1)"
  exit 0
fi

if [ ! -x "$CHROME" ]; then
  echo
  echo "measure-web: no Chrome at $CHROME (set CHROME=… to point at one)" >&2
  echo "             bundle numbers above are still valid; the browser half was not measured." >&2
  exit 2
fi

# ---------------------------------------------------------------------------
# 4. In-page probe + static server
#
# The page runs a tiny probe injected into <head>, ahead of the app bundle. It
# watches the DOM for the first screen's key sentence (Solid renders it during
# module evaluation), stamps performance.now() the moment it appears, counts
# the elements, and writes the result into a hidden #cante-perf-probe element.
# `--dump-dom` then reads that element back out — no WebSocket, no extra
# dependency, the same trick scripts/dom-smoke.sh uses.
#
# The key sentence is chosen per screen:
#   home   — a provisioned machine (the marker the packaging path documents)
#            lands on the home screen: "需要我帮你做什么"
#   wizard — a first run lands on the wizard: "欢迎使用 Cante"
# ---------------------------------------------------------------------------

cat > "$WORK/probe.js" <<'JS'
(function () {
  var KEY = "__KEY__";
  var round = function (n) { return Math.round(n * 10) / 10; };
  var probe = { key: KEY, done: false, reason: null };
  var holder = null;

  function ensureHolder() {
    if (!holder) {
      holder = document.createElement("div");
      holder.id = "cante-perf-probe";
      holder.style.display = "none";
      (document.body || document.documentElement).appendChild(holder);
    }
    return holder;
  }
  function publish() { ensureHolder().setAttribute("data-perf", JSON.stringify(probe)); }

  function record(reason) {
    if (probe.done) return;
    probe.done = true;
    probe.reason = reason;
    // Milliseconds since navigation start, stamped where the mutation landed —
    // before this element is appended, so the node count stays the app's own.
    probe.keyElementMs = round(performance.now());
    probe.nodes = document.getElementsByTagName("*").length;
    publish();
  }

  function present() {
    var body = document.body;
    return !!(body && body.textContent && body.textContent.indexOf(KEY) !== -1);
  }
  function tick() {
    if (present()) {
      record("key-element");
      observer.disconnect();
      clearTimeout(deadline);
    }
  }

  var observer = new MutationObserver(tick);
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  window.addEventListener("DOMContentLoaded", tick);

  window.addEventListener("load", function () {
    tick();
    if (!probe.done) record("load-without-key");
    // loadEventEnd is only written after the load handlers return, and a
    // setTimeout(0) still runs before Chrome serialises the DOM for --dump-dom
    // (verified: the dump carries this task's result).
    setTimeout(function () {
      var nav = performance.getEntriesByType("navigation")[0] || {};
      probe.domInteractiveMs = round(nav.domInteractive || 0);
      probe.domContentLoadedMs = round(nav.domContentLoadedEventEnd || 0);
      probe.loadMs = round(nav.loadEventEnd || 0);
      var resources = performance.getEntriesByType("resource") || [];
      probe.resourceCount = resources.length;
      probe.encodedBytes = resources.reduce(function (sum, r) { return sum + (r.encodedBodySize || 0); }, 0);
      publish();
    }, 0);
  });

  var deadline = setTimeout(function () {
    tick();
    if (!probe.done) record("timeout");
  }, 8000);
})();
JS

cat > "$WORK/serve.py" <<'PY'
import http.server, os, socketserver, sys, urllib.parse

root, probe_path, port = sys.argv[1], sys.argv[2], int(sys.argv[3])
probe_js = open(probe_path, encoding="utf-8").read()
# The sentence each screen must show before it counts as "painted".
KEYS = {"home": "需要我帮你做什么", "wizard": "欢迎使用 Cante"}


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=root, **kwargs)

    def do_GET(self):  # noqa: N802 (the stdlib's spelling)
        parsed = urllib.parse.urlparse(self.path)
        query = urllib.parse.parse_qs(parsed.query)
        screen = query.get("screen", [None])[0]
        if screen in KEYS and parsed.path in ("/", "/index.html"):
            html = open(os.path.join(root, "index.html"), encoding="utf-8").read()
            inject = ""
            if screen == "home":
                # The documented way an administrator pre-sets a machine: a
                # provisioned host skips the wizard and lands on the home screen.
                inject += "<script>window.__CANTE_PROVISIONED__=true;</script>"
            inject += "<script>" + probe_js.replace("__KEY__", KEYS[screen]) + "</script>"
            body = html.replace("<head>", "<head>" + inject, 1).encode()
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

echo
echo "==> serving dist on 127.0.0.1:$PORT"
python3 "$WORK/serve.py" "$APP_DIR/dist" "$WORK/probe.js" "$PORT" >/dev/null 2>&1 &
SERVER_PID=$!
sleep 1

# One --dump-dom run. No --virtual-time-budget: the app keeps a reconcile
# interval alive, so virtual time never settles and Chrome would hang.
dump() {  # $1 screen, $2 outfile, $3 profile suffix
  "$CHROME" --headless=new --disable-gpu --no-first-run \
    --user-data-dir="$WORK/chrome-$3" --dump-dom \
    "http://127.0.0.1:$PORT/?screen=$1" > "$2" 2>/dev/null &
  local pid=$! waited=0
  while kill -0 "$pid" 2>/dev/null; do
    waited=$((waited + 1))
    [ "$waited" -ge $((CHROME_TIMEOUT * 10)) ] && break
    sleep 0.1
  done
  kill -9 "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
}

echo
# Chrome's --dump-dom mode produces no paint-timing entries ("paint" is always
# empty), so there is no first-contentful-paint to report here. The number we do
# get — the key sentence is in the DOM — is the one the product can act on.
echo "==> first screen in headless Chrome, $RUNS run(s) per screen"
echo "    (ms counted from navigation start; no paint timing exists in --dump-dom mode)"

for screen in home wizard; do
  : > "$WORK/$screen.runs"
  for run in $(seq 1 "$RUNS"); do
    dump "$screen" "$WORK/$screen-$run.html" "$screen-$run"
    python3 - "$screen" "$WORK/$screen-$run.html" "$WORK/$screen.runs" <<'PY'
import html, json, re, sys

screen, path, out = sys.argv[1], sys.argv[2], sys.argv[3]
raw = open(path, encoding="utf-8", errors="replace").read()
match = re.search(r'data-perf="([^"]*)"', raw)
if not match:
    # The probe only lands if the page got as far as rendering; its absence is
    # itself a result, not something to paper over.
    with open(out, "a", encoding="utf-8") as fh:
        fh.write(json.dumps({"screen": screen, "ok": False, "why": "no probe in DOM (page did not render?)"}) + "\n")
    print(f"    {screen}: no probe found — the page did not render")
    sys.exit(0)

perf = json.loads(html.unescape(match.group(1)))
perf["screen"] = screen
perf["ok"] = perf.get("reason") == "key-element"
with open(out, "a", encoding="utf-8") as fh:
    fh.write(json.dumps(perf) + "\n")

print(
    "    %-6s key element %6s ms | DOM %5s nodes | DOMContentLoaded %6s ms | load %6s ms | resources %s (%s B) | %s"
    % (
        screen,
        perf.get("keyElementMs"),
        perf.get("nodes"),
        perf.get("domContentLoadedMs"),
        perf.get("loadMs"),
        perf.get("resourceCount"),
        perf.get("encodedBytes"),
        perf.get("reason"),
    )
)
PY
  done

  python3 - "$screen" "$WORK/$screen.runs" <<'PY'
import json, statistics, sys

screen, path = sys.argv[1], sys.argv[2]
rows = [json.loads(line) for line in open(path, encoding="utf-8") if line.strip()]
good = [r for r in rows if r.get("ok")]
print(f"    {screen}: {len(good)}/{len(rows)} runs reached the key element", end="")
if good:
    def median(key):
        vals = [r[key] for r in good if r.get(key) is not None]
        return statistics.median(vals) if vals else None
    print(
        " | median key element %s ms, DOM %s nodes"
        % (median("keyElementMs"), median("nodes"))
    )
else:
    print(" | none — see the per-run lines above")
PY
done

echo
echo "measure-web: done (numbers only — this script does not assert a threshold)"
