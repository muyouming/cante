# 第十次真机验收：把「跑一轮」变成**一行命令**，并真机跑通一次

> 这一轮做两件**能复用**的事（不等本机的新卡 ✗）：
> ① 把"装好的应用 + 零环境变量 → 点一张卡 → 真的出一份文件"这条验收链，从**一堆要记的
> `ACCEPT_*` 环境变量 + 手工清残留 + 手工造输入表**，收敛成**一行命令**
> `gui/scripts/windows/run-accept-drive.ps1`；② 在本机真机跑一次，留原始输出。
>
> 文件名写 `-10.md`：编号 **9 还空着**（`-9` 在前面的分支里都没有出现）。这个系列是**证据记录，
> 不覆盖前一份** ✗，所以按任务要求写成 `-10`，把 `-9` 留给别人。
>
> - **验收对象**：本机**已装好的** `cante-gui.exe` **0.2.3**
>   （`%LOCALAPPDATA%\Cante\`，从卸载注册表项的 `InstallLocation` 查到，不靠猜目录）
> - **验收机器**：Windows 11 家庭版 / `10.0.26200` / x64（真机）；WebView2 运行时 `153.0.4234.46`；
>   msedgedriver `153.0.4234.46`（版本一致 → 会话一次就建起来）
> - **起始提交**：`3cd59a9`（`origin/main`）；**工作分支**：`pool/win-build`
> - **验收人**：跑在那台机器上的 pi —— **不提权的交互会话**（实测 `elevated=False session=1`），
>   所以**就地跑**，没有走计划任务那条路
> - 本文里所有长命令都带了超时；**没有一条超时**。以下"确认没有"都是**列过目录/查过进程**之后写的。

---

## 0. 结论先行

1. **一行命令跑通了** ✓：合计 **35.4 秒**（前置检查 0 s / 造输入表 0.1 s / 跑一轮 35.2 s / 核对产出 0.1 s）。
   同一张卡、同一条命令又跑了几次，`跑一轮`这一步在 **26.6 s / 35.2 s / 45.6 s** 之间浮动
   （桥+pi 起进程、联网推理的时间；三个数都是**实测**，不是估计）——所以它不是个稳定值，
   但不影响结论。
   结果页出现「做好了」，盘上真的多出 `结果_挑出华东区.xlsx`（5655 字节），用应用自带的
   `cante-sheets read` 读回来**内容对得上**（3 行华东区），**原文件 sha256 前后一致** ✓（§2）。
2. **退出码真能区分环境问题与产品问题** ✓：故意给一张不存在的卡 → **退出码 3**（产品问题，
   说清"找不到哪张卡、等了多少毫秒"）；故意给一个不存在的 `-Exe` → **退出码 2**（环境问题）
   ✓（§4）。这条我**两种都真跑过**，不是照着约定写的 ✓。
3. **`verify-bundle.sh --dir` 对装好的目录跑了一次** ✓：四个可执行文件都在、都能跑、没有垃圾，
   执行组件（`pi\bun.exe` 等）该在的都在 ✓（§3）。
4. **顺手发现一个真 bug 并修了** ✓：`result.json` 的组装在 PowerShell 5.1 上**抛异常**
   （`@($genericList)` 放进哈希字面量），第一次跑退出码 2 但**没写出结构化结果**。见 §5 ——
   这条不改，"一行命令"在失败路径上就是坏的 ✗。
5. **我没能验证什么** ✗：见 §7（计划任务那条路、企业预置那台机器、`-WithEnv` 老路径、
   以及"新卡"本身）。

---

## 1. 一行命令长什么样

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File gui\scripts\windows\run-accept-drive.ps1
```

它**自己**做四件事（不用人记任何 `ACCEPT_*`）：

