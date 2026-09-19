#!/usr/bin/env python3
"""How the existing UI behaves under Windows display scaling (100/125/150%).

WHAT SCALING ACTUALLY DOES (measured, not assumed -- see raw-flagonly.json):
  `--force-device-scale-factor` alone raises devicePixelRatio but does NOT shrink
  the CSS viewport. Windows scaling does not shrink a window's *logical* size
  either; it shrinks the *logical screen*. So the CSS viewport only shrinks when
  the window is maximized, or when the configured logical size no longer fits
  the screen (then Windows clamps it).

Each scenario below is therefore an explicit CSS viewport, derived from a real
Windows screen and scaling:

  screen (physical)  scaling  logical screen   maximized viewport   default window (1180x760 logical)
  1920x1080  (-40 taskbar)   100%   1920x1040   1920x1040            1180x760
  1920x1080  (-40 taskbar)   125%   1536x832    1536x832             1180x760 (fits)
  1920x1080  (-40 taskbar)   150%   1280x693    1280x693             1180x693 (height clamped)
  1366x768   (-40 taskbar)   125%   1093x582    1093x582             1093x582 (both clamped)
  1280x720   (-40 taskbar)   150%   853x480     853x480              853x480  (both clamped)

deviceScaleFactor in the CDP override is set to the scenario's scaling only so
the reported dpr is honest; it does not affect CSS layout.

Nothing here writes to the repository.
"""
import asyncio, json, os, shutil, subprocess, sys, tempfile, urllib.request
import websockets

CH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
ROOT = os.environ.get("ZOOM_ROOT", "/private/tmp/r27-zoom/gui/dist")
HERE = os.path.dirname(os.path.abspath(__file__))
PROBE = os.path.join(HERE, "probe.js")

# (group, label, css_w, css_h, dpr)
SCENARIOS = [
    # A. The default Tauri window (1180x760 logical) as scaling varies. Width
    #    stays usable while the screen can hold it; height is clamped when the
    #    logical screen gets shorter.
    ("default window (Tauri 1180x760 logical)", "1180x760 @100%", 1180, 760, 1.0),
    ("default window (Tauri 1180x760 logical)", "1180x760 @125%", 1180, 760, 1.25),
    ("default window (Tauri 1180x760 logical)", "1180x693 @150%", 1180, 693, 1.5),
    # B. Maximized on a 1080p+ Windows laptop -- the headline case.
    ("maximized, 1920x1080 laptop", "1920x1040 @100%", 1920, 1040, 1.0),
    ("maximized, 1920x1080 laptop", "1536x832 @125%", 1536, 832, 1.25),
    ("maximized, 1920x1080 laptop", "1280x693 @150%", 1280, 693, 1.5),
    # C. Smaller / lower-res Windows laptops -- where clamping bites hardest.
    ("small laptop 1366x768, maximized", "1093x582 @125%", 1093, 582, 1.25),
    ("small laptop 1366x768, maximized", "911x512 @150%", 911, 512, 1.5),
    ("small laptop 1280x800, maximized", "1024x640 @125%", 1024, 640, 1.25),
    ("small laptop 1280x720, maximized", "853x480 @150%", 853, 480, 1.5),
    # C2. The narrowest window the app allows (tauri.conf minWidth/minHeight),
    #     and the width at which long card text first showed a sub-pixel clip.
    ("narrowest allowed window", "760x520 @100%", 760, 520, 1.0),
    ("narrowest allowed window", "760x520 @150%", 760, 520, 1.5),
    # D. The app's own low-end contract, for reference.
    ("app contract (App.tsx)", "800x560 @100%", 800, 560, 1.0),
]


async def cdp(ws, session, mid, method, params=None):
    mid[0] += 1
    i = mid[0]
    msg = {"id": i, "method": method, "params": params or {}}
    if session:
        msg["sessionId"] = session
    await ws.send(json.dumps(msg))
    while True:
        m = json.loads(await ws.recv())
        if m.get("id") == i:
            return m


