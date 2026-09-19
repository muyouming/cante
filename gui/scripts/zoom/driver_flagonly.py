#!/usr/bin/env python3
"""Flag-only run via CDP: `--force-device-scale-factor` with NO metric override.

Isolates what the switch alone does to the real app. Nothing here writes to the
repository.
"""
import asyncio, json, os, shutil, subprocess, sys, tempfile, urllib.request
import websockets

CH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
ROOT = "/private/tmp/r27-zoom/gui/dist"
HERE = os.path.dirname(os.path.abspath(__file__))
PROBE = os.path.join(HERE, "probe.js")


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


async def main():
    out = {}
    for scale in ["1", "1.25", "1.5"]:
        port_file = os.path.join(tempfile.mkdtemp(prefix="zsrv2-"), "port")
        srv = subprocess.Popen([sys.executable, os.path.join(HERE, "serve.py"), ROOT, port_file, PROBE],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(100):
            if os.path.exists(port_file) and os.path.getsize(port_file):
                break
            await asyncio.sleep(0.1)
        port = open(port_file).read().strip()
        url = f"http://127.0.0.1:{port}/?provisioned=1&probe=1"
        ud = tempfile.mkdtemp(prefix="zchrome2-")
        chrome = subprocess.Popen([CH, "--headless=new", "--disable-gpu", "--no-first-run",
                                   f"--user-data-dir={ud}", "--remote-debugging-port=0",
                                   f"--force-device-scale-factor={scale}", "--window-size=1180,760",
                                   "about:blank"],
                                  stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        dport_file = os.path.join(ud, "DevToolsActivePort")
        for _ in range(150):
            if os.path.exists(dport_file) and os.path.getsize(dport_file):
                break
            await asyncio.sleep(0.1)
        dport = open(dport_file).read().splitlines()[0]
        ver = json.loads(urllib.request.urlopen(f"http://127.0.0.1:{dport}/json/version").read())
        rep = {"error": "unset"}
        try:
            async with websockets.connect(ver["webSocketDebuggerUrl"], max_size=8 * 1024 * 1024) as ws:
                mid = [0]
                r = await cdp(ws, None, mid, "Target.createTarget", {"url": "about:blank"})
                tid = r["result"]["targetId"]
                a = await cdp(ws, None, mid, "Target.attachToTarget", {"targetId": tid, "flatten": True})
                sess = a["result"]["sessionId"]
                await cdp(ws, sess, mid, "Page.enable")
                await cdp(ws, sess, mid, "Page.navigate", {"url": url})
                await asyncio.sleep(2.0)
                ev = await cdp(ws, sess, mid, "Runtime.evaluate", {
                    "expression": "document.getElementById('zoom-report') ? document.getElementById('zoom-report').textContent : null",
                    "returnByValue": True})
                val = ev.get("result", {}).get("result", {}).get("value")
                rep = json.loads(val) if val else {"error": "no report", "raw": ev}
                await cdp(ws, None, mid, "Target.closeTarget", {"targetId": tid})
        finally:
            chrome.kill(); srv.kill(); shutil.rmtree(ud, ignore_errors=True)
        out[scale] = rep
        vp = rep.get("viewport") or {}
        print(f"dsf={scale}: innerW={vp.get('innerW')} innerH={vp.get('innerH')} dpr={vp.get('dpr')} "
              f"hOverflow={rep.get('horizontalScroll',{}).get('documentOverflows')} "
              f"unreachable={len(rep.get('reachability',{}).get('problems',[]))} "
              f"cardsInView={rep.get('vertical',{}).get('cardsFullyInViewport')}", file=sys.stderr)
    with open(os.path.join(HERE, "raw-flagonly.json"), "w", encoding="utf-8") as h:
        json.dump(out, h, ensure_ascii=False, indent=2)
    print("raw-flagonly -> done")


asyncio.run(main())
