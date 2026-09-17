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
# It renders THREE things:
#   1. a first run, which lands on the wizard;
#   2. a provisioned machine (`window.__CANTE_PROVISIONED__`, the marker the
#      packaging path already documents), which lands on the home screen — so the
#      task cards and the ability-centre entry are asserted in a real browser
#      too, not just in unit tests;
#   3. the same home screen with a keyboard probe injected (r20): the probe opens
#      the ability centre and the results panel for real, presses Tab and
#      Shift+Tab through them, presses Escape, and writes down where the focus
#      went. That is the only place where the focus trap is exercised in a real
#      browser — `bun test` has no DOM (see src/simple/focus-guard.test.ts).
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

# Two routes are injected on top of the static build:
#   * `/?provisioned=1` returns the same index.html with the provisioning marker
#     injected before the bundle runs. That is the documented way an
#     administrator pre-sets a machine, so the smoke exercises a real code path
#     rather than a test-only hook.
#   * `/?provisioned=1&probe=1` injects the keyboard probe (a real script, in a
#     real page) the same way. It has no test-only hooks in the app either: it
#     finds the buttons by their Chinese text and clicks them.
cat > "$WORK/serve.py" <<'PY'
import http.server, os, socketserver, sys, urllib.parse

root, port, probe = sys.argv[1], int(sys.argv[2]), sys.argv[3]


def injected(query):
    flags = []
    if "provisioned=1" in query:
        flags.append("<script>window.__CANTE_PROVISIONED__=true;</script>")
    if "probe=1" in query:
        with open(probe, encoding="utf-8") as handle:
            flags.append("<script>" + handle.read() + "</script>")
    return "".join(flags)


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=root, **kwargs)

    def do_GET(self):  # noqa: N802 (the stdlib's spelling)
        parsed = urllib.parse.urlparse(self.path)
        script = injected(parsed.query)
        if script and parsed.path in ("/", "/index.html"):
            html = open(os.path.join(root, "index.html"), encoding="utf-8").read()
            html = html.replace("<head>", "<head>" + script, 1)
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
python3 "$WORK/serve.py" "$APP_DIR/dist" "$PORT" "$WORK/probe.js" >/dev/null 2>&1 &
SERVER_PID=$!
sleep 1

