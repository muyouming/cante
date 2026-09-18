# 在这台 Windows 验收机上干活（上手清单）

给**下一个接手这台机器的人**。这台机器是配好的，但它不是一台普通的 Windows —— 它是一个
**QEMU/KVM 虚拟机**，而且我是从 SSH 连进来干活的，所以下面这八条坑我一条一条踩过。
每条都写成 **症状 → 真因 → 修法**，能自己复核的我都当场复核过（复核记录在
最后「我怎么复核的」一节）。

**先读 `AGENTS.md`。** 这份文档只写"这台机器特有的事实"，产品律、代码结构、交付规矩
一律以 `AGENTS.md` 和 `gui/ROADMAP.md`、`gui/CONTRACT.md` 为准。

> 与 `gui/DEVELOPING-WINDOWS.md` 的关系：那一份是**为什么要有 Windows 验收、有哪几条路**
> （策略）。这一份是**这台机器上照做就行的操作清单**（操作）。两份不冲突，冲突时以
> `AGENTS.md` / ROADMAP 为准。

---

## 1. 机器现状

| 项 | 值 | 怎么确认的 |
| --- | --- | --- |
| 系统 | Windows 11 **家庭版**（Home）25H2 | `(Get-CimInstance Win32_OperatingSystem).Caption` |
| 版本 / 内部版本 | `10.0.26200` / **26200.9457** | `.Version` / `.BuildNumber` |
| 语言 | zh-CN（中文） | 控制台默认输出中文 |
| 架构 | x64（`AMD64`） | `$env:PROCESSOR_ARCHITECTURE` |
| CPU | **6** 个逻辑处理器 | `(Get-CimInstance Win32_ComputerSystem).NumberOfLogicalProcessors` |
| 内存 | **11.93 GB**（≈12G） | `TotalPhysicalMemory / 1GB` |
| 系统盘 | C: 共 **88.8 GB**，可用约 42 GB | `Get-CimInstance Win32_LogicalDisk` |
| 主机名 | `<机器名>` | `(Get-CimInstance Win32_ComputerSystem).Name` |
| 虚拟化 | **QEMU/KVM**（`QEMU Standard PC (Q35 + ICH9, 2009)`） | `Get-PnpDevice -Class Computer` |
| 网络 | 以太网，**静态 IP** `<IP>` / 网关 `<IP 网关>` | `Get-NetIPConfiguration` |
| 交互会话 | 有（`explorer.exe` + `dwm.exe` 在会话 1，无人值守自动登录） | `Get-Process explorer,dwm` |
| 登录用户 | `<用户名>`（普通用户，**不是**管理员） | `WindowsIdentity ... IsInRole(Administrator)` = False |
| PowerShell | **只有 5.1**（`5.1.26100.9444`，Desktop 版；**没有** `pwsh` 7） | `$PSVersionTable.PSVersion` |
| GPU | `Microsoft 基本显示适配器`（**没有真驱动**，见坑 7） | `Get-CimInstance Win32_VideoController` |

三个要点先记住：

1. **只有 PowerShell 5.1**，没有 7。所有 `.ps1` 都按 5.1 的规矩写（见坑 1）。
2. **是虚拟机、不是真机**。所以性能数字、GPU 相关结论**不能**当画像机（16GB 无独显）的体感。
3. **无人值守**：机器靠自动登录进桌面，任务靠计划任务跑（见坑 8）。

---

## 2. 装了什么、版本多少

全部在这台机器上当场跑出来的（`--version` 或注册表）：

