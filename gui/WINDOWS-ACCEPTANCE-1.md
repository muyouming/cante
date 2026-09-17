# 第一次 Windows 真机验收（Windows 11 Home，2026-09）

这是 Cante 第一次在**真 Windows** 上做的验收：装我们的安装包、把它启动起来、把"到底会发生什么"
如实记下来。**结论不好看，但不是编的**——这份文档里每一句结论后面都有命令或原始输出。

- 验收机器：`HOMEWIN`（Windows 11 Home 25H2 / build 26200.9457 / x64）
- 受测产物：GitHub Release `gui-v0.1.0-rc1` 里的 `Cante_0.1.0_x64-setup.exe`
- 验收人：跑在那台机器上的 pi（**SSH 会话**，没有交互桌面——这条限制贯穿全文，见第 7 节）
- 取证脚本：`gui/scripts/windows/`（`collect-environment.ps1` / `inspect-installer.ps1` /
  `probe-installed-app.ps1` / `capture-window.ps1` / `dump-window-text.ps1`）
- 原始输出：都留在那台机器的 `%TEMP%\cante-acc\evidence\`（文件名与本节各段一一对应）

---

## 0. 一句话结论（先看这个）

**装得上、打得开、窗口真的画出来了（WebView2 起得来），但王姐什么活都干不了：她看到的是一个
英文的开发者界面，状态栏上一行小字写着 `could not start \`cante serve\`: program not found`
——因为安装包里根本没有干活的那个程序。**

这一句拆成两个可核对的事实：

1. **安装包里只有 GUI**。`Cante_0.1.0_x64-setup.exe`（NSIS）与 `.msi` 里各自只有
   `cante-gui.exe`（8,930,304 字节）和 `uninstall.exe`。没有 `cante` / `ante` 守护进程，
   也没有 `cante-sheets` / `cante-pdf` 两个自带工具（第 2 节）。
2. **窗口里渲染出来的是英文开发者界面，不是中文的简单模式**。用 UI Automation 把窗口里的
   文案读出来，拿到的是 `coding agent · graphical client`、`Model: — — choose a model (⌘M)`、
   `Message Cante`、`No session yet` 这一组，并且有一条
   `could not start \`cante serve\`: program not found`（第 4 节）。

第 2 条的成因是可查的、**不是猜的**：`gui-v0.1.0-rc1` 指向的提交是
`cfe9a87 chore(gui): integrate the first optimisation round (#15)`（2026-09-16 08:19 +0900），
而"简单模式就是产品"那一轮（`8fb1300 ... the simple surface is the product — integrate round 5 (#68)`）
是当天 13:06 才进的。`git show gui-v0.1.0-rc1:gui/src/App.tsx` 里只有
`SessionRail` / `CommandPalette` / `Composer` 这一套；当前 `main` 的 `App.tsx` 只渲染 `SimpleApp`。

也就是说：**这份安装包比"简单模式成为唯一界面"早了一个集成轮次**。所以这条结论只对
**rc1 这个产物**成立；对"从今天的 main 打出来的 Windows 包会怎样"我**没有验证**（原因见第 7 节：
这台机器没有 Rust）。

---

## 1. 环境事实

命令：`powershell -NoProfile -ExecutionPolicy Bypass -File gui/scripts/windows/collect-environment.ps1`
（在安装**之前**跑的那份是 `evidence/01-environment-before-install.txt`）

| 项 | 值 |
| --- | --- |
| 机器名 | `HOMEWIN` |
| 系统 | Microsoft Windows 11 Home，`10.0.26200`，build `26200`，UBR `9457`，DisplayVersion `25H2`，EditionID `Core` |
| 架构 | 64-bit（OSArchitecture = 64-bit） |
| CPU / 内存 | 13th Gen Intel Core i5-13500H（12 核 16 线程）；总内存 39.65 GB，空闲约 27 GB |
| 显卡 | Intel Iris Xe Graphics；另有一个 `Microsoft Remote Display Adapter` |
| WebView2 | **已装**：`Microsoft Edge WebView2 Runtime`，版本 `153.0.4234.32`，来自 `HKLM\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-…}`，磁盘目录 `C:\Program Files (x86)\Microsoft\EdgeWebView\Application\153.0.4234.32` |
| 此前是否装过 Cante | **没有**（安装前：卸载注册表项无匹配，`%LOCALAPPDATA%\Cante`、`Program Files\Cante`、`%USERPROFILE%\.cante`、`.ante` 全部 `False`） |
| 守护进程 | `CANTE_BIN` 未设置；PATH 里没有 `cante`，也没有 `ante`；`.cante` / `.ante` 都不存在 |
| WSL | 有 3 个发行版（`Ubuntu` 默认 / `Ubuntu2` / `Ubuntu3`），**全部 Stopped，VERSION 2**。按任务要求，这次**没有**用它跑 Linux 版 `ante` |
| 会话 | `SESSIONNAME` 环境变量为空；`Win32_ComputerSystem.UserName` 为空 → **控制台上没有登录用户**；`quser.exe` / `qwinsta.exe` 在这台机器上不存在（系统里也没这两个文件），所以拿不到会话列表。结论：这是 SSH 会话，**没有交互桌面** |
| 是否提权 | `IsInRole(Administrator) = False`——**普通用户**，安装没有提权 |
| 工具链 | bun `1.4.2`、node `v24.19.0`；**没有** `cargo`；7-Zip `26.03` 在 `C:\Program Files\7-Zip\7z.exe` |

