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

## 第一次真机验收记录（2026-09，Windows 11）

**完整报告：[WINDOWS-ACCEPTANCE-1.md](./WINDOWS-ACCEPTANCE-1.md)**（那份文档里每句结论都有命令或原始输出；
可复跑的取证脚本在 `scripts/windows/`）。这里只留结论：

- 机器：`<机器名>`，Windows 11 Home 25H2 / build 26200.9457 / x64 / 39.65GB 内存；WebView2 `153.0.4234.32` 已装。
  验的是 SSH 会话（**没有交互桌面**），所以上面那份 8 条清单里的需要人眼看的部分**全部没走**。
- 受测产物是 Release `gui-v0.1.0-rc1`，而它指向的提交 **比"简单模式成为唯一界面"早一个集成轮次**——
  所以这份安装包打开的是**英文的旧开发者界面**，不是王姐的中文简单模式。
- 装得上、打得开、**WebView2 真的起来了**（`cante-gui.exe` 拉起 `msedgewebview2.exe`，窗口 1193x796，
  `Responding = True`），普通用户静默安装退出码 0，Defender 全程没报威胁。
- **但什么活都干不了**：NSIS 与 MSI 里各自只有 `cante-gui.exe` + `uninstall.exe`——
  没有守护进程，也没有 `cante-sheets` / `cante-pdf`。
  （`tauri.conf.json` 的 `bundle.resources` 在 Windows 上少了 `.exe`，两个工具进不了包。）
  窗口状态栏上写着 `could not start \`cante serve\`: program not found`——英文原文直接端给用户。
- **没验证的（重要）**：真实双击的 SmartScreen 第一印象（命令行下载的文件没有 Mark of the Web，
  SmartScreen 在物理上不会触发）、窗口观感/字体/中文排版、**控制台黑窗**（连 `cante serve` 都没起来，
  这条路径根本没被触发，所以这次对它是零信息）、中文路径全流程、WPS/微信/输入法、
  Rust 侧与打包（这台机器没有 `cargo`，`scripts/e2e.sh` 断在第 6 步）。
- 顺手测到的好消息：**Windows 上前端门禁全绿**——`bun test src` 542 通过 0 失败、
  `bunx tsc --noEmit` 干净、`bun run build:web` 成功；只有需要 `cargo` 的那一步断掉。
- 两个留给下一轮修的工具坑：`scripts/dom-smoke.sh` 在 Windows 上跑不动（写死 `python3`、
  中文输出撞 cp1252、`CHROME` 默认是 macOS 路径）；`scripts/windows/*.ps1` 必须存成 **UTF-8 with BOM**，
  否则 Windows PowerShell 5.1 按 GBK 解析，中文直接报语法错。
- 下一步最要紧的一条：**给一个从当前 main 打出来的 Windows 包**，否则后面所有体验类结论都在测旧产品。

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

## 用 WSL 跑真实端到端验收

上面那份清单能证明"装得上、起得来、点得动"，但证明不了**真跑一张卡真的做完了事**。
这一节专门解决它：让 Windows 上的应用连上一个**真的守护进程**，把一张卡从头跑到尾。

### 为什么只能这样

上游的 `cante`/`ante` **只有 Linux 与 macOS 构建**（官方 README 说 Windows 建议用 WSL）。
Windows 上没有原生守护进程，应用就会去找 `cante`（`CANTE_BIN` 或 PATH），找不到就没有会话——
这正是 `gui/README.md` 里写的"没有守护进程"那一类故障。所以唯一可行的路是：

**守护进程跑在 WSL 里，Windows 上的应用用 `CANTE_BIN` 指过去。**

WSL 里的 Linux 能访问局域网网关（上游二进制里本来就要连那个模型端点），这条路我们已经在
Windows 11 + WSL（Ubuntu）上确认过能起来。

### 三步

1. **在 WSL 里装好 Linux 版 `ante`**（一次就够，之后可重复运行）：

   ```powershell
   powershell -ExecutionPolicy Bypass -File gui\scripts\windows\wsl-ante-setup.ps1
   ```

   脚本会下载并解包到 WSL 里的 `~/cante-bin/`，跑 `ante --version` 和 `ante --help` 自检，
   最后**打印出该设的 `CANTE_BIN` 值**。默认版本是 `0.preview.99`，可以 `-Version nightly` 换。

2. **把打印出来的值设成 `CANTE_BIN`**。它长这样：

   ```
   wsl.exe -e /home/<你的用户>/cante-bin/ante serve
   ```

   只对当前窗口生效（验收最省事）：

   ```powershell
   $env:CANTE_BIN = "wsl.exe -e /home/<你的用户>/cante-bin/ante serve"
   ```

   或设成用户级（之后新开的窗口都带上，**要重新登录**才会传给开始菜单启动的程序）：

   ```powershell
   [Environment]::SetEnvironmentVariable("CANTE_BIN", "wsl.exe -e /home/<你的用户>/cante-bin/ante serve", "User")
   ```

