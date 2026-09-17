# 第四次 Windows 真机验收：已发布的 v0.2.0 + 每周自动普查

这一轮有两件，互不依赖：

1. **验收已发布的 v0.2.0 安装包**（前面几轮验的是 rc1 与"本机编译出来的包"，不是正式产物）；
2. **把每周一次的真机普查做成 Windows 计划任务**，并验证它真的会自己跑、真的产出报告。

- 验收机器：Windows 11 Home 25H2 / build 26200.9457 / x64（真机，非虚拟机）
- 起始提交：`main` = `aac9aaa`；工作分支：`ws/win11-release-accept`
- 验收人：跑在那台机器上的 pi（**SSH 会话，没有交互桌面**，限制见最后一节）
- 原始输出：`%TEMP%\cante-acc4\evidence\`（文件名与各节一一对应）

---

## 0. 结论先行

### 第一件：v0.2.0 装得上、第一屏就是中文简单模式

- Release `gui-v0.2.0`（2026-09-17T02:39Z）的两个 Windows 产物都下载下来了：
  `Cante_0.2.0_x64-setup.exe`（3,462,393 字节）与 `Cante_0.2.0_x64_en-US.msi`（5,541,888 字节），
  SHA256 见第 2 节。**静默安装退出码 0**。
- **第一屏就是中文简单模式**：向导三步（`1欢迎` / `2检查电脑` / `3开始使用`）+
  `欢迎使用 Cante` + `我帮你把表格、文件这些麻烦事做完。原文件我不会乱动，动手前会先让你确认。`
  （原文见第 4 节）。第一次验收里那个"英文开发者界面"已经不存在了。
- 两个自带工具都在，而且真的能跑：`cante-sheets.exe --version` → `cante-sheets 0.2.0`（退出码 0），
  `cante-pdf.exe --version` → `cante-pdf 0.2.0`（退出码 0）。

### 第二件：v0.2.0 的安装目录里有 **4 个垃圾文件——这是预期，不是回归**

```
         0  \target\release\cante-pdf          ← 0 字节占位符
         0  \target\release\cante-sheets       ← 0 字节占位符
      1806  \target\release\cante-pdf.d        ← cargo 依赖清单
      1812  \target\release\cante-sheets.d     ← cargo 依赖清单
```

**为什么是预期的**：v0.2.0 是在 **02:39Z 打的 tag**，而清理那件事（#117，把 `bundle.resources`
的 glob 换掉）是 **05:42Z 才合进 main** 的。也就是说 **v0.2.0 比清理早三个小时**，它里面必然带着
第二轮验收发现的那批垃圾（那一轮在同一台机器上已经查清来源：`build.rs` 的 0 字节占位符 +
cargo 的 `.d`，被 glob 一起扫进去了）。

**下一次发版（0.2.1 及以后）不应该再看到它们。** 判断办法很简单：看 `target\release\` 这个子目录
还在不在——#117 之后，工具直接装在**安装根目录**，根本不会出现 `target\` 目录。
第三轮验收（本机编译的包）实测就是 5 个文件、0 垃圾。

### 第三件：每周普查已经做成计划任务，而且**真的自己跑起来了**

- 任务名 `CanteWeeklySweep`，每周日 03:30，动作是 `gui\scripts\windows\weekly-sweep.ps1`，
  报告落 `C:\cante-sweep\report-YYYYMMDD.md`，保留最近 8 份（第 5 节）。
- **自动触发验证过**：用一个一次性探针任务（同一套 Principal/Settings）在 15:27:43 到期，
  **没有做任何手工触发**，它自己跑了、`Last Result = 0`、文件写出来了（第 5.3 节）。
- 普查跑在 **WSL 里**（守护进程只有 Linux 构建），用 Windows 版的两个工具读回产出（路径用垫片翻）。
  一张卡的实测：`excel.diff` → **通过**，`cante-sheets 读回 31 行`（第 5.2 节）。

---

## 1. 这一轮与前面几轮的差别（免得混淆三份报告）

| | 第一次 | 第二/三次 | **这一次** |
| --- | --- | --- | --- |
| 受测产物 | rc1（`gui-v0.1.0-rc1`） | 本机编译（#112 修复 / #117 清理） | **已发布的 `gui-v0.2.0`** |
| 界面 | 英文开发者界面 | 中文简单模式 | **中文简单模式** |
| 工具进包 | **没有** | 有（`target\release\` 两份；#117 后一份） | **有**（两份 + 4 个垃圾文件） |
| 安装目录 | 2 个文件 | 10 个 → 5 个 | **10 个（含 4 个垃圾，见第 0 节）** |

一句话：**这一轮验的是"用户真的能下到的那个包"，而它比 main 落后一次清理。**

---

## 2. 下载与包内容

```bash
gh release download gui-v0.2.0 -R muyouming/cante \
  -p 'Cante_0.2.0_x64-setup.exe' -p 'Cante_0.2.0_x64_en-US.msi'