两条**这台机器的画像偏差**，写在这里免得后面被误读：

- 系统区域是 `en-US`（首选 UI 语言 `en-US, zh-Hans-SG`，HomeLocation=China，时区=Tokyo）。
  也就是说这台机器**不是中文界面**，中文路径/字体/输入法那一类问题它代表不了画像机。
- 内存 39.65 GB、有核显，**不是** 16GB 无独显的画像机，手感类结论不能从这里出。

（注册表 `ProductName` 写的是 `Windows 10 Home`，这是 Win11 上众所周知没改的老字段，
`DisplayVersion=25H2`、build 26200 才是真的。）

---

## 2. 安装包检查

命令：

```bash
gh release list -R muyouming/cante
gh release download gui-v0.1.0-rc1 -R muyouming/cante \
  -p 'Cante_0.1.0_x64-setup.exe' -p 'Cante_0.1.0_x64_en-US.msi'
powershell -File gui/scripts/windows/inspect-installer.ps1 -Setup <安装包路径>
```

### 2.1 拿到的东西

Release `gui-v0.1.0-rc1`（`createdAt 2026-09-15T23:19:50Z`，tag 指向
`cfe9a87289c993f8fb9ef4ef72cbcda61895af3e`）三个资产：

| 文件 | 大小 |
| --- | --- |
| `Cante_0.1.0_aarch64.dmg` | 2,835,709 |
| `Cante_0.1.0_x64-setup.exe` | 1,929,671 |
| `Cante_0.1.0_x64_en-US.msi` | 2,912,256 |

我下载了后两个（原始输出：`evidence/02-inspect-nsis.txt`、`evidence/03-inspect-msi.txt`）：

```
ADE9B2D42F33C24C66298D6B3D8169D02E6153C84E7B5265FB6472EA7FA83C88  Cante_0.1.0_x64-setup.exe
0B01FB0EAB937C3DF963D8CC070888A3297A814F65C21A13DCCA98F19E5B05CC  Cante_0.1.0_x64_en-US.msi
```

`Get-Item … VersionInfo`：`FileDescription = Cante`，`FileVersion = 0.1.0`，
`ProductName = Cante`，`ProductVersion = 0.1.0`。

### 2.2 哪一种安装包、里面有什么

**`Cante_0.1.0_x64-setup.exe` 是 NSIS**（`7z l -slt`）：

```
Type = Nsis
Method = LZMA:23
Solid = +
SubType = NSIS-3 Unicode
```

包内文件清单（完整）：

```
$PLUGINSDIR\System.dll            12288
$PLUGINSDIR\modern-wizard.bmp     26494
$PLUGINSDIR\nsDialogs.dll          9728
$PLUGINSDIR\nsis_tauri_utils.dll  34304
$PLUGINSDIR\StartMenu.dll         13316
$PLUGINSDIR\NSISdl.dll            15360
cante-gui.exe                   8930304
uninstall.exe                     79066
```

`$PLUGINSDIR` 那六个是 NSIS 自己的插件和向导图，不是我们的东西。**真正的载荷只有
`cante-gui.exe` 一个**。

**`.msi` 里也一样**：7-Zip 看到 `app.cab` 里只有一个 8,930,304 字节的文件（cab 里是短名 `Path`），
用 `msiexec /a`（管理安装，只解包不注册）解出来是 `PFiles\Cante\cante-gui.exe`，大小对得上。

按文件名匹配的结果（NSIS 与 MSI 都跑了）：

```
cante.exe       -> <无>
ante.exe        -> <无>
cante-sheets*   -> <无>
cante-pdf*      -> <无>
```

**这条和源码对得上**：`gui/src-tauri/tauri.conf.json` 的 `bundle.resources` 写的是

```json
"resources": {
  "target/release/cante-sheets": "cante-sheets",
  "target/release/cante-pdf": "cante-pdf"
}
```

