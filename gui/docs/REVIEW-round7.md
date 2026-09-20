# 第 7 轮独立评审：三条机械核查

- 对象：分支 `ws/r7-review`，HEAD `d5fedc8`（从 `main` 起）
- 机器：macOS（本机），日期 2026-09-20
- 先决条件：`bash gui/scripts/e2e.sh` 已先跑过一次，**9/9 绿，EXIT=0**（见下方核查零）
- 纪律：本报告只报**可复跑的事实**与**不一致**。**不含**"我觉得应该改成…"这类主观建议。
  核不出来的，写「没核出来 + 原因」，**不写成"通过"**。
- 本文件是本次评审**唯一**新增的文件；没有改动任何代码或既有文档（`git status` 见核查零）。

> 说明：本机没有 `timeout`/`gtimeout`（`command -v` 为空），所以所有可能变慢的命令都用
> `bash` 后台 + `kill -9` 硬超时的写法，日志落到 `/tmp`，下面贴的是**原始输出尾巴**。
> 因为并发跑在同一台机器上的其它 agent 也往 `/tmp/e2e-r7.log` 写，第一次的日志被串了；
> 之后改用带时间戳的唯一路径。

---

## 核查零（前置）：e2e 门禁不绿则后面都无从谈起

**结论：绿。** 9 步全过，`EXIT=0`。测后 `git status --porcelain` 为空（本报告写入前）。

命令（本机无 `timeout`，用后台 + 硬超时）：

```bash
cd /Volumes/External/cante-work/wt/r7-review
LOG=/tmp/r7review-e2e-$(date +%s).log
( bash gui/scripts/e2e.sh > "$LOG" 2>&1; echo "EXIT=$?" >> "$LOG" ) &
pid=$!
for i in $(seq 1 1800); do kill -0 $pid 2>/dev/null || break; sleep 1; done
if kill -0 $pid 2>/dev/null; then kill -TERM $pid; sleep 2; kill -9 $pid; echo "TIMEOUT=1800s" >> "$LOG"; fi
grep -nE "^==> |^e2e:|^EXIT|FAIL|TIMEOUT" "$LOG" | tail -30
```

输出尾巴（实测，未删改）：

```
2:==> [1/9] secret scan
5:==> [2/9] bun install
10:==> [3/9] third-party licenses are current
13:==> [4/9] bun test src
1190:==> [5/9] bunx tsc --noEmit
1192:==> [6/9] bun run build:web
1211:==> [7/9] bun test fixtures
1233:==> [8/9] cargo test (src-tauri)
1602:==> [9/9] dom smoke (rendered UI in Chrome; skipped on Windows)
1658:e2e: OK (9/9 steps passed)
1659:EXIT=0
```

工作区是否被测试弄脏：

```bash
git status --porcelain   # 空 → 干净
```

---

## 核查一：`gui/VERIFICATION-MAP.md` 指的"证据"真的存在、真的能跑吗

**结论（先行）**

- 表里指的**脚本**：本地部分基本都在 ✓；**发现 1 个不存在的路径 ✗**（最有价值的一条，见 1.2）。
- 表里指的**记录文件**：都在 ✓（`WINDOWS-ACCEPTANCE-N.md` 缺 9、12 两号，见 1.3）。
- **能跑**：`e2e.sh`、`secret-scan.sh`、`license-inventory.sh --check`、`dom-smoke.sh`、`measure-web.sh`、
  `measure-prompts.ts`、`task-sweep.sh --list`、`verify-bundle.sh` 全部在本机跑出确定结果 ✓。
- **存在但本机跑不了**：`gui/scripts/zoom/driver.py`（缺 Python 依赖 `websockets`）✗；
  所有 `gui/scripts/windows/*.ps1`（本机没有 PowerShell）✗ —— 原因见 1.4。

### 1.1 存在性：逐个核

命令：

