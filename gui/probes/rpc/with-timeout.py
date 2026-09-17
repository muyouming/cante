#!/usr/bin/env python3
"""给一条命令加硬超时（macOS 没有 timeout/gtimeout）。

用法: python3 with-timeout.py <秒> <命令> [参数...]
超时 -> 杀掉子进程、打印「超时」、退出码 124（与 GNU timeout 一致）。
"""
import subprocess
import sys

secs = float(sys.argv[1])
cmd = sys.argv[2:]
try:
    sys.exit(subprocess.run(cmd).returncode)
except subprocess.TimeoutExpired:
    print(f"超时：{secs:g} 秒没跑完：{' '.join(cmd)}", file=sys.stderr)
    sys.exit(124)