| # | 它自己做的事 | 依据 |
| --- | --- | --- |
| 1 | **判断会话**：不提权的交互会话就地跑；提权 / session 0 改走「当前用户 + Interactive + `RunLevel Limited`」的计划任务 | 照 `accept-first-screen.ps1` 那套，**没另起第二套**（AGENTS.md §3.6） |
| 2 | **清残留**：跑前杀掉残留的 `cante-gui`（残留实例让 WebDriver 拿不到调试端口，症状像"提权"） | `DEVELOPING-WINDOWS.md` 记的三个坑之一 |
| 3 | **造输入表**：用应用自带的 `cante-sheets write`（连输入都是产品自己的工具产出的；它不覆盖已存在文件 → 每次建在新的运行目录里） | `DEVELOPING-WINDOWS.md`："输入表可以用应用自带的 cante-sheets 造" |
| 4 | **设好整套 `ACCEPT_*`**（默认 `ACCEPT_ZERO_ENV=1`）→ 跑 `accept-drive.mjs` → **原样**打 phase 行与结果 → 再用 `cante-sheets` 把产出读回来核对 | `accept-install.ps1` 第 3~4 步 |

退出码（照 `accept-first-screen.ps1` 的 0/2/3 约定）：**0** = 通过；**2** = 环境问题
（找不到应用/驱动/组件、没有交互会话、会话建不起来）；**3** = 产品问题（窗口起来了，卡片流程失败）。

可调参数：`-Exe`（直接指可执行文件，不查注册表）、`-Card`（卡片名，默认「从大表里挑出想要的行」）、
`-Instruction`（写给助手的那句话）、`-WorkDir`、`-TimeoutSec`（整轮上限，默认 2100s）、
`-DriveTimeoutSec`（驱动上限，默认 1800s）、`-WithEnv`（老路径：替她设 `CANTE_BIN`/`PI_BIN`，对照用）。

> 为什么单卡上限是 1800s：AGENTS.md §5 实测慢模型一张卡要 850 秒，设 600 会把成功误判成失败。
> 本机这张卡这次只花了 35s（本地桥+pi，不是慢模型），但默认值必须按最坏情况留够。

---

## 2. 那次跑通的**原始输出**（一行命令，全程）

命令与输出（**未删改**，只把真实用户名收敛成 `<用户名>`）：