| 工具 | 版本 | 在哪 | 备注 |
| --- | --- | --- | --- |
| git | `2.55.0.windows.3` | PATH | winget 里登记为 `Git.Git 2.55.0.3` |
| bun | `1.4.2` | `%LOCALAPPDATA%\Microsoft\WinGet\Links\bun.exe` | 指向 `Oven-sh.Bun` 包 |
| rustc | `1.98.1 (48a229cea 2026-09-01)` | `%USERPROFILE%\.cargo\bin` | 默认工具链 `stable-x86_64-pc-windows-msvc` |
| cargo | `1.98.1 (797e8a9bc 2026-08-05)` | `%USERPROFILE%\.cargo\bin` | |
| MSVC | VS **生成工具** 2022 `17.14.37710.0` | `C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools` | 含 `VC.Tools.x86.x64` |
| Windows SDK | `10.0.26100.0` | `C:\Program Files (x86)\Windows Kits\10` | cargo 链接要它 |
| gh | `2.101.0` | PATH | 令牌作用域见第 5 节（**没有 `workflow`**） |
| node | `v24.19.0` | PATH | LTS |
| npm | `11.17.0` | PATH | |
| pi | `0.85.1` | `%APPDATA%\npm\pi.cmd` | **只有 `.cmd`/`.ps1`，没有 `.exe`**（`PI_BIN` 要指真 `.exe`，见第 7 节） |
| tauri-driver | `2.0.6` | `%USERPROFILE%\.cargo\bin\tauri-driver.exe` | WebDriver 服务端 |
| msedgedriver | `153.0.4234.46` | `C:\cante\gui\e2e-windows\msedgedriver\msedgedriver.exe` | **必须与 WebView2 版本一致** |
| WebView2 运行时 | `153.0.4234.46` | — | 应用真正渲染的地方 |
| Edge | `153.0.4234.46` | — | 和 WebView2 同版本（巧合，别依赖） |
| winget | `v1.29.290` | PATH | **装不了显卡驱动**（坑 7） |
| QEMU Guest Agent | 服务 `QEMU-GA`，Running / Auto | `C:\Program Files\Qemu-ga\qemu-ga.exe` | 见坑 4 |

复核版本（整段可复制，在 PowerShell 里跑）：

```powershell
git --version; bun --version; rustc --version; cargo --version
gh --version | Select-Object -First 1; node --version; npm --version
pi --version
& "$env:USERPROFILE\.cargo\bin\tauri-driver.exe"   # 注意：它不认 --version，直接跑会打印 USAGE
& "C:\cante\gui\e2e-windows\msedgedriver\msedgedriver.exe" --version
```

`tauri-driver` 那行不是笔误：**它没有 `--version`**，传了会报
`unused arguments left: ["--version"]` 再打 USAGE。查它版本用 `cargo install --list`：

```powershell
cargo install --list | Select-String -Context 0,1 tauri-driver
```

---

## 3. 八条坑（症状 → 真因 → 修法）

### 坑 1：`.ps1` 缺 UTF-8 BOM → PowerShell 5.1 按 GBK 读 → 解析失败

- **症状**：脚本里带中文时，跑起来报**乱码语法错**，例如
  `表达式或语句中包含意外的标记"}"`、`字符串缺少终止符: "`；更阴的是**它照样退出**
  （有时退出码 0），或者把注释**和下一行粘成一行**，于是某个变量悄悄变成空值。
- **真因**：Windows PowerShell 5.1 读**没有 BOM** 的 `.ps1` 时，按**当前 ANSI 代码页**
  （这台机器是 **GBK/936**）解码，而不是 UTF-8。UTF-8 的中文字节被当成 GBK 双字节，
  行尾的换行可能被"吃掉"，于是**下一行被并进注释**——这不是显示问题，是**真的没执行**。
- **修法**：所有含中文的 `.ps1` 存成 **UTF-8 with BOM**（文件头 `EF BB BF`）。仓库里
  `gui/scripts/windows/*.ps1` 已经全部是带 BOM 的；`git` 检出时**不会**替你加 BOM，
  `.gitattributes` 的 `eol=lf` 也不管 BOM，所以要靠"写文件的时候自己带上"。

最小复核（复制即可，两行只差一个 BOM）：

```powershell
$d = "$env:TEMP\bom-demo"; New-Item -ItemType Directory -Force $d | Out-Null
# 无 BOM
[IO.File]::WriteAllText("$d\nobom.ps1", "# 中文`n`$x = `"OK`"`nWrite-Output `"x=`$x`"`n", (New-Object Text.UTF8Encoding($false)))
# 有 BOM
[IO.File]::WriteAllText("$d\bom.ps1",   "# 中文`n`$x = `"OK`"`nWrite-Output `"x=`$x`"`n", (New-Object Text.UTF8Encoding($true)))
(& "$d\nobom.ps1"); (& "$d\bom.ps1")     # 无 BOM 打印 x=（空），有 BOM 打印 x=OK
```

查一个脚本有没有 BOM（Git Bash 里）：