3. **从带了这个变量的窗口启动应用**，走一遍要验收的卡：

   ```powershell
   & "$env:LOCALAPPDATA\Cante\Cante.exe"     # 换成实际安装位置
   ```

   应用把 `CANTE_BIN` 当"命令"看，不是当路径：它认得这条里已经写好的 `serve`，不会再自己补一个
   （所以不会变成 `ante serve serve`）。这条规则有测试：`gui/src-tauri/tests/binary_spec.rs`。

### 怎么确认真的连上了（别只看窗口在不在）

| 看什么 | 通过的标准 |
| --- | --- |
| WSL 里 | `wsl.exe -e /home/<用户>/cante-bin/ante --version` 打印出版本号（脚本已经替你跑过） |
| 应用首次检查 | 过程走完、进到"准备好了"，**不是**"干活需要的组件还没装好"——后者说明版本探测没到位 |
| 供应商列表 | 能列出来。这份列表来自 `ante catalog`，列得出来就说明应用真的在跟 WSL 里那个二进制说话 |
| 真跑一张卡 | 挑一张**只读、不依赖 Windows 专有工具**的卡（例如合并两张表），能出结果文件、能在资源管理器里看到 |
| 日志 | 应用里没有出现"组件没装好"这类提示，也没有意外的守护进程退出（`cante://exit`）；stdout 里没有一堆非 JSON 行 |

一条卡跑完**至少留 1800 秒**（慢模型实测 850 秒；超时设 600 会把成功误判成失败）。

### 明确的限制（这些是"我们验收的临时办法"，不是产品方案）

- **这不是交付给用户的方案**。王姐不会装 WSL，也不该需要。它只是我们自己的验收手段；
  用户机器上"没有守护进程"这件事仍然要靠安装包和面向用户的说明去解决，这条临时的路替代不了它。
- **路径映射**：应用选出来的是 Windows 路径（`C:\Users\...\表.xlsx`），而 Linux 侧看到的是
  `/mnt/c/Users/.../表.xlsx`。模型得自己把这层对上。**验收时要专门看这一条**：如果它说找不到文件，
  那是路径映射的问题，不是"卡本身不行"——记下来，这需要另一张单子去改桥接层。
- **性能不是真机结论**：虚拟机/WSL 上的耗时不能当作画像机（16GB 无独显）的体感。
- **`bash -lc '……'` 那种写法别用**：作为 `CANTE_BIN` 它能起来，但应用的 `--version` / `catalog`
  探测没法插到那段命令里（整串就是命令本身），首次检查会以为组件没装。用上面打印的那种简单写法。
- **SSH 会话里看不到窗口**：从 SSH 起的 GUI 没有交互桌面，截图是空的。要看窗口必须走 **RDP**，
  或把进程挂到已登录的会话上。

### 这条路什么时候算"验收过"

一份能让别人复核的最小证据：`ante --version` 的输出、应用里那张"准备好了"的截图（或供应商列表）、
**一张卡的结果文件**（含文件路径和内容），以及跑这一轮的 `CANTE_BIN` 原文。缺哪一样都算没跑。

## 每周一次的真机普查（Windows 计划任务，2026-09）

普查（`gui/scripts/sweep/`）本来只在有人手动跑的时候才跑。这台验收机有工具链、能连网关、
反正开着，所以把它接成了**每周自动跑一次**，报告落在固定位置，发现回归可以在报告里直接看到。

### 这台机器上怎么建的

| 项 | 值 |
| --- | --- |
| 计划任务名 | `CanteWeeklySweep` |
| 触发 | 每周日 03:30（`-Weekly -DaysOfWeek Sunday -At 03:30`）+ `StartWhenAvailable`（错过就补跑） |
| 动作 | `powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\cante\gui\scripts\windows\weekly-sweep.ps1` |
| 以谁的身份 | 当前用户，登录类型 **Interactive**（原因见下面的限制） |
| 报告 | `C:\cante-sweep\report-YYYYMMDD.md`（保留最近 **8** 份，按文件名排序删最旧的） |
| 日志 | `C:\cante-sweep\logs\sweep-YYYYMMDD.log`（同样保留 8 份） |
| 一行历史 | `C:\cante-sweep\history.log`（每次一行：时间 / 退出码 / 报告大小） |
| 中间产物 | `C:\cante-sweep\wsl-work\`（每张卡的输入副本与产出、`results.json`） |

跑的东西是 `gui/scripts/windows/weekly-sweep.ps1`，它在 **WSL 里**跑普查：

```
wsl.exe -e bash -lc 'export PATH=$HOME/.bun/bin:$PATH
                      export CANTE_BIN=$HOME/cante-bin/ante
                      export CANTE_SHEETS_BIN=<out>/bin/cante-sheets
                      export CANTE_PDF_BIN=<out>/bin/cante-pdf
                      cd /mnt/c/cante && bash gui/scripts/task-sweep.sh --work <out>/wsl-work --report <out>/report-<日期>.md'
