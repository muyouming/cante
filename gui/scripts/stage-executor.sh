#!/usr/bin/env bash
# 构建期把随包发的执行组件取回来、验校验值、摆到应用旁边（#150 第二步）。
#
# 逻辑在 `stage-executor.ts`（JSON 解析、解压、许可清单都交给 bun —— 那两个包都是给
# 运行时装东西用的，不值得再用 shell 重写一遍）。这个壳只负责：找到仓库根、交给 bun、
# 把退出码原样带出去。`tauri.conf.json` 的 `build.beforeBuildCommand` 就调它。
#
#   bash gui/scripts/stage-executor.sh
#   bash gui/scripts/stage-executor.sh --force
set -euo pipefail

here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v bun >/dev/null 2>&1; then
  printf 'stage-executor: 需要 bun（仓库的其它脚本也一样）\n' >&2
  exit 2
fi

exec bun "$here/stage-executor.ts" "$@"