```
C:\cante-wt\ci> powershell -NoProfile -ExecutionPolicy Bypass -File gui\scripts\windows\run-accept-drive.ps1 -WorkDir C:\tmp\acc-real -TimeoutSec 2100 -DriveTimeoutSec 1800

=== 真机验收：跑一轮（Windows）===
会话：elevated=False session=1
工作目录：C:\tmp\acc-real
应用：C:\Users\<用户名>\AppData\Local\Cante\cante-gui.exe
模式：零环境变量（ACCEPT_ZERO_ENV=1，应用自己找组件）

==> 1. 前置检查
    （耗时 0s）
  应用目录：C:\Users\<用户名>\AppData\Local\Cante
  cante-sheets：C:\Users\<用户名>\AppData\Local\Cante\cante-sheets.exe
  tauri-driver：C:\Users\<用户名>\.cargo\bin\tauri-driver.exe
  msedgedriver：C:\Users\<用户名>\msedgedriver\msedgedriver.exe
  前置检查通过。

启动前没有残留的 cante-gui 实例。

==> 2. 造输入表（应用自带的 cante-sheets write）
    （耗时 0.1s）
  输入：C:\tmp\acc-real\job\销售明细.xlsx
  sha256=EFC84DB4240B9855064580DDC33E795C89354BF5E242FD733268BF95E2B51A82

==> 3. 跑一轮（accept-drive.mjs）
    （耗时 35.2s）
==> 应用：C:\Users\<用户名>\AppData\Local\Cante\cante-gui.exe
==> 零环境变量模式：不设 CANTE_BIN / PI_BIN，桥与执行组件由应用自己在旁边找
==> 工作目录：C:\tmp\acc-real\job
[phase] tauri-driver 就绪 …
[phase] tauri-driver 就绪 — 527 ms
[phase] 打开 WebDriver 会话（启动应用） …
[phase] 打开 WebDriver 会话（启动应用） — 444 ms
[phase] 首页出现 …
[phase] 首页出现 — 522 ms
--- 首页 ---
  | Cante
  | 历史
  | 隐私
  | 关于
  | 你好，需要我帮你做什么？
  | 点一张卡片，或者直接在下面说一句话。
  | 我做的结果
  | 上次做出来的表放在哪儿，这里都记着，随时能打开。
  | 打开我做的结果
  | 还有别的事？
  | 按你想做的事搜一搜，每一项都写清楚要准备什么、会动到什么。
  | 看看能做什么（共 32 项）
  | 表格
  | 合并、拆分、汇总、去重
[phase] 点卡片「从大表里挑出想要的行」 …
[phase] 点卡片「从大表里挑出想要的行」 — 49 ms
[phase] 选文件（原生对话框） …
[dialog] accept-file-dialog: 对话框 name='打开' pid=3832
[dialog] accept-file-dialog: 路径已写入（WM_SETTEXT(hwnd=1508344)），class='Edit'
[dialog] accept-file-dialog: 已点「打开」（BM_CLICK(hwnd=852906)）
[phase] 选文件（原生对话框） — 1441 ms
[phase] 写一句话并生成计划 …
[phase] 写一句话并生成计划 — 117 ms
[phase] 确认页 → 开始 …
--- 确认页（节选）---
  | Cante
  | 历史
  | 隐私
  | 关于
  | 从大表里挑出想要的行
  | 说一句话就行，剩下的我来做
  | 返回首页
  | 1
  | 选文件
  | —
  | 2
  | 说需求
  | —
  | 3
  | 确认
  | —
[phase] 确认页 → 开始 — 52 ms
[phase] 干活（含审批/提问） …
[phase] 干活（含审批/提问） — 30119 ms
--- 结果页 ---
  | Cante
  | 历史
  | 隐私
  | 关于
  | 从大表里挑出想要的行
  | 说一句话就行，剩下的我来做
  | 返回首页
  | 1
  | 选文件
  | —
  | 2
  | 说需求
  | —
  | 3
  | 确认
  | —
  | 4
  | 结果
  | ✓
  | 做好了
  | 从大表里挑出想要的行
  | 本次联网
  | 整理时用到了联网，内容发给了帮你整理的服务方。
  | 看看刚才发出去的是什么
==> 替她点了：审批 7 次、结构化提问 0 次、追问 0 次
accept-drive: OK — 应用在真实 WebView2 里跑完了一轮，结果页出现「做好了」。

==> 4. 核对产出
    （耗时 0.1s）
  替她点了：审批 7 次、结构化提问 0 次、追问 0 次
  工作目录里的文件（C:\tmp\acc-real\job）：
    结果_挑出华东区.xlsx  5655 字节
    销售明细.xlsx  5716 字节
    input.csv  180 字节

  用应用自带的 cante-sheets 读回来：结果_挑出华东区.xlsx
区域,月份,客户,金额
华东区,3月,甲公司,1200
华东区,4月,丙公司,1500
华东区,5月,戊公司,760

  原文件没有被改动：EFC84DB4240B9855064580DDC33E795C89354BF5E242FD733268BF95E2B51A82

=== 每一步的实际耗时 ===
  1. 前置检查                                        0 s
  2. 造输入表（应用自带的 cante-sheets write）            0.1 s
  3. 跑一轮（accept-drive.mjs）                    35.2 s
  4. 核对产出                                      0.1 s

accept-drive: OK — 装好的应用在真实 WebView2 里跑完了一轮，结果页出现「做好了」，产出对得上。

报告：C:\tmp\acc-real\report.txt
```