async def measure(ws, mid, css_w, css_h, dpr, url):
    r = await cdp(ws, None, mid, "Target.createTarget", {"url": "about:blank"})
    tid = r["result"]["targetId"]
    a = await cdp(ws, None, mid, "Target.attachToTarget", {"targetId": tid, "flatten": True})
    sess = a["result"]["sessionId"]
    await cdp(ws, sess, mid, "Emulation.setDeviceMetricsOverride",
              {"width": css_w, "height": css_h, "deviceScaleFactor": dpr, "mobile": False})
    await cdp(ws, sess, mid, "Page.enable")
    # 两面都要量 ✓：全新安装（没有历史轮次 -> 例子全展开）与**她做过一轮之后**
    # （-> 例子默认收起）。store.runs() 只在 init 时读一次 run_log，所以必须在
    # 页面加载**之前**把这个桥桩上（BridgeUnavailable 时 runs() 是空的 ✗）。
    if os.environ.get("ZOOM_STUB_RUNS"):
        n = int(os.environ["ZOOM_STUB_RUNS"])
        stub = (
            "window.__TAURI_INTERNALS__ = { invoke: function (cmd, args) {"
            "  if (cmd === 'run_log') { return Promise.resolve({ runs: Array.from({length: %d},"
            "    function (_, i) { return { id: 'run_' + i, state: 'done', files: [], result: [] }; }) }); }"
            "  return Promise.reject(new Error('not stubbed: ' + cmd)); },"
            "  transformCallback: function (cb) { return cb; } };"
            "window.__TAURI_INTERNALS__.metadata = { currentWebview: { label: 'main' },"
            "  currentWindow: { label: 'main' } };" % n)
        await cdp(ws, sess, mid, "Page.addScriptToEvaluateOnNewDocument", {"source": stub})
    await cdp(ws, sess, mid, "Page.navigate", {"url": url})
    await asyncio.sleep(1.8)
    ev = await cdp(ws, sess, mid, "Runtime.evaluate", {
        "expression": "document.getElementById('zoom-report') ? document.getElementById('zoom-report').textContent : null",
        "returnByValue": True})
    val = ev.get("result", {}).get("result", {}).get("value")
    await cdp(ws, None, mid, "Target.closeTarget", {"targetId": tid})
    return json.loads(val) if val else {"error": "no zoom-report", "raw": ev}


async def main():
    port_file = os.path.join(tempfile.mkdtemp(prefix="zsrv-"), "port")
    srv = subprocess.Popen([sys.executable, os.path.join(HERE, "serve.py"), ROOT, port_file, PROBE],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(100):
        if os.path.exists(port_file) and os.path.getsize(port_file):
            break
        await asyncio.sleep(0.1)
    port = open(port_file).read().strip()
    url = f"http://127.0.0.1:{port}/?provisioned=1&probe=1"

    ud = tempfile.mkdtemp(prefix="zchrome-")
    chrome = subprocess.Popen([CH, "--headless=new", "--disable-gpu", "--no-first-run",
                               f"--user-data-dir={ud}", "--remote-debugging-port=0", "about:blank"],
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    dport_file = os.path.join(ud, "DevToolsActivePort")
    for _ in range(150):
        if os.path.exists(dport_file) and os.path.getsize(dport_file):
            break
        await asyncio.sleep(0.1)
    dport = open(dport_file).read().splitlines()[0]
    ver = json.loads(urllib.request.urlopen(f"http://127.0.0.1:{dport}/json/version").read())

    results = {}
    try:
        async with websockets.connect(ver["webSocketDebuggerUrl"], max_size=8 * 1024 * 1024) as ws:
            mid = [0]
            for group, label, w, h, dpr in SCENARIOS:
                rep = await measure(ws, mid, w, h, dpr, url)
                key = f"{group} | {label}"
                results[key] = {"group": group, "label": label, "cssW": w, "cssH": h, "dpr": dpr, "report": rep}
                print(f"measured {key}", file=sys.stderr)
    finally:
        chrome.kill(); srv.kill(); shutil.rmtree(ud, ignore_errors=True)

    with open(os.path.join(HERE, "raw.json"), "w", encoding="utf-8") as h:
        json.dump(results, h, ensure_ascii=False, indent=2)
    print(json.dumps({k: f"{v['cssW']}x{v['cssH']}" for k, v in results.items()}, ensure_ascii=False, indent=2))
    print("raw ->", os.path.join(HERE, "raw.json"))


asyncio.run(main())
