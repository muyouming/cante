#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""桥（cante-bridge）在 Windows 上真的干一件活的驱动脚本。

为什么需要它：应用（`cante-gui`）走的是 `daemon.rs` 那一层，而这一层在 SSH 会话里看不到
窗口。这个脚本只做「那台机器上能核对」的最小事情：把桥当守护进程起起来，按协议发
`StartSession` + 一个真实的 `UserInput`，自动应答审批，把**收到的每一条事件**原样落盘，
并在结尾打一份摘要。

协议要点（错一个就只会收到误导性的报错，见 `gui/docs/CONTRACT.md`）：
  * op 的 `id` 必须是 **ULID**（`op_` 前缀是仓库里的习惯写法）；
  * 事件字段是 `event`，`TurnEnd` 是**带负载的对象**；
  * 审批应答的字段名必须是 **`tool_use_id`**（写成 `id` 会反复暂停）；
  * StartSession 里只给 `permission_mode` 与 `cwd` 时，模型与凭据由 `pi` 自己决定
    —— 这正是简单模式的真实路径（`store.ts` 不传 provider/model）。

用法：
    python bridge-e2e.py --bridge <cante-bridge.exe> --pi-bin <pi.exe> \
        --dir <工作目录> --prompt "<要它做的事>" --events <事件落盘路径>

