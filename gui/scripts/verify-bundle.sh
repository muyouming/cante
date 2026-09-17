#!/usr/bin/env bash
# 产物闸门 —— 打开**真的打出来的东西**看，不看配置文件。
#
# 为什么要有它（#141）：tauri.conf.json 里"声明了"不等于"包里真的有"。
# 上一轮 `src/packaging.test.ts` 只读了配置文件（那是"我们的意图"），于是
# "配置看着对、发出去的 dmg 里却没有工具"这件事在三轮真机验收里一直没被发现。
# 这个脚本只回答一个问题：我面前的这个 .app / .dmg / 安装目录里，那四个可执行
# 文件到底在不在、能不能就地跑、有没有把 cargo 的垃圾一起带进来。
#
# 用法：
#   bash gui/scripts/verify-bundle.sh --app <Cante.app 路径>
#   bash gui/scripts/verify-bundle.sh --dmg <Cante_0.2.1_aarch64.dmg>
#   bash gui/scripts/verify-bundle.sh --dir <目录>            # Windows 安装目录等
#   bash gui/scripts/verify-bundle.sh --app <app> --expect-version 0.2.1
#
# 断言（对 <app>/Contents/MacOS 或 --dir 里的那一层）：
#   1. cante-gui + cante-sheets + cante-pdf + cante-bridge 四个都在；缺了就非零退出
#      并**逐个点名**缺哪个（不是一句"检查失败"）；
#   2. 每个都非空、可执行；
#   3. cante-sheets / cante-pdf / cante-bridge 能在**bundle 内**跑起来并打出与
#      app 相同的版本号（`--version`）—— 只"在"不够，要真的能跑；
#   4. 没有 `.d`（cargo 的依赖清单）、没有 0 字节文件、没有多余目录。
#
# 退出码：0 = 全过；非 0 = 有缺失/有垃圾，并说清是哪几个。
set -euo pipefail

MAIN_BIN="cante-gui"
TOOL_BINS=(cante-sheets cante-pdf cante-bridge)
ALL_BINS=("$MAIN_BIN" "${TOOL_BINS[@]}")

here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
gui_root="$(cd -- "$here/.." && pwd)"

usage() {
  sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

die() { printf '\nverify-bundle: %s\n' "$*" >&2; exit 2; }

# tauri.conf.json 里的版本号（--dir 模式下没有 Info.plist 可用时的兜底）。
config_version() {
  local conf="$gui_root/src-tauri/tauri.conf.json"
  [ -f "$conf" ] || return 1
  sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$conf" | head -1
}

# ---------------------------------------------------------------------------
# 检查一个"工具和主程序躺在一起"的目录
#   $1 目录  $2 macos|windows  $3 期望版本（可为空）
# ---------------------------------------------------------------------------
check_dir() {
  local dir="$1" platform="$2" want="$3"
  local suffix=""
  [ "$platform" = "windows" ] && suffix=".exe"

  printf '==> 检查目录：%s\n' "$dir"
  if [ ! -d "$dir" ]; then
    printf 'verify-bundle: 目录不存在：%s\n' "$dir" >&2
    return 1
  fi
  ls -la "$dir" || true
  printf '\n'

  local bad=0 i
  local missing=() empty=() notexec=()

  for i in "${ALL_BINS[@]}"; do
    local p="$dir/$i$suffix"
    if [ ! -f "$p" ]; then
      missing+=("$i$suffix")
      bad=1
      continue
    fi
    if [ "$(wc -c <"$p" | tr -d ' ')" -eq 0 ]; then
      empty+=("$i$suffix")
      bad=1
    fi
    if [ ! -x "$p" ]; then
      notexec+=("$i$suffix")
      bad=1
    fi
  done

  # cargo 的 .d 与任何 0 字节文件：上一轮它们就是被 target/release/* 这种宽 glob
  # 一起扫进 Windows 安装包的垃圾（#112 第二次真机验收的证据）。
  local f junk=() zero=()
  while IFS= read -r f; do
    [ -n "$f" ] && junk+=("$(basename "$f")")
  done < <(find "$dir" -maxdepth 1 -type f -name '*.d' 2>/dev/null)
  while IFS= read -r f; do
    [ -n "$f" ] && zero+=("$(basename "$f")")
  done < <(find "$dir" -maxdepth 1 -type f -size 0 2>/dev/null)

  # 多余目录：安装目录里不该再套目录（这一层只应该平铺着可执行文件）。
  local dirs=() d
  while IFS= read -r d; do
    [ -n "$d" ] && dirs+=("$(basename "$d")")
  done < <(find "$dir" -mindepth 1 -maxdepth 1 -type d 2>/dev/null)

  # 只有四个都在且非空时才真的去跑它们（缺了跑不起来，错误会更吵）。
  if [ "${#missing[@]}" -eq 0 ] && [ "${#empty[@]}" -eq 0 ] && [ "${#notexec[@]}" -eq 0 ]; then
    local tool out
    for tool in "${TOOL_BINS[@]}"; do
      if ! out=$("$dir/$tool$suffix" --version 2>&1); then
        printf 'verify-bundle: %s%s --version 跑不起来（输出：%s）\n' "$tool" "$suffix" "$out" >&2
        bad=1
        continue
      fi
      printf '    %s%s --version  →  %s\n' "$tool" "$suffix" "$out"
      if [ -n "$want" ] && ! printf '%s' "$out" | grep -qF "$want"; then
        printf 'verify-bundle: %s%s 的版本应该是 %s，实际是 %s\n' "$tool" "$suffix" "$want" "$out" >&2
        bad=1
      fi
    done
    printf '\n'
  fi

  local failed=0
  if [ "${#missing[@]}" -gt 0 ]; then
    printf 'verify-bundle: ✗ 缺少 %d 个文件：%s\n' "${#missing[@]}" "${missing[*]}" >&2
    printf '               （%s 里没有它们的任何一份）\n' "$dir" >&2
    failed=1
  fi
  if [ "${#empty[@]}" -gt 0 ]; then
    printf 'verify-bundle: ✗ 0 字节的假文件：%s\n' "${empty[*]}" >&2
    failed=1
  fi
  if [ "${#notexec[@]}" -gt 0 ]; then
    printf 'verify-bundle: ✗ 不可执行：%s\n' "${notexec[*]}" >&2
    failed=1
  fi
  if [ "${#junk[@]}" -gt 0 ]; then
    printf 'verify-bundle: ✗ 混进来的 .d 依赖清单：%s\n' "${junk[*]}" >&2
    failed=1
  fi
  if [ "${#zero[@]}" -gt 0 ]; then
    printf 'verify-bundle: ✗ 混进来的 0 字节文件：%s\n' "${zero[*]}" >&2
    failed=1
  fi
  if [ "${#dirs[@]}" -gt 0 ]; then
    printf 'verify-bundle: ✗ 多余目录：%s\n' "${dirs[*]}" >&2
    failed=1
  fi

  if [ "$failed" -eq 0 ] && [ "$bad" -eq 0 ]; then
    printf 'verify-bundle: ✓ %s 里四个程序齐全、可执行、能跑出版本号，且没有 .d / 0 字节 / 多余目录\n' "$dir"
    return 0
  fi
  return 1
}

check_app() {
  local app="$1" want="$2"
  [ -d "$app" ] || die ".app 不存在：$app"
  local macos="$app/Contents/MacOS"
  [ -d "$macos" ] || die "$app 里没有 Contents/MacOS（这真的是 macOS 的 .app 吗？）"

  if [ -z "$want" ] && [ -f "$app/Contents/Info.plist" ]; then
    want="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$app/Contents/Info.plist" 2>/dev/null || true)"
  fi
  [ -n "$want" ] || want="$(config_version || true)"

  check_dir "$macos" macos "$want"
}

