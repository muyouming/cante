#!/usr/bin/env python3
"""#130 探针 1：手写 RFC 6455 握手 + 帧，证明「一条文本帧 = 一条 op/event」。

不用任何 websocket 库 —— 全程原始 socket，把发出去/收回来的字节按帧边界打出来，
这样报告里贴的就是**真的线上字节**，不是库的转述。

用法:
    python3 raw_frames.py <port> [等待秒数]

退出码: 0 = 收到了文本帧；3 = 连上了但没收到任何文本帧；1 = 连接/握手失败。
"""
import base64
import hashlib
import json
import os
import secrets
import socket
import struct
import sys
import time

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 47821
WAIT = float(sys.argv[2]) if len(sys.argv) > 2 else 8.0
HOST = "127.0.0.1"

# RFC 6455 §1.3：客户端握手必须带一个随机的 base64(16 字节) key，
# 服务端回 101 + Sec-WebSocket-Accept = base64(sha1(key + GUID))。
GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
KEY = base64.b64encode(secrets.token_bytes(16)).decode()

# ULID: 48 位毫秒时间戳 + 80 位随机，Crockford base32（26 字符）。
_CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"


def ulid() -> str:
    ts = int(time.time() * 1000)
    val = (ts << 80) | secrets.randbits(80)
    out = []
    for _ in range(26):
        out.append(_CROCKFORD[val & 0x1F])
        val >>= 5
    return "".join(reversed(out))


def send_frame(sock: socket.socket, opcode: int, payload: bytes) -> bytes:
    """客户端 → 服务端：必须 mask。返回「用来打日志」的那份字节。"""
    mask = secrets.token_bytes(4)
    masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
    header = bytes([0x80 | opcode])
    n = len(masked)
    if n < 126:
        header += bytes([0x80 | n])
    elif n < 65536:
        header += bytes([0x80 | 126]) + struct.pack(">H", n)
    else:
        header += bytes([0x80 | 127]) + struct.pack(">Q", n)
    frame = header + mask + masked
    sock.sendall(frame)
    return frame


def recv_exact(sock: socket.socket, n: int) -> bytes:
    buf = b""
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            raise EOFError("对端关掉了连接")
        buf += chunk
    return buf


def recv_frame(sock: socket.socket):
    """服务端 → 客户端：不 mask。返回 (opcode, payload, 原始帧字节)。"""
    b0, b1 = recv_exact(sock, 2)
    fin = bool(b0 & 0x80)
    opcode = b0 & 0x0F
    masked = bool(b1 & 0x80)
    n = b1 & 0x7F
    extra = b""
    if n == 126:
        extra = recv_exact(sock, 2)
        n = struct.unpack(">H", extra)[0]
    elif n == 127:
        extra = recv_exact(sock, 8)
        n = struct.unpack(">Q", extra)[0]
    mask = recv_exact(sock, 4) if masked else b""
    payload = recv_exact(sock, n)
    if masked:
        payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
    raw = bytes([b0, b1]) + extra + mask + payload
    return fin, opcode, payload, raw


def main() -> int:
    print(f"[*] 拨号 ws://{HOST}:{PORT}")
    try:
        sock = socket.create_connection((HOST, PORT), timeout=WAIT)
    except OSError as e:
        print(f"[!] TCP 连不上：{e}")
        return 1

    request = (
        f"GET / HTTP/1.1\r\n"
        f"Host: {HOST}:{PORT}\r\n"
        f"Upgrade: websocket\r\n"
        f"Connection: Upgrade\r\n"
        f"Sec-WebSocket-Key: {KEY}\r\n"
        f"Sec-WebSocket-Version: 13\r\n"
        f"\r\n"
    ).encode()
    print("[*] >>> 握手请求（原始字节）")
    print(request.decode())

    sock.sendall(request)
    # 读握手响应，直到 \r\n\r\n。
    head = b""
    while b"\r\n\r\n" not in head:
        chunk = sock.recv(1)
        if not chunk:
            print("[!] 握手期间对端关连接")
            return 1
        head += chunk
    print("[*] <<< 握手响应（原始字节）")
    print(head.decode(errors="replace"))

    status = head.split(b"\r\n", 1)[0].decode()
    if "101" not in status:
        print(f"[!] 不是 101 Switching Protocols：{status}")
        return 1
    expected = base64.b64encode(hashlib.sha1((KEY + GUID).encode()).digest()).decode()
    got = ""
    for line in head.decode(errors="replace").split("\r\n"):
        if line.lower().startswith("sec-websocket-accept:"):
            got = line.split(":", 1)[1].strip()
    print(f"[*] Sec-WebSocket-Accept 校验: {'通过' if got == expected else f'不匹配 got={got} want={expected}'}")
    print()

    op = {
        "op": {"StartSession": {"permission_mode": "auto"}},
        "id": "op_" + ulid(),
    }
    payload = json.dumps(op, ensure_ascii=False, separators=(",", ":")).encode()
    print(f"[*] >>> 一帧文本（opcode=0x1，masked），payload {len(payload)} 字节")
    print(f"    {payload.decode()}")
    frame = send_frame(sock, 0x1, payload)
    print(f"    帧头前 2 字节={frame[:2].hex()}（0x81=FIN+text，0x80|len=masked）")
    print()

    text_frames = 0
    deadline = time.time() + WAIT
    sock.settimeout(max(0.1, WAIT))
    while time.time() < deadline:
        try:
            fin, opcode, payload, raw = recv_frame(sock)
        except (socket.timeout, EOFError) as e:
            print(f"[*] 读结束：{type(e).__name__}")
            break
        name = {0x0: "continuation", 0x1: "text", 0x2: "binary",
                0x8: "close", 0x9: "ping", 0xA: "pong"}.get(opcode, hex(opcode))
        print(f"<<< 帧 {len(raw)} 字节 fin={fin} opcode=0x{opcode:x}({name}) payload={len(payload)} 字节")
        print(f"    原始前 16 字节: {raw[:16].hex()}")
        if opcode == 0x1:
            text_frames += 1
            try:
                msg = json.loads(payload)
                evt = msg.get("event")
                key = next(iter(evt)) if isinstance(evt, dict) else evt
                print(f"    JSON 解析 OK: id={msg.get('id')} parent={msg.get('parent')} event={key}")
                if key == "SessionStart":
                    info = evt["SessionStart"]
                    print(f"    >>> SessionStart: session_id={info.get('session_id')} "
                          f"model={info.get('model')} permission_mode={info.get('permission_mode')}")
            except Exception as e:
                print(f"    JSON 解析失败：{e}")
            print(f"    payload: {payload.decode(errors='replace')[:400]}")
        if opcode == 0x9:  # ping -> 回 pong（同样要 mask）
            send_frame(sock, 0xA, payload)
            print("    (回了 pong)")
        if opcode == 0x8:
            break

    send_frame(sock, 0x8, struct.pack(">H", 1000))  # 正常关闭
    sock.close()
    print()
    print(f"[=] 收到 {text_frames} 条文本帧")
    return 0 if text_frames else 3


if __name__ == "__main__":
    sys.exit(main())