Windows 上编译产物叫 `cante-sheets.exe` / `cante-pdf.exe`，这两个**没有 `.exe` 后缀**的源路径
在 Windows 上不存在，所以它们进不了包 —— 结果就是真机上 `cante-sheets` / `cante-pdf` 都不在。
（这是我从"包里没有"+"配置这么写"两头对上得出的；`tauri build` 当时为什么没因此报错，我**没有验证**，
这台机器没有 Rust。）

### 2.3 签名与 SmartScreen 的前置条件

`Get-AuthenticodeSignature`：

```
Cante_0.1.0_x64-setup.exe      Status = NotSigned | SignerCertificate = <无>
Cante_0.1.0_x64_en-US.msi      Status = NotSigned | SignerCertificate = <无>
…\Cante\cante-gui.exe          Status = NotSigned | SignerCertificate = <无>
```

**三个都是未签名**。另一件必须说清的事：这个下载来的 exe **没有 Mark of the Web**：

```
=== 是否带「来自互联网」标记（Mark of the Web） ===
没有 Zone.Identifier（这份文件不是浏览器下载来的，SmartScreen 不会因此拦它）。
```

用 `gh release download` 拿到的文件不带 `Zone.Identifier`。所以**这次验收根本没有碰到 SmartScreen
那条路**——SmartScreen 是资源管理器双击时按 MOTW 决定要不要弹的，命令行拉下来的干净文件不会触发。
"王姐双击会看到什么"必须由 RDP 里从浏览器下载再双击来验证（第 7、8 节）。

---

## 3. 安装过程

### 3.1 静默安装

```powershell
Start-Process -FilePath 'Cante_0.1.0_x64-setup.exe' -ArgumentList '/S' -PassThru -Wait
# ExitCode=0
```

- **退出码 0**，而且在**没有提权**的会话里就装完了（`tauri.conf.json` 的
  `bundle.windows.nsis.installMode = "currentUser"`）。
- 安装位置：`C:\Users\<用户名>\AppData\Local\Cante`，里面只有两个文件（合计 9,009,370 字节）：

```
cante-gui.exe   8930304
uninstall.exe     79066
```

- 注册表卸载项（`HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*`）：

```
DisplayName     : Cante
DisplayVersion  : 0.1.0
Publisher       : cante
InstallLocation : "C:\Users\<用户名>\AppData\Local\Cante"
UninstallString : "C:\Users\<用户名>\AppData\Local\Cante\uninstall.exe"
DisplayIcon     : "C:\Users\<用户名>\AppData\Local\Cante\cante-gui.exe"
EstimatedSize   : 8798
```

- 快捷方式两个：开始菜单 `Cante.lnk`、桌面 `Cante.lnk`。
- **没有**写自启动项（`HKCU\…\CurrentVersion\Run` 里那一串是 WingetUI / NeatDM / simplewall /
  Warp / 百度网盘 / Copilot，没有 Cante）。

> **静默装看不到 SmartScreen，这是安装方式决定的，不是"没触发"。** `/S` 绕过的正是
> "资源管理器双击"这个动作。要看未签名提示长什么样，必须在 RDP 会话里双击安装包。

### 3.2 杀软/拦截痕迹

- `Get-MpComputerStatus`：实时保护、行为监控、IOAV 全部开着（`RealTimeProtectionEnabled = True` 等）。
- `Get-MpThreatDetection` / `Get-MpThreat`：**空**——装和启动都没被 Defender 判成威胁。
- `Microsoft-Windows-Windows Defender/Operational`、`Microsoft-Windows-AppLocker/EXE and DLL`、
  `Microsoft-Windows-AppLocker/MSI and Script`、`Microsoft-Windows-SmartScreen/Debug`、
  `Microsoft-Windows-SmartScreen/Operational`：启动前后**没有新事件**（其中 SmartScreen 的两个
  通道在这台 Home 版上根本不存在，脚本会如实打出来）。
- `Get-Item … -Stream Zone.Identifier`：无（见 2.3）。

### 3.3 卸载

`uninstall.exe /S` → 退出码 0，安装目录、桌面/开始菜单快捷方式、注册表卸载项**全部清掉**。

**但有一处残留**：卸载**不会**清理 `%LOCALAPPDATA%\dev.cante.gui`（WebView2 的档案目录，
卸载前实测 8,941,353 字节）。这是实测，不是推测：

```
卸载前 dev.cante.gui 存在 = True
uninstall ExitCode = 0
卸载后 安装目录存在 = False
卸载后 dev.cante.gui 存在 = True      ← 8,941,353 bytes 还在
卸载后 桌面快捷方式存在 = False
```

（这条和"别弄坏我的东西"有关：一个不熟电脑的人卸载了应用，磁盘上仍然留着一份 8.9MB 的目录，
里面是浏览器的缓存/档案。要不要清、怎么清，是个产品决定，我这次只记录事实。）

验收结束后我把应用**重新装了回来**（`/S`，退出码 0），方便后面有人 RDP 上来直接看。

