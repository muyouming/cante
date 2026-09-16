# 在 Windows 上验证（我们最大的验证缺口）

产品**以 Windows 为先**（王姐的电脑是 Windows），而开发一直在 macOS 上做。这份文档写清三件事：
我们缺什么、有哪些办法补上、以及**每次改完要在 Windows 上看什么**。

## 缺口到底是什么

macOS 上能做的：单元测试、`e2e.sh`（含 `cargo test`）、`dom-smoke.sh`（用 Chrome 渲染同一份前端产物）。
macOS 上**做不到**的（也就是我们真正缺的）：

1. **真 Windows + 真 WebView2 渲染**（字体、字号、中文排版、emoji 回退都可能和 Chrome/macOS 不同）；
2. **原生文件对话框**、中文路径、驱动器盘符；
3. **控制台黑窗**会不会闪（我们改过 `CREATE_NO_WINDOW`，但没在真 Windows 上确认过）；
4. **安装包**（NSIS/MSI）能不能装、能不能起；未签名时的 **SmartScreen / 杀软提示**长什么样；
5. **16GB 无独显机器上的手感**——这是画像机，也是 M4 Max 上永远感知不到的东西；
6. WPS（`.et`）、微信 PC、中文输入法这些**真环境**。

## 办法一：把 UI 验证搬进 CI（零成本，自动防回归）

Tauri 官方支持在 **Windows（Edge WebDriver / `msedgedriver`）** 与 Linux 上做 WebDriver 测试——
**macOS 不支持**，恰好我们缺的就是 Windows。所以：在 `windows-latest` 上构建应用、起
`tauri-driver` + `msedgedriver`、驱动**真实窗口**，断言简单界面的关键文案真的渲染出来
（与 `dom-smoke.sh` 同一组断言）。

- 优点：每次 PR 自动跑，不依赖谁的机器；抓到的是"Windows 上起不来 / 渲染不出来"这类硬故障。
- 局限：**原生文件对话框无法自动化**，所以只能走到"确认页"；不能替代人眼对字体/手感/安装体验的判断。
- 实现与状态：`gui/README.md` 末尾那节（以及 `.github/workflows/gui.yml` 里的 Windows job）。

## 办法二：在本机开一台 Windows 虚拟机（要看/要摸的时候）

Apple Silicon 只能虚拟化**同架构**的客户机，所以跑的是 **Windows 11 ARM**；x64/x64 应用靠
微软的 **Prism** 模拟运行（我们的 x64 安装包能跑，只是会慢一点——反过来这也更接近画像机的体感）。

| 方案 | 价格（2026） | 微软官方授权 | 说明 |
| --- | --- | --- | --- |
| **Parallels Desktop** | 约 $99.99/年 | ✅ 是（唯一被授权的第三方） | 一键装 Windows 11 ARM，最省心；**Windows 授权要另买**（x64 与 ARM 的密钥通用） |
| **VMware Fusion** | 免费 | 否 | 功能够用，3D 支持完整；免费方案里的首选 |
| **UTM** | 免费开源 | 否 | 只有软件渲染，整体最慢，但能用（我们的界面是 WebView2，不依赖 GPU） |
| **VirtualBox 7.2+** | 免费开源 | 否 | 3D 还是实验性 |
| **Windows 365 Cloud PC** | 订阅 | ✅ 是 | 云端 Windows，不用占本机磁盘；按订阅付费 |

**注意**：微软唯一"官方认可"的第三方是 Parallels（2023 年起）；其余方案能跑，但 Windows 的
授权与更新支持要自己担。合规敏感的场合选 Parallels 或 Windows 365。

**放哪里**：虚拟机系统盘 60–120GB。本机内部盘只剩几十 GB，**把镜像放到外置盘**
（`/Volumes/External`，还有 2.2TB）。Parallels / Fusion / UTM 都允许自定义位置。