所有等待都有超时；超时与「确认没有」在输出里分开写。
"""

from __future__ import annotations

import argparse
import json
import os
import queue
import subprocess
import sys
import threading
import time

_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

# Windows 上把输出重定向到文件时，Python 默认按 cp1252 编码 stdout —— 中文会直接
# 抛 UnicodeEncodeError（而不是变成乱码）。这里钉成 UTF-8。
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass


def ulid() -> str:
    stamp = int(time.time() * 1000)
    randomness = int.from_bytes(os.urandom(10), "big")
    value = (stamp << 80) | randomness
    out = []
    for _ in range(26):
        out.append(_ALPHABET[value & 31])
        value >>= 5
    return "".join(reversed(out))


def op_id() -> str:
    return "op_" + ulid()


def say(text: str) -> None:
    print(text, flush=True)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--bridge", required=True)
    parser.add_argument("--pi-bin", default="")
    parser.add_argument("--dir", required=True, help="工作目录（也是 StartSession 的 cwd）")
    parser.add_argument("--prompt", default="", help="要它做的事（也可以写成文件，见 --prompt-file）")
    parser.add_argument("--prompt-file", default="", help="从 UTF-8 文件读 prompt（避免命令行里传中文被转码）")
    parser.add_argument("--events", default="", help="把原始事件逐行写到这里")
    parser.add_argument("--timeout", type=int, default=1800)
    parser.add_argument("--approve", default="Accept", choices=["Accept", "Deny"])
    parser.add_argument("--model", default="")
    parser.add_argument("--provider", default="")
    parser.add_argument("--start-timeout", type=int, default=90)
    options = parser.parse_args()

    prompt = options.prompt
    if options.prompt_file:
        with open(options.prompt_file, encoding="utf-8") as handle:
            prompt = handle.read().strip()
    if not prompt:
        say("bridge-e2e: 没给指令（--prompt 或 --prompt-file 至少要有一个）")
        return 2

    bridge = os.path.abspath(os.path.expanduser(options.bridge))
    work = os.path.abspath(os.path.expanduser(options.dir))
    if not os.path.isfile(bridge):
        say(f"bridge-e2e: 找不到桥：{bridge}")
        return 2
    if not os.path.isdir(work):
        say(f"bridge-e2e: 找不到工作目录：{work}")
        return 2

    env = os.environ.copy()
    if options.pi_bin:
        env["PI_BIN"] = os.path.abspath(os.path.expanduser(options.pi_bin))
    say(f"bridge-e2e: 桥 = {bridge}")
    say(f"bridge-e2e: PI_BIN = {env.get('PI_BIN', '<未设，靠 PATH 上的 pi>')}")
    say(f"bridge-e2e: 工作目录 = {work}")

    events_write = None
    if options.events:
        events_write = open(options.events, "w", encoding="utf-8", newline="\n")

    process = subprocess.Popen(
        [bridge, "serve"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        cwd=work,
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        bufsize=1,
    )
    lines: queue.Queue = queue.Queue()
    stderr_lines: queue.Queue = queue.Queue()

    def pump(stream, sink):
        for line in stream:
            sink.put(line.rstrip("\r\n"))

    threading.Thread(target=pump, args=(process.stdout, lines), daemon=True).start()
    threading.Thread(target=pump, args=(process.stderr, stderr_lines), daemon=True).start()

    def send(payload: dict) -> None:
        try:
            process.stdin.write(json.dumps(payload, ensure_ascii=False) + "\n")
            process.stdin.flush()
        except (BrokenPipeError, ValueError, OSError) as error:
            say(f"bridge-e2e: 写不进桥的 stdin（{error}）——它大概已经死了")

    started = time.monotonic()
    session: dict = {}

    start_payload: dict = {"permission_mode": "auto", "cwd": work}
    if options.model:
        start_payload["model"] = options.model
    if options.provider:
        start_payload["provider"] = options.provider
    send({"op": {"StartSession": start_payload}, "id": op_id()})

    deadline = time.monotonic() + options.start_timeout
    saw_start = False
    while time.monotonic() < deadline:
        try:
            line = lines.get(timeout=0.5)
        except queue.Empty:
            if process.poll() is not None:
                break
            continue
        if events_write:
            events_write.write(line + "\n")
            events_write.flush()
        try:
            envelope = json.loads(line)
        except json.JSONDecodeError:
            say(f"  [非 JSON] {line[:160]}")
            continue
        kind = next(iter(envelope.keys()), "?")
        say(f"  [{kind}] {line[:200]}")
        if kind == "event" and "SessionStart" in (envelope.get("event") or {}):
            session = envelope["event"]["SessionStart"]
            saw_start = True
            break

    if not saw_start:
        say(f"bridge-e2e: {options.start_timeout} 秒内没有等到 SessionStart —— 停下。")
        for line in list(stderr_lines.queue)[:20]:
            say(f"  [pi stderr] {line[:200]}")
        process.kill()
        return 3

    model = (session.get("model") or {})
    provider = (session.get("provider") or {})
    say(f"bridge-e2e: 会话起来了；模型 = {model.get('id') or model.get('display_name') or '<空>'}，"
        f"服务方 = {provider.get('id') or '<空>'}，权限模式 = {session.get('permission_mode') or '<空>'}")

    sent_at = time.monotonic()
    say(f"bridge-e2e: 发指令：{prompt}")
    send({"op": {"UserInput": prompt}, "id": op_id()})

    counts = {"ToolStart": 0, "ToolEnd": 0, "AgentMessage": 0, "MessageDelta": 0,
              "TurnPause": 0, "Error": 0}
    tool_names: list[str] = []
    messages: list[str] = []
    status = "<没有 TurnEnd>"
    deadline = sent_at + options.timeout
    stderr_seen: list[str] = []

    while time.monotonic() < deadline:
        # pi 的 stderr 先收着，最后一起打（避免刷屏）。
        while True:
            try:
                stderr_seen.append(stderr_lines.get_nowait())
            except queue.Empty:
                break
        try:
            line = lines.get(timeout=0.5)
        except queue.Empty:
            if process.poll() is not None:
                status = f"<桥退出了，退出码 {process.returncode}>"
                break
            continue

        if events_write:
            events_write.write(line + "\n")
            events_write.flush()
        try:
            envelope = json.loads(line)
        except json.JSONDecodeError:
            say(f"  [非 JSON] {line[:160]}")
            continue
        event = envelope.get("event")
        if not isinstance(event, dict):
            continue

        if "MessageDelta" in event:
            counts["MessageDelta"] += 1
        if "ToolStart" in event:
            counts["ToolStart"] += 1
            use = event["ToolStart"]
            tool_names.append(use.get("name", "?"))
            say(f"  [ToolStart] {use.get('name', '?')} args={json.dumps(use.get('args'), ensure_ascii=False)[:140]}")
        elif "ToolEnd" in event:
            counts["ToolEnd"] += 1
            say(f"  [ToolEnd] {json.dumps(event['ToolEnd'], ensure_ascii=False)[:160]}")
        elif "AgentMessage" in event:
            counts["AgentMessage"] += 1
            text = str(event["AgentMessage"])
            messages.append(text)
            say(f"  [AgentMessage] {text[:300]}")
        elif "TurnPause" in event:
            counts["TurnPause"] += 1
            pause = event["TurnPause"]
            reason = pause.get("reason") or {}
            approval = reason.get("Approval") if isinstance(reason, dict) else None
            responses = []
            for tool in (approval or {}).get("tools", []):
                use_id = tool.get("id") or tool.get("tool_use_id")
                if use_id:
                    responses.append({"tool_use_id": use_id, "decision": options.approve})
            say(f"  [TurnPause] 要审批 {len(responses)} 个工具 → {options.approve}")
            if responses:
                send({"op": {"ApprovalResponse": {"turn_id": pause.get("turn_id"),
                                                  "responses": responses}}, "id": op_id()})
        elif "Error" in event:
            counts["Error"] += 1
            say(f"  [Error] {str(event['Error'])[:200]}")
        elif "TurnEnd" in event:
            end = event["TurnEnd"] or {}
            raw = end.get("status")
            if isinstance(raw, dict):
                status = raw.get("Completed") or next(iter(raw), "unknown")
                if "Error" in raw:
                    status = f"Error: {str(raw['Error'])[:200]}"
            else:
                status = str(raw)
            break

    elapsed = time.monotonic() - sent_at
    say("")
    say("=== 摘要 ===")
    say(f"轮次状态：{status}")
    say(f"耗时：{elapsed:.1f} 秒")
    say(f"工具调用：{counts['ToolStart']} 次（{', '.join(tool_names) or '无'}）")
    say(f"事件计数：{json.dumps(counts, ensure_ascii=False)}")
    if messages:
        say(f"助手最后一句：{messages[-1][:500]}")
    if stderr_seen:
        say(f"pi 的 stderr（{len(stderr_seen)} 行）：")
        for line in stderr_seen[:20]:
            say(f"  {line[:200]}")

    try:
        process.stdin.close()
    except OSError:
        pass
    time.sleep(1.0)
    if process.poll() is None:
        process.kill()
    if events_write:
        events_write.close()
    say(f"bridge-e2e: 桥退出码 {process.returncode}；总耗时 {time.monotonic() - started:.1f} 秒")
    return 0 if status == "Completed" else 1


if __name__ == "__main__":
    sys.exit(main())
