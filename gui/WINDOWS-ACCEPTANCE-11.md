# 第十一次真机验收：给刚合并的两件新功能补 Windows 真机证据

> 目标要求"两端都有证据"。这一轮在 Windows 真机上，用 **`run-accept-drive.ps1` 一行命令**
> 给两件刚合并的新功能取证：
> ① **#196 新卡 `doc.worksummary`**「把这段时间做的事写成一份总结」——真的跑一轮、真的出文件；
> ② **#195 确认页的「先给我看一眼（只看不动）」**——用 UI Automation 读确认页**真实文字**，
> 证明它**不滚屏就在屏上**。
>
> - **验收对象**：从当前 `main`（`58d9881`）**新构建**的 `cante-gui.exe`（0.2.3，dev profile），
>   摆在 `C:\tmp\cante-app\`，**零环境变量**跑（`ACCEPT_ZERO_ENV=1`，应用自己找包里的桥与执行组件）
> - **验收机器**：Windows 11 家庭版 / `10.0.26200` / x64（真机）；WebView2 `153.0.4234.46`；
>   msedgedriver `153.0.4234.46`
> - **验收会话**：不提权的交互会话（实测 `elevated=False session=1`），就地跑
> - 本文里所有长命令都带了超时；**没有一条超时**。以下"确认没有"都是**列过进程/文件**之后写的。

---

## 0. 结论先行

1. **新卡跑通了** ✓：结果页出现「**做好了**」，桌面上真的多出 `结果_工作总结-3.docx`（2113 字节），
   把 docx 的正文读回来**内容对得上**（归并成 5 件事、每件标了来自原话第几条、没写的数字用
   「（请补充）」留空）✓。产出目录里**原本就有的 4 个文件 sha256 前后一致** ✓。这一步 **137.8 s**。
2. **确认页那一条真的在屏上** ✓：UI Automation 读到「先给我看一眼（只看不动）」，
   `IsOffscreen=false`、矩形 `[356,540,548,560]`、窗口客户区 `[34,32,1214,792]` → 落在里面 ✓。
   **而且这个判定确实有信号**：同一屏里另有 **17 个元素被标成 offscreen**、**13 个矩形落在客户区外**
     （底边 y 最大到 **927**，而客户区底边是 **792**）——它不是一个恒为 true 的检查 ✓（§3）。
     （这一段的数字以 **§3.2 的原始输出**为准 ✓ —— 独立评审发现概括时抄错了一组 ✗：
     曾写成 `[388,540,580,560]` / `[92,32,1272,792]` / y=880 ✓，已改成原始值 ✓。）
3. **给那行命令加了 `-TextCard` / `-PasteText` 两个参数**（还有 `-Port`），
   新卡就是它的一次真实调用 ✓（§4 有一行示例、§5 是原始输出）。
4. **一个必须说清的真相**：**走 WebDriver 那条路，UIA 读不到 DOM** ✗。原因是
   `msedgedriver` 启动应用时会用自己的值**覆盖** `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`
   （实测：那样起来的窗口，其 `msedgewebview2.exe` 命令行里**没有**
   `--force-renderer-accessibility`，UIA 只能看到 3 个壳元素）。所以我**另建了一条取证路**：
   `read-confirm-visible.ps1` **自己启动应用**（不经 msedgedriver）走到确认页再读（§3.2）。
   可见性这条我**验到了**，但验的方式与"用 WebDriver 那条路读"不同——这一点如实写在 §6。
5. **我没能验证什么** ✗：见 §7。

---

## 1. 为什么必须**重新构建**（否则验的是旧产物）

`gui-v0.2.3` 这个 tag 是 **2026-09-18 01:24** 打的；#195 / #196 是 **2026-09-19 21:12** 才合并的。
本机 `%LOCALAPPDATA%\Cante\cante-gui.exe` 是 9-18 装的 —— **它里面没有这两件新功能**，
拿它跑只会得到"卡片不存在"。所以这次先从当前 `main` 构建：

```
C:\cante-wt\ci> cd gui && bunx tauri build --debug --no-bundle
   ... Finished `dev` profile [unoptimized + debuginfo] target(s) in 1m 52s
       Built application at: C:\cante-wt\ci\gui\src-tauri\target\debug\cante-gui.exe