```

```
1c18ccd8099743aa6b8364f90bf0c855e1f71c6a722a89fc730f32c876c88265  Cante_0.2.0_x64-setup.exe  (3,462,393)
8346807cefe119cf3955bf61fb9f9f0be1292837695990035e991f43edf90e79  Cante_0.2.0_x64_en-US.msi   (5,541,888)
```

两个都**未签名**（`Get-AuthenticodeSignature` → `NotSigned`），而且都**没有 Mark of the Web**
（`gh release download` 下的，没有 `Zone.Identifier` 流）——所以走这条下载路径**碰不到 SmartScreen**。

**NSIS 包内清单**（`7z l`，完整）：

```
$PLUGINSDIR\System.dll            12288
$PLUGINSDIR\modern-wizard.bmp     26494
$PLUGINSDIR\nsDialogs.dll          9728
$PLUGINSDIR\nsis_tauri_utils.dll  34304
$PLUGINSDIR\StartMenu.dll         13316
$PLUGINSDIR\NSISdl.dll            15360
cante-gui.exe                  10328064
target\release\cante-pdf              0   ← 垃圾
target\release\cante-sheets           0   ← 垃圾
target\release\cante-pdf.d         1806   ← 垃圾
cante-pdf.exe                   2177024
target\release\cante-pdf.exe    2177024   ← 重复副本
target\release\cante-sheets.d      1812   ← 垃圾
cante-sheets.exe                2513408
target\release\cante-sheets.exe 2513408   ← 重复副本
uninstall.exe
```

**MSI**（`msiexec /a` 管理安装解出真实文件名）内容**完全对应**：

```
/PFiles/Cante/cante-gui.exe                   10328064
/PFiles/Cante/cante-pdf.exe                    2177024
/PFiles/Cante/cante-sheets.exe                 2513408
/PFiles/Cante/target/release/cante-pdf               0
/PFiles/Cante/target/release/cante-pdf.d          1806
/PFiles/Cante/target/release/cante-pdf.exe     2177024
/PFiles/Cante/target/release/cante-sheets            0
/PFiles/Cante/target/release/cante-sheets.d       1812
/PFiles/Cante/target/release/cante-sheets.exe  2513408
```

两个产物的差别只有容器格式（NSIS 3 Unicode / MSI+WiX），**载荷一模一样**，
连 4 个垃圾文件都一样——因为它们是同一份配置打出来的。

---

## 3. 装完的目录清单（原样、完整）

装之前先把上一轮本机编译的 0.2.0 静默卸掉，并删掉 WebView2 档案（`%LOCALAPPDATA%\dev.cante.gui`），
**模拟"这台电脑第一次装"**，这样第一屏才会是向导第 1 步。

```
uninstall（上一轮那个）ExitCode = 0
删除 dev.cante.gui = 已删除
install（v0.2.0 静默）ExitCode = 0
```

`C:\Users\<用户名>\AppData\Local\Cante`（`Get-ChildItem -Recurse -Force`，原样全列）：

```
DIR        \target
  10328064  \cante-gui.exe
   2177024  \cante-pdf.exe
   2513408  \cante-sheets.exe
     79156  \uninstall.exe
DIR        \target\release
         0  \target\release\cante-pdf
      1806  \target\release\cante-pdf.d
   2177024  \target\release\cante-pdf.exe
         0  \target\release\cante-sheets
      1812  \target\release\cante-sheets.d
   2513408  \target\release\cante-sheets.exe