```bash
head -c 3 gui/scripts/windows/weekly-sweep.ps1 | xxd      # 期望 efbbbf
git ls-files '*.ps1' | while read f; do
  [ "$(head -c3 "$f" | xxd -p)" = "efbbbf" ] || echo "缺 BOM: $f"; done
```

> **⚠️ 任务书里说"仓库已有闸门 `gui/src/script-encoding.test.ts`"——我没有找到它。**
> 我在 `main`、`pool/win-docs`、`pool/win-ci`、`pool/win-usage`、以及所有远端分支里
> 都搜过（`git ls-tree -r --name-only <ref> | grep script-encoding` → 0 条），
> 工作区里也没有这个文件。**也就是说：BOM 目前没有任何测试在挡**，而
> `gui/scripts/check-windows.ps1` 正是**没有 BOM** 的那一个（见坑 9）。
> 修法建议：把 BOM 检查做成一个扫 `git ls-files '*.ps1'` 的小测试（`gui/src/` 下，
> 纯 Node 读前 3 字节即可），或者先在 CI 里加一步。**这一条我没有改任何代码**——
> 任务只让写这一个 md，改动留给你们定。

### 坑 2：SSH 会话是 Session 0，没有交互桌面 → GUI 建不出窗口

- **症状**：从 SSH 里启动应用/截图/读窗口文字，进程**活着但窗口句柄是 0**、
  `MainWindowHandle` 空、UIA 找不到窗口、截图是黑的或空的。而 `WEBVIEW2` 子进程**可能照样在跑**，
  于是看起来"起了"其实**没画面**。
- **真因**：Windows 的 `sshd` 跑在 **Session 0**（服务会话），**Session 0 没有交互桌面**
  （`WinSta0` 的 default desktop 不归它）。GUI 应用在 Session 0 里创建窗口会失败/看不见。
  登录用户的桌面在**会话 1**。
- **修法**：**UI 类验收必须在交互桌面里跑**。这台机器的做法是**注册一个交互型计划任务**
  来启动脚本，而不是从 SSH 直接起：

  ```powershell
  $a  = New-ScheduledTaskAction -Execute 'powershell.exe' `
        -Argument '-NoProfile -ExecutionPolicy Bypass -File C:\path\to\your.ps1'
  $pr = New-ScheduledTaskPrincipal -UserId "$env:COMPUTERNAME\$env:USERNAME" `
        -LogonType Interactive -RunLevel Limited      # 注意 RunLevel：见坑 3
  Register-ScheduledTask -TaskName my-probe -Action $a -Principal $pr -Force
  Start-ScheduledTask -TaskName my-probe
  ```

  怎么确认自己**现在**在哪个会话：

  ```powershell
  'PID 会话 = ' + (Get-Process -Id $PID).SessionId
  '窗口站 = ' + [Environment]::UserInteractive        # Session 0 里通常仍是 True，别只信它
  Get-Process explorer,dwm -ErrorAction SilentlyContinue | Select-Object Id,SessionId,ProcessName
  ```

  **这台机器上的一个好消息（也是坑 2 的例外）**：跑在这个 pi 里的命令，**已经在会话 1**
  （有 `explorer.exe` + `dwm.exe`），所以我**能**建出真窗口。原因是这台机器特意做了桥：
  **计划任务 `RemotePiSupervisor`**（`LogonType Interactive` + `RunLevel Limited`）拉起
  `%USERPROFILE%\.pi\remote\RemotePiSupervisorLauncher.vbs`，那个 VBS 再用
  `WshShell.Run(cmd, 0, True)`（窗口样式 0 = 隐藏）把 node 主管进程**放进登录会话**。
  **所以：不要以为"在 pi 里跑"就等于"在会话 1 里跑"——这条桥是别人专门搭的，
  换台机器就没有。** 另外，**RDP 里也是会话 1**，要看窗口、要看字体，RDP 才是最省事的路。

### 坑 3：提权（`RunLevel Highest`）跑验收必失败

- **症状**：WebDriver 会话**等 60 秒后**报
  `session not created: DevToolsActivePort file doesn't exist`。应用本身可能开着，但驱动连不上。
- **真因**：**WebView2 运行时 150+ 在提权进程里会忽略 `WEBVIEW2_*` 环境变量**
  （上游 `MicrosoftEdge/WebView2Feedback#5645`）。而 `msedgedriver` 正是通过
  `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` 之类的变量把**远程调试端口**传进去的——
  变量被忽略 → 端口没开 → 找不到 `DevToolsActivePort`。`tauri-apps/wry#1782` 有完整记录。