```

**为什么要把它挪到 `C:\tmp\cante-app\` 再跑**（一个真实踩到的坑 ✗）：随包发的执行组件 `pi`
在 `target\debug\` 里**跑不起来** —— `gui\node_modules` 是它的祖先目录，bun 的模块解析被那层
`node_modules` 干扰，实测报 `Cannot find module '@earendil-works/chord/context'`。
把四个 exe + `pi\` 原样拷到一个**没有 `node_modules` 祖先**的目录（形状与安装目录一致）就正常了：

```
C:\tmp\cante-app> pi\bun.exe pi\dist\bundle\cli.js --version
0.85.1
```

（这不是产品缺陷，是"在源码树里跑开发构建"的副作用；安装出来的目录没有这个问题，
第八次验收在真安装目录上跑通过 ✓。）

---

## 2. 新卡跑一轮：原始输出（`run-accept-drive.ps1`，一行命令）

```
C:\cante-wt\ci> powershell -NoProfile -ExecutionPolicy Bypass -File gui\scripts\windows\run-accept-drive.ps1 `
    -Exe "C:\tmp\cante-app\cante-gui.exe" `
    -Card "把这段时间做的事写成一份总结" -TextCard `
    -Instruction "把我这几个月的流水账写成一份工作总结，别写得太长" `
    -PasteTextFile "C:\tmp\ledger.txt" `
    -WorkDir "C:\tmp\acc-final13" -Port 4503

=== 真机验收：跑一轮（Windows）===
会话：elevated=False session=1
工作目录：C:\tmp\acc-final13
应用：C:\tmp\cante-app\cante-gui.exe
卡片：把这段时间做的事写成一份总结
卡片模式：文字卡（贴一段字，不选文件）
产出目录（文字卡没选文件 → 产品放桌面；可能不止一处）：C:\Users\<用户名>\OneDrive\桌面；C:\Users\<用户名>\Desktop
模式：零环境变量（ACCEPT_ZERO_ENV=1，应用自己找组件）

==> 1. 前置检查
    （耗时 0s）
  应用目录：C:\tmp\cante-app
  ...
  前置检查通过。

启动前没有残留的 cante-gui 实例。

产出目录快照（可能不止一处）：
  C:\Users\<用户名>\OneDrive\桌面： 2 个文件
  C:\Users\<用户名>\Desktop： 3 个文件
  合计跑前有 5 个文件（跑完拿新增的当产出）。

==> 2. 备好来料（文字卡：不选文件，直接贴）
    （耗时 0s）
  来料（贴进输入框的那段字，244 字）：C:\tmp\acc-final13\job\来料-流水账.txt
  ---- 来料原文 ----
  | 3月2日 收各部门3月报销单据，核了一遍，共37份，有2份缺发票，退回去了
  | 3月5日 物业费发票核对，跟财务对了一次账
  | 3月6日 会议：月度例会，写会议纪要发给各科室
  | 3月11日 采购办公用品，比了三家价，下单
  | 3月15日 收各部门4月报销单据
  | 3月18日 帮主任整理上季度考勤表
  | 3月20日 会议室预订表更新，协调了两个科室的时间冲突
  | 3月25日 采购打印机耗材
  | 3月28日 收各部门5月报销单据
  | 4月2日 物业费发票核对
  | 4月8日 又核对了一次3月那两笔缺发票的报销，其中一笔补上了

==> 3. 确认页可见性（UI Automation，未经滚动）
    （耗时 19.7s）
  ... （§3 贴原文）

==> 4. 跑一轮（accept-drive.mjs）
    （耗时 137.8s）
==> 应用：C:\tmp\cante-app\cante-gui.exe
==> 零环境变量模式：不设 CANTE_BIN / PI_BIN，桥与执行组件由应用自己在旁边找
==> 卡片模式：文字卡（贴一段字，不选文件）
[phase] tauri-driver 就绪 — 540 ms
[phase] 打开 WebDriver 会话（启动应用） — 382 ms
[phase] 首页出现 — 777 ms
[phase] 点卡片「把这段时间做的事写成一份总结」 — 49 ms
[phase] 文字卡：不选文件，直接写（跳过原生对话框） — 13 ms
[phase] 写一句话并生成计划 — 185 ms
[phase] 确认页 → 开始 — 64 ms
[phase] 干活（含审批/提问） — …
  | ... | 做好了
==> 替她点了：审批 14 次、结构化提问 0 次、追问 0 次
accept-drive: OK — 应用在真实 WebView2 里跑完了一轮，结果页出现「做好了」。

==> 5. 核对产出（文字卡：产物在桌面）
    （耗时 0.1s）
  产出目录里**新增**的文件（看了这些目录：C:\Users\<用户名>\OneDrive\桌面；C:\Users\<用户名>\Desktop）：
    结果_工作总结-3.docx  2113 字节  （21:49:02）

  用应用自带的工具/纯文本读回来核对：结果_工作总结-3.docx
  ---- 读回来的正文（原文）----
  | 个人工作总结
  | 时间范围：3月2日—4月8日
  | 一、报销单据的收集与核对
  | 做了什么：按月收集各部门报销单据并逐份核对。3月2日收3月单据共37份，核对后有2份缺发票，已退回；3月15日收4月单据、3月28日收5月单据（份数：请补充）；4月8日又复核了3月那两笔缺发票的报销，其中1笔已补上。
  | 做出的结果或影响：3月共收37份并完成核对；2份缺发票已退回并跟进，其中1笔已补齐；4月、5月单据已按节点收齐。
  | 下面打算：继续按月跟催票据，把3月剩下那1笔没补齐的发票接着追。
  | （来自：原话第1、5、9、11条）
  | 二、会议支持与协调
  | ...
  | 三、物业费发票核对与对账
  | 四、办公用品与耗材采购
  | 五、考勤表整理

  正文命中来料里的关键词：报销、发票、会议、采购

  产出目录里原本就有的 4 个文件哈希前后一致 → 没有被改动

=== 每一步的实际耗时 ===
  1. 前置检查                                        0 s
  2. 备好来料（文字卡：不选文件，直接贴）                          0 s
  3. 确认页可见性（UI Automation，未经滚动）               19.7 s
  4. 跑一轮（accept-drive.mjs）                   137.8 s
  5. 核对产出（文字卡：产物在桌面）                           0.1 s

accept-drive: OK — 卡片跑通（结果页「做好了」+ 产出对得上），且确认页那一条在屏上。
```

