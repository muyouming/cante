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
# It renders FOUR things:
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
#   4. the home screen at TWO window sizes (r24): 1180×760 and 800×560, with a
#      layout probe that measures where things actually landed. App.tsx claims
#      "usable at 800×560"; that claim used to be nobody's job to check. The
#      probe clicks the history, privacy, ability-centre and results layers open,
#      and reports which interactive things are unreachable (off the side, cut by
#      an overflow-hidden box, or below the fold with nothing to scroll), whether
#      the sentence box is really typeable, and whether the cards can be scrolled
#      to. Note the measured viewport is ~87px SHORTER than --window-size in
#      headless Chrome (it reserves a toolbar), so the 800×560 run is checked at
#      about 800×473 — stricter than the contract, never looser.
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
# 0 = let the kernel pick a free port; serve.py writes the real one to
# $WORK/port. The old fixed 8099 was shared by every worktree on a machine, so
# two agents running the smoke at once silently attached to each other's server
# — and a worktree whose serve.py predates a probe flag then produced
# "no report" (#154). Set PORT=… only if you need a known port; if it is taken
# this script now stops instead of testing somebody else's build.
PORT="${PORT:-0}"

WORK="$(mktemp -d)"
SERVER_PID=""
KEEP_WORK=0

cleanup() {
  if [ -n "$SERVER_PID" ]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true   # silence bash's "Terminated" report
  fi
  if [ "$KEEP_WORK" = "1" ]; then
    echo "dom-smoke: artifacts kept in $WORK" >&2
  else
    rm -rf "$WORK"
  fi
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

root, port, portfile, probe, layout, firstrun = (
    sys.argv[1],
    int(sys.argv[2]),
    sys.argv[3],
    sys.argv[4],
    sys.argv[5],
    sys.argv[6],
)


def injected(query):
    flags = []
    if "provisioned=1" in query:
        flags.append("<script>window.__CANTE_PROVISIONED__=true;</script>")
    for flag, path in (("probe=1", probe), ("layout=1", layout), ("firstrun=1", firstrun)):
        if flag in query:
            with open(path, encoding="utf-8") as handle:
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


# Threaded: Chrome opens several sockets at once (the document, the bundle, a
# speculative preconnect). A single-threaded server serves them one at a time,
# and a preconnect that never sends a request can stall the queue behind it.
class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


with Server(("127.0.0.1", port), Handler) as httpd:
    # With port 0 the kernel picks one; write it down so the shell can read it.
    with open(portfile, "w") as handle:
        handle.write(str(httpd.server_address[1]))
    httpd.serve_forever()
PY

echo "==> serving $APP_DIR/dist (requested PORT=$PORT; 0 = let the kernel choose)"
python3 "$WORK/serve.py" "$APP_DIR/dist" "$PORT" "$WORK/port" \
  "$WORK/probe.js" "$WORK/layout.js" "$WORK/firstrun.js" \
  >"$WORK/server.out" 2>"$WORK/server.err" &
SERVER_PID=$!

# Wait for the server to write down the port it bound, and fail loudly if it
# never comes up: the old script sent the bind error to /dev/null and then ran
# every dump against whichever server already held the port.
for _ in $(seq 1 100); do
  [ -s "$WORK/port" ] && break
  kill -0 "$SERVER_PID" 2>/dev/null || break
  sleep 0.1
done
if [ ! -s "$WORK/port" ]; then
  echo "dom-smoke: the local server did not come up (PORT=$PORT). Its output was:" >&2
  sed 's/^/  | /' "$WORK/server.err" >&2 || true
  echo "dom-smoke: leave PORT unset to let the kernel pick a free port (a fixed port can be held by another worktree)." >&2
  exit 2
fi
PORT="$(cat "$WORK/port")"
echo "==> serving $APP_DIR/dist on 127.0.0.1:$PORT"

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

# The layout probe (r24). Same idea as the keyboard probe — a plain script in a
# real page, no test-only hook in the app — but it measures instead of pressing
# keys. It writes raw geometry facts as JSON into <pre id="layout-report"> and
# decides nothing: the assertions live in the python below, so a failure message
# can say what the product needs ("a card is cut off") rather than "rect moved".
#
# What it does, in order:
#   * reads the measured viewport (innerWidth/innerHeight) — the honest number,
#     not the --window-size we asked for;
#   * walks every visible, enabled control and classifies where it is. Below the
#     fold inside something scrollable is fine (she can scroll); off the side,
#     cut by an overflow-hidden box, or below the fold with nothing to scroll is
#     a real "she cannot get to it";
#   * scrolls the task-card list to the first and the last card and checks each
#     one can be brought fully on screen;
#   * focuses the sentence box, types a sentence through a real input event, and
#     reads back whether the text stayed;
#   * opens the history panel, the privacy panel, the ability centre and the
#     results panel for real, measures the close/back button and the search box,
#     runs the same unreachable-control scan inside each layer, and closes it.
# Everything is restored, so the DOM this dump leaves behind is still the home
# screen and the text assertions above still read it.
cat > "$WORK/layout.js" <<'JS'
(function () {
  var out = {
    error: null,
    viewport: null,
    home: {},
    history: {},
    privacy: {},
    library: {},
    results: {},
  };

  function label(el) {
    if (!el || !el.tagName) return null;
    var text = el.getAttribute("aria-label") || el.textContent || "";
    return text.replace(/\s+/g, " ").trim().slice(0, 28);
  }

  function round(rect) {
    return {
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      w: Math.round(rect.width),
      h: Math.round(rect.height),
    };
  }

  function byText(text, scope) {
    var list = Array.prototype.slice.call((scope || document).querySelectorAll("button"));
    for (var i = 0; i < list.length; i++) {
      if ((list[i].textContent || "").indexOf(text) >= 0) return list[i];
    }
    return null;
  }

  // Rendered at all? getClientRects() is empty for display:none, and Chrome
  // keeps laid-out boxes for `visibility:hidden`, so the computed style is read
  // too.
  function shown(el) {
    if (!el || el.getClientRects().length === 0) return false;
    var style = getComputedStyle(el);
    return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
  }

  function controls(scope) {
    var list = Array.prototype.slice.call(
      (scope || document).querySelectorAll(
        'a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"])',
      ),
    );
    return list.filter(function (el) {
      return shown(el) && !el.disabled;
    });
  }

  function insideViewport(el) {
    var r = el.getBoundingClientRect();
    return (
      r.left >= -1 && r.top >= -1 && r.right <= window.innerWidth + 1 && r.bottom <= window.innerHeight + 1
    );
  }

  function coversViewport(el) {
    var r = el.getBoundingClientRect();
    return (
      r.left <= 1 && r.top <= 1 && r.right >= window.innerWidth - 1 && r.bottom >= window.innerHeight - 1
    );
  }

  // The nearest ancestor she can scroll inside, or null. Only counts when there
  // is more content than fit — a box that happens to be overflow:auto but has
  // nothing to scroll does not make anything reachable.
  function scrollerIn(el, scope) {
    for (var p = el.parentElement; p; p = p.parentElement) {
      var style = getComputedStyle(p);
      if (
        (style.overflowY === "auto" || style.overflowY === "scroll") &&
        p.scrollHeight > p.clientHeight + 1
      ) {
        return p;
      }
      if (p === scope) break;
    }
    return null;
  }

  // Cut off by a box that clips and cannot be scrolled: the control is painted
  // outside a hidden-overflow ancestor. The ancestor has to actually have
  // clipped content (its scroll size exceeds its client size); otherwise the
  // overflow-hidden shell (App.tsx's root, the full-screen layers) would be
  // blamed for ordinary scrolling content, which is a false alarm.
  function cutByHiddenBox(el, scope) {
    var r = el.getBoundingClientRect();
    for (var p = el.parentElement; p; p = p.parentElement) {
      var style = getComputedStyle(p);
      var clips = /hidden|clip/.test(style.overflow + " " + style.overflowX + " " + style.overflowY);
      var scrolls = /(auto|scroll)/.test(style.overflowX + " " + style.overflowY);
      var clippedContent = p.scrollHeight > p.clientHeight + 1 || p.scrollWidth > p.clientWidth + 1;
      if (clips && !scrolls && clippedContent) {
        var box = p.getBoundingClientRect();
        if (
          r.left < box.left - 1 ||
          r.top < box.top - 1 ||
          r.right > box.right + 1 ||
          r.bottom > box.bottom + 1
        ) {
          return (p.className || p.tagName).toString().slice(0, 60);
        }
      }
      if (p === scope) break;
    }
    return null;
  }

  // Text that does not fit its own box. Reported, never asserted: the `truncate`
  // class (long task titles, file names) is deliberate, and pure geometry cannot
  // tell a deliberate ellipsis from text that got cut. A reviewer reads the number;
  // a real cut still shows up as a card that cannot be reached.
  function textWiderThanBox(scope) {
    var list = Array.prototype.slice.call(
      (scope || document).querySelectorAll("p,span,h1,h2,h3,li,label,dt,dd"),
    );
    var count = 0;
    for (var i = 0; i < list.length; i++) {
      if (shown(list[i]) && list[i].scrollWidth > list[i].clientWidth + 1) count += 1;
    }
    return count;
  }

  // “Can she get to it?” — the only question this file asks about geometry.
  function reachability(scope) {
    var vw = window.innerWidth;
    var vh = window.innerHeight;
    var list = controls(scope);
    var problems = [];
    var belowFold = 0;
    for (var i = 0; i < list.length; i++) {
      var el = list[i];
      var r = el.getBoundingClientRect();
      var what = label(el);
      if (r.width < 1 || r.height < 1) {
        problems.push({ why: "zero-size", what: what });
        continue;
      }
      if (r.left < -1 || r.right > vw + 1) {
        problems.push({ why: "off-screen-x", what: what, rect: round(r), viewportW: vw });
        continue;
      }
      var cut = cutByHiddenBox(el, scope);
      if (cut) {
        problems.push({ why: "cut-by-hidden-box", what: what, rect: round(r), box: cut });
        continue;
      }
      if (r.top < -1 || r.bottom > vh + 1) {
        if (scrollerIn(el, scope)) belowFold += 1;
        else problems.push({ why: "off-screen-y-no-scroll", what: what, rect: round(r), viewportH: vh });
      }
    }
    return {
      checked: list.length,
      problems: problems,
      belowFoldInScroll: belowFold,
      textWiderThanBox: textWiderThanBox(scope),
    };
  }

  function visibleInScroller(sc, el) {
    var r = el.getBoundingClientRect();
    var sr = sc.getBoundingClientRect();
    return r.left >= sr.left - 1 && r.right <= sr.right + 1 && r.top >= sr.top - 1 && r.bottom <= sr.bottom + 1;
  }

  function scrollTo(sc, el, alignEnd) {
    var r = el.getBoundingClientRect();
    var sr = sc.getBoundingClientRect();
    var delta = alignEnd ? r.bottom - sr.bottom : r.top - sr.top;
    sc.scrollTop = Math.max(0, sc.scrollTop + delta);
  }

  function probeHome() {
    // TaskCard is the only button on the home screen with an aria-label, and that
    // label is "title。example" — so the count here is the number of cards, not a
    // number copied out of the catalogue.
    var cards = Array.prototype.slice
      .call(document.querySelectorAll("button[aria-label]"))
      .filter(function (b) {
        return (b.getAttribute("aria-label") || "").indexOf("。") >= 0;
      });
    var scroller = cards.length ? scrollerIn(cards[0], document) : null;
    var home = {
      cards: cards.length,
      scroller: scroller ? { clientH: scroller.clientHeight, scrollH: scroller.scrollHeight } : null,
      firstCard: cards.length ? round(cards[0].getBoundingClientRect()) : null,
      firstCardReachable: false,
      lastCardReachable: false,
      libraryEntryCount: null,
      reachability: reachability(document),
      input: {},
    };
    var entry = byText("看看能做什么");
    if (entry) {
      var match = /共\s*(\d+)\s*项/.exec(entry.textContent || "");
      if (match) home.libraryEntryCount = parseInt(match[1], 10);
    }
    if (cards.length) {
      var first = cards[0];
      var last = cards[cards.length - 1];
      if (scroller) {
        var keep = scroller.scrollTop;
        scrollTo(scroller, first, false);
        home.firstCardReachable = visibleInScroller(scroller, first);
        scroller.scrollTop = scroller.scrollHeight;
        home.lastCardReachable = visibleInScroller(scroller, last);
        scroller.scrollTop = keep;
      } else {
        home.firstCardReachable = insideViewport(first);
        home.lastCardReachable = insideViewport(last);
      }
    }
    var input = document.getElementById("cante-say");
    if (!input) {
      home.input = { found: false };
    } else {
      input.focus();
      var focused = document.activeElement === input;
      var sentence = "把上个月的表格汇总一下";
      input.value = sentence;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      home.input = {
        found: true,
        rect: round(input.getBoundingClientRect()),
        inView: insideViewport(input),
        focusable: focused,
        typedKept: input.value === sentence,
        tallEnough: input.getBoundingClientRect().height >= 44,
      };
      input.value = "";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
    out.home = home;
  }

  // The history and privacy layers live in App.tsx: a full-screen box with a
  // "返回" button at the top and a scroll area under it. They carry no
  // role="dialog", so the back button is how they are found.
  async function probeAppPanel(entryText) {
    var record = { opened: false };
    var entry = byText(entryText);
    if (!entry) return record;
    entry.focus();
    entry.click();
    await null; // the layer renders and its focus layer lands the focus
    var back = byText("返回");
    if (!back) return record;
    record.opened = true;
    var panel = back.parentElement;
    record.backInView = insideViewport(back);
    record.coversViewport = !!panel && coversViewport(panel);
    record.switches = panel ? panel.querySelectorAll('[role="switch"]').length : 0;
    record.reachability = reachability(panel || document);
    back.click();
    await null;
    record.closed = !byText("返回");
    return record;
  }

  // The ability centre and the results panel are real dialogs (role="dialog"),
  // and both close with a "回到首页" button.
  async function probeDialog(entryText, searchId) {
    var record = { opened: false };
    var entry = byText(entryText);
    if (!entry) return record;
    entry.focus();
    entry.click();
    await null; // the dialog renders and its focus layer lands the focus
    var dialog = document.querySelector('[role="dialog"]');
    if (!dialog) return record;
    record.opened = true;
    record.coversViewport = coversViewport(dialog);
    var close = byText("回到首页", dialog);
    record.closeInView = !!close && insideViewport(close);
    if (searchId) {
      var search = dialog.querySelector("#" + searchId);
      record.searchInView = !!search && insideViewport(search);
      record.searchFocused = document.activeElement === search;
    }
    record.reachability = reachability(dialog);
    if (close) close.click();
    await null;
    record.closed = !document.querySelector('[role="dialog"]');
    return record;
  }

  window.addEventListener("load", function () {
    void (async function () {
      try {
        out.viewport = {
          innerW: window.innerWidth,
          innerH: window.innerHeight,
          dpr: window.devicePixelRatio,
          clientW: document.documentElement.clientWidth,
          clientH: document.documentElement.clientHeight,
        };
        await null; // let Solid's first paint settle before measuring
        probeHome();
        out.history = await probeAppPanel("历史");
        out.privacy = await probeAppPanel("隐私");
        out.library = await probeDialog("看看能做什么", "cante-library-search");
        out.results = await probeDialog("打开我做的结果");
      } catch (error) {
        out.error = String((error && error.stack) || error);
      }
      var pre = document.createElement("pre");
      pre.id = "layout-report";
      pre.textContent = JSON.stringify(out);
      document.body.appendChild(pre);
    })();
  });
})();
JS

# The first-run probe (r24/F7). Unlike the two above, it *drives* the wizard:
# welcome → 先看看界面 (there is no desktop bridge in a plain browser, so the
# check step can only be skipped) → it measures the last step's layout → it
# clicks one example → 开始使用 → it reads back #cante-say. That last read is
# the only place where “点一下例子真的填进框里” is observed in a real browser;
# the unit test only scans the source for the wiring.
#
# It also records the last-step geometry: after F1 the outer box is top-aligned
# with an m-auto inner box, so the title must not sit above the viewport on a
# scroll area that cannot reach it (that was the 800×560 regression).
#
# It is a plain script in a real page and writes facts, not verdicts, into
# <pre id="firstrun-report"> — the assertions live in the python below.
cat > "$WORK/firstrun.js" <<'JS'
(function () {
  var out = {
    error: null,
    steps: [],
    example: null,
    stored: null,
    homeValue: null,
    homeTitleSeen: false,
    keyAfter: null,
    layout: { viewportH: null, h1: null, contentH: null, scroller: null },
  };

  function byText(text, scope) {
    var list = Array.prototype.slice.call((scope || document).querySelectorAll("button"));
    for (var i = 0; i < list.length; i++) {
      if ((list[i].textContent || "").indexOf(text) >= 0) return list[i];
    }
    return null;
  }

  function byExactText(text, selector) {
    var list = Array.prototype.slice.call(document.querySelectorAll(selector));
    for (var i = 0; i < list.length; i++) {
      if ((list[i].textContent || "").trim() === text) return list[i];
    }
    return null;
  }

  function click(el, name) {
    if (!el) {
      out.steps.push(name + ":missing");
      return false;
    }
    // Focus before click: a real mouse press lands the focus on the button too.
    el.focus();
    el.click();
    out.steps.push(name + ":clicked");
    return true;
  }

  function round(rect) {
    return {
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      w: Math.round(rect.width),
      h: Math.round(rect.height),
    };
  }

  async function settle(times) {
    // Solid's effects run as microtasks; no timers, because --dump-dom may run
    // before one fires (same rule as the other probes).
    for (var i = 0; i < (times || 4); i++) await null;
  }

  function measureLastStep() {
    var h1 = byExactText("开始之前，先记住三件事", "h1");
    var scroller = null;
    for (var p = h1 && h1.parentElement; p; p = p.parentElement) {
      var style = getComputedStyle(p);
      if (style.overflowY === "auto" || style.overflowY === "scroll") {
        scroller = p;
        break;
      }
    }
    var inner = h1 && h1.closest("div.m-auto");
    out.layout = {
      viewportH: window.innerHeight,
      h1: h1 ? round(h1.getBoundingClientRect()) : null,
      contentH: inner ? Math.round(inner.getBoundingClientRect().height) : null,
      scroller: scroller
        ? {
            clientH: scroller.clientHeight,
            scrollH: scroller.scrollHeight,
            scrollTop: Math.round(scroller.scrollTop),
          }
        : null,
    };
  }

  window.addEventListener("load", function () {
    void (async function () {
      try {
        await settle();
        click(byText("开始检查"), "welcome");
        await settle();
        click(byText("先看看界面"), "skip");
        await settle();
        measureLastStep();
        var example = byText("帮我把微信里那些接龙整理成一张表");
        out.example = example ? "帮我把微信里那些接龙整理成一张表" : null;
        click(example, "pick-example");
        out.stored =
          typeof localStorage !== "undefined"
            ? localStorage.getItem("cante:first-run:sentence")
            : null;
        await settle();
        click(byText("开始使用"), "start");
        await settle(8);
        var box = document.getElementById("cante-say");
        out.homeValue = box ? box.value : null;
        out.homeTitleSeen = !!byText("看看能做什么");
        out.keyAfter =
          typeof localStorage !== "undefined"
            ? localStorage.getItem("cante:first-run:sentence")
            : null;
      } catch (error) {
        out.error = String((error && error.stack) || error);
      }
      var pre = document.createElement("pre");
      pre.id = "firstrun-report";
      pre.textContent = JSON.stringify(out);
      document.body.appendChild(pre);
    })();
  });
})();
JS

# `$1` url path, `$2` output file, `$3` chrome profile tag, `$4` --window-size.
# No --virtual-time-budget: the app keeps a reconcile interval alive, so virtual
# time never settles and Chrome hangs. --dump-dom after load is enough — Solid
# renders during module evaluation, and both probes await their microtasks before
# writing their report.
#
# Note --window-size is the WINDOW, and headless Chrome's window keeps a toolbar
# (~87px tall when re-measured on macOS), so the page gets a shorter viewport
# than the number asked for. The probes report the measured viewport, and the
# checker asserts against that: the 800×560 window is checked at roughly
# 800×473, i.e. never a looser claim than the contract.
#
# Chrome writes the serialized document in one go and then stays alive (the app
# keeps an interval running, so it never reaches "idle"). Wait for the condition
# that means the dump is complete — the document ends with `</html>` — instead
# of sleeping a fixed 40s and hoping; `DUMP_TIMEOUT` is the ceiling for the case
# where it never shows up at all. Chrome's stderr and the timing go to disk so a
# failure can be read without another run.
DUMP_LOG="$WORK/dump-log.txt"
dump() {
  local url="$1" out="$2" tag="$3" size="$4"
  local start=$SECONDS timed_out=yes
  : > "$out"
  "$CHROME" --headless=new --disable-gpu --no-first-run \
    --user-data-dir="$WORK/chrome-$tag" --window-size="$size" \
    --dump-dom "http://127.0.0.1:$PORT$url" \
    > "$out" 2>"$WORK/chrome-$tag.stderr" &
  local pid=$!
  local deadline=$((SECONDS + ${DUMP_TIMEOUT:-60}))
  while kill -0 "$pid" 2>/dev/null; do
    if [ -s "$out" ] && tail -c 32 "$out" | tr -d '[:space:]' | grep -q '</html>$'; then
      timed_out=no
      break
    fi
    [ "$SECONDS" -ge "$deadline" ] && break
    sleep 0.2
  done
  kill -0 "$pid" 2>/dev/null || timed_out=no
  kill -9 "$pid" 2>/dev/null || true
  local rc=0
  wait "$pid" 2>/dev/null || rc=$?
  printf '%s\t%s\twindow=%s\tseconds=%s\ttimed_out=%s\trc=%s\tbytes=%s\n' \
    "$tag" "$url" "$size" "$((SECONDS - start))" "$timed_out" "$rc" \
    "$(wc -c < "$out" | tr -d ' ')" >> "$DUMP_LOG"
}

echo "==> dumping the first-run DOM"
dump "/" "$WORK/dom-first-run.html" first-run "1180,760"

echo "==> dumping the provisioned DOM (home screen, 1180×760)"
dump "/?provisioned=1&layout=1" "$WORK/dom-home.html" home "1180,760"

echo "==> dumping the keyboard probe DOM (Tab / Shift+Tab / Escape)"
dump "/?provisioned=1&probe=1" "$WORK/dom-probe.html" probe "1180,760"

echo "==> dumping the home screen in a small window (800×560)"
dump "/?provisioned=1&layout=1" "$WORK/dom-home-small.html" home-small "800,560"

echo "==> driving the first-run wizard to its last step (1180×760)"
dump "/?firstrun=1" "$WORK/dom-firstrun-large.html" firstrun-large "1180,760"

echo "==> driving the first-run wizard to its last step (800×560)"
dump "/?firstrun=1" "$WORK/dom-firstrun-small.html" firstrun-small "800,560"

exit_code=0
python3 - "$WORK/dom-first-run.html" "$WORK/dom-home.html" "$WORK/dom-probe.html" <<'PY' || exit_code=1
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
print("dom-smoke: screens rendered, keyboard walk stayed inside")
PY

# ---- r24：小窗口 / 缩放下的布局核对 ----------------------------------------
#
# App.tsx 的注释里写着一条契约：800×560 也还能用。这条契约以前没人验。这里把两个
# 窗口尺寸下的真实测量结果拿来做断言，标准就是「她够不够得着」：
#   * 卡片在（数量不是 0，而且真能滚到第一张和最后一张）；
#   * 输入框在视野里、能点、能打字；
#   * 历史 / 隐私 / 能力中心 / 我做的结果都能打开、关掉，而且关掉的按钮在视野里；
#   * 没有任何一个可见的控件是被裁掉的（屏幕外、被 overflow:hidden 的盒子切掉、
#     或者掉在视野下面而又没地方能滚）。
# 「在可滚动区域下面」不算问题：她能滚下去。这条区分是这个检查不变成噪音的关键。
python3 - "$WORK/dom-home.html" 1180 760 "$WORK/dom-home-small.html" 800 560 <<'PY' || exit_code=1
import html, json, re, sys


def load(path):
    dom = open(path, encoding="utf-8", errors="replace").read()
    if len(dom) < 500:
        return None, f"Chrome produced no DOM ({len(dom)} bytes)"
    blob = re.search(r'<pre id="layout-report">(.*?)</pre>', dom, flags=re.S)
    if not blob:
        return None, "no layout report — 探针没跑出来"
    try:
        return json.loads(html.unescape(blob.group(1))), None
    except ValueError as error:
        return None, f"layout report is not JSON ({error})"


def describe(problem):
    why = problem.get("why")
    what = problem.get("what") or "(unlabelled)"
    rect = problem.get("rect") or {}
    if why == "off-screen-x":
        right = rect.get("x", 0) + rect.get("w", 0)
        return f"{what}: off the side (x={rect.get('x')}..{right}, the window is {problem.get('viewportW')} wide)"
    if why == "off-screen-y-no-scroll":
        return f"{what}: below the bottom (y={rect.get('y')}, the window is {problem.get('viewportH')} tall) with nothing to scroll"
    if why == "cut-by-hidden-box":
        return f"{what}: cut off by a box that cannot scroll ({problem.get('box')})"
    return f"{what}: {why}"


def unreachable(record, name, problems):
    scan = (record or {}).get("reachability") or {}
    for problem in scan.get("problems", []):
        problems.append(f"{name}: " + describe(problem))
    return scan


SOURCES = [
    (sys.argv[1], int(sys.argv[2]), int(sys.argv[3])),
    (sys.argv[4], int(sys.argv[5]), int(sys.argv[6])),
]

failed = 0
for path, win_w, win_h in SOURCES:
    label = f"layout {win_w}×{win_h} window"
    report, error = load(path)
    if error:
        print(f"dom-smoke: {label}: {error}", file=sys.stderr)
        failed = 1
        continue

    problems = []

    def need(ok, message, bucket=problems):
        if not ok:
            bucket.append(message)

    if report.get("error"):
        problems.append("the probe threw: " + str(report["error"]).splitlines()[0])

    viewport = report.get("viewport") or {}
    inner_w = viewport.get("innerW", 0)
    inner_h = viewport.get("innerH", 0)
    # 先证明 --window-size 真的生效了：否则两条记录量的是同一个视口，这个文件就
    # 变成了一个什么都不验的绿灯。headless 的窗口带工具栏，量到的视口比窗口矮。
    if win_w >= 1100:
        need(
            inner_w >= 1100,
            f"the viewport is only {inner_w}px wide — --window-size did not take effect, so this run proves nothing",
        )
    else:
        need(
            inner_w <= win_w and inner_h <= win_h,
            f"the viewport is {inner_w}×{inner_h}, not at or below the {win_w}×{win_h} window",
        )

    home = report.get("home") or {}
    cards = home.get("cards", 0)
    need(cards >= 20, f"only {cards} task card(s) rendered")
    need(home.get("firstCardReachable") is True, "the first card could not be scrolled fully onto the screen")
    need(home.get("lastCardReachable") is True, "the last card could not be scrolled fully onto the screen")
    entry_count = home.get("libraryEntryCount")
    if entry_count is not None:
        need(
            entry_count == cards,
            f"the home screen advertises {entry_count} tasks but {cards} cards are rendered",
        )
    box = home.get("input") or {}
    need(box.get("found") is True, "the sentence box is not on the home screen")
    need(box.get("inView") is True, "the sentence box is outside the viewport")
    need(box.get("focusable") is True, "the sentence box did not take the focus")
    need(box.get("typedKept") is True, "typing into the sentence box did not stick")
    need(box.get("tallEnough") is True, "the sentence box is under 44px tall")

    home_scan = unreachable(home, "home screen", problems)

    layers = [
        ("history", "历史", True, False, False),
        ("privacy", "隐私", True, False, True),
        ("library", "能力中心", False, True, False),
        ("results", "我做的结果", False, True, False),
    ]
    for key, name, is_panel, is_dialog, wants_switch in layers:
        layer = report.get(key) or {}
        need(layer.get("opened") is True, f"the {name} layer did not open")
        need(layer.get("coversViewport") is True, f"the {name} layer does not cover the window")
        if is_panel:
            need(layer.get("backInView") is True, f"the 返回 button of the {name} layer is outside the viewport")
        if is_dialog:
            need(layer.get("closeInView") is True, f"the 回到首页 button of the {name} layer is outside the viewport")
        need(layer.get("closed") is True, f"the {name} layer did not close again")
        if wants_switch:
            need(layer.get("switches", 0) >= 1, f"the {name} layer rendered no switch")
        unreachable(layer, name, problems)

    library = report.get("library") or {}
    need(library.get("searchInView") is True, "the ability centre search box is outside the viewport")
    need(library.get("searchFocused") is True, "the ability centre did not put the focus on its search box")

    layer_ok = all(
        (report.get(key) or {}).get("opened") is True and (report.get(key) or {}).get("closed") is True
        for key, *_ in layers
    )
    yes = lambda value: "yes" if value else "NO"
    # 这条摘要只说量到的事实：断言失败时它不会先说一句“可以”，再说“其实不行”。
    print(
        f"dom-smoke: {label}: viewport {inner_w}×{inner_h}; cards {cards}; "
        f"scrolls to first/last card {yes(home.get('firstCardReachable') is True)}/{yes(home.get('lastCardReachable') is True)}; "
        f"sentence box in view {yes(box.get('inView') is True)}, typeable {yes(box.get('typedKept') is True)}; "
        f"history/privacy/ability-centre/results open+close {yes(layer_ok)}; "
        f"{home_scan.get('checked', 0)} controls checked, "
        f"{home_scan.get('belowFoldInScroll', 0)} below the fold but reachable, "
        f"{home_scan.get('textWiderThanBox', 0)} text boxes wider than their box "
        f"(reported, not asserted: 省略号是有意的)"
    )
    if problems:
        for problem in problems:
            print(f"dom-smoke: {label}: {problem}", file=sys.stderr)
        failed = 1

if failed:
    sys.exit(1)
PY

# ---- r24/F7：向导最后一步真的驱动一遍（点例子 → 首页框里有字） -----------------
#
# 之前 dom-smoke 只 dump 了向导第 1 步，「点一下例子真的填进框里」只有源码扫描。
# 这里注入一个普通脚本，真的点 welcome → 先看看界面 → 量最后一步布局 → 点例子
# → 开始使用，然后读回 #cante-say。两个窗口尺寸都跑，和上面那条约定一样。
#
# 顺带把 F1 钉住：内容比视口高时，标题不能被裁到视口上面、也不能有一段永远滚不到。
python3 - "$WORK/dom-firstrun-large.html" "$WORK/dom-firstrun-small.html" <<'PY' || exit_code=1
import html, json, re, sys

failed = 0
for path in sys.argv[1:]:
    label = "first-run wizard (driven)"
    dom = open(path, encoding="utf-8", errors="replace").read()
    if len(dom) < 500:
        print(f"dom-smoke: {label}: Chrome produced no DOM ({len(dom)} bytes)", file=sys.stderr)
        failed = 1
        continue
    blob = re.search(r'<pre id="firstrun-report">(.*?)</pre>', dom, flags=re.S)
    if not blob:
        print(f"dom-smoke: {label}: no report (探针没跑出来)", file=sys.stderr)
        failed = 1
        continue
    try:
        report = json.loads(html.unescape(blob.group(1)))
    except ValueError as error:
        print(f"dom-smoke: {label}: report is not JSON ({error})", file=sys.stderr)
        failed = 1
        continue
    if report.get("error"):
        print(f"dom-smoke: {label}: the probe threw: {report['error']}", file=sys.stderr)
        failed = 1
        continue

    steps = " → ".join(report.get("steps", []))
    layout = report.get("layout") or {}
    h1 = layout.get("h1")
    content_h = layout.get("contentH")
    scroller = layout.get("scroller") or {}
    problems = []
    if not report.get("example"):
        problems.append("最后一步没找到那条例子的按钮")
    if report.get("homeValue") != report.get("example"):
        problems.append(
            f"点例子并开始使用后，#cante-say 里的字是 {report.get('homeValue')!r}，"
            f"不是那条例子的原文 {report.get('example')!r}"
        )
    if not report.get("homeTitleSeen"):
        problems.append("点「开始使用」后没有进到首页")
    if report.get("keyAfter") is not None:
        problems.append("暂存键在首页取走后还留着（应该取走即清）")
    if not h1:
        problems.append("最后一步的标题没找到")
    elif h1.get("y", -999) < -1:
        problems.append(
            f"最后一步的标题被裁到视口上面（y={h1.get('y')}，视口高 {layout.get('viewportH')}），滚不回来"
        )
    if content_h and scroller and scroller.get("scrollH", 0) < content_h:
        problems.append(
            f"内容高 {content_h}px 但可滚区只有 {scroller.get('scrollH')}px：有一段永远滚不到"
        )

    h1_y = h1.get("y") if h1 else None
    print(f"dom-smoke: {label}: 走完 {steps}；框里读回 {report.get('homeValue')!r}")
    print(
        f"  | 最后一步布局：标题 y={h1_y}；视口高 {layout.get('viewportH')}；"
        f"内容高 {content_h}；可滚区 {scroller.get('clientH')}→{scroller.get('scrollH')}；"
        f"暂存值点后 {report.get('stored')!r}，首页取走后 {report.get('keyAfter')!r}"
    )
    if problems:
        for problem in problems:
            print(f"dom-smoke: {label}: {problem}", file=sys.stderr)
        failed = 1

if failed:
    sys.exit(1)
PY

if [ "$exit_code" -ne 0 ]; then
  # Leave enough behind that the next person does not need an A/B run: what each
  # dump weighed, whether it ended at all, whether its probe report was there,
  # and what the page said. A bare "no report" is not a diagnosis.
  echo "dom-smoke: --- raw evidence ---" >&2
  [ -f "$DUMP_LOG" ] && sed 's/^/  dump | /' "$DUMP_LOG" >&2
  python3 - "$WORK" <<'PY' >&2 || true
import html, os, re, sys

work = sys.argv[1]
FILES = [
    ("dom-first-run.html", "first run (wizard)", None),
    ("dom-home.html", "home 1180×760", "layout-report"),
    ("dom-probe.html", "keyboard probe", "probe-report"),
    ("dom-home-small.html", "home 800×560", "layout-report"),
    ("dom-firstrun-large.html", "wizard driven 1180×760", "firstrun-report"),
    ("dom-firstrun-small.html", "wizard driven 800×560", "firstrun-report"),
]
for name, label, report_id in FILES:
    path = os.path.join(work, name)
    if not os.path.exists(path):
        print(f"  {label}: no dump file ({name})")
        continue
    raw = open(path, encoding="utf-8", errors="replace").read()
    ended = raw.rstrip().endswith("</html>")
    has_report = report_id is not None and f'id="{report_id}"' in raw
    error_page = bool(re.search(r"ERR_[A-Z_]+|neterror|This site can.?t be reached", raw))
    body = re.sub(r"<script.*?</script>", " ", raw, flags=re.S)
    text = html.unescape(re.sub(r"<[^>]+>", "\n", body))
    lines = [line.strip() for line in text.split("\n") if line.strip()]
    print(
        f"  {label}: {len(raw)} bytes; dump ended {ended}; probe report present {has_report}; "
        f"browser error page {error_page}; first text: " + " / ".join(lines[:6])
    )
    tag = name[len("dom-"):-len(".html")]
    err = os.path.join(work, f"chrome-{tag}.stderr")
    if os.path.exists(err):
        tail = [line for line in open(err, encoding="utf-8", errors="replace") if "ERROR" in line]
        if tail:
            print("    chrome stderr (last 3): " + " | ".join(line.strip()[:120] for line in tail[-3:]))
PY
  KEEP_WORK=1
  exit "$exit_code"
fi
echo "dom-smoke: OK — every screen rendered, the keyboard walk stayed inside, and both window sizes are usable"
