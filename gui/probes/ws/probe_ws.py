#!/usr/bin/env python3
"""#130 探针 2：用标准 websocket 库跑「建会话」，并验证守护进程不在客户端掉线时死掉。

和 raw_frames.py 的区别：那条手写帧、证明线上形状；这条用现成库、证明**语义**：
  1. 连上 → 发 StartSession(auto) → 收到 SessionStart（关键断言）；
  2. 客户端正常断开；
  3. **同一个守护进程**还活着，第二个客户端能再连、再建一个会话。
     —— 这正是「子进程模型」没有的性质：stdio 的 serve 在 stdin 关掉时就该退，
        而 --ws 的 serve 是常驻服务，不归客户端所有。

用法: python3 probe_ws.py <port>
输出: 一行一个 JSON 摘要（便于报告里贴），退出码 0 = 两条都过。
"""
import asyncio
import json
import sys
import time

import websockets

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 47821
URL = f"ws://127.0.0.1:{PORT}"
_CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"


def ulid() -> str:
    import secrets
    val = (int(time.time() * 1000) << 80) | secrets.randbits(80)
    out = []
    for _ in range(26):
        out.append(_CROCKFORD[val & 0x1F])
        val >>= 5
    return "".join(reversed(out))


async def one_session(label: str) -> dict:
    """连一次、建一个会话、等到 SessionStart+ExtensionRefreshed，然后正常断开。"""
    result = {"client": label, "connected": False, "session_start": False,
              "session_id": None, "permission_mode": None, "events": [], "frame_bytes": []}
    async with websockets.connect(URL, open_timeout=10) as ws:
        result["connected"] = True
        op = {"op": {"StartSession": {"permission_mode": "auto"}}, "id": "op_" + ulid()}
        sent = json.dumps(op, separators=(",", ":"))
        await ws.send(sent)
        result["op_id"] = op["id"]
        deadline = time.time() + 20
        while time.time() < deadline and len(result["events"]) < 2:
            try:
                raw = await asyncio.wait_for(ws.recv(), timeout=max(0.1, deadline - time.time()))
            except asyncio.TimeoutError:
                break
            assert isinstance(raw, str), "事件必须是文本帧"
            result["frame_bytes"].append(len(raw.encode()))
            msg = json.loads(raw)
            key = next(iter(msg["event"]))
            result["events"].append(key)
            if key == "SessionStart":
                info = msg["event"]["SessionStart"]
                result["session_start"] = True
                result["session_id"] = info.get("session_id")
                result["permission_mode"] = info.get("permission_mode")
                result["parent_matches_op"] = msg.get("parent") == op["id"]
    return result


async def main() -> int:
    for attempt in range(3):
        try:
            first = await one_session("first")
            break
        except (OSError, websockets.exceptions.WebSocketException) as e:
            if attempt == 2:
                print(json.dumps({"error": f"{type(e).__name__}: {e}"}, ensure_ascii=False))
                return 1
            await asyncio.sleep(1)
    print(json.dumps(first, ensure_ascii=False))

    # 客户端 #1 已经断开。守护进程应该**还在**（它不是我们的子进程）。
    await asyncio.sleep(0.5)
    second = await one_session("second")
    print(json.dumps(second, ensure_ascii=False))

    same = (first["session_id"] is not None and second["session_id"] is not None
            and first["session_id"] != second["session_id"])
    print(json.dumps({"verdict": {
        "session_start_over_ws": first["session_start"] and second["session_start"],
        "server_survived_client_disconnect": True,
        "each_connect_gets_a_fresh_session": same,
        "one_text_frame_per_event": all(b > 0 for b in first["frame_bytes"]),
    }}, ensure_ascii=False))
    return 0 if (first["session_start"] and second["session_start"]) else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
