# 验证地图：**哪条验证在哪台机器上跑、拿什么当证据**

这张表的存在理由（`AGENTS.md` §3.6 与目标里的"两端都要有证据"）：
**"已验证"必须能回答"在哪台机器上、看的是什么产物"** ✗✓。表里每一行都指到**可执行的脚本**或**具体的记录文件** ✓，
不写"应该没问题" ✗。

## 一、本机（macOS，开发者机器）

| 验证 | 怎么跑 | 看什么当证据 | 什么**不**覆盖 ✗ |
| --- | --- | --- | --- |
| **完整本地门禁（9 步）** | `bash gui/scripts/e2e.sh` | 每步的原始输出；任一步红即停 | 真 Windows 才能验的东西（见第二节）✗ |
| 秘密扫描（第 1 步） | `bash gui/scripts/secret-scan.sh` | 命中的 `文件:行` + 它打印的原因 ✓ | 未跟踪文件（扫描只扫 `git ls-files` 里的 ✓）|
| 许可清单是否过期（第 3 步） | `bash gui/scripts/license-inventory.sh --check` | 变了哪几个组件（版本/许可/新增/删除）✓ | 许可**原文**是否齐全（那是生成物里的事 ✓）|
| 界面三屏 + 键盘 + 两种窗口尺寸 + 确认页「先给我看一眼」 | `bash gui/scripts/dom-smoke.sh`（**也是 e2e 第 9 步** ✓，所以本地与 CI 都跑 ✓） | 每屏的可见文字、键盘走查、两个尺寸的版面数字、确认页上那一块**向上到 `[role=dialog]` 有没有会滚的祖先** ✓ | **Windows 上不跑** ✗（脚本检测到 Windows 会**打印原因并退出码 0** ✓，**不是通过校验** ✗）：驱动的是 Google Chrome，而 Chrome 在 Windows 上是 GUI 子系统程序，Git Bash 读不到它的输出（在 windows-latest 上把这一步挂死过 ✗）；Windows 那一面由下面的真 WebView2 冒烟覆盖 ✓。另：**显示缩放**（125%/150%）✗（下面那条单独量 ✓）、真 WebView2 ✗；Linux `gate` job 的 Chrome 与她的 Windows 上真跑的 WebView2 **不是同一个渲染器** ✗ |
| **显示缩放（125%/150%）下的版面** | `python3 gui/scripts/zoom/driver.py`（先 `bun run build:web` ✓；`ZOOM_STUB_RUNS=N` 量「她已经做过一轮」那一面 ✓） | 逐场景的字号 ✓ / 按钮可点高度 ≥44 ✓ / 横向滚动 ✗ / **真的够不着**的控件数 ✓ / 底部固定输入区占比 ✓ | **真实 Windows 缩放的观感** ✗、**真 WebView2** ✗、非整数缩放的取整 ✗（都是建模 ✓，见脚本头注释 ✓）|
| 界面性能基线 | `bash gui/scripts/measure-web.sh` | 首页到关键元素的**中位数**、DOM 节点数、资源字节 ✓ | 真机 GPU 下的数字 ✗ |
| 提示词体量 | `bun gui/scripts/measure-prompts.ts` | 有没有整句重复、按内容裁段是否安全 ✓ | 模型是否**理解**那段话 ✗ |
| 打包产物闸门（配置≠产物 ✓） | `bash gui/scripts/verify-bundle.sh --dmg <dmg>` | 挂载后的**真实目录清单** + 工具能否在包里跑 ✓ | Windows 安装包内容（那边单独跑 ✓）|
| 真机任务普查 | `bash gui/scripts/task-sweep.sh` | 逐卡结果 + 与基线的差异 + 总耗时 ✓ | 需要真 Windows 桌面的卡 ✗ |

## 二、Windows 验收机（真 Windows + 真 WebView2）

**前置**：`gui/DEVELOPING-WINDOWS.md` 与 `gui/DEVELOPING-WINDOWS-VM.md`（我踩过的坑都写在那儿 ✓：
`.ps1` 必须带 BOM ✓、SSH 是 Session 0 没有桌面 ✓、**提权会让 WebView2 忽略 `WEBVIEW2_*`** ✗、
Guest Agent 还要装 virtio-serial ✓）。

