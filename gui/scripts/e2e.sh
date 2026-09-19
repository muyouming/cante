#!/usr/bin/env bash
# Headless gate for the GUI: the exact commands CI runs, in order. Stops at the
# first failure, exits non-zero there, and prints a one-line summary. Works from
# any cwd; on Linux CI toolchain.sh is a no-op.
#
#   bash gui/scripts/e2e.sh
set -euo pipefail

here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
gui_root="$(cd -- "$here/.." && pwd)"

# shellcheck source=./toolchain.sh
source "$here/toolchain.sh"

cd "$gui_root"

# 步骤总数（加/删步骤时改这里；它只影响最后那行统计的显示）
total=9
current=0

step() {
  local name="$1"
  shift
  current=$((current + 1))
  printf '\n==> [%d/%d] %s\n' "$current" "$total" "$name"
  if ! "$@"; then
    printf 'e2e: FAIL at step %d/%d (%s)\n' "$current" "$total" "$name" >&2
    exit 1
  fi
}

# 秘密扫描放最前面：几秒钟就出结果，越早拦住越省事（CI 里也是第一步）。
# 之所以本地也要跑：本地判据必须与 CI 一致——"本地绿、CI 红"我们已经踩过。
step "secret scan" bash scripts/secret-scan.sh
step "bun install" bun install
# 第三方组件清单：清单过期就红（并点名是哪些组件变了）。它必须排在 `bun install`
# 之后 —— npm 那半的许可证/版权行只存在于已安装包自己的 package.json 里，bun.lock
# 不带这两个字段。这是它能跑的最早位置，仍在秘密扫描之后。
step "third-party licenses are current" bash scripts/license-inventory.sh --check
step "bun test src" bun test src
step "bunx tsc --noEmit" bunx tsc --noEmit
step "bun run build:web" bun run build:web
step "bun test fixtures" bun test fixtures
# CI 把编译警告当错误（`build.warnings = deny`），而本机默认没有这个配置 —— 于是
# "本地全绿、CI 红" 这类事故一定会发生（已经发生过一次：一个重复的 `#[test]`
# 属性）。这里用 `-D warnings` 让本地的判据与 CI 对齐：rustc 的 lint 一律当错误。
# 注意它只影响 rustc 的 lint，不影响依赖构建脚本打出的 cargo:warning（例如本机
# 那套 Xcode 许可绕行脚本的提示），所以本机仍然跑得动。
CARGO_WARNINGS_DENIED="${RUSTFLAGS:-} -D warnings"
step "cargo test (src-tauri)" env RUSTFLAGS="$CARGO_WARNINGS_DENIED" cargo test --manifest-path src-tauri/Cargo.toml
# 最后一步：真渲染界面、真的量“她看到什么”。放在最后是有意的——它最慢（约 13 秒
# 本机 / 需装 Chrome 的 CI 更多），前面全是快的；而且它是唯一能看见「界面里到底
# 长什么样」的检查，源码扫描证明不了（评审实测：把「先给我看一眼」套进会滚的盒子，
# 源码扫描和旧的 dom-smoke 都是绿的 ✗）。放进门禁，本地与 CI 才判据一致。
#
# 这一步只在 macOS / Linux 上跑（驱动的是 Google Chrome ✓）。在 Windows 上它**明确跳过**
# （打印原因、退出码 0 ✓）——Chrome 在 Windows 上是 GUI 子系统程序，Git Bash 读不到它的输出，
# 曾在 windows-latest 上把这一步挂死一个多小时 ✗；Windows 那边交给真 WebView2 的 tauri-driver 冒烟 ✓。
# 另外：找不到 Chrome 时退出码 2（红 ✗）；Chrome 在但 10 秒不答 --version 也判「这个平台跑不了」（不再无限等 ✓）。
step "dom smoke (rendered UI in Chrome; skipped on Windows)" bash scripts/dom-smoke.sh

printf '\ne2e: OK (%d/%d steps passed)\n' "$current" "$total"
