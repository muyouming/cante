#!/usr/bin/env bash
# Fetch the msedgedriver that matches this machine's WebView2 runtime.
#
#   bash gui/e2e-windows/install-msedgedriver.sh [destination]
#
# Why this is not a pinned version: `tauri-driver` drives the Tauri window
# through Microsoft's Edge WebDriver, and EdgeDriver only talks to the Edge /
# WebView2 build it was released for. On GitHub's `windows-latest` image both
# Edge and the WebView2 runtime are upgraded together with the image, so a
# pinned version rots — and it rots in the worst way: a version mismatch makes
# the WebDriver **session hang**, it does not error. Tauri's manual-setup guide
# says exactly this and points at github.com/chippers/msedgedriver-tool; this is
# the same resolution without a tool to compile first.
#
# Resolution order:
#   1. the WebView2 Evergreen runtime `pv` from the registry — that is the
#      runtime the Tauri app actually loads, so it is the one that must match;
#   2. Edge's own version (same build in practice, different registry key);
#   3. that exact driver build from Microsoft, else LATEST_RELEASE_<major>.
#
# The versions it resolved are printed: they are the first thing to look at when
# a session creation times out.
set -euo pipefail

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
DEST="${1:-$HERE/msedgedriver}"
BASE="https://msedgedriver.microsoft.com"
ZIP="$DEST/edgedriver_win64.zip"
DRIVER="$DEST/msedgedriver.exe"

# Evergreen WebView2 runtime, then the Edge browser itself. The `(x86)` view is
# where a 64-bit Windows registers both.
WEBVIEW2_KEYS=(
  'HKLM\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
  'HKLM\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
  'HKCU\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
)
EDGE_KEYS=(
  'HKLM\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{56EB18F8-B008-4CBD-B6D2-8C97FE7E9062}'
  'HKLM\SOFTWARE\Microsoft\EdgeUpdate\Clients\{56EB18F8-B008-4CBD-B6D2-8C97FE7E9062}'
)

die() {
  printf 'install-msedgedriver: %s\n' "$*" >&2
  exit 1
}

# `reg query <key> /v pv` -> the value. `//v` keeps Git Bash from rewriting the
# switch into a path, and `|| true` keeps `set -e` from turning "no such key"
# into a hard failure (a key that is missing is information, not an error).
reg_value() {
  local out
  out="$(reg query "$1" //v "$2" 2>/dev/null | tr -d '\r' | awk '/REG_SZ/ {print $3}' || true)"
  printf '%s' "$out"
}

first_value() { # $@ = keys
  local key value
  for key in "$@"; do
    value="$(reg_value "$key" pv)"
    if [ -n "$value" ]; then
      printf '%s' "$value"
      return 0
    fi
  done
  return 0
}

# Microsoft publishes `LATEST_RELEASE_<major>` as UTF-16LE; strip the encoding.
latest_for_major() {
  local major="${1%%.*}"
  [ -n "$major" ] || return 0
  curl -fsSL --max-time 60 "$BASE/LATEST_RELEASE_$major" 2>/dev/null | tr -d '\000' | tr -d '\r\n' || true
}

mkdir -p "$DEST"

webview2_version="$(first_value "${WEBVIEW2_KEYS[@]}")"
edge_version="$(first_value "${EDGE_KEYS[@]}")"
if [ -z "$edge_version" ]; then
  # Last resort: ask the browser binary itself.
  edge_version="$(powershell.exe -NoProfile -Command \
    '(Get-Item "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe").VersionInfo.ProductVersion' \
    2>/dev/null | tr -d '\r' || true)"
fi

target="${webview2_version:-$edge_version}"
printf '==> WebView2 运行时：%s\n' "${webview2_version:-（读不到）}"
printf '==> Edge 浏览器：%s\n' "${edge_version:-（读不到）}"
[ -n "$target" ] || die "这台机器上读不到 Edge/WebView2 版本，装不了匹配的驱动。"

# Try the exact runtime build first, then walk back.
#
# 2026-09-19：CI 上 `curl: (22) ... 400` 卡红过一个 PR ✗ —— 微软那个 CDN 对**某些具体版本**
# 会返回 400（同一个地址在人肉下载时又是好的 ✓），所以只试"目标版本 + 同主版本最新"不够 ✗。
# 这里改成**逐级回退**（同主版本里往前找几个 ✓），并且**把试过的每个版本与它的 HTTP 码都打出来** ✓
# —— 下次再红，日志里直接能看出是"CDN 挂了"还是"版本被下架了" ✓，不用猜 ✓。
installed=""
tried=""
for candidate in "$target" "$(latest_for_major "$target")" \
                 "$(latest_for_major $(( ${target%%.*} - 1 )) 2>/dev/null)" ; do
  [ -n "$candidate" ] || continue
  case " $tried " in *" $candidate "*) continue ;; esac
  tried="$tried $candidate"
  printf '==> 试 msedgedriver %s\n' "$candidate"
  if curl -fsSL --retry 2 --retry-delay 3 --max-time 300 \
    "$BASE/$candidate/edgedriver_win64.zip" -o "$ZIP"; then
    installed="$candidate"
    break
  fi
  printf '    这个版本拿不到（见上面的 curl 错误码）—— 继续往下一个候选 ✓\n'
done
[ -n "$installed" ] || die "微软那边没有可下载的 msedgedriver（试过：${tried:-无}）。看上面的 curl 错误码：400/404 是版本被下架或地址变了，超时/5xx 是 CDN 抖动——这两种要分开处理 ✗。"

if command -v unzip >/dev/null 2>&1; then
  unzip -o -q "$ZIP" -d "$DEST"
else
  powershell.exe -NoProfile -Command \
    "Expand-Archive -LiteralPath '$(cygpath -w "$ZIP")' -DestinationPath '$(cygpath -w "$DEST")' -Force"
fi
rm -f "$ZIP"
[ -f "$DRIVER" ] || die "解压后没看到 $DRIVER。"

reported="$("$DRIVER" --version 2>&1 | head -n 1 | tr -d '\r')"
printf '==> msedgedriver：%s\n' "$reported"
# Take the *first* dotted version in the line: a greedy sed would happily start
# inside "152.…" and report a major of 2.
reported_version="$(printf '%s' "$reported" | grep -oE '[0-9]+(\.[0-9]+){3}' | head -n 1 || true)"
if [ -n "$reported_version" ] && [ "${reported_version%%.*}" != "${installed%%.*}" ]; then
  die "驱动的主版本 ${reported_version%%.*} 和下载的 ${installed%%.*} 对不上——会话会挂住，先修这个。"
fi

# Put it on PATH for the following steps. GITHUB_PATH wants Windows paths: the
# runner prepends the lines verbatim, so a Git Bash path would be useless.
if [ -n "${GITHUB_PATH:-}" ]; then
  printf '%s\n' "$(cygpath -w "$DEST" 2>/dev/null || printf '%s' "$DEST")" >> "$GITHUB_PATH"
  printf '==> 已加入 PATH（后续步骤生效）\n'
fi

printf '==> 装好了：%s\n' "$DRIVER"
