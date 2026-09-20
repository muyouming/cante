#!/usr/bin/env bash
# 秘密扫描 —— 一道便宜、确定、三平台都能跑的保险。
#
# 这个仓库是 public 的：一旦把密钥、内网地址或本机家目录提交进去，历史就洗不干净了
# （本仓库已经因此停下过两次）。CI 在"构建"之前跑这一步，几秒钟出结果；本地也能跑：
#
#   bash gui/scripts/secret-scan.sh
#
# 扫"会被提交的东西"：已跟踪的文件 **加上** 还没跟踪但没被 gitignore 的新文件。
#
# 为什么必须含未跟踪的那部分（这是一次真事故换来的）：
#   起初只扫 `git ls-files`（＝只扫已跟踪）。于是**刚写出来、还没 git add 的新文件根本不在扫描范围里** ✗。
#   一次 PR 里，agent 自己跑 `e2e.sh`（第一步就是这个扫描）得到 OK，因为那个测试文件当时**还没被跟踪**；
#   等到 CI 上文件已提交，同一个扫描立刻抓到「本机家目录字面量」并红 ✗ ——
#   本地绿、CI 红，差一点就这么合进 main。
#   现在用 `--cached --others --exclude-standard`：已跟踪的 + 未跟踪但未被忽略的；
#   构建产物 / node_modules / target 仍然不在范围里（它们被 gitignore 忽略），噪音不会回来。
#   —— 扫的始终是"提交之后会被看到的东西"。
#
# 命中就红（退出码 1），并打印 `文件:行号: 命中了什么`。
# 白名单是 gui/scripts/secret-scan.allow：每一行都必须有紧邻上方的 # 注释写原因，
# 它记的是"审过的例外"，不是把红变绿的地方。
#
# 只用 bash + git + grep/sort/tr，不装任何东西（gitleaks 之类要联网下载，这里不引）。
set -euo pipefail

here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
allow_file="$here/secret-scan.allow"

# 从仓库根扫：git ls-files 输出的是仓库相对路径，报告里一眼能对上。
repo_root="$(git -C "$here" rev-parse --show-toplevel 2>/dev/null || true)"
if [ -z "$repo_root" ]; then
  printf 'secret-scan: 这里不是 git 仓库，列不出会被提交的文件\n' >&2
  exit 2
fi
cd "$repo_root"
allow_display="gui/scripts/secret-scan.allow"

# ---------------------------------------------------------------------------
# 规则
#
# 每条规则一个 ERE；注释里的例子都用占位写法，脚本自己不会命中自己。
# ---------------------------------------------------------------------------

# API key 形态：sk- 后面跟 20+ 个 [A-Za-z0-9_-]。占位符（sk-xxxx…、sk-YOUR_KEY、
# sk-<key> 等）由 key_is_real 事后放行 —— ERE 没有负向环视，所以分成两步。
KEY_RE='sk-[A-Za-z0-9_-]{20,}'

# 私有网段：192.168.x、172.16–172.31.x，以及 URL 里的 10.x（裸的 10. 会误伤版本号
# 和 10.5 这种小数，所以只在 ://10. 这种明确的 IP/URL 上下文里报）。
PRIVATE_IP_RE='(192\.168\.[0-9]|://10\.[0-9]|172\.(1[6-9]|2[0-9]|3[01])\.[0-9])'

# 本机家目录字面量：macOS/Linux 的 /Users/<用户名>、/home/<用户名>，Windows 的
# C:\Users\<用户名>。首字符不是 .，所以 /home/.ante 这种逻辑路径不会误报；同样是
# 占位符的 <用户>、%USERPROFILE%、~/ 因为首字符落在排除集里，天然不报。
_HOME_TAIL='[^[:space:]/\\<>%$~*?(),;:.{}`"][^[:space:]/\\<>%$~*?(),;:{}`"]*'
HOME_POSIX_RE="/(Users|home)/$_HOME_TAIL"
HOME_WIN_RE="[Cc]:[\\\\/]+[Uu]sers[\\\\/]+$_HOME_TAIL"

