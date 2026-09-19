#!/usr/bin/env python3
"""显示缩放（125%/150%）下的版面测量 —— #197 第一条的取证。

为什么要有这个：我们的字号地板（正文 >=16px、标题 >=20px、按钮 >=44px）是在
**CSS px** 上量的，而 dom-smoke.sh 只跑两个**窗口尺寸**，从没跑过**缩放**。
Windows 在 1080p 以上的笔记本上默认就开 125%，所以这是王姐最可能撞上的环境。

它做什么：用无头 Chrome 的 CDP Emulation.setDeviceMetricsOverride 把 CSS 视口
设成「物理屏幕 / 缩放」的真实结果，逐场景量：字号、按钮可点高度、横向滚动、
有没有**真的够不着**的控件（把「在可滚动区域下面」与「真的够不着」分开算）、
以及底部固定输入区吃掉了多少高度。

跑法：
    cd gui && bun install && bun run build:web
    python3 gui/scripts/zoom/driver.py            # -> raw.json
    python3 gui/scripts/zoom/driver_flagonly.py   # 验证开关本身不改变布局

注意：--force-device-scale-factor 在无头 Chrome 里**不改 CSS 视口**（只改截图缩放），
所以这里用 CDP 指标覆盖，并**分别**对「最大化」与「默认窗口」两种真实情况建模。
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
ROOT = "/private/tmp/r27-zoom/gui/dist"
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