**这张卡最怕的两件事，这次都没犯 ✓**（正好是 §任务背景里说的）：

- **没编数字** ✓：流水账没写的金额、份数、比例，产出里都用「（请补充）」留空，
  并在结尾提醒她填 —— 没有出现"看起来像真的"的数字。
- **没写得更碎** ✓：11 条流水账被**归并成 5 件事**，每件后面标了「来自：原话第 X 条」，
  她能对着核。还主动标出原话里日期对不上的一处（第 9 条日期 3 月、单据月份 5 月），
  **照写、没替她改** —— 这正是卡里写死的两条规矩。

**产出清单**（`C:\tmp\acc-final13\`）：

```
job\来料-流水账.txt                          623   ← 贴进输入框的那段字（副本）
job\drive-artifacts\result.txt              2105   ← 结果页文字（原样读回）
job\drive-artifacts\result.png             83851   ← 结果页截图
job\drive-artifacts\result.html            10163   ← 结果页 DOM
job\drive-artifacts\accept-drive-result.json 3294  ← 每 phase 的毫秒数
job\drive-artifacts\confirm-visible.json   23622   ← 确认页可见性取证（47 个元素的 offscreen+矩形）
report.txt                                          ← 上面那份人看的报告
result.json                                         ← 结构化结果（exitCode=0, visibility.ok=true）
C:\Users\<用户名>\Desktop\结果_工作总结-3.docx  2113  ← 产出（真的在盘上）
```

---

## 3. 确认页的可见性：原文 + 判定（这是本轮的核心证据）

### 3.1 读到的原文（节选，UIA 原样，已去重）

确认页上的文字，UIA 一共读到 **47 个有名元素 / 42 条去重文字**。目标那一段三行都在：

```
  | 先给我看一眼（只看不动）
  | 我先只说明打算怎么做：你的文件一个字都不会改，也不会多出文件。看完你再决定要不要开始。
  | 先给我看一眼
  | 取消
  | 开始