```bash
cd /Volumes/External/cante-work/wt/r7-review
for f in \
  gui/scripts/e2e.sh gui/scripts/secret-scan.sh gui/scripts/license-inventory.sh \
  gui/scripts/dom-smoke.sh gui/scripts/zoom/driver.py gui/scripts/measure-web.sh \
  gui/scripts/measure-prompts.ts gui/scripts/verify-bundle.sh gui/scripts/task-sweep.sh \
  gui/DEVELOPING-WINDOWS.md gui/DEVELOPING-WINDOWS-VM.md \
  gui/scripts/windows/inspect-installer.ps1 gui/scripts/windows/accept-first-screen.ps1 \
  gui/scripts/windows/run-accept-drive.ps1 gui/scripts/windows/verify-bundle.sh \
  gui/scripts/windows/agent-dashboard.ps1 gui/scripts/windows/accept-paths.ps1 \
  gui/scripts/windows/run-offline.ps1 gui/scripts/windows/run-results-audit.ps1 \
  gui/scripts/windows/read-result-page.ps1 gui/scripts/windows/scale/read-display-config.ps1 \
  gui/scripts/windows/scale/scroll-reach.ps1 gui/scripts/windows/measure-scale-viewport.ps1 \
  gui/scripts/windows/scale-probe.ps1 gui/scripts/windows/scroll-reach-scale.ps1 \
  gui/scripts/windows/a11y-uia.ps1 gui/scripts/windows/a11y/narrate-script.ps1 \
  gui/scripts/windows/a11y/probe-tts-duration.ps1 gui/scripts/windows/a11y/probe-view-counts.ps1 \
  gui/scripts/windows/capture-window.ps1 gui/scripts/windows/collect-environment.ps1 \
  gui/scripts/windows/probe-installed-app.ps1 gui/scripts/windows/dump-window-text.ps1 \
  gui/SWEEP-0.2.1.md .github/workflows/gui.yml .github/workflows/gui-release.yml \
  gui/src/simple/copy.ts gui/src/simple/copy-print.ts gui/src/simple/location.ts \
; do if [ -e "$f" ]; then echo "EXISTS  $f"; else echo "MISSING $f"; fi; done
```

输出（节选，只留非 EXISTS 与关键行——完整输出 37 行，仅 `verify-bundle.sh` 一行不达标）：

```
EXISTS  gui/scripts/zoom/driver.py
EXISTS  gui/scripts/windows/run-offline.ps1
EXISTS  gui/scripts/windows/run-results-audit.ps1
MISSING gui/scripts/windows/verify-bundle.sh      ← ✗ 见 1.2
EXISTS  gui/scripts/windows/a11y-uia.ps1
EXISTS  gui/scripts/windows/a11y/narrate-script.ps1
EXISTS  gui/SWEEP-0.2.1.md
```

### 1.2 ✗ `VERIFICATION-MAP.md` 第 32 行指到一个**不存在**的脚本路径

表里原文（第 32 行）：

```
| **产物闸门（安装目录）** | `gui\scripts\windows\verify-bundle.sh --dir <安装目录>` | 四个可执行文件 + 随包执行组件都在、都能跑 ✓ | 安装包内部（要装完才看得到 ✓）|
```

核对命令与输出：

```bash
ls -la gui/scripts/windows/verify-bundle.sh          # No such file or directory
ls -la gui/scripts/windows/ | grep -i bundle         # (none)
git log --oneline --all -- gui/scripts/windows/verify-bundle.sh   # 空 → 这个路径从未存在过
```

```
ls: gui/scripts/windows/verify-bundle.sh: No such file or directory
(none)
(空)
```

**实际情况**：真正带 `--dir`（安装目录）模式的是**另一个文件** `gui/scripts/verify-bundle.sh`
（第 14 行注释就写着 `--dir <安装目录>  # Windows：主程序所在目录`，第 35 行 usage 也列了）。
该脚本在本机能跑：

```bash
bash gui/scripts/verify-bundle.sh                      # 打印 usage，EXIT=2
bash gui/scripts/verify-bundle.sh --dir /nonexistent-xyz   # "找不到 …"，EXIT=2
bash gui/scripts/verify-bundle.sh --build-dir src-tauri/target/release
```

```
用法: verify-bundle.sh --app <Cante.app> | --dmg <x.dmg> | --dir <安装目录> | --build-dir <target/release>
      [--expect-executor | --no-expect-executor]   # 默认：Windows 上要求，其它平台不要求
no-args EXIT=2
verify-bundle: 找不到 /nonexistent-xyz
bad-dir EXIT=2
```

`--build-dir` 那次**正确地 FAIL 了**（本机只编了 `cante-pdf`/`cante-sheets` 两个工具，没有主程序与桥）：

```
verify-bundle: 检查 dir src-tauri/target/release
① 四个可执行文件
  ✗ 缺 cante-gui —— 主程序旁边只找到：cante-pdf cante-sheets
  ✗ 缺 cante-sheets —— 主程序旁边只找到：cante-pdf cante-sheets
  ✗ 缺 cante-pdf —— 主程序旁边只找到：cante-pdf cante-sheets
  ✗ 缺 cante-bridge —— 主程序旁边只找到：cante-pdf cante-sheets
verify-bundle: FAIL —— 4 处不达标（上面每条都写清了缺什么）
EXIT=1
```