--- 10 个文件 / 19,791,702 字节
--- 0 字节文件：2
--- .d 文件：2
```

（`evidence/02-install-dir.txt`。**4 个垃圾文件全在 `target\release\` 里，是预期现象**，见第 0 节。）

**两个工具真的能跑**（从安装目录直接执行，两处副本都试了）：

```
$ .\cante-sheets.exe --version                 →  cante-sheets 0.2.0
$ .\cante-pdf.exe --version                    →  cante-pdf 0.2.0
$ .\target\release\cante-sheets.exe --version  →  cante-sheets 0.2.0
$ .\target\release\cante-pdf.exe --version     →  cante-pdf 0.2.0
```

那 2 个 0 字节文件当然跑不了（`ls -la` 看得很清楚是 0 字节）——它们**不是**可执行的工具，
只是一份空壳；解析器不会被它们骗到（找的是带 `.exe` 的名字）。

---

## 4. 窗口里读到的文字（原样）

用 UI Automation 读（`gui/scripts/windows/dump-window-text.ps1`，
`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--force-renderer-accessibility` 把 WebView2 的无障碍树打开）。

**第一屏（向导第 1 步，全新档案）**：

```
Button | 历史
Button | 隐私
List | 进度
  ListItem | 1欢迎
  ListItem | 2检查电脑
  ListItem | 3开始使用
Text | 欢迎使用 Cante
Text | 我帮你把表格、文件这些麻烦事做完。原文件我不会乱动，动手前会先让你确认。先花十秒钟检查一下你的电脑，好吗？
Button | 开始检查
```

**点「开始检查」之后（第 2 步）**——"没有守护进程"在正式产物里长什么样（后面第 5 节会把守护进程补上，
但**默认安装、什么都不配**的用户看到的就是这一屏）：

```
Text | 检查你的电脑
Text | 这台电脑还缺一个必须的组件
Text | 这台电脑上还没有装好 Cante 需要的那个组件。
Text | 这不是网络问题，也不是你操作错了，是这台电脑少了一个真正干活的组件。装好它，任务才能跑起来。
Text | 请让帮你配置这台电脑的技术同事装一次 Cante 的组件，装好后点「重新检查」。
Button | 复制详情（给技术同事看）
Button | 重新检查
Button | 先看看界面
```

**点「先看看界面」→「开始使用」之后（首页）**：

```
Text | 你好，需要我帮你做什么？
Text | 点一张卡片，或者直接在下面说一句话。
Text | 我做的结果
Text | 上次做出来的表放在哪儿，这里都记着，随时能打开。
Button | 打开我做的结果
Text | 还有别的事？
Text | 按你想做的事搜一搜，每一项都写清楚要准备什么、会动到什么。
Button | 看看能做什么（共 32 项）
Text | 表格 / 合并、拆分、汇总、去重
Button | 把几张表合成一张（自动去掉重复行）。把这三个月的销售表合成一张，重复的记录只留一条
…（表格 15 张 / 文件 7 张 / 微信 5 张 / 文书 4 张 / 资料 1 张，共 32 张）
Text | 直接说一句话
Edit | 直接说一句话
Button | 开始处理
```

（完整树在 `evidence/03-window-text-first-run.txt` 与 `evidence/04-window-text-home.txt`。
"点"是 UI Automation 的 `InvokePattern.Invoke()`，不是真鼠标，见第 6 节。）

**读这屏的方式**：app 起来后由脚本读窗口，`MainWindowTitle = 'Cante'`，58 个 UIA 元素。
中文没有乱码，字号/排版**没有验证**（读不出像素观感）。

---

## 5. 每周一次的真机普查（计划任务）

### 5.1 为什么不能直接跑 `task-sweep.ps1`（两件实测出来的事）

1. **这台机器上没有 Windows 原生守护进程**。普查要驱动真守护进程跑每张卡（`gui/scripts/sweep/README.md`），
   而上游 `cante`/`ante` 只有 Linux/macOS 构建。本机唯一能用的守护进程在 WSL 里
   （`~/cante-bin/ante`，`ante 0.preview.99`，由 `gui/scripts/windows/wsl-ante-setup.ps1` 装）。
   实测把 `CANTE_BIN` 指向它、其余都在 Windows 侧跑 → 握手就停住了：
   `错误事件：session not initialized`（普查给的是 Windows 路径，Linux 侧的守护进程认不得；
   这正是 `DEVELOPING-WINDOWS.md` 里"路径映射"那条限制预言过的）。
2. Windows 原生那条路上，`cante-bridge`（#116）也顶不了：它的 `PI_BIN` 只接受**一个程序名**
   （`bridge.rs` 里 `Command::new(&program)`，不带参数），而 pi 在这台机器上是
   `pi.cmd` / `pi` 两个 npm 壳子、没有 `pi.exe` —— 实测报
   `没能把助手启动起来（pi）：program not found`。
   （跟之前"npm 的 bun 没有 `.exe`"是同一类问题。）

**所以本轮的方案是：整个普查跑在 WSL 里**（Linux 侧有原生 python3 3.14.4 与 bun 1.4.2，
装法见 5.4），`CANTE_BIN=$HOME/cante-bin/ante`；只有"读回产出"那两个核验工具是 Windows 的 `.exe`。

### 5.2 两个垫片：让 Windows 的核验工具在 WSL 里能用

普查读回产出时会调 `cante-sheets` / `cante-pdf`。在 WSL 里直接找，会先撞上 Windows 构建留下的
**0 字节占位符**（`target/release/cante-sheets`），执行时报 `Exec format error`；
找不到的话它会退回内置读取方式——报告里就不再是"产品自己的工具读回来的"。

做法：`weekly-sweep.ps1` **每次运行时现场生成两个十行的垫片**（LF 行尾、无 BOM）到
`C:\cante-sweep\bin\`，内容是把参数里的 Linux 路径 `wslpath -w` 翻成 Windows 路径，
再 `exec` 对应的 `.exe`；然后通过 `CANTE_SHEETS_BIN` / `CANTE_PDF_BIN` 交给普查。

实测（`evidence/16-sweep-wsl-shim2.log`）：

```
==> excel.diff
    通过：产出 结果_对比.xlsx；cante-sheets 读回 31 行；表：对照