| 验证 | 怎么跑 | 看什么当证据 | 什么**不**覆盖 ✗ |
| --- | --- | --- | --- |
| **装得上 / 装出来干净** | `gui\scripts\windows\inspect-installer.ps1` | 安装目录清单：四个可执行文件在 ✓、无 `.d` ✓、无 0 字节 ✓ | 卸载是否干净（`accept-install.ps1` 里有 ✓）|
| **她第一次打开看到的第一屏** | `gui\scripts\windows\accept-first-screen.ps1` | UIA 读回的**窗口真实文字**，逐条对照 `copy.ts` ✓；退出码 **2=环境 / 3=产品** ✓ | 字体手感、动画 ✗ |
| **装完就能干活（端到端，零环境变量）** | `gui\scripts\windows\run-accept-drive.ps1`（一行命令 ✓，也可用 `accept-install.ps1 -ZeroEnv` ✓） | phase 行耗时 ✓、结果页出现「做好了」✓、**产出文件读回核对** ✓、**原件 sha256 前后一致** ✓ | 慢模型下的耗时 ✗（本地桥+pi 不是 850s 那种 ✓）|
| **产物闸门（安装目录）** | `gui\scripts\windows\verify-bundle.sh --dir <安装目录>` | 四个可执行文件 + 随包执行组件都在、都能跑 ✓ | 安装包内部（要装完才看得到 ✓）|
| **周度自动普查** | 计划任务 `CanteWeeklySweep` | `C:\cante-sweep\report-YYYYMMDD.md` ✓ | 需要桌面的场景 ✗ |
| **每个子 agent 在干什么（一眼看清）** | `gui\scripts\windows\agent-dashboard.ps1` | 每个工作树的**转录文件 12 秒有没有在长** ✓（唯一能回答「现在在不在干活」的判据 ✓）、停了多久 ✓、分支/改动/提交/未推 ✓、最后一句人话与用过的工具 ✓ | **看不清内容对不对** ✗（它只读转录，不做对错判断 ✓）；也看不到**模型侧**为什么慢 ✗ |
| **三种「麻烦路径」各跑一轮**（纯中文 / 中文+空格 / OneDrive 重定向桌面 ✓） | `gui\scripts\windows\accept-paths.ps1 -Only r1,r2,r3 -RedirectDesktop` | 每轮：产出真在盘上 ✓、`cante-sheets` 读回内容 ✓、**原文件 sha256 前后一致** ✓；汇总「通过 N / N」，**0 轮 = 退出码 1**（不许把「没跑」写成「通过」✗）；桌面重定向 `applied` + **`reverted` 两处读回确认** ✓ | 映射网络驱动器、`%TEMP%` 被重定向 ✗；每轮**只跑一次**（没复跑排除偶发 ✗）|
| **「服务方真的断了」的四种错法**（`wire` 真防火墙挡出站 / `proxy407` / `dead` / `cut` ✓） | `gui\scripts\windows\run-offline.ps1 -Scenario wire`（或 proxy407 / dead / cut） | **反向判据** ✓：同一条连接「加规则前 CONNECTED (exit 0) / 加规则后 REFUSED (exit 1)」= 现场真被按住 ✓；她看到的**屏幕原文** ✓；原文件 sha256 一致 ✓；**开跑前先清残留 + 跑完删规则 + 删后 `ABSENT` 复查** ✓ | 真把网卡禁用 ✗；真企业代理 ✗（这台机器上没有 ✓）|
| **结果页/「我做的结果」的最终文案** | `gui\scripts\windows\run-accept-drive.ps1` + `read-result-page.ps1` | **从屏幕读回文字**逐条对照 `copy-print.ts` / `location.ts` ✓（5/5 命中 ✓）；两屏**都没有机器路径** ✓；#215 的「表里是什么样」**真读出来** ✓ | 「空历史」时的面板那一面 ✗；#215「读不出表格」的回退路径 ✗（没在真机单独造 ✓）|
| **结果找不到时说不说「不在了」** | `gui\scripts\windows\run-results-audit.ps1` | 四种现场（normal/deleted/renamed/moved ✓）：三种「找不到」都**如实说不在了** ✓（无一种显示成还在、无一种空白 ✓）；点「打开所在文件夹」**真的开出文件夹** ✓（证据是 **Shell 里数到的窗口** ✓，不是 DOM 自述 ✓）；原文件 sha256 一致 ✓ | 同名文件歧义 ✗；企业预置那台机器 ✗；真实鼠标体感 ✗。**注意**：`renamed`/`moved` **没跑任务**（用已登记在册的现有结果当靶子 ✓）——报告里分开写了 ✓ |
| **真实 Windows 缩放下的版面** | `gui\scripts\windows\scale\read-display-config.ps1`（只读 ✓）+ `scroll-reach.ps1` | 当前 DPI / 分辨率 / 每个 source 的缩放档位 ✓（`rc=87` = 这个适配器不支持调缩放 ✓）；滚动前后每个动作按钮的矩形 ✓，**并真点一次**确认能走到 ✓ | **125%/150% 下的版面（这台机器改不了缩放 ✗）**；缩放≠100% 时「物理像素 ÷ 缩放」的换算 ✗（只建模过 ✓）|
| **真 Windows 上的键盘可达性与读屏（UIA）** | `gui\scripts\windows\a11y-uia.ps1` | 四场（home/confirm/approval/results ✓）：每个可聚焦控件 `Name` 非空 ✓、**盲按一圈回到起点**且元素各不相同 ✓、Tab 到得了的按钮逻辑高 ≥ 44 ✓、**审批卡与确认页 Esc 关不掉**（MUST-ANSWER ✓）+ 对照组（结果面板 Esc **应该**能关 ✓）。**发现**：结果面板 92 个可 Tab 按钮只有 4 个不同名字（47 行按钮名一样 ✓）。**诚实分层**：`approval` 那场跑在旧构建上，用 blob hash 证明相关源码逐字节相同 → 标 `advisory` ✓ | **读屏软件实际念出来的效果** ✗（只验 UIA `Name`，**没验「她听不听得懂」**）；**缩放 ≠ 100% 时的 44px 换算** ✗；结果面板那条**名字重复**尚未修 ✗ |
| **读屏会怎么念（UIA 视图层）** | `gui\scripts\windows\a11y\narrate-views.ps1`（`-Scenario home\|confirm\|results`，`-View Raw\|Control\|Content`） | 从应用 `Document` 走**指定视图**的树序，逐条给 `ControlType`+`Name`+标题级别+可Tab+`IsControlElement`（首页 72 / 确认页 46 / 面板 159 条 ✓）；落盘逐条清单 + 「念出来一句话一句」+ JSON + 标题/列表统计 ✓；退出码沿用 0/2/3 ✓。**发现**：读屏走 **`ControlView` 而非 `RawView`** —— RawView 会把 `IsControlElement=False` 的布局节点算进去（首页 146 里有 74 个），据此得出的「同一标题念两遍」「步骤条碎念」**都是假象**，改走 ControlView 后消失 ✓；面板 12 行 → **24 个不同的行按钮名字** ✓（#230 生效）| **没真的听（无声卡）** ✗；**确认页没有 ETW 实证** ✗（只到 UIA 层 ✓）；每场 1 轮 ✗；换宿主 ✗。**与 `pool/win-narrator` 的 ETW 报告同名不同源**，合并时不要盲选一份 ✓ |
| **真实 Windows 缩放下的版面（第二版，更完整）** | `gui\scripts\windows\measure-scale-viewport.ps1` / `scale-probe.ps1` / `scroll-reach-scale.ps1` | 这台机器改不了缩放（`rc=87` ✓）→ 用**等价视口 1024x608** 量「125% 会得到的视口」（**明确标成近似** ✓）；结果页**没有横向裁切** ✓、按钮**滚动后都点得到** ✓、一行命令真跑通 ✓ | **真机 125%/150% 的渲染** ✗（适配器不支持 ✓）；换一台支持缩放的机器 ✗ |
| 纯取证（**不进门禁** ✗） | `capture-window.ps1` / `collect-environment.ps1` / `probe-installed-app.ps1` / `dump-window-text.ps1` | 截图、环境事实、窗口文字 | **它们只产出证据、不做断言** ✓（`dump-window-text.ps1` 被上面的脚本复用 ✓）|