---

## 4. 启动行为（这次最重要的部分）

命令：`powershell -File gui/scripts/windows/probe-installed-app.ps1 -WaitSeconds 20`
（原始输出：`evidence/04-launch-probe.txt`）

### 4.1 进程事实

```
PID = 4448
20 秒后的状态
HasExited        = False
MainWindowHandle = 264216
MainWindowTitle  = 'Cante'
Responding       = True
WorkingSetMB     = 24.8
ProcessName      = cante-gui.exe
```

**进程活着，`Responding = True`，而且真的创建了一个标题为 `Cante` 的顶层窗口。**
这不是"窗口出现了我能看见"——SSH 会话里我看不见，见 4.4。

### 4.2 它拉起了什么子进程

每 200 ms 采样一次，20 秒里出现过的相关进程：

```
cante-gui.exe       | pid=4448 | ppid=10504 | cmd="…\Cante\cante-gui.exe"
msedgewebview2.exe  | pid=6688 | ppid=4448  | cmd="…\msedgewebview2.exe" --embedded-browser-webview=1
                                             --webview-exe-name=cante-gui.exe --webview-exe-version=0.1.0
                                             --user-data-dir="…\AppData\Local\dev.cante.gui\EBWebView"
                                             --noerrdialogs … --lang=en-US
```

两条结论：

1. **WebView2 真的起来了**：`cante-gui.exe` 自己拉起了 `msedgewebview2.exe`，参数里带
   `--webview-exe-name=cante-gui.exe` 和 `--user-data-dir=…\dev.cante.gui\EBWebView`。
   （`--lang=en-US` 与这台机器的系统区域一致，不是异常。）
2. **一个 `cante` / `ante` 子进程都没有出现过**。这要分两层说清楚，别混：
   - 一方面，`daemon.rs` 的注释写明守护进程是"第一次发指令时懒启动"，我这次没点任何东西，
     所以即使装了守护进程它也不该在这 20 秒里出现；
   - 另一方面，就算触发了也起不来——`cante` 不在 PATH、`CANTE_BIN` 没设、
     `C:\Users\<用户名>\AppData\Local\Cante` 里也没有它。界面自己说的那句话（4.4）印证了这一点。

### 4.3 它写出了什么文件 / 配置

启动后新增的目录只有一个：

```
C:\Users\<用户名>\.cante        存在=False
C:\Users\<用户名>\.ante         存在=False
C:\Users\<用户名>\AppData\Roaming\Cante   存在=False
C:\Users\<用户名>\AppData\Local\Cante     存在=True（就是安装目录，里面只有那两个 exe）
+ 新增：%LOCALAPPDATA%\dev.cante.gui\EBWebView（WebView2 档案，8.8 MB）
```

另外 `%TEMP%` 下多了一个 0 字节的 `9d480919-…tmp`——**它落在系统临时目录里，我没法归因到 Cante**，
所以不作为证据。（同理：验收时机器上确实有 6 个 `msedgewebview2.exe` 在跑，查了父进程是
`SearchHost`（Windows 搜索界面），**不是** Cante 的残留。）

stdout / stderr 都是 **0 字节**——`main.rs` 里 `#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]`，
发布版是 GUI 子系统，本来也不往控制台写。

### 4.4 窗口里到底画了什么

两条独立的路，互相印证。

**(a) 截图。** `capture-window.ps1` 用 `PrintWindow(PW_RENDERFULLCONTENT)` 抓主窗口
（原始输出：`evidence/05-capture-window.txt`）：

```
MainWindowHandle = 2360676
MainWindowTitle  = 'Cante'
窗口矩形 = 502,310 - 1695,1106  (1193x796)
窗口类名 = Tauri Window
IsWindowVisible = True / IsWindowEnabled = True / IsIconic = False
PrintWindow 返回 = True
图片 = %TEMP%\cante-acc-shot\main-window.png  (28383 bytes)
不同颜色数 = 280
主色调： #0B0F14 46.2% / #0E141B 22.7% / #0F172B 19.3% / #F3F3F3 7.4% / …
```

字符降采样（78x30）显示：顶部两条亮带（系统标题栏）、一条深色横带、左侧一列带文字的区块、
约 42% 宽度处有一条竖直分隔线、右半是均匀的深色。

**但这些像素只证明"窗口画了东西"，证明不了"画的是哪句话"**（而且我是看不见图片的：
这个模型不支持读图）。下面的 (b) 才是可核对的证据。