> 事实记录：① 的"缺"行把 `cante-sheets`/`cante-pdf` 也报成"缺"，与同一行"只找到：cante-pdf cante-sheets"
> 并列出现。原因是 `pick_bin` 只认**非空普通文件**（`-f` 且 `-s`），而这两个是 0 字节占位——
> 所以"找到了名字"但"不算数"。这是脚本的**既有打印口径**，不是本轮产出，仅记录现象。

### 1.3 记录文件（证据）在不在

```bash
ls gui/WINDOWS-ACCEPTANCE-*.md | wc -l          # 21
ls gui/SWEEP-*.md                                # SWEEP-0.2.1.md SWEEP-0.2.1-full.md
ls gui/docs/INDEPENDENT-REVIEW-2026-09-20.md     # 存在
for n in $(seq 1 23); do [ -e "gui/WINDOWS-ACCEPTANCE-$n.md" ] || echo -n "$n "; done
```

```
21
gui/SWEEP-0.2.1.md
gui/SWEEP-0.2.1-full.md
gui/docs/INDEPENDENT-REVIEW-2026-09-20.md
缺号：9 12
```

- `VERIFICATION-MAP.md` 里的通配指代 `WINDOWS-ACCEPTANCE-N.md` / `SWEEP-*.md`（第 58–59 行）指向的是
  **一类记录文件**，不是某一个具体文件；这类文件存在 ✓。
- 现存编号 1–23 中**缺 9 与 12**，表里没有指名要 9 或 12，所以**不构成"表指了却不在"**；
  仅作事实记录。
- `C:\cante-sweep\report-YYYYMMDD.md` 这条（第 2 节「周度自动普查」）是**Windows 机器上的产物**，
  本机不存在、也没法核。原因：它只在那台验收机上、由计划任务写。

### 1.4 能跑 / 不能跑（本机）

| 项 | 结论 | 命令 / 原因 | 输出尾巴 |
| --- | --- | --- | --- |
| `e2e.sh` | **能跑** ✓ | `bash gui/scripts/e2e.sh` | `e2e: OK (9/9 steps passed)` / `EXIT=0` |
| `secret-scan.sh` | **能跑** ✓ | `bash scripts/secret-scan.sh` | `secret-scan: OK —— 633 个被跟踪的文件…（放行 19 条已审阅的例外）` |
| `license-inventory.sh --check` | **能跑** ✓ | `bash scripts/license-inventory.sh --check` | `…清单是最新的…（Rust 528 + npm 15 = 543 条；原文 230 份）` / `EXIT=0` |
| `dom-smoke.sh` | **能跑** ✓ | e2e 第 9 步（同一脚本） | 见核查零 |
| `measure-web.sh` | **能跑** ✓ | `SKIP_BUILD=1 bash scripts/measure-web.sh` | `measure-web: done …` / `EXIT=0`（见下） |
| `measure-prompts.ts` | **能跑** ✓ | `bun scripts/measure-prompts.ts` | 末行 `EXIT=0`（见下） |
| `task-sweep.sh --list` | **能跑**（只列，不跑任务） ✓ | `bash scripts/task-sweep.sh --list` | 38 行 / `EXIT=0` |
| `verify-bundle.sh` | **能跑** ✓ | 见 1.2 | usage `EXIT=2`；`--build-dir` 真产物 `FAIL EXIT=1` |
| `zoom/driver.py` | **存在，本机跑不了** ✗ | `python3 gui/scripts/zoom/driver.py` | `ModuleNotFoundError: No module named 'websockets'` / `EXIT=1` |
| `gui/scripts/windows/*.ps1`（全部） | **存在，本机跑不了** ✗ | `command -v pwsh powershell` 为空 | 本机无 PowerShell；它们本来就只在 Windows 验收机上跑 |

`measure-web.sh` 尾巴（第一次我用 180s 硬超时**把它判成"没跑完"**，实际是超时设短了；420s 这次跑完）：

```
    home: 5/5 runs reached the key element | median key element 14.1 ms, DOM 233 nodes
    wizard: 5/5 runs reached the key element | median key element 14.3 ms, DOM 36 nodes
measure-web: done (numbers only — this script does not assert a threshold)
EXIT=0
```

`measure-prompts.ts` 尾巴：

