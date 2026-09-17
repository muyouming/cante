#!/usr/bin/env bash
# #130 探针一键复现：在 macOS 上起一台 `cante serve --ws`，用原始帧和标准库各验一遍。
#
#   cd gui/probes/ws && bash run.sh
#
# 需要：python3（本机有 websockets 库）、CANTE_BIN（默认 ~/.ante/bin/ante）。
# 不碰产品代码；不改 CANTE_BIN 的语义 —— 探针自己起进程、自己收尾。
# 原始输出落在 .run/（不进仓库）。每条命令都带超时（AGENTS.md §5）。
set -uo pipefail
cd "$(dirname "$0")"
mkdir -p .run

BIN="${CANTE_BIN:-${HOME}/.ante/bin/ante}"
PORT="${PORT:-47821}"
T=45 # 单次探针的超时（秒）

echo "=== 0. 守护进程自述 ==="
bash with-timeout.sh 20 "${BIN}" --version 2>&1 | tee .run/version.txt
bash with-timeout.sh 20 "${BIN}" serve --help 2>&1 | tee .run/serve-help.txt

echo
echo "=== 1. 起 serve --ws 127.0.0.1:${PORT} ==="
"${BIN}" serve --ws "127.0.0.1:${PORT}" >.run/serve.out 2>.run/serve.err &
DPID=$!
cleanup() { kill "${DPID}" 2>/dev/null; wait "${DPID}" 2>/dev/null; }
trap cleanup EXIT
# 等端口真的 listen（最多 10 秒）。
for _ in $(seq 1 20); do
  if python3 -c "import socket,sys; socket.create_connection(('127.0.0.1',${PORT}),timeout=1).close()" 2>/dev/null; then
    echo "  pid=${DPID}，端口已 listen"
    break
  fi
  sleep 0.5
done
echo "  stdout=$(wc -c <.run/serve.out) 字节 stderr=$(wc -c <.run/serve.err) 字节（服务是静默的）"

echo
echo "=== 2. 原始帧：手写握手 + 一帧 StartSession ==="
bash with-timeout.sh "${T}" python3 raw_frames.py "${PORT}" 8 2>&1 | tee .run/raw_frames.out
raw=${PIPESTATUS[0]}
echo "  raw_frames 退出码=${raw}（0=收到文本帧）"

echo
echo "=== 3. curl 到同一个端口（Windows 清单里要核对这条）==="
echo "--- 不带 Upgrade 头 ---"
bash with-timeout.sh 15 curl -sS -i --max-time 8 "http://127.0.0.1:${PORT}/" 2>&1 | tee .run/curl-plain.out
echo "  curl 退出码=${PIPESTATUS[0]}"
echo "--- 带 Upgrade 头（拿到 101 后没法说帧，只能等超时）---"
bash with-timeout.sh 15 curl -sS -i --max-time 8 \
  -H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Version: 13" \
  -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  "http://127.0.0.1:${PORT}/" 2>&1 | tee .run/curl-upgrade.out
echo "  curl 退出码=${PIPESTATUS[0]}（28=超时，是对的结果：握手换成 websocket 后就没有 HTTP 响应体了）"

echo
echo "=== 4. 标准库：建会话 + 断开后服务仍在 ==="
bash with-timeout.sh 90 python3 probe_ws.py "${PORT}" 2>&1 | tee .run/probe_ws.out
probe=${PIPESTATUS[0]}
echo "  probe_ws 退出码=${probe}（0=两次都拿到 SessionStart）"

echo
echo "=== 5. 这台守护进程认不认令牌 ==="
bash with-timeout.sh "${T}" python3 token_check.py "${PORT}" 2>&1 | tee .run/token_check.out
token=${PIPESTATUS[0]}
echo "  token_check 退出码=${token}"

echo
echo "=== 6. 非 loopback 绑定应被拒 ==="
bash with-timeout.sh 15 "${BIN}" serve --ws 0.0.0.0:47899 >.run/nonloop.out 2>&1
nonloop=$?
nonloop_msg=$(cat .run/nonloop.out)
echo "  0.0.0.0 退出码=${nonloop} 输出: ${nonloop_msg}"

echo
echo "=== 7. 客户端都断开后，守护进程是否还活着 ==="
if kill -0 "${DPID}" 2>/dev/null; then echo "  还活着（ws 是常驻服务，不归客户端所有）"; else echo "  已退出"; fi

echo
echo "=== 汇总 ==="
echo "  raw_frames=${raw} probe_ws=${probe} token_check=${token}"
[ "${raw}" = 0 ] && [ "${probe}" = 0 ] && echo "  建会话这条路通了（token 认不认见上面第 5 节）" || echo "  有未通过项，见上面"