**不要用的**：
- **Whisky / Wine**（本机已装）：Tauri 依赖 **WebView2（Edge）**，在 Wine 下基本跑不起来，
  而且它不是真实 Windows 环境——别在这上面花时间。
- **VirtualBuddy**（本机已装）：它只能跑 **macOS 客户机**，帮不上 Windows。

## 办法三：一台便宜的 Intel 小主机（最忠实，也最便宜）

如果能接受再添一台机器：**二手/全新 Intel N100 或 i5 小主机 + 16GB 内存（约 ¥700–1500）+ 远程桌面**。

- 它**就是画像机的规格**：16GB、无独显、真 Windows、真杀软、真 WPS、真微信——
  "在她那种电脑上到底是什么手感"只有这种机器能给答案；
- 顺带还能当 Windows 原生构建/试装机器（避免"只有 CI 能出安装包"）；
- 比任何虚拟机都便宜，而且不需要 Mac 常开。

## 每次要在 Windows 上过一遍的清单

按顺序做，每一条都写清"怎么看、算通过的标准是什么"。

1. **装得上、起得来**：把 `Cante_x.x.x_x64-setup.exe` 拷过去双击安装 → 开始菜单能启动 → 窗口出现。
   *通过*：不需要任何命令行操作；安装过程没有报错弹窗。
2. **未签名提示的第一印象**：记录 SmartScreen / 杀软（Windows Defender 或第三方）具体说了什么。
   *通过*：我们知道**用户会看到什么**，并且产品里有对应的解释文案；如果提示吓人，这就是必须解决的产品问题。
3. **启动不闪黑窗**：启动应用、点几张卡，全程盯着有没有控制台窗口一闪。
   *通过*：一次都没有。**不通过就是 bug**（我们在代码里处理过，但没在真 Windows 上确认）。
4. **文件选择与中文路径**：把要处理的文件放在 `C:\Users\<名字>\Desktop\测试 文件夹\` 这种**带空格和中文**的路径下，走一遍完整任务。
   *通过*：对话框能打开、能多选、路径不出乱码、结果文件落在**原文件旁边**且能在资源管理器里看到。
5. **「打开所在文件夹」真的打开**：在结果卡片上点它。
   *通过*：资源管理器打开到**那个文件夹**（不是"文档"或空白窗口）。
6. **WPS 的 `.et`**：用真 WPS 存一个 `.et`，选进来。
   *通过*：**在开始之前**就被说清"这是 WPS 自己的格式、读不了"，并且给出的"另存为 Excel 文件"这一步
   在真 WPS 里确实做得到（这是 #88 的文案能不能落地的唯一验证方式）。
7. **微信 PC 常开时的表现**：一边开着微信（含中文输入法）一边用它。
   *通过*：窗口切换正常、输入框能用中文输入法正常输入、**产品里没有任何"自动发送"的入口**；
   接龙/聊天记录"粘进来"这条路走得通。
8. **手感（16GB 机器）**：启动到能点第一张卡要多久？跑一张表的时候界面卡不卡？
   *通过*：启动几秒内可用；点击有即时反馈；没有"点了没反应"的瞬间。

## 发现问题怎么报回来

一句话就够，但请带上这四样（缺一样都会让我多花一轮去猜）：

1. **在哪一步**（上面清单的编号）；
2. **看到什么**（截图最好；文案/弹窗原文）；
3. **期望是什么**；
4. **机器信息**（Windows 版本、内存、是虚拟机还是真机——虚拟机上的性能问题不等于真机问题）。

我会把它落成 issue，按"能不能看懂 / 会不会弄坏她的东西 / 是不是白等"三条产品律排优先级。

## 办法四（步骤最多，所以放在最后）：在远程 Windows 服务器上跑真机任务普查

前面三个办法看的是**界面**；这个办法跑的是**任务**：把 `gui/scripts/sweep/` 那套
普查（用产品真实的 `instructionFor` 指令驱动真守护进程、自动应答审批、把产出读
回来核对、生成 `report.md`）搬到真 Windows 上跑，再把结果打成一个 zip 拷回来。
这是把"20 多张卡只在 macOS 上验过"这个缺口补上最快的一条路——不需要重建机器，
一台能 RDP 的服务器就够。

普查的用法与设计在 `gui/scripts/sweep/README.md`；这一节只讲**怎么在一台干净的
Windows 服务器上把它跑起来、结果怎么拿回来、以及它验不了什么**。

### 前置条件

| 项 | 要求 | 说明 |
| --- | --- | --- |
| Windows 版本 | Windows 10 1809+ / 11；Server 2019+ | 只影响 WebView2 与安装包，普查本身要求不高 |
| **WebView2 运行时** | **必须有** | Win11 与较新的 Win10 自带；**Windows Server 默认没有**。我们安装包会去下载它，但要联网；离线机器要先手动装 |
| 管理员权限 | 装应用要，跑普查不要 | 静默安装与装 WebView2 需要；普查只用当前用户目录 |
| Python | **3.10+** | 普查脚本是 Python（只用标准库，不用装包） |
| bun | 必须有 | 提示词一律由产品自己的 `prompts.ts` 生成，不能用别的方式代替 |
| Rust / cargo | **不需要** | 核验产出用的 `cante-sheets` / `cante-pdf` 由安装包带来，不在服务器上编译 |
| 仓库 | 可读即可，不必可写 | 仓库只读时用 `--work` 把工作目录指到别处（见下） |

WebView2 单独装（任选一种）：

```powershell
winget install Microsoft.EdgeWebView2Runtime
# 或者从 https://developer.microsoft.com/microsoft-edge/webview2/ 下 Evergreen Bootstrapper
```

### 三条命令的完整流程

**1) 装应用**（管理员 PowerShell；`/S` 是静默安装，去掉就是双击那种向导）：

```powershell
.\Cante_x.y.z_x64-setup.exe /S
# 装完确认三个可执行文件在（守护进程 + 两个核验工具）：
Get-ChildItem $env:LOCALAPPDATA -Recurse -Filter cante-sheets.exe -ErrorAction SilentlyContinue |
  Select-Object -First 3 FullName