```
 结论：按「正文提没提」裁不安全 …… 按 accept 裁才安全，但那要把 accept 带进 buildPrompt ……
 块形状检查
  警告：出现没登记过的块标题，它们的字被算进「其它」：【她事先说过】
EXIT=0
```

`task-sweep.sh --list` 尾巴：

```
vision.table
research.brief
wechat.rollcall[贴进来]
wechat.missing
EXIT=0
```

**本机跑不了、且表里没写"只能在真机跑"的**：只有 `zoom/driver.py`。它的依赖缺失没有任何
在仓库里的安装说明（`grep -rn websockets --include='*.md'` 只在 `docs/SPIKE-ws-transport.md`
里出现，那是另一条链路 `py -m pip install websockets`，不是 `zoom/driver.py` 的说明书）。
表里对它的说明是「`python3 gui/scripts/zoom/driver.py`（先 `bun run build:web` ✓ …）」，
没有写它需要 `websockets`。这条**我没核出来它在本机能不能按表跑通**（原因：依赖不在）。
只记录事实：**本机缺依赖 → 跑不了**。

---

## 核查二：文案红线有没有被绕过

**结论（先行）**

- **5 条指定闸门全部绿** ✓（`secret-scan`、`copy-guard`、`typography`、`tone`、`platform`）。
- **人工抽查发现 2 个"闸门盲区"**：`copy-guard` 只走 `src/simple/`，所以
  ① `src/App.tsx` 里的内联中文**不在扫描范围**（实有 1 处：`微信`）；
  ② 范围 A 只扫 `copy*.ts`，所以 `src/simple/` 下**非 copy 的 `.ts`**（`approval.ts`、`capabilities.ts`、
  `catalog.ts` 等）里的用户可见中文**不在扫描范围**（下面列出）。
- `src/simple/*.tsx` 内联中文共 **121 处 / 5 个文件**，与 `copy-guard` 的台账数字**逐格相等**（见 2.2），
  说明"只许减少"的闸门在自己管辖范围内**确实在挡**。

### 2.1 五条指定闸门（命令 + 原始输出尾巴）

```bash
cd /Volumes/External/cante-work/wt/r7-review/gui
bash scripts/secret-scan.sh
bun test src/simple/copy-guard.test.ts
bun test src/simple/typography.test.ts
bun test src/simple/tone.test.ts
bun test src/simple/tasks/platform.test.ts
```

```
secret-scan: OK —— 633 个被跟踪的文件，没有密钥、内网地址或本机家目录字面量（放行 19 条已审阅的例外）
secret-scan EXIT=0
src/simple/copy-guard.test.ts   6 pass  0 fail  52 expect() calls  Ran 6 tests across 1 file. [582.00ms]
src/simple/typography.test.ts   4 pass  0 fail   5 expect() calls  Ran 4 tests across 1 file. [12.00ms]
src/simple/tone.test.ts         4 pass  0 fail  44 expect() calls  Ran 4 tests across 1 file. [131.00ms]
src/simple/tasks/platform.test.ts 6 pass 0 fail 79 expect() calls  Ran 6 tests across 1 file. [14.00ms]
```

> 事实记录（路径层面，不是产品问题）：任务书里写的是 `cd gui && bun test src/simple/platform.test.ts`，
> 但该文件的实际路径是 **`src/simple/tasks/platform.test.ts`**。按任务书那条路径跑会**匹配不到测试文件**：
>
> ```
> The following filters did not match any test files:
>  src/simple/platform.test.ts
> 8181 files were searched [8.00ms]
> ```
>
> `AGENTS.md` §2 的原文也是「`gui/src/simple/tasks/platform.test.ts` 会扫…」——**AGENTS.md 是对的**，
> 任务书里的路径写短了。

### 2.2 人工抽查：`src/simple/*.tsx` 里的内联中文（有就列）

只读复刻 `copy-guard` 的词法器（注释/字符串切分 + JSX 文本节点），但把扫描根从 `src/simple`
扩到**整个 `src/`**，好同时暴露盲区。脚本落在 `/tmp`（**没有**写进仓库）：

```bash
bun /tmp/r7-inline-audit.mjs /Volumes/External/cante-work/wt/r7-review/gui
```

每个 `.tsx` 的处数（自建词法器口径）：

```
  0  About.tsx            0  ApprovalSheet.tsx    0  ErrorView.tsx
  0  FocusLayer.tsx       0  HintText.tsx         0  History.tsx
  0  Home.tsx             0  Notice.tsx           0  QuestionSheet.tsx
  0  ResultsPanel.tsx     0  TaskCard.tsx         0  TaskLibrary.tsx
  0  Transcript.tsx       0  TranscriptLine.tsx   0  VirtualList.tsx
  0  Wizard.tsx           0  main.tsx
  1  App.tsx              13 PrivacyPanel.tsx     16 ResultCard.tsx
 19  ConfirmSheet.tsx     21 WechatImport.tsx     52 TaskRunner.tsx
```

