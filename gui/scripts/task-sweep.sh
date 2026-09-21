#!/usr/bin/env bash
# 真机任务普查的入口（issue #83）。
#
# 把产品里真实的提示词发给真实助手，跑一遍，产出一份 Markdown 报告。提示词一律
# 由任务卡自己的 prompt() 生成（见 sweep/prompts.ts），这里只做环境准备：确认
# 模型端点在、把 cante-sheets / cante-pdf 找到并导出，然后交给 sweep.py。
#
#   bash gui/scripts/task-sweep.sh                 # 跑全部卡
#   bash gui/scripts/task-sweep.sh excel.merge excel.tidy
#   bash gui/scripts/task-sweep.sh pdf               # 整类：只跑 pdf.*
#   bash gui/scripts/task-sweep.sh --list
#   SWEEP_TIMEOUT=900 bash gui/scripts/task-sweep.sh pdf.split   # 单卡上限 900 秒
#   TIMEOUT=300 bash gui/scripts/task-sweep.sh pdf.split         # 同义，旧写法还认
#   bash gui/scripts/task-sweep.sh --zip                         # 跑完打一个 zip 好拷回来
#
# 单卡上限默认交给 sweep.py（--timeout 1800 / SWEEP_TIMEOUT）：这里**只在明确设了
# TIMEOUT 或 SWEEP_TIMEOUT 时**才传 --timeout，否则会盖掉那个默认值。
#
# 没配置模型端点时不会假装通过：脚本会写一份说明「本次没真跑」的报告并不报错。
set -euo pipefail

here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
gui_root="$(cd -- "$here/.." && pwd)"
repo_root="$(cd -- "$gui_root/.." && pwd)"

timeout_seconds="${TIMEOUT:-${SWEEP_TIMEOUT:-}}"

if ! command -v python3 >/dev/null 2>&1; then
  echo "task-sweep: 需要 python3" >&2
  exit 2
fi
if ! command -v bun >/dev/null 2>&1; then
  echo "task-sweep: 需要 bun（用来调用产品自己的提示词函数）" >&2
  exit 2
fi

# --- 模型端点：WSL 里手工跑也要有 -------------------------------------------
#
# 为什么在这里读（issue #303）：weekly-sweep.ps1 是用 WSLENV 把端点渡进 WSL 的，
# 但只要有人**直接在 WSL 里**跑 `bash gui/scripts/task-sweep.sh`（真机验收就是这么跑的），
# 进程环境里就没有端点——守护进程起来后第一次请求才失败，报告上看起来像"整批卡全灭"。
# 位置和 gui/scripts/run-desktop.sh 一致：~/.ante/cante-gateway.env（一行一个 export）。
# 已经在环境里的值优先，不被文件盖掉（例如 weekly-sweep 已经渡进来的那份）。
if [ -z "${OPENAI_COMPATIBLE_BASE_URL:-}" ] || [ -z "${OPENAI_COMPATIBLE_API_KEY:-}" ]; then
  gw_env="${CANTE_ENV_FILE:-$HOME/.ante/cante-gateway.env}"
  if [ -f "$gw_env" ]; then
    # shellcheck disable=SC1090  # 这个路径是用户的，不是仓库里的
    set -a
    # shellcheck disable=SC1090
    . "$gw_env"
    set +a
    echo "task-sweep: 已从 $gw_env 读入模型端点（值不打印）" >&2
  fi
fi

# --- 找 cante-sheets / cante-pdf -------------------------------------------
# 顺序和产品里的一致：环境变量 → 本 worktree 的构建产物 → ~/.cante/bin → PATH。
resolve_helper() {
  local name="$1" override="${2:-}" candidate
  if [ -n "$override" ] && [ -x "$override" ]; then
    printf '%s' "$override"
    return 0
  fi
  for candidate in \
    "$gui_root/src-tauri/target/debug/$name" \
    "$gui_root/src-tauri/target/release/$name" \
    "$HOME/.cante/bin/$name"; do
    if [ -x "$candidate" ]; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  candidate="$(command -v "$name" 2>/dev/null || true)"
  if [ -n "$candidate" ]; then
    printf '%s' "$candidate"
    return 0
  fi
  return 1
}

sheets_bin="$(resolve_helper cante-sheets "${CANTE_SHEETS_BIN:-}" || true)"
pdf_bin="$(resolve_helper cante-pdf "${CANTE_PDF_BIN:-}" || true)"

# 找不到就试着自己编译一次（第一次会比较久）。编不出来也不致命：sweep.py 会退回
# 内置的读取方式，并在报告里说明。
if [ -z "$sheets_bin" ] || [ -z "$pdf_bin" ]; then
  if command -v cargo >/dev/null 2>&1; then
    echo "task-sweep: 没找到 cante-sheets / cante-pdf，尝试 cargo build（可能需要几分钟）…" >&2
    if cargo build --manifest-path "$gui_root/src-tauri/Cargo.toml" \
        --bin cante-sheets --bin cante-pdf >/tmp/cante-sweep-build.log 2>&1; then
      sheets_bin="$(resolve_helper cante-sheets "${CANTE_SHEETS_BIN:-}" || true)"
      pdf_bin="$(resolve_helper cante-pdf "${CANTE_PDF_BIN:-}" || true)"
    else
      echo "task-sweep: cargo build 没成功（日志在 /tmp/cante-sweep-build.log）；产出核对会退回内置读取。" >&2
    fi
  fi
fi

export CANTE_SHEETS_BIN="${sheets_bin:-}"
export CANTE_PDF_BIN="${pdf_bin:-}"

if [ -n "$timeout_seconds" ]; then
  exec python3 "$here/sweep/sweep.py" --timeout "$timeout_seconds" "$@"
fi
exec python3 "$here/sweep/sweep.py" "$@"
