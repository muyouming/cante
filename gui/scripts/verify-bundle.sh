#!/usr/bin/env bash
#
# 打开**产物**看里面到底有什么 —— 这是打包那条链唯一不会骗人的检查。
#
# 为什么要有它（#141 的根因）：
#   v0.2.1 的 `tauri.conf.json` 里既没有 `resources` 也没有 `externalBin`，静态测试
#   （`gui/src/packaging.test.ts`）也过了 —— 但**发布出去的 macOS dmg 里只有主程序** ✗，
#   两个自带工具根本没进去。三轮"真机验收"验的都是 Windows 安装包，**没有人打开过 macOS 的 dmg**。
#   教训写进了 `AGENTS.md` §3.6：说"已验证"之前，先问"我看的是它真的产出的那个东西吗"。
#
# 用法：
#   verify-bundle.sh --app <Cante.app 路径>
#   verify-bundle.sh --dmg <dmg 路径>            # 自己挂载、检查、卸载
#   verify-bundle.sh --dir <安装目录>            # Windows：主程序所在目录
#
# 检查内容（缺一个就非零退出，并说清缺哪个）：
#   ① 主程序 + 三个自带程序都在（cante-gui / cante-sheets / cante-pdf / cante-bridge）；
#   ② 三个自带程序**在包里**能执行并打出与主程序同版本的号；
#   ③ 没有 `.d`、没有 0 字节文件、没有多出来的目录（0.2.0 那批垃圾不许回来）。
set -uo pipefail

TARGET=""
MODE=""
DESC=""
SKIP_JUNK=0

usage() {
  echo "用法: verify-bundle.sh --app <Cante.app> | --dmg <x.dmg> | --dir <安装目录> | --build-dir <target/release>" >&2
  exit 2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --app) MODE=app; TARGET=${2:-}; shift 2 ;;
    --dmg) MODE=dmg; TARGET=${2:-}; shift 2 ;;
    --dir) MODE=dir; TARGET=${2:-}; shift 2 ;;
    # 构建目录（target/release）里本来就躺着 cargo 的 .d 与占位符 —— 那里查垃圾没有意义（③），
    # 只查"四个可执行文件在不在、能不能跑"。安装目录与 dmg 仍然查满 ③。
    --build-dir) MODE=dir; SKIP_JUNK=1; TARGET=${2:-}; shift 2 ;;
    *) usage ;;
  esac
done
[ -n "$MODE" ] && [ -n "$TARGET" ] || usage
[ -e "$TARGET" ] || { echo "verify-bundle: 找不到 $TARGET" >&2; exit 2; }

FAILS=0
note() { printf '  %s\n' "$*"; }
fail() { printf '  ✗ %s\n' "$*"; FAILS=$((FAILS + 1)); }
ok() { printf '  ✓ %s\n' "$*"; }

MNT=""
cleanup() { [ -n "$MNT" ] && hdiutil detach "$MNT" -quiet 2>/dev/null; [ -n "$MNT" ] && rmdir "$MNT" 2>/dev/null; }
trap cleanup EXIT

# ---- 找到"主程序所在目录"（macOS 是 Contents/MacOS，Windows 是安装目录）----
case "$MODE" in
  app) MACOS="$TARGET/Contents/MacOS" ;;
  dir) MACOS="$TARGET" ;;
  dmg)
    MNT="$(mktemp -d)"
    # 这个 dmg 带许可协议（SLA）：它会**从 stdin 读**接受与否 ✗，不喂它就直接 "attach canceled" ✓。
    # 另外不能用 `-acceptlicense`（这台 macOS 的 hdiutil 不认这个 flag，会报 usage 错）✗；
    # 用 `-mountpoint` 固定挂载点，免得拿到随机卷名（例如 dmg.PU0E4n）而按卷名找必扑空。
    # 注意 `set -o pipefail` 的坑：`yes` 会被 SIGPIPE 掉（退出码 141），整条管道会被判失败
    # —— 即使 hdiutil 成功了 ✗。所以在子 shell 里临时关掉 pipefail，只看 hdiutil 的结果。
    if ! ( set +o pipefail; yes 2>/dev/null | hdiutil attach -nobrowse -readonly -mountpoint "$MNT" "$TARGET" >/dev/null 2>&1 ); then
      echo "verify-bundle: 挂载失败：$TARGET" >&2
      exit 2
    fi
    APP="$(find "$MNT" -maxdepth 1 -name '*.app' | head -1)"
    [ -n "$APP" ] || { echo "verify-bundle: dmg 里没有 .app" >&2; exit 1; }
    DESC="（dmg: $(basename "$TARGET")）"
    MACOS="$APP/Contents/MacOS"
    ;;
esac

echo "verify-bundle: 检查 $MODE $TARGET $DESC"