**(b) 把窗口里的文字读出来。** `dump-window-text.ps1 -ForceAccessibility` 走 UI Automation
（WebView2 默认把 DOM 的 UIA 树藏着，脚本用 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--force-renderer-accessibility`
把它打开），读到 **58 个元素**（原始输出：`evidence/06-window-text.txt`）。窗口里真实出现的文案：

```
CANTE
no session
Model: — — choose a model (⌘M)
Provider: — — choose a model (⌘M)
Reasoning effort: not set — cycle effort
Permissions: not set — cycle permissions
Command palette (⌘K)
coding agent · graphical client
Session — — start a new session
Clear the transcript view / Compact history / Context report
WORKSPACE
C:\Users\<用户名>\AppData\Local\Temp\cante-acc
Bridge and daemon status
bridge connected
daemon / idle / steps / 0
No session yet
The GUI is starting a session. If it stays empty, check the bridge status in the session rail.
Message Cante
Send message
Interrupt (⌘.)
could not start `cante serve`: program not found        ← 状态栏
```

**这就是"王姐会看到什么"的答案：**

- 一屏**英文**，术语堆着（`bridge`、`daemon`、`WORKSPACE`、`Provider`、`Reasoning effort`）；
- 快捷键是 **macOS 的 `⌘M` / `⌘K` / `⌘.`**，在 Windows 键盘上按不出来；
- **一张任务卡都没有**（这是旧版的开发者界面，不是简单模式）；
- 最后一行的 **`could not start \`cante serve\`: program not found`** 就是"没有守护进程"这件事
  在真机上长什么样——**英文原文直接端给用户**。

**为什么是英文旧界面**（可查证，不是猜）：`gui-v0.1.0-rc1` 指向 `cfe9a87`（2026-09-16 08:19 +0900），
而简单模式成为唯一入口是 `8fb1300`（当天 13:06）。`git show gui-v0.1.0-rc1:gui/src/App.tsx`
的头部注释就写着这是 "Codex / Claude-Desktop shape: a session rail on the left…"，只 import
`SessionRail` / `CommandPalette` / `Composer` 那一套。

**一个反向对照**（说明今天源码这一头是好的）：在同一台机器上，用当前 `main` 构建前端产物，
走 `bash gui/scripts/dom-smoke.sh`（Chrome 渲染，**不是 WebView2**），拿到的 DOM 是中文简单壳：

```
dom-smoke: first run (wizard): 13 text node(s) rendered
  | Cante | 历史 | 隐私 | 1 | 欢迎 | 2 | 检查电脑 | …
dom-smoke: provisioned (home): 85 text node(s) rendered
  | 你好，需要我帮你做什么？ | 点一张卡片，或者直接在下面说一句话。 | 还有别的事？ …
dom-smoke: OK — both screens rendered with every required element
```

**注意这两条不能互相代替**：dom-smoke 是 Chrome 里的浏览器预览（没有 Tauri 桥），
rc1 的截图/UIA 是真 WebView2 里的真窗口。"今天的 main 打成 Windows 包以后窗口里也是中文"
——我**没有验证**。

### 4.5 事件日志

- `Get-WinEvent -LogName Application`：启动后**一条新事件都没有**（没有崩溃、没有 .NET 异常、
  没有 Windows Error Reporting）。
- Defender / AppLocker / SmartScreen：无新事件（同 3.2）。
- `Get-MpThreatDetection`：空。

也就是说：**它在"没报错"和"能干活"之间，落到了前者。**

---

## 5. 能不能用

**不能。** 王姐装完之后：

1. 图标、快捷方式、卸载项都有，双击能打开（这一点是好的）；
2. 打开以后是一屏**英文的开发者界面**，一个中文任务卡都没有；
3. 底部一行英文写着 `could not start \`cante serve\`: program not found`——**她看不懂，也不知道
   能做什么**；
4. 就算她硬着头皮在输入框里敲一句话，也没有任何东西会回应，因为没有守护进程。

对"三条产品律"的对照：

- 把麻烦事做完 —— **没做到**（守护进程根本不在包里，工具也不在）；
- 别弄坏我的东西 —— 这一轮**没有被检验**（不认识界面、没走到选文件那一步），
  唯一相关的事实是卸载会留下 8.9MB 的 `dev.cante.gui` 目录；
- 出错能看懂并有出路 —— **没做到**：出错文案是英文原文直接端上来，而且它是状态栏里的小字，
  不是"发生了什么 + 你可以怎么做 + 复制详情"。

还有一条**代码层面的观察**（我在源码里查的，**没有在屏幕上验证**）：`gui/src/simple/copy.ts`
的 `DICTIONARY`（15 条 `test` 正则）里**没有一条能匹配 `program not found`**——
最接近的第 13 条只认 `no such file` / `file not found` / `cannot find the (file|path)`，
第 73 条只认 `daemon exited|died|crashed` / `exited with code`。所以即使换成简单模式，
这句话大概也会落到"通用兜底"而不是一条具体解释。**值得下一轮专门验一下**（在简单模式里
把 `CANTE_BIN` 指向一个不存在的程序，看用户看到什么）。