守护进程：/home/<用户>/cante-bin/ante serve
```

对照——不加垫片时同一条命令的结果（`evidence/15-sweep-wsl-shim.log`）：

```
    通过：产出 结果_对比.xlsx；内置兜底读取到 23 行
```

两种都算通过，但**只有加了垫片那次是"产品自己的工具读回来的"**。差别写在这里，免得以后有人
看到"内置兜底"四个字以为没问题。

### 5.3 计划任务：定义、自动触发、报告位置

用 `Register-ScheduledTask` 建的（`schtasks /create` 也能建，但做不到下面这套设置）：

```
任务名    CanteWeeklySweep
动作      powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\cante\gui\scripts\windows\weekly-sweep.ps1"
触发      每周日 03:30（-Weekly -DaysOfWeek Sunday -At 03:30）+ StartWhenAvailable（错过就补跑）
身份      当前用户，登录类型 Interactive，RunLevel Limited
设置      MultipleInstances=IgnoreNew，ExecutionTimeLimit=6 小时
报告      C:\cante-sweep\report-YYYYMMDD.md（保留最近 8 份）
日志      C:\cante-sweep\logs\sweep-YYYYMMDD.log（保留 8 份）+ history.log（一行一次）
```

**为什么是 Interactive 而不是"不管用户是否登录都运行"**：实测 `-LogonType S4U` 直接
`Access is denied`（HRESULT `0x80070005`）——这个用户没有"作为批处理作业登录"的权限，而我们
**没有提权**（`IsInRole(Administrator) = False`）。改用 SYSTEM 也不行：WSL 发行版是按用户注册的，
SYSTEM 看不到它。Interactive 实测在**只有 SSH、没有交互桌面**的时候一样能被触发（下面那条）。

**自动触发验证（没有做任何手工触发）**：另外建了一个一次性探针任务
`CanteSweepTriggerProbe`（同一套 Principal/Settings，动作只是把时间写进文件），定在 4 分钟后到期：

```
探针任务已建，触发时间 2026-09-17T15:27:43（现在不做任何手工触发）
…
-rw-r--r-- 1 <用户名> <组> 50 Sep 17 15:27 /c/cante-sweep/probe-fired.txt
Status: Ready    Last Run Time: 9/17/2026 3:27:43 PM    Last Result: 0
```

**到点自己跑了、退出码 0、文件写出来了**，然后我把探针任务删掉（`schtasks /delete /f`）。

**真实任务的触发**：`schtasks /run /tn CanteWeeklySweep` → `SUCCESS: Attempted to run`，
状态变 `Running`（`Last Run Time 9/17/2026 3:23:13 PM`）。

**跑完的结果**：（这一节在报告提交时还写着"进行中"——它是全量 30 多张卡，
一次要几十分钟。跑完之后我会把结论行原样贴进来，并把 `history.log` 的对应行抄在这里。
**在贴进去之前，这一条算"没验完"，不算通过。**）

```
（待补：report-20260917.md 的一行结论 + history.log 的那一行）
```

**怎么确认它真的跑了**（别只看任务存在）：① `schtasks /query /tn CanteWeeklySweep /v /fo LIST`
看 `Last Run Time` / `Last Result`；② 报告文件**不是空的**（报告是跑完才写的，跑到一半只有一份
空壳 —— 本次实测：任务在 15:23 启动后，`report-20260917.md` 一直是 5 字节，
所以要等 `history.log` 里出现那一行才算完）；③ `history.log` 每次一行。

### 5.4 为了让它在 WSL 里跑，机器上多了什么

| 加的东西 | 为什么 | 在哪 |
| --- | --- | --- |
| WSL 里的**原生 bun** `$HOME/.bun/bin/bun`（1.4.2） | `/mnt/c` 上那份是 Windows 的（POSIX 壳子指向 .exe），在 WSL 里配 Linux 路径会出问题 | WSL `/home/<用户>/.bun/bin/bun` |
| 两个垫片 | 见 5.2（运行时生成，机器上不手改） | `C:\cante-sweep\bin\`（每次运行由脚本重写） |
| 计划任务 | 见 5.3 | `CanteWeeklySweep` |
| 报告目录 | 见 5.3 | `C:\cante-sweep\` |

**WSL 里没有 `unzip`**，官方那条 `curl bun.sh/install | bash` 会报 `unzip is required`；
我用 `curl` 下 `bun-linux-x64.zip` + `python3 -c "import zipfile; …"` 解包到 `$HOME/.bun/bin/bun`
（`/mnt/c` 那份 Windows 的 unzip 用不了）。这条写在这里，免得下次又卡。

**密钥**：`weekly-sweep.ps1` 运行时从 `%USERPROFILE%\.pi\agent\models.json` 读服务方
（默认 `9router`）的 `baseUrl` / `apiKey`，只放进程环境变量、用 `WSLENV` 渡过 WSL 边界，
**不落盘、不进命令行、不进仓库、不进报告**。换服务方用 `-Provider <名字>`。

---

## 6. SmartScreen / Defender / 卸载

| 项 | 实测 |
| --- | --- |
| 数字签名 | 两个产物都 `NotSigned` |
| Mark of the Web | **没有**（`gh` 下的，没有 `Zone.Identifier`）→ 这条路**碰不到 SmartScreen** |
| 静默安装退出码 | **0**（`/S`，不需要提权） |
| Defender | 实时保护 / 行为监控 / 杀毒引擎全开；`Get-MpThreatDetection` **0 条** |
| 事件日志 | 安装与启动之后 `Application`、`Windows Defender/Operational`、`AppLocker/EXE and DLL`、`SmartScreen/Debug` **都没有新事件**（`SmartScreen/Operational` 这个通道在 Home 版上不存在） |
| 卸载 | `uninstall.exe /S` 退出码 0；安装目录、桌面/开始菜单快捷方式、注册表卸载项**全清** |
| 卸载残留 | **`%LOCALAPPDATA%\dev.cante.gui` 留在盘上：9,057,260 字节**（WebView2 档案） |

（`evidence/05-uninstall.txt`、`evidence/06-defender-events.txt`。）

卸载那一条与第一次验收一致：**卸载不清 WebView2 档案**。这是个产品决定（缓存/会话状态留着），
不是这次的 bug，但三份报告里都出现了，值得单独开一张单子。

（本轮验完我把 v0.2.0 **重新装了回去**，方便后面有人 RDP 上来直接看。）

---

## 7. 我没能验证什么

**这一节和上面的结论一样重要。** 下面每一条都是"没验证"，不是"通过"。

1. **真实双击安装的第一印象（SmartScreen / 杀软）**：这次的产物是 `gh` 下的，没有 Mark of the Web，
   SmartScreen **物理上不会**被触发；而静默安装（`/S`）绕过的正是"资源管理器双击"那个动作。
   所以是**没有触发**，不是"确认没有拦"。
2. **窗口观感**：我只有 UI Automation 的文本（第 4 节）。字体、字号、中文排版、emoji 回退、
   有没有控制台黑窗一闪、点击手感——**一条都没有验证**（SSH 会话没有交互桌面，我也读不了像素）。
   第 4 节那些"点击"是 UI Automation 的 `Invoke()`，**不是真鼠标**。
3. **"工具在界面上报可用"那句话**：还是没看到。向导第 2 屏说的是**守护进程**（跟这两个工具无关），
   而工具的能力提示在任务卡后面的"确认"页，要点到那一步得先真的选一个文件。
   我验证的仍然是**前置条件**：文件就在安装目录且能跑出 `0.2.0`。
4. **v0.2.0 是不是"最后一次带垃圾的版本"**：第三轮验的是本机编译的包（#117 之后，5 个文件、0 垃圾），
   但**还没有从 main 打出来的正式产物**。要确认只能等下一次发版。**不要把"第三轮干净"当成
   "下一个 release 一定干净"**——那要等 CI 真的打出那个包。
5. **计划任务的全量跑**：见 5.3 末尾（报告是跑完才写的，提交这份报告时它还在跑；
   贴进去之前那条算"没验完"）。
6. **计划任务在"长期没人登录"时的行为**：只验了"到点自己跑"（探针任务）与"手工触发"。
   `StartWhenAvailable` 在机器一直没人登录时到底怎么表现，**没有验证**（要等真的过一周）。
7. **Mac / Linux**：这台机器出不了 dmg，也没有 macOS 环境；本轮验的全是 Windows 侧。
8. **"超时"与"确认没有"分开写**：本轮所有长命令都设了超时
   （`gh release download` 600s、安装 600s、两次 `tauri build` 未跑、`cargo test` 2400s、
   普查 1500s/1800s），**一次都没有超时**；第 3 节里"0 字节文件：2、`.d` 文件：2"是
   递归列目录**统计出来**的（**确认有**），第 2 节"没有 `Zone.Identifier`"也是**查过才写的**。

---

## 附：这一轮动过的东西

| 文件 | 动作 |
| --- | --- |
| `gui/WINDOWS-ACCEPTANCE-4.md` | 新增（本文件） |
| `gui/DEVELOPING-WINDOWS.md` | 追加一节"每周一次的真机普查（Windows 计划任务，2026-09）" |
| `gui/scripts/windows/weekly-sweep.ps1` | 新增：计划任务跑的入口（读密钥、生成垫片、在 WSL 里跑普查、保留最近 8 份） |

**没有改任何产品代码**（`gui/src/**`、`gui/src-tauri/**`、`AGENTS.md` 一个字节没动）。
`tauri.conf.json` 与 `packaging.test.ts` 保持 main 上的样子。

机器上新增的东西（都在仓库外）：计划任务 `CanteWeeklySweep`、目录 `C:\cante-sweep\`、
WSL 里的 `$HOME/.bun/bin/bun`。

原始输出（在那台机器的 `%TEMP%\cante-acc4\evidence\`）：

```
01-nsis-listing.txt              v0.2.0 NSIS 包内清单
02-install-dir.txt               装完的安装目录（含 4 个垃圾文件的统计）
03-window-text-first-run.txt     第一屏（向导第 1 步）+ 第 2 步
04-window-text-home.txt          一路点到首页（32 张卡）
05-uninstall.txt                 卸载前 / 卸载后残留
06-defender-events.txt           Defender 状态、威胁记录、事件日志
09-msi-listing.txt / 10-msi-admin.log   MSI 的两种看法
11~16-sweep-*.log                普查的四种跑法（bridge / WSL 直连 / 无垫片 / 有垫片）
20-runner-manual.txt             手工跑一次 weekly-sweep.ps1（只跑一张卡）
```