# The keyboard probe (r20). It is a plain script in a real page: it finds the
# buttons by their Chinese text, clicks them, presses Tab/Shift+Tab/Escape with
# real KeyboardEvents, and writes down where the focus went. The app's focus
# layer moves the focus itself (a synthetic key event has no native default), so
# this exercises the real handler, not a stand-in.
#
# It runs from the load event, and everything it needs is already rendered by
# then; the chained awaits below are microtasks, and Chrome serialises the DOM
# after them (a plain setTimeout would land after --dump-dom has already run).
# The result is appended as <pre id="probe-report">, which the assertions read.
cat > "$WORK/probe.js" <<'JS'
(function () {
  var report = { screens: [] };
  var seen = new WeakMap();
  var counter = 0;

  function byText(text) {
    var list = Array.prototype.slice.call(document.querySelectorAll("button"));
    for (var i = 0; i < list.length; i++) {
      if ((list[i].textContent || "").indexOf(text) >= 0) return list[i];
    }
    return null;
  }

  // 每个元素一个编号：光看文字对不上（好几张卡片的风险按钮都写「还有 3 条」）。
  function idOf(el) {
    if (!seen.has(el)) {
      counter += 1;
      seen.set(el, counter);
    }
    return seen.get(el);
  }

  function describe(el) {
    if (!el || !el.tagName) return null;
    var label = el.getAttribute("aria-label") || el.textContent || "";
    return {
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      label: label.trim().slice(0, 30),
      inLayer: !!(el.closest && el.closest("[data-focus-layer]")),
      mark: idOf(el),
    };
  }

  // 这一层里现在能按到的东西有几个。刻意不调应用里的那个助手：验的人得自己数。
  function layerSize() {
    var roots = document.querySelectorAll("[data-focus-layer]");
    var list = [];
    for (var i = 0; i < roots.length; i++) {
      list = list.concat(
        Array.prototype.slice.call(
          roots[i].querySelectorAll(
            'a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"])',
          ),
        ),
      );
    }
    return list.filter(function (el) {
      return !el.disabled && el.getClientRects().length > 0;
    }).length;
  }

  function press(key, shift) {
    var target = document.activeElement || document.body;
    target.dispatchEvent(
      new KeyboardEvent("keydown", { key: key, shiftKey: !!shift, bubbles: true, cancelable: true }),
    );
  }

  async function probe(name, entryText) {
    var record = {
      name: name,
      layerSize: 0,
      entryFound: false,
      opened: false,
      activeAfterOpen: null,
      insideAfterOpen: false,
      tabStops: [],
      tabStayedInside: true,
      shiftTabStops: [],
      shiftTabStayedInside: true,
      escClosed: false,
      activeAfterClose: null,
    };
    var entry = byText(entryText);
    if (entry) {
      record.entryFound = true;
      // 先 focus 再 click：真的用鼠标点一个按钮时，焦点也会落到那个按钮上，
      // 而 element.click() 不会。关掉浮层后焦点该还给谁，靠的就是这个。
      entry.focus();
      entry.click();
      await null; // the panel renders and its focus layer lands the focus
      record.opened = !!document.querySelector('[role="dialog"]');
      record.activeAfterOpen = describe(document.activeElement);
      record.insideAfterOpen = !!(record.activeAfterOpen && record.activeAfterOpen.inLayer);
      record.layerSize = layerSize();
      for (var i = 0; i < 12; i++) {
        press("Tab");
        var stop = describe(document.activeElement);
        record.tabStops.push(stop);
        if (!stop || !stop.inLayer) record.tabStayedInside = false;
      }
      for (var j = 0; j < 3; j++) {
        press("Tab", true);
        var back = describe(document.activeElement);
        record.shiftTabStops.push(back);
        if (!back || !back.inLayer) record.shiftTabStayedInside = false;
      }
      // 两个层同时开着时，Tab 要在两层之间循环。确认页 + 右上角那条「排好的活」就是
      // 这个情形，但要进去得有真的守护进程（本机浏览器预览里点卡片直接就报错了），
      // 所以第二层由探针自己造一个：测的是同一段代码（所有开着的数据
      // 层合起来算一个循环）。
      var companion = document.createElement("div");
      companion.setAttribute("data-focus-layer", "");
      var companionButton = document.createElement("button");
      companionButton.type = "button";
      companionButton.textContent = "PROBE-COMPANION";
      companion.appendChild(companionButton);
      document.body.insertBefore(companion, document.body.firstChild);
      record.companionReached = false;
      for (var k = 0; k < 80 && !record.companionReached; k++) {
        press("Tab");
        if (document.activeElement === companionButton) record.companionReached = true;
      }
      // 从第二层再往前一步，应该回到主层里，而不是跑到页面顶上。
      press("Tab");
      record.afterCompanionInLayer = !!(
        document.activeElement &&
        document.activeElement.closest &&
        document.activeElement.closest("[data-focus-layer]")
      );
      companion.remove();
      press("Escape");
      await null; // the close and the focus restore are microtasks
      record.escClosed = !document.querySelector('[role="dialog"]');
      record.activeAfterClose = describe(document.activeElement);
    }
    report.screens.push(record);
  }

  window.addEventListener("load", function () {
    void (async function () {
      await probe("ability-centre", "看看能做什么");
      await probe("my-results", "打开我做的结果");
      var pre = document.createElement("pre");
      pre.id = "probe-report";
      pre.textContent = JSON.stringify(report);
      document.body.appendChild(pre);
    })();
  });
})();
JS

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

echo "==> dumping the keyboard probe DOM (Tab / Shift+Tab / Escape)"
dump "/?provisioned=1&probe=1" "$WORK/dom-probe.html" probe

python3 - "$WORK/dom-first-run.html" "$WORK/dom-home.html" "$WORK/dom-probe.html" <<'PY'
import html, json, re, sys

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

# ---- r20：键盘探针 ---------------------------------------------------------
#
# 开头那两条只能证明「画出来了」。这一段证明「键盘真的走得完」：探针（注入进去的
# 普通脚本，不是测试专用的钩子）真的点开了两个浮层，真的按了 Tab、Shift+Tab、Esc，
# 把每一步焦点落在哪写进了 <pre id="probe-report">。