---

## 6. 我验证了什么

| # | 事项 | 证据 |
| --- | --- | --- |
| 1 | 环境事实（系统/内存/WebView2/此前没装过/没有守护进程/无交互桌面/无 Rust） | `01-environment-before-install.txt` |
| 2 | rc1 两个安装包的 SHA256、类型、**完整载荷清单** | `02-inspect-nsis.txt`、`03-inspect-msi.txt` |
| 3 | 包内**没有** `cante`/`ante`/`cante-sheets`/`cante-pdf` | 同上 |
| 4 | 三个二进制**未签名**；安装包**没有 Mark of the Web**（所以这次碰不到 SmartScreen） | 2.3 |
| 5 | **普通用户**静默安装成功，退出码 0；安装位置、两个文件、快捷方式、卸载项 | 3.1 |
| 6 | 安装与启动期间 **Defender 没有报任何威胁**（实时保护是开着的） | 3.2 |
| 7 | 静默卸载退出码 0，安装目录/快捷方式/注册表项全清；**留下 `dev.cante.gui`** | 3.3 |
| 8 | **进程活着、窗口创建成功、WebView2 真的起来了** | 4.1、4.2 |
| 9 | 20 秒里**没有** `cante`/`ante` 子进程；没有 `.cante`/`.ante` 配置 | 4.2、4.3 |
| 10 | 启动前后 Application / Defender 日志**无新事件** | 4.5 |
| 11 | 窗口真的画了内容（`PrintWindow` + 像素统计 + 字符降采样） | 4.4(a) |
| 12 | **窗口里的实际文案**（58 个 UIA 元素，含那句 `program not found`） | 4.4(b) |
| 13 | rc1 用的是旧界面，今天的 main 用简单模式（git 层面对上） | 第 0 节 |
| 14 | 本机前端门禁：`bun install` → `bun test src` 542 通过 0 失败；`bunx tsc --noEmit` 干净 | 第 9 节 |
| 15 | `bash gui/scripts/e2e.sh` 前 5 步通过、第 6 步因没有 cargo 断掉 | 第 9 节 |
| 16 | 当前 main 的前端产物在真 Chrome 里**渲染出中文简单壳** | 第 9 节 |

---

## 7. 我没能验证什么以及为什么

**这一节比上一节重要。** 下面每一条都是"没验证"，不是"通过"。

### 7.1 结构性限制：我是 SSH 会话，没有交互桌面

`Win32_ComputerSystem.UserName` 为空，控制台上没有登录用户；`quser`/`qwinsta` 在这台机器上
不存在，我没有别的办法开一个交互桌面。所以：

- **真实双击安装的第一印象（SmartScreen / 杀软弹窗）——没验证。**
  原因有二：① 这次的安装包是命令行下载的，没有 MOTW，SmartScreen **在物理上不会**被触发；
  ② 即使有 MOTW，也要资源管理器双击才会弹，SSH 会话里没有资源管理器。
  **必须 RDP**：从浏览器下载 → 双击 → 把弹窗原文和截图记下来。
- **窗口的观感——没验证。** 我拿到了 `PrintWindow` 的像素和 UI Automation 的文案，
  但**看不见画面**（这个模型不支持读图，SSH 会话也没有桌面）。
  字体、字号、中文排版、emoji 回退、"好不好看"这些问题一个都没回答。
  截图留在 `%TEMP%\cante-acc-shot\main-window.png`，等人在 RDP 里看。
- **墨迹全流程——没验证。** 点卡片 → 选文件（中文路径/带空格路径）→ 结果落在原文件旁边 →
  点「打开所在文件夹」。这需要鼠标，而且 **rc1 的界面里压根没有卡片**，
  等于"产品不会走的路径"，验证了也不算数。
- **控制台黑窗会不会闪——没验证。** 需要在有人看着的桌面上盯着看。
  补一句免得被误读成"没问题"：这次连 `cante serve` 都没起来（`program not found`），
  `CREATE_NO_WINDOW` 那条路径**根本没有被触发**，所以这次的数据对这个问题**零信息**。
- **文件对话框、WPS 的 `.et`、微信 PC、中文输入法——没验证。** 要么需要鼠标，要么这台机器上
  我也没有确认这些真环境在场（系统区域还是 en-US）。
- **16GB 无独显画像机的手感——没验证。** 这台是 39.65GB 内存 + i5-13500H，不是画像机。

### 7.2 这台机器没有 Rust

- `cargo` 不存在，`bash gui/scripts/e2e.sh` 到第 6 步 `cargo test (src-tauri)` 就报
  `env: 'cargo': No such file or directory`。**Rust 侧一个测试都没跑。**