与 `copy-guard.test.ts` 的 `INLINE_COPY_BUDGET` 台账**逐格一致**（`ConfirmSheet 19 / PrivacyPanel 13 /
ResultCard 16 / TaskRunner 52 / WechatImport 21`）→ 我的复刻是可信的，下面的盲区结论可用它背书。

**✓ 在 `src/simple` 内、被台账覆盖的 121 处**（示例，按文件；完整清单见命令输出）：

- `ResultCard.tsx`：`:58 做好了` / `:59 这件事没有做完` / `:375 这是一次试跑。它只说明了打算怎么做，没有改动任何文件。` / `:838 一键撤销（还原成动手前）` …
- `WechatImport.tsx`：`:74 打开电脑版微信，找到要整理的那个聊天。` / `:146 微信聊天记录整理` / `:206 开始整理` …
- `TaskRunner.tsx`：`:74 原来的文件都还在，没有被改动。…` / `:467 说一句话就行，剩下的我来做` / `:872 再试一次` …
- `PrivacyPanel.tsx`：`:155 你的内容去哪了` / `:211 联网时内容会发给帮你整理的服务方` …
- `ConfirmSheet.tsx`：`:194 动手前，先给你看一眼` / `:466 发消息一律是 0 条：…` / `:488 默认是不勾选的：结果会另存为新文件，原件一个字都不会变。` …

**✗ 盲区 A：`src/App.tsx` 的内联中文不在 `copy-guard` 扫描范围**

`copy-guard.test.ts` 第 426/437 行：`const ALL_FILES = walk(HERE);`（`HERE` = `src/simple`），
`COMPONENTS = ALL_FILES.filter(f => f.endsWith(".tsx"))` —— 所以**只走 `src/simple/` 下的 `.tsx`**。
`src/` 下另有 5 个 `.tsx` 从不被扫：

```bash
find src -name '*.tsx' | grep -v '^src/simple/'
# src/App.tsx
# src/main.tsx
# src/components/TranscriptLine.tsx
# src/components/Transcript.tsx
# src/components/VirtualList.tsx
```

其中**实有内联中文 1 处**（另 4 个文件 0 处）：

```
src/App.tsx:242 [string] 微信
```

对应源码（`App.tsx` 第 239–243 行）：

```tsx
renderTask={(task, instruction, onExit) =>
  task?.group === "微信" ? (
    <WechatImport store={store} />
  ) : (
```

这处是**分组判定值**（`task.group === "微信"`），不是直接渲染的句子；但它确实是内联中文字面量，
且 `App.tsx` 不在 `copy-guard` 任何范围里（既不在范围 B 的组件集合，也不是 `copy*.ts`）。
**只报事实**：该处中文不受任何文案闸门扫描。

**✗ 盲区 B：范围 A 只扫 `copy*.ts`，非 copy 的 `.ts` 里的用户可见中文不扫**

`COPY_MODULES` 的过滤（第 432–436 行）：`/^copy.*\.ts$/` 且非 `.test.ts` 且非 `copy-capability.ts`。
所以 `src/simple/` 下这些**非 copy 的 `.ts`** 全部落在范围外。按"字符串字面量含中文"口径列出
（13 个文件命中，节选，完整输出见命令）：

```bash
python3 - <<'PY'
import os,re
strlit=re.compile(r'["\'`][^"\'`]*[\u3400-\u9fff][^"\'`]*["\'`]')
for f in sorted(os.listdir('src/simple')):
    if not f.endswith('.ts') or f.endswith('.test.ts') or f.startswith('copy'): continue
    for i,line in enumerate(open('src/simple/'+f,encoding='utf8'),1):
        s=line.strip()
        if s.startswith(('//','*','/*')): continue
        if strlit.search(line): print(f"{f}:{i} {s[:100]}")
