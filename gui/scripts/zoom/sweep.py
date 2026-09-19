#!/usr/bin/env python3
"""Focused sweep: where does long card text start to overflow its box, and where
does the layout fold (COMPACT_WIDTH=900, Tailwind sm=640)?

Not part of the main table; this only answers "is the 787px clip real and
stable?". Nothing here writes to the repository.
"""
import asyncio, json, os, shutil, subprocess, sys, tempfile, urllib.request
import websockets

CH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
ROOT = "/private/tmp/r27-zoom/gui/dist"
HERE = os.path.dirname(os.path.abspath(__file__))
PROBE = os.path.join(HERE, "probe.js")
WIDTHS = [960, 920, 900, 880, 820, 800, 787, 760]


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


async def measure(ws, mid, w, h, url):
    r = await cdp(ws, None, mid, "Target.createTarget", {"url": "about:blank"})
    tid = r["result"]["targetId"]
    a = await cdp(ws, None, mid, "Target.attachToTarget", {"targetId": tid, "flatten": True})
    sess = a["result"]["sessionId"]
    await cdp(ws, sess, mid, "Emulation.setDeviceMetricsOverride",
              {"width": w, "height": h, "deviceScaleFactor": 1.5, "mobile": False})
    await cdp(ws, sess, mid, "Page.enable")
    await cdp(ws, sess, mid, "Page.navigate", {"url": url})
    await asyncio.sleep(1.4)
    ev = await cdp(ws, sess, mid, "Runtime.evaluate", {
        "expression": "document.getElementById('zoom-report') ? document.getElementById('zoom-report').textContent : null",
        "returnByValue": True})
    val = ev.get("result", {}).get("result", {}).get("value")
    await cdp(ws, None, mid, "Target.closeTarget", {"targetId": tid})
    return json.loads(val) if val else None


async def main():
    port_file = os.path.join(tempfile.mkdtemp(prefix="zsrv3-"), "port")
    srv = subprocess.Popen([sys.executable, os.path.join(HERE, "serve.py"), ROOT, port_file, PROBE],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(100):
        if os.path.exists(port_file) and os.path.getsize(port_file):
            break
        await asyncio.sleep(0.1)
    port = open(port_file).read().strip()
    url = f"http://127.0.0.1:{port}/?provisioned=1&probe=1"
    ud = tempfile.mkdtemp(prefix="zchrome3-")
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
    out = {}
    try:
        async with websockets.connect(ver["webSocketDebuggerUrl"], max_size=8 * 1024 * 1024) as ws:
            mid = [0]
            for w in WIDTHS:
                rep = await measure(ws, mid, w, 700, url)
                if not rep:
                    continue
                hs = rep.get("horizontalScroll", {})
                cards = [e for e in rep.get("elements", []) if e.get("name") == "第一张任务卡（整块按钮）"]
                card = cards[0] if cards else {}
                clipped = hs.get("offenders", [])
                out[w] = {
                    "clipped": [(o["what"], o["scrollW"], o["clientW"]) for o in clipped],
                    "docOverflow": hs.get("documentOverflows"),
                    "cardW": card.get("width"),
                    "cardH": card.get("height"),
                }
                print(f"w={w:4d} cardW={card.get('width')} cardH={card.get('height')} "
                      f"clipped={len(clipped)} docOverflow={hs.get('documentOverflows')}", file=sys.stderr)
    finally:
        chrome.kill(); srv.kill(); shutil.rmtree(ud, ignore_errors=True)
    with open(os.path.join(HERE, "raw-sweep.json"), "w", encoding="utf-8") as h:
        json.dump(out, h, ensure_ascii=False, indent=2)
    print(json.dumps(out, ensure_ascii=False, indent=2))


asyncio.run(main())