- **修法**：**别用提权会话跑**。三种都行：
  1. 计划任务用 **`RunLevel Limited`**（不是 `Highest`）；
  2. 普通（非管理员的）用户 shell；
  3. 必须在提权环境里（比如 CI runner）时，用 **`gsudo`** 之类**降回中等完整性**再跑
     —— 仓库的 `.github/workflows/gui.yml` 用的就是这个办法，还带缓存。

  这条机器上我留了对照实验的痕迹：计划任务 `cante-drive`（`RunLevel Highest`）和
  `cante-drive2`（`RunLevel Limited`），跑的是**同一个脚本**；绿的是 **Limited** 那个。

  ```powershell
  # 一眼看出任务是不是提权的（Highest 就是要改的）
  Get-ScheduledTask | Where-Object { $_.Principal.LogonType -eq 'Interactive' } |
    Select-Object TaskName, @{n='RunLevel';e={$_.Principal.RunLevel}}
  ```

  **复核状态**：⚠️ **借证，未亲复现**。证据是仓库里**一手记录**：
  `gui/README.md` 的 "One Windows trap" 一节、`.github/workflows/gui.yml` 第 154–167 行、
  以及上面那对 Highest/Limited 计划任务。

  我**试过**一个轻量复现（启动 `cante-gui.exe` 时设
  `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--remote-debugging-port=9222'`，分别不提权/提权，
  再看 9222 有没有在听），**结果两组都是 `9222 = False`，区分不出来**——这个探法本身不成立
  （端口开不开还取决于 WebView2 是否真的加载了页面），所以**当作没验**。
  要真正复现，得跑完整的 `accept-drive.mjs` + WebDriver 会话（长验收，我没跑）。
  **别把我的那次尝试当成证据。**

### 坑 4：`qemu-guest-agent` 必须**同时**装 virtio-serial 驱动

- **症状**：服务 `QEMU-GA` **明明在跑**，但从宿主机看是
  **"agent is not running"** / guest-ping 一直失败。
- **真因**：QEMU Guest Agent **靠 virtio-serial 通道**和宿主通信。Windows 侧如果没有
  virtio-serial 驱动，那个 PCI 设备会停在"**其他设备 / 简单通讯控制器**"（设备管理器里带感叹号），
  **通道没建起来** → 服务跑得再欢，宿主也连不上。
- **修法**：从 virtio-win 光盘装 `vioserial` 驱动（这台机器上光盘是 **F:**，
  路径 `F:\vioserial\w11\amd64\vioser.inf`）：

  ```powershell
  pnputil /add-driver F:\vioserial\w11\amd64\vioser.inf /install
  pnputil /scan-devices
  Restart-Service QEMU-GA -Force
  # 确认设备不再有感叹号（VirtIO Serial Driver 应显示 OK）
  Get-PnpDevice -ErrorAction SilentlyContinue |
    Where-Object { $_.InstanceId -match 'VEN_1AF4&DEV_1003' } |
    Select-Object Status, FriendlyName, InstanceId
  ```

  排查设备问题（找所有非 `OK` 的设备）：

  ```powershell
  Get-PnpDevice | Where-Object { $_.Status -ne 'OK' } |
    Select-Object Status, Class, FriendlyName, InstanceId
  ```

  **复核状态**：**已复核当前状态**——`VirtIO Serial Driver` 现在是 `OK`，`QEMU-GA` 是
  `Running / Auto`。**"装之前"的样子**我从这台机器上留下的证据文件看到了
  （`%USERPROFILE%\ga-fix.txt`：两个 `PCI\VEN_1AF4&DEV_1003` 停在 **Error**），
  装完之后同一份文件里 `pnputil` 报"已成功添加驱动程序程序包"。
  **我没有**卸载驱动去亲手复现"坏"的那一面（会把机器弄坏，不值）。

### 坑 5：装机路径别猜——去注册表卸载项的 `InstallLocation` 查

- **症状**：`%APPDATA%\Cante` 里什么都没有，于是判定"没装上"，其实**装在别处**。
- **真因**：Tauri 的 **NSIS 是 per-user 安装**，默认落在 **`%LOCALAPPDATA%`**；
  而人（包括我）的直觉常常写成 `%APPDATA%`（Roaming）。**两个目录长得很像、结果完全不同。**