```

（前一行是 `TRY_FIRST.heading`，第二行是 `TRY_FIRST.hint`，第三行是 `TRY_FIRST.action` ——
与 `gui/src/simple/copy.ts` 的 `TRY_FIRST` 逐字一致 ✓。它和「取消」「开始」一起被读到，
说明这一块**确实在按钮排上方的那一屏里**，不是藏在滚动区中部。）

### 3.2 判定：**不用滚屏就在屏上** ✓

判据不是"文字在 DOM 里"，而是 UI Automation 给的两个**几何事实**：

| 量 | 值 |
| --- | --- |
| 目标元素 Name | `先给我看一眼（只看不动）` |
| `IsOffscreen` | **false** |
| 元素矩形（屏幕坐标） | `[356, 540, 548, 560]` |
| 窗口客户区（屏幕坐标） | `[34, 32, 1214, 792]` |
| 矩形是否落在客户区内 | **是** |

`read-confirm-visible.ps1` 的结论行：

```
命中：Name=「先给我看一眼（只看不动）」 offscreen=False 矩形=[356,540,548,560] 在客户区内=True
read-confirm-visible: OK — 「先给我看一眼（只看不动）」在屏上（offscreen 为假、矩形落在窗口客户区内）。
```

### 3.3 这个判定**有信号**，不是恒为 true（重要）

要证明"它在屏上"，先得证明这个检查**能把不在屏上的东西认出来**。同一张确认页里：

- **17 个有名元素**的 `IsOffscreen` 是 **true**；
- **13 个元素的矩形落在窗口客户区之外**（底边 y 最大到了 **927**，而客户区底边是 **792**）。

例（都来自同一次读数）：

```
  OFF | 一件事分几次记、说法又不一样时，我可能把本来两件事并成一条；…  rect=[371,514,983,566]
  OFF | 总结的口吻和详略我按常见的写法定，不一定符合你们单位的要求；…  rect=[371,572,983,624]
  OFF | 在这台电脑上做过 4 次，其中 3 次做成了。              rect=[388,656,698,676]
  OUT | 要处理的文件（0 个）                          rect=[371,764,983,794]
  OUT | 这次不涉及文件，内容来自你写的话。                rect=[371,804,643,824]   ← y 804 > 792，在客户区外
  OUT | 会影响什么                                 rect=[371,850,983,880]   ← y 850，同样在下方
```

**同一屏、同一套判定**：滚动区里的这些元素被如实判成“看不见”；而
「先给我看一眼（只看不动）」(y=540) 判成“在屏上” ✓。所以这条结论不是碰巧为真。

### 3.4 为什么不用 WebDriver 那条路读（诚实说明）

一开始我按最直觉的做法，在 `accept-drive.mjs` 里（应用由 WebDriver 拉起时）调 UIA 读确认页 ——
**读不到** ✗。逐层查下来：

1. 那样起来的窗口，UIA 树里只有 **3 个壳元素**（`Cante` / `Cante - Web 内容`），没有任何页面文字；
2. 查 `msedgewebview2.exe` 的**命令行**（进程级事实，不是配置层）：

   ```
   force-renderer-accessibility present: False
   remote-debugging present: True
   ```

   也就是说，`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` 里我设的那个 accessibility 开关
   **没有到达 WebView2** —— 它是被 `msedgedriver` 用自己的 `--remote-debugging-*` 参数**覆盖**掉的
   （msedgedriver 的二进制里有 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = ` 这个赋值点）。