# 在候选里挑出真正的那个可执行文件（macOS 没有扩展名，Windows always `.exe`）。
#
# 为什么不能只按固定顺序取第一个：Windows 的**构建目录**（target/release）里同时躺着
# `cante-pdf.exe`（真程序）、`cante-pdf`（0 字节占位）和 `cante-pdf.d`（依赖清单）——
# 0.2.0 的安装包当年就是把这一整套 glob 进去的（#141）。原来的顺序先看不带扩展名的那个，
# 于是在构建目录里挑中了 0 字节占位文件：`du` 报 0、`--version` 跑不出东西，闸门在
# Windows 上必红（真机实测）。现在：优先 `.exe`，并要求选中的是**非空**普通文件。
# 真程序不在时，候选落到 0 字节文件上会被 `-s` 拒掉，① 照样报「缺」、② 也跑不出东西
# —— 判据没有放松。
pick_bin() { # $1 = 目录，$2 = 不带扩展名的名字；找到就打印完整路径
  local dir="$1" name="$2" cand
  for cand in "$dir/$name.exe" "$dir/$name"; do
    [ -f "$cand" ] && [ -s "$cand" ] && { printf '%s' "$cand"; return 0; }
  done
  return 1
}

# ---- ① 四个可执行文件都在 ----
echo "① 四个可执行文件"
for bin in cante-gui cante-sheets cante-pdf cante-bridge; do
  found="$(pick_bin "$MACOS" "$bin" || true)"
  if [ -n "$found" ]; then
    ok "${bin}（$(du -h "$found" | cut -f1 | tr -d ' ')）"
  else
    fail "缺 $bin —— 主程序旁边只找到：$(ls -1 "$MACOS" 2>/dev/null | tr '\n' ' ')"
  fi
done

# ---- ② 自带程序**在包里**能跑，版本与 app 一致 ----
#
# 期望版本从 `.app/Contents/Info.plist` 读（权威 ✓）。**不要**去主程序里 grep 版本号 ✗ ——
# 第一版就是这么干的：它抓到了打包进前端 JS 的某个版本号（0.35.3），于是每个工具都被判成
# "对不上" ✗。Windows 的安装目录没有 Info.plist，那就只检查"能跑"，不去猜版本。
EXPECT=""
if [ "$MODE" = "app" ] || [ "$MODE" = "dmg" ]; then
  PLIST="$(dirname "$MACOS")/Info.plist"
  if [ -f "$PLIST" ]; then
    EXPECT="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$PLIST" 2>/dev/null || true)"
  fi
fi
if [ -n "$EXPECT" ]; then
  echo "② 包里能跑吗（期望版本 ${EXPECT}）"
else
  echo "② 包里能跑吗"
fi
for bin in cante-sheets cante-pdf cante-bridge; do
  cand="$(pick_bin "$MACOS" "$bin" || true)"
  [ -n "$cand" ] || continue
  out="$("$cand" --version 2>&1 | head -1)"
  if [ -z "$out" ]; then
    fail "${bin} 在包里跑不出东西（可能是架构不对或没执行权限）"
    continue
  fi
  ok "${bin} --version → $out"
  if [ -n "$EXPECT" ] && ! printf '%s' "$out" | grep -q "$EXPECT"; then
    fail "${bin} 的版本与 app（${EXPECT}）对不上 —— 打包时少编了一次？"
  fi
done

# ---- ③ 没有垃圾（0.2.0 那批：.d 清单 + 0 字节的无扩展名文件 + target/release 目录）----
if [ "$SKIP_JUNK" = "1" ]; then
  echo "③ 跳过（--build-dir：构建目录里本来就有 .d 与占位符；垃圾要查的是安装目录与 dmg）"
else
  echo "③ 有没有混进构建垃圾"
  junk="$(find "$MACOS" -maxdepth 1 -name '*.d' 2>/dev/null)"
  [ -z "$junk" ] && ok "没有 .d 依赖清单" || fail ".d 文件回来了：$(printf '%s ' $junk)"
  zero="$(find "$MACOS" -maxdepth 1 -type f -size 0 2>/dev/null)"
  [ -z "$zero" ] && ok "没有 0 字节文件" || fail "0 字节文件：$(printf '%s ' $zero)"
  # 排除根目录本身要用 `-mindepth 1`，不能用 `! -path "$MACOS"`：GNU find 在 -path 的
  # 模式里把 `\` 当转义符，Windows 路径 `C:\Users\…` 因此永远匹配不上它自己，安装目录
  # 会被当成「多出来的子目录」误报（Windows 真机实测，v0.2.1 安装目录）。
  dirs="$(find "$MACOS" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -v -E '/(Resources|Frameworks|_CodeSignature)$' || true)"
  [ -z "$dirs" ] && ok "没有多出来的子目录" || fail "多出来的目录：$(printf '%s ' $dirs)"
fi

echo
if [ "$FAILS" -eq 0 ]; then
  echo "verify-bundle: OK —— 四个可执行文件都在、都能跑、没有垃圾 ✓"
  exit 0
fi
echo "verify-bundle: FAIL —— $FAILS 处不达标（上面每条都写清了缺什么）" >&2
exit 1