- **修法**：**永远读卸载登记里的 `InstallLocation`，不要猜目录**：

  ```powershell
  Get-ItemProperty 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
                   'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
                   'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*' `
                   -ErrorAction SilentlyContinue |
    Where-Object { $_.DisplayName -like '*Cante*' } |
    Select-Object DisplayName, DisplayVersion, InstallLocation, UninstallString
  ```

  两个坑要一起躲：
  1. **值是带引号的**：这台机器上 `InstallLocation` 原文是
     `"C:\Users\<用户名>\AppData\Local\Cante"`（**含首尾双引号**，长度把引号算进去了）。
     拼路径前先 `Trim('"')`，否则会变成一个不存在、又不好看出错在哪的路径。
  2. **确认到底在哪**：这台机器上验证过——
     `Test-Path "$env:LOCALAPPDATA\Cante"` = **True**，
     `Test-Path "$env:APPDATA\Cante"` = **False**。

### 坑 6：装完就跑会"找不到应用"——因为验收脚本跑完会**静默卸载**

- **症状**：明明刚装完、验收也过了，回头一看**安装目录空了 / 开始菜单没了 / 注册表项没了**，
  以为装坏了或崩了。
- **真因**：`gui/scripts/windows/accept-install.ps1` 的**第 5 步就是收尾卸载**：
  `Start-Process <安装目录>\uninstall.exe -ArgumentList '/S' -Wait`（`/S` = 静默），
  然后逐项检查残留。**这是设计**——验收要保证"干净机器进去、干净机器出来"。
- **修法**：知道这件事就不会慌。要**保留**安装就加 `-SkipUninstall`：

  ```powershell
  powershell -NoProfile -ExecutionPolicy Bypass `
    -File gui\scripts\windows\accept-install.ps1 -Installer "C:\path\Cante_0.2.3_x64-setup.exe" -SkipUninstall
  ```

  反过来说：**"脚本跑完应用不见了"= 正常**；**"跑之前就找不到"= 真的没装上**，
  这时回到坑 5 去注册表查 `InstallLocation`。

### 坑 7：`winget` 装不了显卡驱动（没有清单）

- **症状**：`winget search` 显卡驱动 → `No package found matching input criteria.`；
  设备管理器里显示适配器停在 **`Microsoft 基本显示适配器`**；
  Intel 那块 VF 是 **问题码 43**（`Error`）。
- **真因**：winget 的清单是**应用**清单，**显卡驱动不在里面**
  （能搜到的只有 DDU、Parsec VDD 这类工具，不是驱动本体）。
- **修法**：驱动走别的三条路之一——**`pnputil`（有 .inf 时）/ Windows Update / 厂商安装包**：

  ```powershell
  # 1) 直接装厂商驱动的 .inf
  pnputil /add-driver C:\path\to\driver\*.inf /install
  pnputil /scan-devices
  Get-PnpDevice -Class Display | Select-Object Status, FriendlyName, InstanceId
  ```

  这台机器上我试过 Windows Update 那条路，结果是**没有**：
  `Microsoft.Update.Session` 搜 `Type='Driver'` → **0 个更新**（证据在
  `%USERPROFILE%\gpu-wu.txt`）。**所以这台机器的 GPU 就是没驱动**，WebView2 走
  **软件渲染**。UI 验收要做的话，别指望 GPU。

  > 顺带记住：**vGPU 这条路在这台机器上走不通**（Intel Iris Xe VF 一直是问题码 43，
  > WU 也没驱动）。这跟 `gui/DEVELOPING-WINDOWS.md` 里"跑 vGPU 交给 CI / 另开单子"一致。

### 坑 8：计划任务在"没有登录会话"时不会跑

- **症状**：计划任务**明明注册了、时间也到了**，就是**不跑**；`Last Run Time` 空、
  报告不生成。
- **真因**：**交互型（`Interactive`）任务需要有人在桌面上**（要有登录会话）。
  这台机器靠**自动登录**保证一直有人——但**应答文件里的 `AutoLogon` 只有 3 次**
  （`C:\Windows\Panther\unattend.xml` 里 `<LogonCount>3</LogonCount>`），
  **用久了就没了**，于是没人登录 → 交互任务不跑。
  另一条相关的：这台机器上**没有**"作为批处理作业登录"的权限，
  用 `-LogonType S4U`（"不管用户是否登录都运行"）注册会直接 **`Access is denied`**（0x80070005）；
  而 **`SYSTEM` 也不行**——WSL 发行版是**按用户**注册的，SYSTEM 看不到它。