**产物清单**（工作目录 `C:\tmp\acc-real\`）：

```
job\销售明细.xlsx                 5716   ← 输入，cante-sheets write 造的
job\input.csv                      180   ← 中间 CSV
job\结果_挑出华东区.xlsx           5655   ← 产出
job\drive-artifacts\result.png    68710  ← 结果页截图
job\drive-artifacts\result.txt     2003  ← 结果页文字（原样读回）
job\drive-artifacts\result.html   11496  ← 结果页 DOM
job\drive-artifacts\accept-drive-result.json   ← 每 phase 的毫秒数
job\drive-artifacts\admin.json      104  ← 关掉企业预置/网关默认值，让向导不跳过
report.txt                         4337  ← 上面那份人看的报告
result.json                        4537  ← 结构化结果
```

结果页文字（`result.txt`，节选，扣掉重复的部分）里还能看到产品对"结果"的核对原话：

```
新增 1 个文件
结果核对
我核对了一下：结果文件在，能打开。 大小 5.5 KB。
需要你核对
- 「区域」列里的值统一是"华东区""华南区""华北区"这种写法……
结果_挑出华东区.xlsx
位置：C:/tmp/acc-real/job
新增 · 5.5 KB
打开文件 / 打开所在文件夹
以后也能在首页的「我做的结果」里找到它。
复制成微信能贴的文字
只是复制成文字，你自己到微信里粘贴，Cante 不会替你发送。
```

（最后一行顺带印证了红线：**微信绝不自动发送** ✓ —— 它只说"复制成文字"，没有任何发送路径。）

---

## 3. `verify-bundle.sh --dir` 对**装好的目录**再跑一次

```
C:\cante-wt\ci> bash gui/scripts/verify-bundle.sh --dir C:/Users/<用户名>/AppData/Local/Cante

verify-bundle: 检查 dir C:/Users/<用户名>/AppData/Local/Cante 
① 四个可执行文件
  ✓ cante-gui（9.9M）
  ✓ cante-sheets（2.4M）
  ✓ cante-pdf（2.1M）
  ✓ cante-bridge（720K）
② 包里能跑吗
  ✓ cante-sheets --version → cante-sheets 0.2.3
  ✓ cante-pdf --version → cante-pdf 0.2.3
  ✓ cante-bridge --version → cante-bridge 0.2.3
③ 有没有混进构建垃圾
  ✓ 没有 .d 依赖清单
  ✓ 没有 0 字节文件
  ✓ 没有多出来的子目录
④ 执行组件（随包发的 pi + bun）
  ✓ pi/bun.exe（83M）
  ✓ pi/dist/bundle/cli.js（4.0K）
  ✓ pi/package.json（8.0K）
  ✓ pi/THIRD-PARTY-NOTICES.md（16K）
  ✓ pi/bun.exe --version → 1.4.2

verify-bundle: OK —— 四个可执行文件都在、都能跑、没有垃圾，执行组件该在的都在 ✓
EXIT=0
```

（`④` 里 `pi/dist/bundle/cli.js` 是 **4.0K**；第八次验收记的是 **1.0K** —— 版本不同、文件名同，
**不是矛盾**，两边都是当时那份包的真实大小 ✓。这条我只是说明，不是断言 ✓。）

---

## 4. 退出码**真能区分**环境问题与产品问题（两种都跑过）

任务要"退出码区分环境问题与产品问题"。我没有只照着约定写，而是**两种都故意跑了一次**：

**(a) 产品问题 → 退出码 3**。故意给一张不存在的卡：

```
C:\cante-wt\ci> powershell ... run-accept-drive.ps1 -Card "这张卡不存在-故意" -WorkDir C:\tmp\acc-prod ...

==> 1. 前置检查
    （耗时 0s）
  ...前置检查通过。

==> 2. 造输入表（应用自带的 cante-sheets write）
    （耗时 0.1s）
  输入：C:\tmp\acc-prod\job\销售明细.xlsx

==> 3. 跑一轮（accept-drive.mjs）

run-accept-drive: FAIL（产品问题）— 产品问题：卡片流程失败 —— 找不到「任务卡 这张卡不存在-故意」（60000ms）

=== 每一步的实际耗时 ===
  1. 前置检查                                        0 s
  2. 造输入表（应用自带的 cante-sheets write）            0.1 s