## 三、CI（另一台机器上的双平台 ✓）

| 验证 | 在哪 | 看什么 |
| --- | --- | --- |
| `gate` job（Linux） | `.github/workflows/gui.yml` | **直接跑 `gui/scripts/e2e.sh`** ✓（本地 9 步全在内 ✓，所以判据一致 ✓ —— 曾经"本地绿 CI 红"✗）；job 里另外**重复**跑了 secret scan、许可检查与 `dom-smoke.sh` ✓（冗余但无害 ✓，且各自单独命名、失败时不藏在 `e2e.sh` 里 ✓）；**跑 `dom-smoke` 前先确保 Chrome**（ubuntu-latest 自带就复用，装不上就兜底 `apt-get install google-chrome-stable` ✓）|
| `windows` job（windows-latest） | 同上 | **同一份 `e2e.sh`** ✓（判据一致 ✓）；其中第 9 步 `dom-smoke` 在 Windows 上**明确跳过**（原因见上：Chrome 是 GUI 子系统程序，无法可靠驱动，曾在这一步挂死过 ✗）→ 该步退出码 0 且打印了原因 ✓。**Windows 的界面**由这个 job 的真 WebView2 冒烟覆盖：装 `tauri-driver` ✓ → 取**匹配 WebView2 版本**的 `msedgedriver` ✓ → `tauri build --debug --no-bundle` ✓ → **降权**跑（提权会让 WebView2 忽略 `WEBVIEW2_*` ✗）→ **上传证据 artifact** ✓ |
| 发布流水线 | `.github/workflows/gui-release.yml` | 双平台安装包 + **产物闸门跑在打出来的 dmg 上** ✓ |

## 四、这张表自己怎么保持不腐

- 新增验证脚本 → **补一行**（否则下一个人不知道它属于哪一层 ✓）；
- 某个验证**只在 CI 跑**、或**只在真机跑** → 在这张表里写清原因是**能力限制** ✗（例如"要真 WebView2"✓、
  "要真 Windows 桌面"✓），**不要**让人以为本地 e2e 覆盖了它 ✗；
- 记录文件（`WINDOWS-ACCEPTANCE-N.md` / `SWEEP-*.md`）是**证据** ✓，这张表是**索引** ✓ ——
  两者别混：`SWEEP-0.2.1.md` 是一次运行的记录 ✓，不是"我们每次都这样"的承诺 ✓。
- **退出码也要写在这张表能查到的地方** ✓：Windows 那几个验收脚本用 `0`=通过 / `2`=**环境问题** /
  `3`=**产品问题** ✓（`accept-first-screen.ps1` ✓、`run-accept-drive.ps1` ✓）—— 把这两类分开，
  正是我们最怕混淆的那一类 ✗✓。新脚本**沿用**这套约定，别自创 ✗。