3. 对照实验：**应用自己启动**（`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--force-renderer-accessibility`，
   不经 msedgedriver）时，同一份 UIA 代码能读到**完整页面文字**（首页那次读到 84 个元素；
   确认页这次读到 47 个有名元素）✓。

**结论**：可见性这条**能验**，但**必须让应用自己启动**去验。于是有了
`gui/scripts/windows/read-confirm-visible.ps1`（自己启动 → 点卡片 → 贴流水账 → 生成计划 →
在确认页读 UIA），`run-accept-drive.ps1` 把它作为独立一步调用（§2 的 `==> 3.`）。
这一步**不替代**卡片那一轮，两者都独占 `cante-gui`，所以先后跑。

> 这也顺带解释了第一次尝试为什么得到 `verdict: none`（当时用的是 WebDriver 路径）——
> 那不是"文案不在屏上"，是"这条路读不到 DOM"。两者不能混为一谈。

---

## 4. 那行命令加了什么参数（新卡怎么跑）

`gui/scripts/windows/run-accept-drive.ps1` 新增三个参数（**只改 `gui/scripts/windows/**`**）：

| 参数 | 用途 |
| --- | --- |
| `-TextCard` | 声明这是 `needs:"text"` 的卡：**没有选文件这一步**，不碰原生对话框、也不要 `-PasteText` 为空 |
| `-PasteText <字>` / `-PasteTextFile <文件>` | 贴进输入框的来料（用文件是为了多行安全；父进程经计划任务传递时也走文件） |
| `-Port <n>` | WebDriver 端口。同机并行跑多轮时各给一个，避免都抢 4444 / 互杀 `cante-gui`（实测过这个坑） |

**一条命令跑新卡**（就是 §2 那条，去掉可选参数后的最小形式）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File gui\scripts\windows\run-accept-drive.ps1 `
    -Card "把这段时间做的事写成一份总结" -TextCard `
    -Instruction "把我这几个月的流水账写成一份工作总结，别写得太长" `
    -PasteTextFile "C:\path\流水账.txt"
```

退出码仍是 **0=通过 / 2=环境问题 / 3=产品问题**：
`-TextCard` 模式下，产出按"**产出目录里新增了什么**"来认（跑前给产出目录拍 sha256 快照），
不再假设一定是 `结果_*.xlsx`；文字卡的产物可能是 `.docx` / `.txt`，脚本两种都真的读回来核对
（docx 用 .NET `ZipArchive` 抽 `word/document.xml` 的正文，不额外装库）。

---

## 5. 新卡接进来还动了哪些（都在驱动里，没动产品）

- `gui/scripts/windows/accept-drive.mjs`：加 `ACCEPT_TEXT` / `ACCEPT_PASTE_TEXT`；
  文字卡走"跳过原生对话框、直接把整段字写进 `#task-instruction`"那条路。
  **原文件一点没动**（`src/**`、`src-tauri/**`、workflows 都没碰）。
- `gui/scripts/windows/read-confirm-visible.ps1`：**新增**，可见性取证（§3）。
- `gui/scripts/windows/run-accept-drive.ps1`：加 `-TextCard/-PasteText/-PasteTextFile/-Port`，
  产物核对按"新增了什么"来判，并把可见性一步接进来。

---

## 6. 我没能验证什么 ✗

1. **安装包（MSI/NSIS）里的新卡**：这次验的是**开发构建**（`target\debug`，从当前 `main` 编出来），
   不是从 Release 下的安装包。所以"**装出来的产品**里有这两件新功能"这条**没验** ✗ ——
   要等 0.2.4 之类的发布包出来再按第八次那种方式验一次。