# 通用文档占位符用户名（RFC/文档惯例，不是真人）：这些不算命中。
# 本仓库自己的夹具用户名（示例里的客户/机器名）不在这里 —— 那是"审过的例外"，
# 放 secret-scan.allow 里，免得把一个通用扫描器写成本仓库专用。
# 「你」和「you」同义，是同一类文档占位（本仓库的界面语言是中文）。
is_placeholder_user() {
  case "$1" in
    user|username|name|example|you|yourname|someone|x|你) return 0 ;;
    # 「省略号」是通用的占位写法（`C:\Users\…` 读起来就是"某个用户名"），
    # 文档里这么写是**对的**，规则该放行 —— 否则闸门会把好习惯也判成违规 ✗。
    "…"|"..."|xxx|xxxx|xxxxx|用户名|用户|某用户|某某) return 0 ;;
  esac
  return 1
}

# key_is_real：返回 0 表示"这是真的密钥形态"，返回 1 表示"是占位符，放行"。
key_is_real() {
  local body="${1#sk-}" upper
  # 全是同一种填充字符（xX*._-）的，是占位符。
  case "$body" in
    *[!xX*._-]*) : ;;
    *) return 1 ;;
  esac
  upper="$(printf '%s' "$body" | tr '[:lower:]' '[:upper:]')"
  case "$upper" in
    *YOUR*|*KEY*|*EXAMPLE*|*PLACEHOLDER*|*CHANGEME*|*SAMPLE*|*DUMMY*|*FAKE*|*TODO*|*XXXX*)
      return 1 ;;
  esac
  return 0
}

# home_is_real：从命中片段里取出用户名；通用占位符放行。
home_is_real() {
  local user="$1"
  # 剥掉路径前缀，只留"用户名"那一段：POSIX 的两种家目录写法与 Windows 的那种
  # （大小写、正反斜杠都可能）都要认，否则 Windows 形态会把整条路径当成用户名，
  # 占位符判断就永远不生效 ✗。
  # 注：这段注释本身也刻意不写完整的家目录前缀 —— 脚本会扫自己，注释里用占位写法
  # 才不会被自己的规则命中（这是这个文件的约定）。
  # 剥成一串**单个**反斜杠再取第一段 —— 不能只删一个 ✗：TS / JSON 源码里路径是
  # 双反斜杠转义的（"C:\\\\Users\\\\user" 这种），只删一个会剩下 "\\user"，
  # 占位符白名单就永远不生效，闸门会把**正确写法**判成违规 ✗（实测踩过）。
  # POSIX 的两种家目录写法与 Windows 的那种（大小写、正反斜杠、以及**双反斜杠**
  # 转义都可能）都要认 ✗：TS / JSON 源码里路径是 "C:\\\\Users\\\\user" 这种，
  # 只删一个反斜杠会剩下 "\\user"，占位符白名单就永远不生效，
  # 闸门会把**正确写法**判成违规 ✗（实测踩过）。
  user="$(printf '%s' "$1" | sed -E 's#^/(Users|home)/##; s#^.*[Uu]sers[*\\/]+##; s#^[*\\/]+##; s#[/].*$##; s#\\+.*$##')"
  is_placeholder_user "$user" && return 1
  return 0
}

# ---------------------------------------------------------------------------
# 白名单：gui/scripts/secret-scan.allow
#
# 每行 `路径[:规则名]`，路径支持 shell 通配（* ? [..]）；规则名省略表示该路径的全部规则。
# 规则名只能是 api-key / private-ip / home-dir。每条上方必须有一行 # 写原因，否则脚本
# 自己报错退出（2）—— "白名单条目为什么存在"必须写在文件里，而不是只在某次 PR 讨论里。
# ---------------------------------------------------------------------------
allow_count=0
allow_paths=()
allow_rules=()