def describe(entry):
    if not entry:
        return "（没有焦点）"
    return f"{entry['tag']}#{entry['id'] or '-'}({entry['label']})"


# 探针里用来找入口按钮的那段中文：关掉浮层后焦点应该还给这句话的那个按钮。
ENTRIES = {"ability-centre": "看看能做什么", "my-results": "打开我做的结果"}


def entry_text(name):
    return ENTRIES.get(name, "")


probe_dom = open(sys.argv[3], encoding="utf-8", errors="replace").read()
blob = re.search(r'<pre id="probe-report">(.*?)</pre>', probe_dom, flags=re.S)
if not blob:
    print("dom-smoke: keyboard probe: no report (探针没跑出来)", file=sys.stderr)
    exit_code = 1
else:
    report = json.loads(html.unescape(blob.group(1)))
    for screen in report["screens"]:
        name = screen["name"]
        size = screen["layerSize"]
        stops = [item for item in screen["tabStops"] if item]
        distinct = len({item["mark"] for item in stops})
        backwards = [item for item in screen["shiftTabStops"] if item]
        distinct_back = len({item["mark"] for item in backwards})
        problems = []
        if not screen["entryFound"]:
            problems.append("找不到打开它的那个按钮")
        if not screen["opened"]:
            problems.append("浮层没有打开")
        if not screen["insideAfterOpen"]:
            problems.append(f"打开后焦点不在浮层里（在 {describe(screen['activeAfterOpen'])}）")
        if not screen["tabStayedInside"]:
            problems.append("Tab 跑到浮层外面去了")
        if not screen["shiftTabStayedInside"]:
            problems.append("Shift+Tab 跑到浮层外面去了")
        # Tab 在真的动：12 次里走过的不同元素数，等于这一层里能按到的东西数（封顶 12）。
        # 全落在一个元素上也能通过上面两条，那是假的绿。
        if size < 1:
            problems.append("这一层里一个能按的东西都没有")
        elif distinct != min(12, size):
            problems.append(f"Tab 只走到 {distinct} 个地方，这一层里有 {size} 个（期望 {min(12, size)}）")
        if distinct_back != min(3, size):
            problems.append(f"Shift+Tab 只走到 {distinct_back} 个地方（期望 {min(3, size)}）")
        if not screen["escClosed"]:
            problems.append("Esc 没有关掉它")
        # 两个层同时开着时 Tab 要走到第二层（确认页 + 那条「排好的活」靠的就是这段）。
        if name == "ability-centre":
            if not screen.get("companionReached"):
                problems.append("Tab 走不到同时开着的第二层")
            if not screen.get("afterCompanionInLayer"):
                problems.append("从第二层往前一步跑出了浮层")
        # 能力中心的初始焦点必须落在搜索框上：那一页的意义就是「用一句话找」。
        if name == "ability-centre" and (screen["activeAfterOpen"] or {}).get("id") != "cante-library-search":
            problems.append(f"初始焦点不在搜索框（在 {describe(screen['activeAfterOpen'])}）")
        # 关掉以后焦点要还给打开它的那个按钮，而不是掉到页面顶上。
        after = screen["activeAfterClose"] or {}
        if after.get("tag") == "body" or after.get("inLayer") or entry_text(name) not in (after.get("label") or ""):
            problems.append(f"关掉后焦点没有还给打开它的按钮（在 {describe(after)}）")
        path = " → ".join((item["label"] or item["tag"])[:12] for item in stops[:5])
        print(f"dom-smoke: keyboard probe: {name}: 12 Tab + 3 Shift+Tab 都留在浮层里，Esc 能关掉")
        print(
            "  | 打开时焦点："
            + describe(screen["activeAfterOpen"])
            + f"；层里能按的有 {size} 处；Tab 走过 {distinct} 处："
            + path
            + " …；关掉后焦点："
            + describe(after)
        )
        if problems:
            print(f"dom-smoke: keyboard probe: {name}: " + "；".join(problems), file=sys.stderr)
            exit_code = 1

if exit_code:
    sys.exit(exit_code)
print("dom-smoke: OK — every screen rendered, and the keyboard walk stayed inside")
PY
