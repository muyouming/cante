#!/usr/bin/env bash
# 本机（macOS）没有 timeout/gtimeout。用法：bash with-timeout.sh 90 node probe.mjs stream
# 「有限期没等到结果」与「确认没有」必须分开写 —— 超时一律退出码 124。
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
exec python3 "$here/with-timeout.py" "$@"