```

Tauri 的 NSIS 默认装到 `%LOCALAPPDATA%\Cante`（也可能在 `%LOCALAPPDATA%\Programs\Cante`
或 `%PROGRAMFILES%\Cante`）；上面那条命令就是用来确认实际位置的。

**2) 设模型端点**（只活在这个 PowerShell 窗口里，不写进任何文件）：

```powershell
$env:OPENAI_COMPATIBLE_BASE_URL = "https://你的网关/v1"
$env:OPENAI_COMPATIBLE_API_KEY  = "sk-…"
# 找不到守护进程时，脚本的报错会告诉你要设哪几个变量；一般是这个：
$env:CANTE_BIN = "$env:LOCALAPPDATA\Cante\ante.exe"
# 两个核验工具也可以单独指（带空格的路径不用加引号也行，脚本用列表参数调用）：
# $env:CANTE_SHEETS_BIN = "$env:LOCALAPPDATA\Cante\cante-sheets.exe"
# $env:CANTE_PDF_BIN    = "$env:LOCALAPPDATA\Cante\cante-pdf.exe"
```

**3) 跑普查**（Windows 上没有 bash，用 PowerShell 入口；参数与退出码原样转发）：

```powershell
cd <仓库>
powershell -ExecutionPolicy Bypass -File gui\scripts\task-sweep.ps1 --list
powershell -ExecutionPolicy Bypass -File gui\scripts\task-sweep.ps1 excel.diff
powershell -ExecutionPolicy Bypass -File gui\scripts\task-sweep.ps1 excel.merge excel.tidy
powershell -ExecutionPolicy Bypass -File gui\scripts\task-sweep.ps1 pdf
powershell -ExecutionPolicy Bypass -File gui\scripts\task-sweep.ps1 --work "$env:TEMP\cante-sweep" --zip
```

* `--list`：看全部卡片（带场景的会显示成 `excel.merge[列名一致]`）。
* 只跑几张卡：把卡片 id 写在后面（`excel.diff`）；只跑一类：给整类前缀
  （`excel` / `files` / `pdf` / `doc` / `wechat`）。
* 跑多久：正常一张卡 **30–60 秒**，慢模型实测到过 850 秒。所以有两个旋钮：
  `--timeout`（默认 1800 秒，安全上限，别调小）与 `--stall-timeout`（默认 300 秒，
  这么久一个事件都没有才算「卡住」）。报告里「卡住」与「超时到顶」是两类不同结论。
* 仓库只读 / 不想写进仓库：`--work "$env:TEMP\cante-sweep"`。报告开头的
  「这次是怎么跑的」一节会写明实际用的路径。
* 环境变量在 PowerShell 里想临时用一次也行：
  `$env:SWEEP_TIMEOUT = "900"`。

### 结果怎么拿回来

跑完控制台会打印一行「结果包：`C:\…\cante-sweep-<时间>.zip`」。包里有：

| 位置 | 内容 |
| --- | --- |
| `report.md` | 一张卡一行的结论（通过 / 停下问问题 / 失败），失败带可操作证据 |
| `work/` | 每张卡的输入副本、产出、`sweep-events.jsonl` 原始事件日志 |
| `app-logs/` | `%USERPROFILE%\.ante\logs` 里最近 7 天的应用日志 |
| `ZIP-说明.txt` | 这个包是怎么跑出来的、哪些文件因为含密钥没进包 |

把**这一个 zip** 拷回开发机就够（报告 + 证据 + 日志都在里面）。没打包的话，至少
拷 `report.md` 与 `work\results.json`（用 `--work` 改过目录时，报告开头写着实际路径）。

**密钥不会进包**：环境变量里像密钥的值（`*_API_KEY` / `*TOKEN*` / `*SECRET*` …）
会从文本文件里擦成 `<已隐藏的密钥>`，命中的二进制文件整个不打包，
`settings.json` / `catalog.json` / `*.env` / `*.pem` / `*.key` 直接排除；包里的
路径也已把真实家目录敏化成 `<用户>` / `~`。

### 说清局限：这些必须人坐在 RDP 里手验

普查能答的是「任务与产出」：真实的提示词发下去会怎样、计划/风险提示写得对不对、
产出格式对不对、原件有没有被改坏。下面这些**自动化覆盖不到，必须人按上面
「每次要在 Windows 上过一遍的清单」那 8 条手验**：

1. **原生文件对话框**（清单第 4 条）——RDP 里也是真窗口，只能人点；中文/空格路径、
   结果落在原文件旁边也得人看。
2. **未签名提示 / 杀软**（第 2 条）——跟安装包签名和机器策略有关，脚本给不出
   「王姐会看到什么」这种第一印象。
3. **控制台黑窗闪不闪**（第 3 条）——普查自己用 `CREATE_NO_WINDOW` 把子进程窗口藏了，
   所以它**不能**当这条的证据。
4. **微信 PC + 中文输入法**（第 7 条）——要在 RDP 里装真微信、切真输入法，人自己敲。
5. **WPS 的 `.et`**（第 6 条）——要装真 WPS，才能验那句「这是 WPS 自己的格式」
   的提示落不落得地。
6. **手感**（第 8 条）——RDP 的延迟会污染判断，别在 RDP 里给「卡不卡」下结论。
7. **字体与排版**（第 1 条）——普查不看界面，一条渲染问题都发现不了。

还有一条要说在明处：**RDP 会话里的普查本身没人验过**。如果同一张卡在 Windows 上
的结论与 macOS 上明显不同（比如从「通过」变「失败」），先怀疑环境（驱动器盘符、
路径长度、编码、WebView2 版本、有没有装 WPS/微信），再怀疑模型与提示词。
