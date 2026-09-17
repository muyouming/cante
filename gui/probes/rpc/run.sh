#!/usr/bin/env bash
# #103 探针一键复现。每条命令都带超时（AGENTS.md §5）。
#
#   cd gui/probes/rpc && bash run.sh
#
# 需要：node、pi 在 PATH（或 PI_BIN=/path/to/pi）。
# 不需要真模型：模型端点由本目录的 fake-openai.mjs 提供（localhost）。
# 原始输出落在 .run/*.jsonl（不进仓库）。
set -uo pipefail
cd "$(dirname "$0")"
T=60 # 单次探针的超时（秒）

run() {
  local name="$1"
  shift
  echo "=== $name ==="
  bash with-timeout.sh "$T" node probe.mjs "$@" >".run/$name.report.json" 2>".run/$name.stderr"
  local code=$?
  if [ $code -eq 124 ]; then
    echo "  超时：${T}s 没跑完（见 .run/$name.stderr）"
    return
  fi
  python3 - "$name" <<'PY'
import json, sys
name = sys.argv[1]
try:
    r = json.load(open(f".run/{name}.report.json"))
except Exception as e:
    print(f"  解析报告失败：{e}")
    raise SystemExit(0)
print(f"  exit={r['exit']} stopReason={r['stopReason']} 工具标记文件={r['markerFileExists']}"
      + (f"/{r['markerFile2Exists']}" if r.get('markerFile2Exists') is not None else ""))
print(f"  uiRequests={json.dumps(r['uiRequests'], ensure_ascii=False)}")
bad = [t for t in r["toolExecutionEnd"] if t["isError"]]
print(f"  toolExecutionEnd={len(r['toolExecutionEnd'])} 个，其中 isError={len(bad)}")
PY
}

run "stream" stream
run "approval-allow-select" approval --decision allow
run "approval-deny-select" approval --decision deny
run "approval-deny-confirm" approval --decision deny --ui confirm
run "approval-cancel-select" approval --decision cancel
run "multi-allow-select" approval --decision allow --multi --ui select
run "multi-allow-batch" approval --decision allow --multi --ui batch
run "multi-allow-batch2" approval --decision allow --multi --ui batch2
run "multi-deny-batch2" approval --decision deny --multi --ui batch2
run "abort" abort

echo
echo "全部跑完。以上每条都记录了「超时」与「确认结果」的区别。"