PY
```

```
approval.ts:30 read: "读取文件",
approval.ts:31 write: "写一个新文件",
approval.ts:35 bash: "运行一条命令",
approval.ts:43 agent: "让另一个助手去做一件事",
approval.ts:82 const action = ACTIONS[tool.name.toLowerCase()] ?? "做一步操作";
capabilities.ts:103 `这台电脑可以用 cante-sheets 读写表格文件${where}，包括 .xlsx。`,
capabilities.ts:109 "表名要用中文或普通文字：不能是空的，不能超过 31 个字，也不能带 \\ / ? * [ ] : 这些符号。",
capabilities.ts:219 "这个会话背后的助手可以直接看图片：照片和截图（jpg、png、heic、webp 等）都能看。",
capabilities.ts:225 "如果用户给了图片，先停下来如实说明看不了，并请他把表里的内容用文字写下来、…"
catalog.ts:19 const GROUP_ORDER: readonly TaskGroup[] = ["表格", "文件", "微信", "文书", "资料"];
catalog.ts:49 ["合并", "汇总", "合起来", "合成", "合成一张", "拼成", "拼起来", "并成一张"],
```

其中至少有一部分是**界面可见**的，不是内部数据：`approval.ts` 的 `ACTIONS` 经 `describeApproval()`
被 `ApprovalSheet.tsx:73` 渲染成 `<p>{tool.action}</p>`；`catalog.ts` 的 `GROUP_ORDER` 是分组名。
**只报事实**：这些模块不在 `copy-guard` 范围 A（只扫 `copy*.ts`）之内，也不在范围 B（只扫 `.tsx`）之内。

### 2.3 没核到的

- 我只做了**源码文本层**的抽查，没有渲染界面去逐句比对（那需要真 WebView2 / Chrome 驱动，
  属于 `dom-smoke` 与 Windows 真机验收的范围）。**本报告不据此断言"界面里一定没有别的内联文案"**。
- `src/components/*.tsx` 与 `App.tsx` 的**注释**里也有大量中文，按设计不算文案，未列入。

---

## 核查三：文档与代码说的是不是同一件事

挑了 3 条**具体事实断言**回代码核对（另附 1 条顺带发现的）。

### 3.1 ✗ 不一致：`CONTRACT.md` 的 `cante://state` 载荷少了字段

文档原文（`gui/CONTRACT.md` 第 95 行）：

```
| `cante://state` | `{ status: Status, session: SessionInfo | null, pending_approval: PendingApproval | null }` |
```

代码实际发出的载荷（`gui/src-tauri/src/protocol.rs` 第 250–258 行，`CanteState::to_value`，
`cante://state` 与 `events_since` 的 `state` 共用它）：

```rust
pub fn to_value(&self, cante: Option<&str>, cwd: &str) -> Value {
    json!({
        "status": self.status,
        "session": self.session,
        "pending_approval": self.pending_approval,
        "pending_question": self.pending_question,
        "cante": cante,
        "cwd": cwd,
    })
}
```

前端也确实**读** `pending_question`（`gui/src/store.ts` 第 631–635 行），并且
`gui/src/protocol.ts:124` 的 `BridgeStatePayload` 就带 `pending_question`、`cante`、`cwd`：

```ts
export interface BridgeStatePayload {
  status: "idle" | "thinking" | "streaming" | "awaiting" | "error" | "offline";
  session: SessionInfo | null;
  pending_approval: PendingApproval | null;
  pending_question: PendingQuestion | null;
  cante: string | null;
  cwd: string;
}
```

**不一致点**：文档的行只写了 3 个字段（`status`/`session`/`pending_approval`），
代码实际发 6 个（多 `pending_question`/`cante`/`cwd`），且**代码那 3 个多出来的字段前端真的在读**。
另外我在 `CONTRACT.md` 里 grep `pending_question`、`提问`、`r25`、`QuestionSheet` **均无命中**——
即这份"权威契约"里**没有**这半个暂停态的记载。

### 3.2 ✗ 不一致：`VERIFICATION-MAP.md` 指的路径不存在（同核查 1.2）

文档原文（第 32 行）：

```
| **产物闸门（安装目录）** | `gui\scripts\windows\verify-bundle.sh --dir <安装目录>` | … |
```

代码事实：仓库里**没有** `gui/scripts/windows/verify-bundle.sh`
（`ls` 报 No such file；`git log --all --` 该路径为空，从未存在过）；
带 `--dir` 模式的是 `gui/scripts/verify-bundle.sh`（第 14 行）。两边原文见 1.2，此处不重复。

### 3.3 ✗ 不一致：任务卡数量——文档说 32，代码里是 33

文档原文：

- `AGENTS.md` 第 11 行：`…**只有一个界面**（简单模式），32 张任务卡，…`
- `gui/CONTRACT.md` 第 349 行：`…但简单界面只有 32 张固定卡片这一个入口，卡片来自 src/simple/tasks/index.ts 的静态表…`

代码事实（在 `gui/` 下跑）：

```bash
cat > /tmp/r7-count-tasks.ts <<'EOF'
import { TASKS } from "/Volumes/External/cante-work/wt/r7-review/gui/src/simple/tasks/index.ts";
console.log("TASKS length =", TASKS.length);
console.log(TASKS.map((t) => t.id).join("\n"));
EOF
bun /tmp/r7-count-tasks.ts
```

```
TASKS length = 33
excel.merge
excel.group
excel.tidy
excel.diff
excel.filter
excel.split
files.rename
files.archive
files.dupes
pdf.merge
pdf.split
pdf.toword
files.by-date
doc.notice
doc.leave
doc.report
doc.worksummary
doc.summary
check.totals
check.reconcile
invoice.ledger
invoice.dupes
invoice.crosscheck
admin.byperson
admin.changes
admin.expiry
vision.table
research.brief
wechat.table
wechat.draft
wechat.batch
wechat.rollcall
wechat.missing
```

`TASKS.length === 33`，而两份文档写 32。第 33 张是 `doc.worksummary`（`types`/目录里的
`worksummary.ts`），由 `#196`（提交 `58d9881`，2026-09-19）加入 —— 也就是**在写"32"的那两处之后**。
`AGENTS.md` 第 11 行成文于 `2d51937`（2026-09-16），`CONTRACT.md` 那句成文于 `1ef87b2`（2026-09-17）。

**顺带的一致性事实（这条是 ✓）**：`gui/SWEEP-0.2.1.md` 第 34 行的「20/32」是**一次历史运行的记录**
（表里第 58–59 行也写了"SWEEP-*.md 是一次运行的记录，不是承诺"）；`gui/SWEEP-0.2.1-full.md`
（提交 `2a61d74`，2026-09-18）声称的「覆盖率 32/32」，在它成文时也是**对的**（`git show 2a61d74:gui/src/simple/tasks/*.ts` 逐文件数 `id:` 得 3+1+2+3+4+6+3+1+2+1+1+5 = **32**）。
它是在 `#196` 之前，所以与"现在目录里有 33 张"不矛盾——但它**不能**被读成"今天的目录 33/33 全覆盖"。
实测今天的覆盖：`task-sweep.sh --list` 列 38 条，去重后**命中目录 32/33**，缺 `doc.worksummary`：

```bash
bun - <<'EOF'
import { TASKS } from ".../src/simple/tasks/index.ts";
const ids = TASKS.map(t => t.id).sort();
const listed = (await Bun.file("/tmp/r7-sweeplist.txt").text()).split("\n").map(s=>s.trim()).filter(Boolean).map(s=>s.replace(/\[.*\]$/,""));
const base=[...new Set(listed)].sort();
const inSweep=new Set(base);
console.log("catalogue cards:", ids.length);
console.log("sweep distinct cards:", base.length);
console.log("in catalogue but NOT in sweep plan:", ids.filter(x=>!inSweep.has(x)).join(", ")||"(none)");
EOF
```

```
catalogue cards: 33
sweep distinct cards: 32
in catalogue but NOT in sweep plan: doc.worksummary
```

### 3.4 ✗ 不一致（顺带发现）：`VERIFICATION-MAP.md` 写"四种错法"，脚本支持五种

文档原文（第 36 行）：

```
| **「服务方真的断了」的四种错法**（`wire` 真防火墙挡出站 / `proxy407` / `dead` / `cut` ✓） | `gui\scripts\windows\run-offline.ps1 -Scenario wire`（或 proxy407 / dead / cut） | … |
```

脚本事实（`gui/scripts/windows/run-offline.ps1` 第 34 行）：

```powershell
[Parameter(Mandatory = $true)][ValidateSet('dead', 'cut', 'forbid', 'wire', 'proxy407')][string]$Scenario,
```

`ValidateSet` 有 **5** 个值，脚本头第 6 行也写「五种现场（-Scenario）」：多出来的是 **`forbid`**
（代理回 403）。两边原文：

- 表：标题「**四种**错法」，括号里列 `wire / proxy407 / dead / cut`（4 个）；
- 脚本：`ValidateSet('dead','cut','forbid','wire','proxy407')`（5 个），且 `forbid` **有真机报告**
  （`gui/WINDOWS-ACCEPTANCE-13.md` 第 61、149 行；`WINDOWS-ACCEPTANCE-15.md` 同时覆盖了 `wire`/`proxy407`）。

**不一致点**：表把"五种"写成了"四种"，并列名了 `forbid` 缺席。

### 3.5 一致性抽查（这几条是 ✓，用来对照上面的"不一致"）

这些我核过、两边**对得上**（只列事实）：

| 文档断言 | 文档原文位置 | 代码事实 | 结论 |
| --- | --- | --- | --- |
| 事件环容量 4096 | `CONTRACT.md:117` `keep the last 4096 events` | `daemon.rs:21` `RING_CAPACITY: usize = 4096` | ✓ |
| 静默预算 600 s | `CONTRACT.md`（"The silence budget is 600 s"）| `bridge.rs:61` `STALL_TIMEOUT = Duration::from_secs(600)` | ✓ |
| 静默报错开头句 | `CONTRACT.md`（Wording 行）| `bridge.rs:71` `STALL_HEADLINE = "连不上帮你处理的服务方"` | ✓ |
| 许可总数 543 | `ROADMAP.md:138`「543 条清单」 | `license-inventory.sh --check` 输出 `Rust 528 + npm 15 = 543` | ✓ |
| 周报文件名 `report-YYYYMMDD.md` + 保留 8 | `DEVELOPING-WINDOWS.md:338` | `weekly-sweep.ps1:70-71` `Get-Date -Format 'yyyyMMdd'` → `report-$stamp.md`；`:43` `$Keep = 8` | ✓ |
| `.ps1` 必须 UTF-8 带 BOM | `DEVELOPING-WINDOWS.md:118` | 53 个 `scripts/**/*.ps1` 全部以 `efbbbf` 开头 | ✓ |
| Windows 验收退出码 `0/2/3` | `VERIFICATION-MAP.md`（第四节）| `run-offline.ps1` 头注释 + `accept-first-screen.ps1` / `run-accept-drive.ps1` 头注释一致 | ✓ |

---

## 没核到的（单独列，**不写成"通过"**）

1. **`gui/scripts/windows/*.ps1` 全部没跑**。原因：本机是 macOS，`command -v pwsh powershell` 为空。
   我只看它们的**源码文本**（BOM、`ValidateSet`、退出码注释、参数块），**没有执行**。
   它们在真 Windows 上是否真能跑，本报告**不表态**。
2. **`zoom/driver.py` 没跑通**。原因：本机缺 Python 依赖 `websockets`（`ModuleNotFoundError`）。
   它声称的能力（125%/150% 版面数字）本报告**未复现**。
3. **`task-sweep.sh` 只跑了 `--list`**，没跑任何真实卡片（需要模型端点真跑一轮，耗时不可控，
   且任务书要求"只跑不改变状态的那些"）。所以"普查结果是否属实"本报告**没核**。
4. **Windows 真机上的记录文件内容**（`WINDOWS-ACCEPTANCE-N.md` 里写的输出、截图、sha256）
   **没核**内容真伪 —— 只核了文件**存在**。要核内容需要那台机器与产物，本机没有。
5. **`C:\cante-sweep\report-YYYYMMDD.md`**（周报产物）本机不存在、无从核。
6. **界面渲染层**的文案比对（真 WebView2 / Chrome）**没核**：核查二只做了源码文本层抽查。
7. **`verify-bundle.sh` 的 dmg 分支没跑**：本机没有打出来的 `.dmg` 产物
   （`find gui/src-tauri/target -name '*.dmg'` 为空）。只跑了 usage/`--dir`/`--build-dir` 三条。
8. **`license-inventory.sh` 的原文完整性**没核：只核了"清单是否过期"（`--check` 绿）。
   表里本来就写明它**不**覆盖"许可原文是否齐全"。

---

## 一句话汇总（只陈述事实）

- 核查一：表里指的脚本**几乎都在**；**1 个路径不存在**（`gui\scripts\windows\verify-bundle.sh`），
  真身在 `gui/scripts/verify-bundle.sh`。记录文件都在；`zoom/driver.py` 本机缺依赖跑不了；
  全部 `.ps1` 本机跑不了（无 PowerShell）。
- 核查二：5 条闸门**全绿**；`src/simple` 内联中文 121 处与台账逐格相等；
  但 `src/App.tsx`（1 处）与 `src/simple` 下**非 copy 的 `.ts`**（13 文件命中）**不在扫描范围**。
- 核查三：`CONTRACT.md` 的 `cante://state` 载荷少 3 个字段（含前端在读的 `pending_question`）；
  卡片数文档 32 / 代码 33；`VERIFICATION-MAP.md` 一处路径不存在、一处"四种"实为五种。