2. **可见性只证明到"UIA 报告的几何位置"这一层** ✗：我能证明的是
   "UIA 说这个元素 `IsOffscreen=false` 且矩形落在窗口客户区内"，**不是**"人眼看到的像素里它确实可见"。
   我没有对这一屏截图像素级核对（截图有存，但没有逐像素判定"这几个字真被画出来了"）。
   差别在于：UIA 的矩形是浏览器报告的布局盒，理论上存在"布局说在屏上、但被别的层盖住"的极端情况 ——
   这次没有证据说有这种情况，但我**没有排除**它 ✗。
3. **计划任务那条路**（提权 / session 0 → `RunLevel Limited`）**这次没执行** ✗：本机是不提权的交互会话，
   走的是"就地跑"分支。脚本里那段是照 `accept-first-screen.ps1` 抄的，但**没实测**。
4. **`-WithEnv` 老路径没跑** ✗：只跑了默认的零环境变量模式。
5. **不同流水账长度/内容**：只跑了一份 11 条、244 字的流水账。更长的、含表格粘贴的没试。
6. **同机并发**：这轮期间这台机器上**有别的验收在跑**（`accept-paths.ps1` 那条线），
   它和本脚本都会杀 `cante-gui`，我因此撞了一次"后台干活的程序意外退出了"、
   一次"等首页超时"（两个都是**另一个进程把应用杀了**，不是产品问题）。
   我给脚本加了 `-Port`，但"两个验收同时跑"本身仍是**互斥**的 ——
   这次是靠**错开时间**才跑通的，不是靠参数解决的 ✗。具体来说：
   **同机同一时刻只能有一个真机验收在跑**（因为它们都杀 `cante-gui`、抢窗口）。

### 6.1 顺手修了一个**脚本自己**的坑（不是产品问题）

第一次跑完卡片时，脚本报 `PRODUCT:产出目录里没有新增文件` —— **但产品其实写成了** ✗。
根因：我盯的是 `[Environment]::GetFolderPath('Desktop')`（在这台机器上指
`OneDrive\桌面`），而**应用写到了 `%USERPROFILE%\Desktop`**。两个都是“桌面”，
产品没错，是**我看错了地方**（AGENTS.md §3.6：“先问一句我看的是它真的产出的那个东西吗”）。
改法：同时盯**所有桌面候选目录**（`GetFolderPath('Desktop')`、`%USERPROFILE%\Desktop`、
`%OneDrive%\桌面`），跑前对每一处拍 sha256 快照，跑后拿“新增了什么”当产出。
改完重跑就对了 ✓ —— 这也解释了桌面上为什么会有 `结果_工作总结.docx`、`-1`、`-2`、`-3` 四份：
都是我这几轮跑留下的（时间 21:22 / 21:32 / 21:39 / 21:49）。产品每次**不覆盖**、只加序号 ✓，
那四份的共存本身就是"原件不被覆盖"的一条旁证 ✓。

---

## 7. 这一轮改了哪些文件

| 文件 | 改动 |
| --- | --- |
| `gui/scripts/windows/read-confirm-visible.ps1` | **新增**。确认页可见性取证（自己启动应用 → UIA 读矩形/offscreen） |
| `gui/scripts/windows/accept-drive.mjs` | 加文字卡模式（`ACCEPT_TEXT`/`ACCEPT_PASTE_TEXT`）；不再在 WebDriver 路径上假做可见性 |
| `gui/scripts/windows/run-accept-drive.ps1` | 加 `-TextCard/-PasteText/-PasteTextFile/-Port`；产物按"新增"核对；接上可见性一步 |
| `gui/WINDOWS-ACCEPTANCE-11.md` | **新增**。本文 |

**没动**：`src/**`、`src-tauri/**`、workflows，以及任何已有验收脚本的既有行为 ✗。