check_dmg() {
  local dmg="$1" want="$2"
  [ -f "$dmg" ] || die "dmg 不存在：$dmg"

  # 这个 dmg 带许可协议（SLA）：hdiutil 从 stdin 读一个 Y。挂载点用 -mountpoint
  # 自己定（临时目录名），**不要**去猜 /Volumes/Cante —— 那既可能是 dmg.XXXXXX，
  # 也可能已经被别的卷占了（踩过这个坑）。
  local mount_dir
  mount_dir="$(mktemp -d "${TMPDIR:-/tmp}/cante-verify.XXXXXX")"
  # These must survive the function returning: the EXIT trap runs later, and with
  # `set -u` a `local` would already be out of scope (that is exactly how the
  # first version of this script failed after a successful check).
  CANTE_VERIFY_MOUNT="$mount_dir"
  CANTE_VERIFY_ATTACHED=0
  cleanup() {
    if [ "${CANTE_VERIFY_ATTACHED:-0}" -eq 1 ]; then
      hdiutil detach "${CANTE_VERIFY_MOUNT:-}" -quiet >/dev/null 2>&1 || true
    fi
    rmdir "${CANTE_VERIFY_MOUNT:-}" >/dev/null 2>&1 || true
  }
  trap cleanup EXIT

  local out
  if ! out="$(printf 'Y\n' | hdiutil attach "$dmg" -nobrowse -readonly -mountpoint "$mount_dir" 2>&1)"; then
    printf '%s\n' "$out" >&2
    die "挂载失败：$dmg"
  fi
  CANTE_VERIFY_ATTACHED=1

  local apps=() a
  while IFS= read -r a; do
    [ -n "$a" ] && apps+=("$a")
  done < <(find "$mount_dir" -maxdepth 1 -name '*.app' 2>/dev/null)
  if [ "${#apps[@]}" -ne 1 ]; then
    die "dmg 里应该正好有 1 个 .app，实际 ${#apps[@]} 个（$mount_dir）"
  fi
  check_app "${apps[0]}" "$want"
}

# ---------------------------------------------------------------------------
main() {
  local mode="" target="" want="" platform="macos"
  while [ $# -gt 0 ]; do
    case "$1" in
      --app) mode="app"; target="${2:-}"; shift 2 ;;
      --dmg) mode="dmg"; target="${2:-}"; shift 2 ;;
      --dir) mode="dir"; target="${2:-}"; shift 2 ;;
      --windows) platform="windows"; shift ;;
      --expect-version) want="${2:-}"; shift 2 ;;
      -h | --help) usage 0 ;;
      *) die "看不懂的参数：$1（用 --help）" ;;
    esac
  done

  [ -n "$mode" ] || usage 2

  case "$mode" in
    app) check_app "$target" "$want" ;;
    dmg) check_dmg "$target" "$want" ;;
    dir)
      if [ -z "$want" ]; then
        # Windows 安装目录里没有 Info.plist，用仓库里的版本号兜底。
        want="$(config_version || true)"
      fi
      check_dir "$target" "$platform" "$want"
      ;;
  esac
}

main "$@"