```

**为什么在 WSL 里跑**：守护进程 `ante` 只有 Linux/macOS 构建，普查要驱动真守护进程；而普查自己
产出的路径会被写进给助手的指令里，只有整个普查（连同它的 python/bun）都在 Linux 侧跑，
那些路径才是 Linux 侧认得的。

**两个 `bin/` 下的垫片是什么**："读回产出"用的 `cante-sheets` / `cante-pdf` 是 Windows 的 `.exe`，
WSL 能执行（互操作），但参数里的 Linux 路径要先 `wslpath -w` 翻一次。所以 `weekly-sweep.ps1`
每次运行时现场生成两个十行的垫片（LF 行尾、无 BOM），再用 `CANTE_SHEETS_BIN` / `CANTE_PDF_BIN`
交给普查。不这么做的话，普查要么挑到 Windows 构建留下的 0 字节占位符（`Exec format error`），
要么退回它内置的读取方式——报告里就不再是"产品自己的工具读回来的"。

**密钥从哪来**：不落盘、不进命令行。`weekly-sweep.ps1` 运行时从
`%USERPROFILE%\.pi\agent\models.json` 读服务方（默认 `9router`）的 `baseUrl` / `apiKey`，
只放进程环境变量，再用 `WSLENV` 渡过 WSL 边界。要换服务方就 `-Provider <名字>`。

### 怎么手工跑一次 / 改频率 / 停掉

```powershell
# 手工跑（等价于计划任务那次；只跑一张卡时加 -Cards）
powershell -ExecutionPolicy Bypass -File gui\scripts\windows\weekly-sweep.ps1
powershell -ExecutionPolicy Bypass -File gui\scripts\windows\weekly-sweep.ps1 -Cards excel.diff

# 立刻触发计划任务一次（不手工跑上面那条）
schtasks /run /tn CanteWeeklySweep
schtasks /query /tn CanteWeeklySweep /v /fo LIST      # 看 Status / Last Run Time / Last Result

# 改频率（例如改成每周一 04:00）：删掉重建，参数与上面表里的一致
schtasks /delete /tn CanteWeeklySweep /f

# 停掉（不再自动跑；历史报告不动）
schtasks /change /tn CanteWeeklySweep /disable
# 彻底删掉
schtasks /delete /tn CanteWeeklySweep /f
```

注意 `schtasks` 在 Git Bash 里会把 `/tn` 当成路径，要么用 PowerShell，要么加 `MSYS_NO_PATHCONV=1`。

### 它什么时候"真的跑了"

别只看任务存在。三样一起看：

1. `schtasks /query /tn CanteWeeklySweep /v /fo LIST` 里的 `Last Run Time` 与 `Last Result`（0 = 成功）；
2. `C:\cante-sweep\report-YYYYMMDD.md` 存在且不是空的（**报告是跑完才写的**，跑到一半只有一份空壳，
   所以"文件在"不等于"跑完了"——要看里面的卡片表）；
3. `C:\cante-sweep\history.log` 每次一行。

### 已知限制（都实测过，不是推测）

- **登录类型只能是 Interactive**：这台机器上的用户没有"作为批处理作业登录"的权限，用
  `-LogonType S4U`（"不管用户是否登录都运行"）注册会直接 `Access is denied`（0x80070005）；
  而以 SYSTEM 跑又不行——WSL 发行版是**按用户**注册的，SYSTEM 看不到它。
  实测 Interactive 的任务在"只有 SSH、没有交互桌面"的时候**照样会被触发**（我们用一次性探针任务
  验过：没有手工触发，到点自己跑了、Last Result=0、文件写出来了）。
  **但机器如果一直没人登录、又碰上 `StartWhenAvailable` 的处理，最坏情况是错过一次**——
  每周报告断了一次就去看 `history.log` 和任务的 Last Run Time。
- **WSL 里必须有原生 bun**（`$HOME/.bun/bin/bun`）。`/mnt/c` 上那份是 Windows 的，
  在 WSL 里用它+Linux 路径会出问题。装法（WSL 里没有 unzip 时用 python 解压）见
  `gui/WINDOWS-ACCEPTANCE-4.md`。
- **一跑就是全部卡**（这个仓库的默认：30 多张）。单卡上限 1800 秒、卡住判据 300 秒，
  所以一次跑几十分钟是正常的。想缩短就 `-Cards excel.diff`（那样报告只覆盖这几张）。
- **报告里的结论仍然是"模型 + WSL"下的结论**，不能当画像机（16GB 无独显）的体感证据。
- **这台机器上的普查不是 CI**：它是我们自己的回归预警，不挡合并。