accept-drive: 结论 = 3（0=通过 / 2=环境问题 / 3=产品问题）

报告：C:\tmp\acc-prod\report.txt
```

判据：**WebDriver 会话建起来了**（有 `打开 WebDriver 会话` 这条 phase 记录）→ 说明窗口、驱动、
应用都是好的 → 后面才是产品的问题。所以 `3` 不是"随便出错就报 3"，而是"会话起来了但流程失败" ✓。

**(b) 环境问题 → 退出码 2**。故意指一个不存在的 `-Exe`：

```
C:\cante-wt\ci> powershell ... run-accept-drive.ps1 -Exe "C:\nope\cante-gui.exe" -WorkDir C:\tmp\acc-env2b

应用：(未找到)
模式：零环境变量（ACCEPT_ZERO_ENV=1，应用自己找组件）

==> 1. 前置检查

run-accept-drive: FAIL（环境问题）— 环境问题：应用未安装

=== 每一步的实际耗时 ===

accept-drive: 结论 = 2（0=通过 / 2=环境问题 / 3=产品问题）

报告：C:\tmp\acc-env2b\report.txt
```

两条结构化结果（`result.json`）里的 `exitCode` 也对得上：`0` / `3` / `2` ✓。

---

## 5. 顺手修掉的一个真 bug（`result.json` 在 PS 5.1 上写不出来）

第一次跑（拿一个不存在的 `-Exe` 走**环境问题的负路径**）时，人看的报告是对的、退出码也是 2，
但控制台末尾冒出一段**没人预料到的**报错，而且 `result.json` **根本没生成**：

```
powershell.exe : 参数类型不匹配
...
所在位置 ...\run-accept-drive.ps1:466 字符: 1
+ $result = [pscustomobject]@{
+ ~~~~~~~~~~~~~~~~~~~~~~~~~~~~
ArgumentException
```

根因（我用一个最小复现钉住了）：**`@($genericList)` 放进 PowerShell 5.1 的哈希字面量会抛
`ArgumentException`** —— `@()` 对泛型 `List[object]` 有点特殊，`$L.ToArray()` 包一层就没事：

```
$L = New-Object System.Collections.Generic.List[object]; $L.Add([pscustomobject]@{...})
[pscustomobject]@{ timings = @($L) }          # FAIL - ArgumentException
[pscustomobject]@{ timings = $L }             # OK
[pscustomobject]@{ timings = $L.ToArray() }   # OK
[pscustomobject]@{ timings = @($L.ToArray()) }# OK
```

修法：先 `$script:Timings.ToArray()` 再包，并把 `drive` 的构造提到哈希字面量**外面**（同时消掉
`$(if …)` 那种在哈希里容易出错的内联）。修完 `PARSE OK`，重跑三条路径（0 / 2 / 3）都正常 ✓。

> 为什么这条值得写进报告：**它只在“收尾组装结果”那一步烳** —— `$ErrorActionPreference='Continue'`
> 让脚本带着 `$null` 继续往下走，所以**人看的报告照常生成、退出码照常对**，只有 `result.json`
> 静默地不见了 ✗。而这正是本脚本**计划任务那条路**读退出码所依赖的文件（父进程那句
> `$saved = Get-Content $resultFile | ConvertFrom-Json; $code = ...exitCode`）——它没了，
> 父进程就只能停在默认的 `2`，于是一个**真产品问题（3）会被报成环境问题（2）** ✗。
> 只看那条绿的一行命令，永远发现不了它 ✗ —— 所以它必须被单独验过 ✓。

---

## 6. 新卡怎么在这一轮里加进来（给下一批留的接口）

一行命令**不用改**，它本身是卡片无关的 —— 卡片名与指令都是参数：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File gui\scripts\windows\run-accept-drive.ps1 `
    -Card "新卡的标题（和 tasks/*.ts 里的 title 逐字一致）" `
    -Instruction "写给助手的那句话"
```

要接进来，只需要三处（都在**卡片开发**那侧，不属于本轮改动范围）：

1. **卡片的 `title`**：新卡在 `gui/src/simple/tasks/*.ts` 里定义的 `title`（`TaskDef.title`），
   就是 `-Card` 要传的字符串。驱动是靠 `TaskCard.tsx` 渲染的
   `aria-label = "<title>。<example>"` 前缀去点的
   （`//button[starts-with(@aria-label, "<title>")]`），所以**传 `title` 即可，不用管 `aria-label`**。
2. **接进 `TASKS`**：新卡的数组要由集成者登记进 `gui/src/simple/tasks/index.ts` 的 `TASKS`，
   否则首页根本不渲染它、`-Card` 也就点不到（AGENTS.md §4）。
3. **输入表**：本脚本现在固定造一张"区域/月份/客户/金额"的表。**要因卡而异时**，
   在这里加一个参数（例如 `-Fixture` 或 `-SeedCsv`），把造表那段（`$csv = …` /
   `cante-sheets write`）换掉/扩展即可 —— 造表的位置集中在一处，扩展成本很低 ✓。

**指令怎么传给脚本**：`-Instruction` → `ACCEPT_INSTRUCTION` → `accept-drive.mjs` 写进
`#task-instruction` 输入框。它**必须与卡片提示词一致**才会走到同一段产品逻辑，所以加卡时
把那张卡的示例指令抄进来即可。

> 判据提醒（AGENTS.md §3.6）：这里验的是"**产品真的走到结果页并产出文件**"，
> 不是"我们的意图"。所以新卡接进来后，仍应以 `结果_*.xlsx` 能被 `cante-sheets read` 读回为准，
> 而不是"界面说成功"。

---

## 7. 我没能验证什么 ✗

1. **计划任务那条路没跑** ✗。本机这个会话是**不提权的交互会话**（实测 `elevated=False session=1`），
   所以脚本走的是"就地跑"分支 —— **提权 / session 0 → 自动改走 `RunLevel Limited` 计划任务**
   那段代码这次**没有执行过**。它是照 `accept-first-screen.ps1` 抄的（同一套 API、同一套参数），
   但我**没有**在提权会话里实测；SSH 起的会话才能到那条路，而这条机上我现在不是。
   脚本里那段有 `catch` 会打印"建不了计划任务"，所以真出问题不会静默 ✗。
2. **企业预置那台机器没验** ✗：脚本会写 `admin.json`（`allow_network=true`、无禁用卡）来避免
   向导被跳过，但"**机器上已经有 `~\.cante\admin.json` 时**会怎样"这次没造那个场景。
3. **`-WithEnv`（老路径）没跑** ✗：这次只跑了默认的零环境变量模式。老路径的代码路径
   （`ACCEPT_ZERO_ENV=0` + `CANTE_BIN`/`PI_BIN`）没被执行过。
4. **新卡本身没验** ✗：本机的新卡还没合并过来，所以 §6 写的是"接口怎么用"，**不是**"新卡跑通了"✗。
5. **`result.json` 顶层字段的消费方**：本机只在报告里贴了它，**没有**别的脚本/CI 在读它，
   所以"字段够不够用"没有真实下游来证。
6. **慢模型下的耗时** ✗：本机这张卡 35s 用的是本地桥+pi；AGENTS.md §5 记的 850s 是**慢模型**下的
   数字，两种情形不是一回事，我没有在慢模型下跑过这条命令。

---

## 8. 这一轮改了什么

| 文件 | 改动 |
| --- | --- |
| `gui/scripts/windows/run-accept-drive.ps1` | **新增**。一行命令的入口（判断会话 / 清残留 / 造输入表 / 设 `ACCEPT_*` / 跑一轮 / 核对产出 / 0-2-3 退出码） |
| `gui/WINDOWS-ACCEPTANCE-10.md` | **新增**。本文 |

**没动**：`src/**`、`src-tauri/**`、workflows，以及任何已有的验收脚本 ✗。