- **修法**：
  1. **重建自动登录**（3 次用完之后）：

     ```powershell
     $w = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'
     Set-ItemProperty $w -Name AutoAdminLogon  -Value '1' -Force
     Set-ItemProperty $w -Name ForceAutoLogon  -Value '1' -Force
     Set-ItemProperty $w -Name DefaultUserName -Value $env:USERNAME -Force
     Remove-ItemProperty $w -Name AutoLogonCount -ErrorAction SilentlyContinue   # 别留上限
     ```

     （这台机器已经这么处理过了：`AutoAdminLogon=1`、`ForceAutoLogon=1`、
     `AutoLogonSID` 有值、`AutoLogonCount` **已不存在**。）
  2. **注册交互任务时用 `RunLevel Limited`**（配合坑 3）：

     ```powershell
     $pr = New-ScheduledTaskPrincipal -UserId "$env:COMPUTERNAME\$env:USERNAME" `
           -LogonType Interactive -RunLevel Limited
     ```
  3. **跑完要会看"到底跑没跑"**，不能只看任务存在：

     ```powershell
     $i = Get-ScheduledTaskInfo -TaskName <任务名>
     $i.LastRunTime; $i.LastTaskResult      # 0 = 成功
     ```

     **注意**：`LastTaskResult=0` 只说明"任务被启动过、没报错退出"，
     **不等于**"里面的活干完了"。要看产物文件（例如报告）是不是**非空、内容完整**。

- **复核状态**：**已复核当前机器状态**——`AutoLogonCount` 不存在、`AutoAdminLogon=1`、
  `ForceAutoLogon=1`；`unattend.xml` 里确实是 `LogonCount=3`；所有验收计划任务
  （`cante-accept` / `cante-app` / `cante-cdp` / `cante-drive` / `cante-probe` …）都是
  `LogonType=Interactive`。**"没人登录就不跑"这条我没有亲手复现**（要登出/重启才能试，
  会把正在跑的会话弄断），证据是机器上留下的记录和 `AGENTS.md` §4 的说明。

---

## 4. 这台机器能做什么 / 不能做什么

### 能（就是这台机器存在的理由：CI 做不到的事）

- **真机 UI 验收**：这台机器有**交互桌面**（会话 1，见坑 2），所以**能开真窗口、
  能点、能截图**。跑 `gui/scripts/windows/accept-drive.mjs` 那种真 WebView2 驱动验收——
  **前提**：用 `RunLevel Limited` 的交互任务起（坑 3）。
- **Windows 构建快检**：`gui/scripts/check-windows.ps1`（**先看坑 1/坑 9**，
  它有 BOM 和硬编码路径两个问题；能修就修，修不了就用 `bun test src` + `bunx tsc --noEmit` 顶上）。
- **装真安装包、看真目录、读注册表**：per-user 安装路径、卸载残留、开始菜单/桌面快捷方式
  这些**只有真 Windows 能看**。
- **驱动应用跑一轮**：有 virtio-serial + QEMU-GA 这条通道（坑 4），宿主能探进来。

### 不能（别在这台机器上做）

- **跑完整门禁**：`gui/scripts/e2e.sh`（`bun install` + `vite build` + 全量 `cargo test`）
  在这台机器上实测 **30 分钟以上**，而 **CI 已经在 `windows-latest` 上跑同一份**。
  **推分支前只跑快检，完整门禁交给 CI**（`AGENTS.md` §3.5 / §5）。
- **拿性能数字当画像机体感**：这是**虚拟机**（QEMU），而且没有 GPU 驱动。启动耗时、
  "卡不卡"这类结论**不能用**。
- **跑 vGPU / 真显卡相关的事**：Intel Iris Xe VF 一直问题码 43，WU 不给驱动（坑 7）。
- **在 SSH 里期待看到窗口**：除非走这台机器那条 `RemotePiSupervisor` 桥
  （别人搭的，换机器就没有），否则 **Session 0 没桌面**（坑 2）。

### 每次长命令都要带超时（这条是真金白银换来的）

```powershell
# PowerShell：放进 Job 等，超时就停掉并如实报告"超时"
$j = Start-Job { ... }
if (Wait-Job $j -Timeout 60) { Receive-Job $j } else { Stop-Job $j; "超时：60 秒没跑完" }
```

```bash
timeout 60 <命令>          # bash
```

报告里 **"超时"与"确认没有"必须分开写**——把"没等到结果"写成"没有"是最怕的错。

---

## 5. 顺带两个"推不上去"的坑（Windows 上尤其）

这两条 `AGENTS.md` §6.5 已经写了，这里只做**这台机器上的**提醒：

1. **`.github/workflows/**` 的改动可能推不上去**：这台机器 `gh` 的令牌作用域是
   `admin:public_key, gist, read:org, repo`——**没有 `workflow`**。碰到
   `refusing to allow an OAuth App to create or update workflow … without workflow scope`
   就**如实写进报告**，别反复重试；集成者会把提交取回本机来推。
2. **在 Windows 上生成 patch / 重定向输出，别用 `>`**（PowerShell 按 GBK 写，中文变非法字节，
   `git am`/`git apply` 会说"不是合法补丁"）。让 git 自己写：
   `git format-patch -1 HEAD --output=…`。

---

## 6. 我怎么复核的（哪条是亲验、哪条是借证）

| 坑 | 复核状态 | 我做了什么 |
| --- | --- | --- |
| 1 缺 BOM | ✅ **亲验** | 写了一份只差 BOM 的最小脚本对跑：无 BOM → `x=`（空）、有 BOM → `x=OK`；又拿**仓库真的** `check-windows.ps1` 跑，确认它因 GBK 解析**报乱码语法错**。**并且查清 `script-encoding.test.ts` 不存在**（坑 9）。 |
| 2 Session 0 无桌面 | ✅ **亲验（含反例）** | 查到 `sshd` 在**会话 0**、`explorer/dwm` 在**会话 1**；又实测**我这个会话能建真窗口**（`winver` 拿到句柄），并查清原因是 `RemotePiSupervisor` 计划任务 + VBS 桥把我放进了会话 1。 |
| 3 提权破坏 WebView2 | ⚠️ **借证，未亲复现** | 仓库一手记录（`gui/README.md`、`gui.yml` 第 154–167 行、上游 issue）+ 机器上 Highest/Limited 两个对照任务。我试了个轻量复现（看 9222 端口），**两组结果一样、区分不出来，当作没验**。 |
| 4 qemu-ga 要 virtio-serial | ✅ **亲验当前状态** / ⚠️ "坏"的那面是历史证据 | 现在 `VirtIO Serial Driver` = OK、`QEMU-GA` = Running；装之前是 Error 的样子来自机器上留下的 `ga-fix.txt`。**没卸载去复现"坏"。** |
| 5 装机路径别猜 | ✅ **亲验** | 读注册表拿到 `InstallLocation`（**带引号**），实测 `%LOCALAPPDATA%\Cante` 在、`%APPDATA%\Cante` 不在。 |
| 6 跑完会静默卸载 | ✅ **亲验（读脚本 + 对照机器状态）** | 读了 `accept-install.ps1` 第 5 步的 `uninstall.exe /S`；确认机器上的验收脚本都这么收尾，`-SkipUninstall` 可保留。 |
| 7 winget 装不了显卡驱动 | ✅ **亲验** | `winget search` 找不到驱动清单；WU 搜 `Type='Driver'` 得 **0**；显示适配器是 `Microsoft 基本显示适配器`，Intel VF 问题码 43。 |
| 8 没登录会话不跑任务 | ✅ **亲验当前状态** / ⚠️ "不跑"没亲复现 | 查到 `AutoLogonCount` 不存在、`AutoAdminLogon=1`、`ForceAutoLogon=1`、`unattend.xml` 里 `LogonCount=3`、所有验收任务都是 Interactive。**没登出去复现"没人登录就不跑"。** |

---

## 7. 我发现的新坑（第 9 条）

### 坑 9：`gui/scripts/check-windows.ps1` 在这台机器上**跑不起来**，而且任务书说的闸门不存在

- **症状**：照着 `AGENTS.md` §3.5 的推荐去跑推分支前的快检——

  ```powershell
  powershell -NoProfile -ExecutionPolicy Bypass -File gui\scripts\check-windows.ps1
  ```

  **退出码 1**，输出全是乱码语法错（`意外的标记"}"`、`字符串缺少终止符: "`）。
  而任务书（和 `AGENTS.md` 的期待）说仓库里有闸门 `gui/src/script-encoding.test.ts` 在挡这件事。
- **真因**（两个叠在一起）：
  1. `gui/scripts/check-windows.ps1` 是**唯一一个没有 BOM** 的 `.ps1`
     （其它 10 个都有：`git ls-files '*.ps1'` 逐个查头 3 字节，只有它缺），
     内容里有中文注释 → 撞**坑 1**；
  2. **那个闸门文件不存在**：`gui/src/script-encoding.test.ts` 在 `main`、本分支、
     `pool/win-ci`、`pool/win-usage` 和所有远端分支里都搜不到
     （`git ls-tree -r --name-only <ref> | grep script-encoding` → 0 条）。
- **修法**（**我没有动代码**，只写这份文档，改动留给你们定）：
  1. 给 `gui/scripts/check-windows.ps1` 补 BOM（同一个提交），顺带看下它的第 20 行
     ——它把 `C:\Users\$env:USERNAME\tools\bun` **硬编码**到 PATH 最前，
     而**这台机器上那个目录不存在**（真的 bun 在 `%LOCALAPPDATA%\Microsoft\WinGet\Links`）。
     修 BOM 只解决"解析不了"，这一行不解决的话前端那两步可能仍找不到 bun。
  2. 补上那个闸门（扫 `git ls-files '*.ps1'`，读前 3 字节是不是 `EF BB BF`），
     否则**下一个人还会踩**，而且没有测试会红。
- **复核状态**：✅ **亲验**——`-File` 调用退出码 **1**（乱码语法错）；
  把同一份文件**加 BOM 后**复制到 `%TEMP%` 再跑，`-SkipFrontend` **退出码 0**
  （打印「check-windows: 全部通过」）。BOM 是唯一变量。

> 另外两条**不算坑、但下一个人会想知道**（都在这台机器上验证过）：
> - **pi 在这台机器上是 `.cmd`/`.ps1`（npm 全局装的），没有 `.exe`**。
>   而 Rust 的 `CreateProcess` **起不了 `.cmd`** → `PI_BIN` 必须指到**真 `.exe`**
>   （`Get-Command pi` 看 `Source` 结尾是不是 `.exe`）。这台机器上 `Get-Command pi`
>   给的是 `...\npm\pi.ps1`——所以验收要用 pi 时要注意这一点。
> - **这台机器只有 PowerShell 5.1，没有 `pwsh`**（`where pwsh` 找不到）。
>   写脚本、贴命令都按 5.1 的语法来。

---

## 8. 一页速查

```powershell
# —— 我是谁、在哪个会话 ——
'用户   = ' + [Security.Principal.WindowsIdentity]::GetCurrent().Name
'管理员 = ' + ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
'会话   = ' + (Get-Process -Id $PID).SessionId
Get-Process explorer,dwm -ErrorAction SilentlyContinue | Select-Object Id,SessionId,ProcessName

# —— 应用装在哪（别猜）——
(Get-ItemProperty 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue |
  Where-Object DisplayName -like '*Cante*').InstallLocation.Trim('"')

# —— 交互型计划任务跑东西（UI 验收的基本姿势）——
$a  = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -ExecutionPolicy Bypass -File C:\path\x.ps1'
$pr = New-ScheduledTaskPrincipal -UserId "$env:COMPUTERNAME\$env:USERNAME" -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName my-run -Action $a -Principal $pr -Force
Start-ScheduledTask -TaskName my-run
Get-ScheduledTaskInfo -TaskName my-run | Select-Object LastRunTime,LastTaskResult   # 0 = 成功

# —— 计划任务在 Git Bash 里要把 /tn 当路径，加这个 ——
# MSYS_NO_PATHCONV=1 schtasks /query /tn <任务名> /v /fo LIST
```

**下一次要交接时，把这几条也一起传下去**：会话 1（有桌面）是靠 `RemotePiSupervisor`
那条桥撑起来的；自动登录是**手设**的、应答文件那 3 次早就用完了；
`check-windows.ps1`（坑 9）和那个不存在的闸门**还没修**。