load_allowlist() {
  [ -f "$allow_file" ] || return 0
  local raw line rule entry prev_comment=0 lineno=0
  while IFS= read -r raw || [ -n "$raw" ]; do
    lineno=$((lineno + 1))
    line="${raw#"${raw%%[![:space:]]*}"}"
    line="${line%"${line##*[![:space:]]}"}"
    [ -z "$line" ] && continue
    case "$line" in
      \#*) prev_comment=1; continue ;;
    esac
    if [ "$prev_comment" -eq 0 ]; then
      printf 'secret-scan: %s:%d 白名单条目没有原因注释（每行上方必须有一行 # 说明）\n' \
        "$allow_display" "$lineno" >&2
      exit 2
    fi
    prev_comment=0
    rule='*'
    entry="$line"
    case "$entry" in
      *:api-key|*:private-ip|*:home-dir)
        rule="${entry##*:}"
        entry="${entry%:*}" ;;
      *:*)
        printf 'secret-scan: %s:%d 未知的规则名（只能是 api-key / private-ip / home-dir）\n' \
          "$allow_display" "$lineno" >&2
        exit 2 ;;
    esac
    allow_paths+=("$entry")
    allow_rules+=("$rule")
    allow_count=$((allow_count + 1))
  done < "$allow_file"
}

is_allowed() {
  [ "$allow_count" -eq 0 ] && return 1
  local path="$1" rule="$2" i=0
  while [ "$i" -lt "$allow_count" ]; do
    if [ "${allow_rules[$i]}" = '*' ] || [ "${allow_rules[$i]}" = "$rule" ]; then
      case "$path" in
        ${allow_paths[$i]}) return 0 ;;
      esac
    fi
    i=$((i + 1))
  done
  return 1
}

# ---------------------------------------------------------------------------
# 扫描
# ---------------------------------------------------------------------------
failed=0
allowed_hits=0

emit_hit() { # 规则 标签 路径 行号 命中片段
  local rule="$1" label="$2" path="$3" line="$4" match="$5"
  if is_allowed "$path" "$rule"; then
    allowed_hits=$((allowed_hits + 1))
    return 0
  fi
  failed=1
  if [ "${#match}" -gt 120 ]; then
    match="${match:0:117}..."
  fi
  printf '%s:%s: %s: %s\n' "$path" "$line" "$label" "$match"
}

# scan_bulk 规则 标签 正则 [过滤器]
# 用 git ls-files 列出「会被提交的文件」（已跟踪 + 未跟踪但未被忽略），一次 grep 扫完
scan_bulk() {
  local rule="$1" label="$2" regex="$3" filter="${4:-}"
  local hits hit path line match rest
  hits="$(git ls-files -z --cached --others --exclude-standard \
    | xargs -0 grep -nIoHE -e "$regex" 2>/dev/null | sort -u || true)"
  [ -z "$hits" ] && return 0
  while IFS= read -r hit; do
    [ -z "$hit" ] && continue
    # grep -o 的输出是 文件:行号:命中。命中片段里可以有冒号（Windows 盘符写法），
    # 所以从左往右切：仓库里的路径不含冒号，行号一定是数字。
    path="${hit%%:*}"
    rest="${hit#*:}"
    line="${rest%%:*}"
    match="${rest#*:}"
    case "$line" in ''|*[!0-9]*) continue ;; esac
    if [ -n "$filter" ] && ! "$filter" "$match"; then
      continue
    fi
    emit_hit "$rule" "$label" "$path" "$line" "$match"
  done <<< "$hits"
}

load_allowlist

scan_bulk api-key 'API key 形态' "$KEY_RE" key_is_real
scan_bulk private-ip '内网地址' "$PRIVATE_IP_RE"
scan_bulk home-dir '本机家目录' "$HOME_POSIX_RE" home_is_real
scan_bulk home-dir '本机家目录' "$HOME_WIN_RE" home_is_real

if [ "$failed" -ne 0 ]; then
  printf '\nsecret-scan: FAIL —— 上面每一条都要处理。\n' >&2
  printf '  改成环境变量/本机配置文件，或写成占位符（如 sk-…、<用户名>）；\n' >&2
  printf '  已经提交过的密钥要去服务端吊销，别用 force push 掩盖。\n' >&2
  printf '  确实无害且无法改写的，才按格式加进 %s 并写清原因。\n' "$allow_display" >&2
  exit 1
fi

scanned="$(git ls-files | wc -l | tr -d ' ')"
printf 'secret-scan: OK —— %s 个会被提交的文件，没有密钥、内网地址或本机家目录字面量' "$scanned"
if [ "$allowed_hits" -gt 0 ]; then
  printf '（放行 %d 条已审阅的例外）' "$allowed_hits"
fi
printf '\n'
