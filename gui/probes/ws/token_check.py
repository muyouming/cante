#!/usr/bin/env python3
"""#130 探针 3：这台守护进程到底认不认 token？

上游 `ante-sdk` 的注释说：「`ante serve --ws` refuses a peer without it」（没有令牌
就不给连）。本机装的是 `ante 0.preview.99`，我们实测它**不带令牌也握手成功** ——
这条探针把三种情况（不带 / 带错的 Bearer / 带非 Bearer 的 Authorization）各拨一次，
把状态行原样打出来，供报告里如实写「装了哪个版本、认不认令牌」。

用法: python3 token_check.py <port>
退出码: 0 = 三种都拿到了明确的 HTTP 状态行（无论 101 还是 401）；1 = 网络层就失败了。
"""
import base64
import secrets
import socket
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 47821
CASES = [
    ("不带令牌", ""),
    ("带错的 Bearer", "Authorization: Bearer not-a-real-token\r\n"),
    ("Authorization 但不是 Bearer", "Authorization: not-a-real-token\r\n"),
]


def dial(extra: str) -> str:
    key = base64.b64encode(secrets.token_bytes(16)).decode()
    head = (
        f"GET / HTTP/1.1\r\nHost: 127.0.0.1:{PORT}\r\n"
        f"Upgrade: websocket\r\nConnection: Upgrade\r\n"
        f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n{extra}\r\n"
    ).encode()
    s = socket.create_connection(("127.0.0.1", PORT), timeout=5)
    s.sendall(head)
    s.settimeout(4)
    try:
        data = s.recv(400)
    except socket.timeout:
        data = "<等 4 秒没有回应>".encode()
    finally:
        s.close()
    return data.decode(errors="replace").split("\r\n")[0].strip()


def main() -> int:
    ok = True
    for label, extra in CASES:
        try:
            status = dial(extra)
        except OSError as e:
            status = f"<网络层失败 {type(e).__name__}: {e}>"
            ok = False
        print(f"{label}: {status}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