- **安装包构建没跑**（`bun run build` / `tauri build`）——所以我**不能**说"今天的 main 打出来的
  Windows 包会显示中文界面"。我只能说源码里 `App.tsx` 现在只渲染 `SimpleApp`，
  以及它的前端产物在 Chrome 里渲染出了中文（4.4 的反向对照）。这两件事不等于"真窗口里是中文"。
- 双平台 CI job、`cargo test`、警告当错误……全部**交给 CI**，这次没跑就是没跑。

### 7.3 其他"没做"和原因

- **WSL 里的 Linux 版 `ante` 没用。** 任务明确说"这次先不要用它，那是下一步的事"。
  它是这台机器上最有可能真的把任务跑通的路径（`CANTE_BIN=wsl.exe -e /home/<用户>/cante-bin/ante serve`），
  但那是下一次验收的范围。
- **没有测多显示器 / DPI 缩放 / 最小窗口尺寸**：都需要在真桌面上看。
- **没有测长时间运行、待机恢复、断电**：不在这次范围里。
- **没有改任何产品代码**（`gui/src/**`、`gui/src-tauri/**`、`AGENTS.md` 一个字节没动）。
  按纪律，这次只交：本文件 + `DEVELOPING-WINDOWS.md` 的一小节 + `gui/scripts/windows/**`
  的取证脚本。
- 我第一次跑 `bun test src` 时直接失败（6 个文件 `Cannot find package 'solid-js'`），
  原因是 `node_modules` 没装。跑 `bun install --frozen-lockfile`（21.7 秒，96 个包）之后
  就是全绿。**这是环境没准备好，不是产品问题**，但值得写一句：`AGENTS.md` §5 那张表里
  `bun test src` 那一行没提"先 `bun install`"，新人/新机器上会先撞一次
  （`gui/README.md` 第 48 行有写 `bun install`，`scripts/e2e.sh` 也把它当第 1 步）。

---

## 8. 需要 RDP 人工确认的清单

前提：用 RDP（或物理坐在机器前）登录，**用 Explorer 双击**，不是 SSH。
机器上现在装着 rc1（我最后重新装回来了），安装包在
`C:\Users\<用户名>\AppData\Local\Temp\cante-acc\Cante_0.1.0_x64-setup.exe`。

1. **从浏览器下载安装包**（不要用命令行下载——命令行不带 Mark of the Web），
   **双击**运行，把 SmartScreen / 杀软弹窗的**原文**和截图记下来。这是"未签名提示的第一印象"。
2. **双击桌面 `Cante.lnk`**，看窗口出现的过程：有没有**控制台黑窗一闪**（这是我们的 bug 探测器，
   一次都不能有）。
3. **看窗口本身**：字体、字号（正文 ≥16px、标题 ≥20px、按钮 ≥44px 是硬约束）、中文排版、
   emoji 回退；把截图贴回 issue。（先确认跑的是**哪个版本**——rc1 是英文旧界面，
   这一条对 rc1 大概率是"不通过，因为压根不是简单模式"。）
4. **验"没有守护进程"这件事的用户体验**：确认状态栏/错误视图原文；如果手里有
   从当前 main 打的新包，重点看简单模式下它说的是不是人话（见 5 节末尾那条代码观察）。
5. **走一遍完整任务**（需要先解决守护进程，见第 10 节）：文件放在
   `C:\Users\<名字>\Desktop\测试 文件夹\` 这种带空格和中文的路径下，看对话框、看结果是不是
   落在**原文件旁边**、点「打开所在文件夹」是不是真的打开那个文件夹。
6. **WPS 的 `.et`**：用真 WPS 存一个，看"开始之前"有没有被说清读不了、给的出路在真 WPS 里做不做得到。
7. **微信 PC 常开 + 中文输入法**：输入框能不能正常用中文输入法；产品里**没有任何发送入口**。
8. **卸载后看一眼** `%LOCALAPPDATA%\dev.cante.gui` 是不是还在（我这里是还在），
   判断这算不算"弄坏她的东西"。

---

## 9. 本机前端门禁（顺手做的，为后面派代码任务铺路）

环境：bun `1.4.2`、node `v24.19.0`、Windows 11（同上）。

```
$ bun install --frozen-lockfile
96 packages installed [21.73s]

$ bun test src
 542 pass
 0 fail
 634594 expect() calls
Ran 542 tests across 33 files. [2.94s]        → 退出码 0

$ bunx tsc --noEmit
（无输出）                                      → 退出码 0，2.0 秒
```

完整门禁脚本 `bash gui/scripts/e2e.sh`（原始输出 `evidence/09-e2e.txt`）：

```
==> [1/6] bun install                        ✅
==> [2/6] bun test src                       ✅ 542 pass / 0 fail
==> [3/6] bunx tsc --noEmit                  ✅
==> [4/6] bun run build:web                  ✅ vite 7.3.6，70 modules，885ms
==> [5/6] bun test fixtures                  ✅ 9 pass / 0 fail
==> [6/6] cargo test (src-tauri)             ❌ env: 'cargo': No such file or directory
e2e: FAIL at step 6/6
```

**结论：Windows 上"前端那一半"的门禁全绿且很快（全部加起来十几秒）；断在第 6 步，因为这台机器
没有 Rust。** 这是环境缺口，不是产品问题。

另外跑 `bash gui/scripts/dom-smoke.sh`（开发者用的浏览器冒烟，**不属于 CI 门禁**），
在当前 main 上输出 `dom-smoke: OK — both screens rendered with every required element`
（`evidence/10-dom-smoke.txt`）。但这个脚本在 Windows 上有两个坎，我是**在外面绕过去**的，
没有改仓库里的脚本（不在任务范围内）：

1. 脚本里写的是 `python3`，这台机器上 Python 3.12 的命令名是 `python` → 我在临时目录放了一个
   `python3` 垫片并加进 PATH；
2. 脚本的中文输出在 Windows 控制台上会因为默认编码（cp1252）抛
   `UnicodeEncodeError: 'charmap' codec can't encode …` → 我加了 `PYTHONIOENCODING=utf-8`；
3. `CHROME` 默认指向 macOS 的路径 → 我用 `CHROME="/c/Program Files/Google/Chrome/Application/chrome.exe"` 覆盖。

**这三条建议后面顺手修掉**（`python3` 回退到 `python`、默认编码、Windows 的 Chrome 路径），
否则 Windows 机器上没人能跑这个冒烟。

---

## 10. 下一步需要什么

按"最少改动、最大信息量"排：

1. **给一个从当前 main 打出来的 Windows 包**（CI 的 `GUI Release` workflow 手动跑一次即可，
   或者在那台机器上装 Rust）。因为 rc1 比简单模式落地早一轮，**现在这份安装包测的是旧产品**，
   后面所有"用户体验"类结论都会失真。
2. **决定守护进程在 Windows 上怎么办**。三条路，任务只给了方向、没给结论：
   - 在 WSL 里跑 Linux 版 `ante`，把 `CANTE_BIN` 指过去（`wsl.exe -e /home/<用户>/cante-bin/ante serve`）——
     那台机器的 WSL 里已经有一份 `0.preview.99`，**这是最可能真的跑通的一条**；
   - 给上游做 Windows 原生构建（上游 README 说只有 macOS/Linux）；
   - 产品层面承认"Windows 上先不能干活"，并**用中文把这件事讲清楚 + 给出路**（当前 rc1 是英文原文）。
     这一条和 `copy.ts` 里缺 `program not found` 规则是同一个坑。
3. **`bundle.resources` 在 Windows 上少了 `.exe`**：`cante-sheets` / `cante-pdf` 进不了包，
   于是"读表格/读 PDF"这些卡在 Windows 上会走"这台电脑还没有…工具"那条路。
   要么补 `.exe`，要么明确接受并配好文案。
4. **`dom-smoke.sh` 的 Windows 可移植性**（见第 9 节三条）。
5. **RDP 会话**（第 8 节全部依赖它）。这次验收最硬的天花板就是"没有人能看见那台机器的屏幕"。

---

## 附：这次动过的文件

| 文件 | 动作 |
| --- | --- |
| `gui/WINDOWS-ACCEPTANCE-1.md` | 新增（本文件） |
| `gui/DEVELOPING-WINDOWS.md` | 只追加一节"第一次真机验收记录（2026-09，Windows 11）" |
| `gui/scripts/windows/collect-environment.ps1` | 新增：环境事实 |
| `gui/scripts/windows/inspect-installer.ps1` | 新增：拆包看载荷、SHA256、签名、MOTW |
| `gui/scripts/windows/probe-installed-app.ps1` | 新增：启动后看进程/子进程/文件/事件日志 |
| `gui/scripts/windows/capture-window.ps1` | 新增：`PrintWindow` 截图 + 像素统计 + 字符降采样 |
| `gui/scripts/windows/dump-window-text.ps1` | 新增：用 UI Automation 把窗口里的文案读出来 |

产品代码（`gui/src/**`、`gui/src-tauri/**`）和 `AGENTS.md` **一个字节都没动**。

> 写脚本时踩到的坑，留给后人：**`gui/scripts/windows/*.ps1` 必须存成 UTF-8 with BOM**。
> 这台机器上只有 Windows PowerShell 5.1，它读没有 BOM 的 `.ps1` 会按 GBK 解析，
> 脚本里的中文会变成乱码并直接报语法错（我第一次跑就是这么挂的）。每个脚本头部都写了这句。
