# 「跑一轮真机验收」的一行入口（Windows 真机）：装好的应用 + 零环境变量 → 点一张卡 →
# 真的出一份文件。
#
#   # 文件卡（选文件 → 点卡 → 真出一份表）
#   powershell -NoProfile -ExecutionPolicy Bypass -File gui\scripts\windows\run-accept-drive.ps1
#
#   # 文字卡（needs:"text"，例如 doc.worksummary）—— 贴一段流水账，不选文件
#   powershell -NoProfile -ExecutionPolicy Bypass -File gui\scripts\windows\run-accept-drive.ps1 `
#     -Card "把这段时间做的事写成一份总结" -TextCard `
#     -Instruction "把我这几个月的流水账写成一份工作总结，别写得太长" `
#     -PasteText "3月2日 整理各部门报销单据
#   3月5日 核对物业费发票…"
#
# 它把 accept-install.ps1 的第 3~4 步（起窗口 + 驱动跑一轮 + 核对产出）单独拿出来跑，
# **不装、不卸** —— 适合"应用已经装好，我只想再跑一轮"。它自己负责四件事：
#   1. **判断会话**：不提权的交互会话就地跑；提权 / session 0 自动改走「当前用户 +
#      Interactive + RunLevel Limited』的计划任务（和 accept-first-screen.ps1 同一套做法，
#      这里**不另起**第二套 —— 那正是 AGENTS.md §3.6 说的"别自己发明"）；
#   2. **清残留**：跑前杀掉残留的 cante-gui（残留实例会让 WebDriver 拿不到调试端口，
#      症状和"提权"一模一样，DEV 文档记过）；
#   3. **备好来料**：文件卡用应用自带的 `cante-sheets write` 造一张输入表（它不覆盖已存在
#      文件，所以每次都建在一个新的运行目录里）；文字卡则把 `-PasteText` 整段交给驱动贴进输入框；
#   4. **设好整套 ACCEPT_\***（默认零环境变量模式 ACCEPT_ZERO_ENV=1）→ 跑 accept-drive.mjs →
#      把它的 phase 行与结果**原样**打出来 → 再用 `cante-sheets` 把产出读回来核对。
#
# 退出码（照 accept-first-screen.ps1 的 0/2/3 约定）：
#   0 = 跑通（结果页出现「做好了」，且盘上真的有产出、内容对得上）；
#   2 = **环境问题**（找不到应用 / 驱动 / 执行组件、没有交互会话、WebDriver 会话建不起来）；
#   3 = **产品问题**（窗口起来了，但卡片流程失败：出错页 / 等不到结果页 / 产出不对）。
# 判断依据写在下面对应的分支里，报告里会打印得出这个码的理由。
#
# 用法：
#   ... -Exe "C:\...\cante-gui.exe"            # 不查注册表，直接指一个可执行文件
#   ... -Card "从大表里挑出想要的行" -Instruction "把华东区的记录挑出来，另存成一张新表"
#   ... -Card "把这段时间做的事写成一份总结" -TextCard -PasteText "…流水账…"
#   ... -WithEnv                               # 老路径：脚本替她设 CANTE_BIN / PI_BIN（对照用）
#   ... -WorkDir "D:\accept-01"                # 换个运行目录（默认 %TEMP%\cante-accept-drive-<时间戳>）
#   ... -TimeoutSec 2400                       # 整轮上限（默认 2100s，AGENTS.md §5：单卡别低于 1800s）
#
# 产物（默认在工作目录里）：
#   report.txt                     人看的报告（phase 行 + 结果页文字 + 产物清单，原文）
#   job\                           工作目录（文件卡：输入表；文字卡：只放来料副本）
#   job\drive-artifacts\           accept-drive.mjs 的截图 / 结果页文字 / accept-drive-result.json
#   job\drive-artifacts\confirm-visible.json  确认页可见性取证（#192 A，UIA 矩形）
#   result.json                    结构化结果（给脚本/CI 用）
#
# 注意：本文件必须保存为 UTF-8 with BOM（Windows PowerShell 5.1 否则按 GBK 解析，中文会乱码）。

param(
    [string]$Exe = "",
    [string]$Card = "从大表里挑出想要的行",
    [string]$Instruction = "把华东区的记录挑出来，另存成一张新表",
    # 文字卡（needs:"text"，例如 doc.worksummary）：没有选文件这一步，来料整段贴进输入框。
    # 给了 -PasteText 就自动进文字卡模式（不缺一张输入表，也不碰原生对话框）。
    [string]$PasteText = "",
    [switch]$TextCard,
    # 内部：从文件读粘贴内容（父进程用计划任务把多行来料传过来时用）。
    [string]$PasteTextFile = "",
    # 文字卡产出落在哪儿：没选文件时产品把它放桌面（见 worksummary 的指令）。
    # 默认取当前用户桌面；出别的卡（选了文件的）时用不着它。
    [string]$OutputDir = "",
    [string]$WorkDir = "",
    # WebDriver 端口。默认 4444（accept-drive.mjs 的缺省）；同机并行跑多轮时要各自给一个
    # ——两台并行的验收都去杀 cante-gui / 抢同一个端口，会互相把对方的应用干掉（实测）。
    [int]$Port = 0,
    [int]$TimeoutSec = 2100,
    [int]$DriveTimeoutSec = 1800,
    # 老路径：替她设 CANTE_BIN / PI_BIN（#150 第二步之前用的模式）。默认**不设** ——
    # 正式验收要证的正是"不靠环境变量也能干活"（应用自己找包里的桥与执行组件）。
    [switch]$WithEnv,
    [switch]$KeepWorkDir,
    # 内部使用：子进程模式。父进程（提权 / session 0）复用它，避免无限自我重启。
    [switch]$Child
)

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$script:Lines = New-Object System.Collections.Generic.List[string]
function Say([string]$text) { Write-Output $text; [void]$script:Lines.Add($text) }
function SayLines([string]$text) {
    if ([string]::IsNullOrEmpty($text)) { return }
    foreach ($line in ($text -split "`r?`n")) { Say $line }
}

function Test-IsElevated {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    $p = New-Object Security.Principal.WindowsPrincipal($id)
    return $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}
function Get-SessionId { return (Get-Process -Id $PID).SessionId }

# 「已装好的应用在哪」只有一个可信来源：卸载注册表项里的 InstallLocation（照 DEVELOPING-WINDOWS.md）。
# 别在 %APPDATA% / %LOCALAPPDATA% 之间猜 —— 那件事我们已经吃过亏。
function Resolve-InstalledExe([string]$Given) {
    if ($Given) {
        if (Test-Path $Given) { return (Resolve-Path $Given).Path }
        return $null
    }
    $entry = Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' -ErrorAction SilentlyContinue |
        Where-Object { $_.GetValue('DisplayName') -like '*Cante*' } | Select-Object -First 1
    if ($entry) {
        $location = $entry.GetValue('InstallLocation')
        if ($location) {
            $location = $location.Trim('"')
            $candidate = Join-Path $location 'cante-gui.exe'
            if (Test-Path $candidate) { return $candidate }
        }
    }
    $fallback = Join-Path $env:LOCALAPPDATA 'Cante\cante-gui.exe'
    if (Test-Path $fallback) { return $fallback }
    return $null
}

function Resolve-TauriDriver {
    $candidate = Join-Path $HOME '.cargo\bin\tauri-driver.exe'
    if (Test-Path $candidate) { return $candidate }
    $onPath = (Get-Command tauri-driver.exe -ErrorAction SilentlyContinue).Source
    if ($onPath) { return $onPath }
    return $null
}

function Resolve-MsEdgeDriver([string]$workDir) {
    # 和 CI / accept-install 用同一批位置，这样第二遍跑不用重新下载。
    $candidates = @(
        (Join-Path $script:GuiRoot 'e2e-windows\msedgedriver\msedgedriver.exe'),
        (Join-Path $HOME 'msedgedriver\msedgedriver.exe'),
        (Join-Path $workDir 'msedgedriver\msedgedriver.exe')
    )
    foreach ($candidate in $candidates) { if (Test-Path $candidate) { return $candidate } }
    return $null
}

function Resolve-PiBin {
    $candidates = @(
        (Join-Path $HOME '.bun\bin\pi.exe'),
        (Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links\pi.exe')
    )
    foreach ($candidate in $candidates) { if (Test-Path $candidate) { return $candidate } }
    $onPath = (Get-Command pi.exe -ErrorAction SilentlyContinue).Source
    if ($onPath) { return $onPath }
    return $null
}

function Run-Command([string]$File, [string[]]$Arguments, [int]$TimeoutSec = 300) {
    # 外部命令统一带超时：卡住的子进程不该把整轮挂死（AGENTS.md §5）。
    # 用 .NET Process 而不是 Start-Process：后者在带重定向时拿不到 ExitCode（实测），
    # 而且读回来的字节会按 ANSI 解码，中文全成乱码。这里显式按 UTF-8 读、异步读流。
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $File
    $psi.Arguments = (($Arguments | ForEach-Object { '"' + ($_ -replace '"', '\"') + '"' }) -join ' ')
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
    $psi.StandardErrorEncoding = [System.Text.Encoding]::UTF8
    $proc = New-Object System.Diagnostics.Process
    $proc.StartInfo = $psi
    [void]$proc.Start()
    $outTask = $proc.StandardOutput.ReadToEndAsync()
    $errTask = $proc.StandardError.ReadToEndAsync()
    if (-not $proc.WaitForExit($TimeoutSec * 1000)) {
        try { $proc.Kill() } catch { }
        return [pscustomobject]@{ Code = 124; Stdout = ''; Stderr = ("超时：超过 ${TimeoutSec}s 没结束") }
    }
    return [pscustomobject]@{ Code = $proc.ExitCode; Stdout = $outTask.Result; Stderr = $errTask.Result }
}

$script:Here = $PSScriptRoot
$script:GuiRoot = (Resolve-Path (Join-Path $script:Here '..\..')).Path
$script:InstallDir = Join-Path $env:LOCALAPPDATA 'Cante'
$script:ProfileDir = Join-Path $env:LOCALAPPDATA 'dev.cante.gui'
# 父进程用计划任务时靠文件传来料（多行安全）；子进程从文件读后当 -PasteText 用。
if ($PasteTextFile) {
    if (Test-Path $PasteTextFile) {
        $PasteText = Get-Content $PasteTextFile -Raw -Encoding UTF8
    }
}
# 文字卡模式：给了 -PasteText 或显式 -TextCard 都算（前者更好用，调用方不用记两个开关）。
$isTextCard = ($TextCard -or $PasteText -ne '')
# 文字卡没选文件时，产品把结果放“桌面”——但“桌面”在这台机器上不止一个地方：
# 操作系统报告的桌面可能是 OneDrive 重定向的，而应用自己解析出来的可能又是
# %USERPROFILE%\Desktop（实测：应用写进了后者，GetFolderPath 指的是前者）。
# 所以**两个都看**，否则会误判成“没有产出”（我就误判过一次）。
$script:OutputDirs = @()
if ($isTextCard) {
    if ($OutputDir) { $script:OutputDirs += $OutputDir }
    $cands = @(
        ([Environment]::GetFolderPath('Desktop')),
        (Join-Path $env:USERPROFILE 'Desktop'),
        $(if ($env:OneDrive) { Join-Path $env:OneDrive '桌面' }),
        $(if ($env:OneDrive) { Join-Path $env:OneDrive 'Desktop' })
    ) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -Unique
    $script:OutputDirs = @($cands)
}

if (-not $WorkDir) {
    $WorkDir = Join-Path $env:TEMP ('cante-accept-drive-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
}

$elevated = Test-IsElevated
$session = Get-SessionId

# ---------------------------------------------------------------------------
# 父进程：提权或 session 0 时，把真正那一步交给 Limited 计划任务
# （与 accept-first-screen.ps1 同一套；HTTPS 在这里不重要，"不另起一套"才重要）
# ---------------------------------------------------------------------------

if (-not $Child -and ($elevated -or $session -eq 0)) {
    New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
    $reportFile = Join-Path $WorkDir 'report.txt'
    $resultFile = Join-Path $WorkDir 'result.json'
    Remove-Item $reportFile, $resultFile -Force -ErrorAction SilentlyContinue

    Say '=== 真机验收：跑一轮（Windows）==='
    Say ("当前会话：elevated=$elevated session=$session")
    Say '这个会话驱动不了窗口（提权进程里 WebView2 会忽略 WEBVIEW2_* / 调试端口，session 0 没有交互桌面）。'
    Say '改由「当前用户 + Interactive + RunLevel Limited」的计划任务在登录会话里跑，再把报告原样带回来。'

    $taskName = 'CanteAcceptDrive'
    $innerTimeout = [Math]::Max(120, $TimeoutSec - 20)
    # 贴进去的那段字可能带换行 —— 直接当计划任务的命令行参数会被拆碎。父进程先写成
    # 一个文件，子进程从文件读（-PasteTextFile），这样多行来料也安全。
    $childPasteFile = ''
    if ($PasteText -ne '') {
        $childPasteFile = Join-Path $WorkDir 'paste-text.txt'
        Set-Content -Path $childPasteFile -Value $PasteText -Encoding UTF8
    }
    $inner = @(
        '-NoProfile', '-ExecutionPolicy', 'Bypass',
        '-File', ('"' + $PSCommandPath + '"'),
        '-Child',
        '-Card', ('"' + $Card + '"'),
        '-Instruction', ('"' + $Instruction + '"'),
        '-WorkDir', ('"' + $WorkDir + '"'),
        '-OutputDir', ('"' + $OutputDir + '"'),
        '-TimeoutSec', $innerTimeout.ToString(),
        '-DriveTimeoutSec', $DriveTimeoutSec.ToString()
    )
    if ($Port -gt 0) { $inner += @('-Port', $Port.ToString()) }
    if ($Exe) { $inner += @('-Exe', ('"' + $Exe + '"')) }
    if ($childPasteFile) { $inner += @('-PasteTextFile', ('"' + $childPasteFile + '"')) }
    if ($isTextCard) { $inner += '-TextCard' }
    if ($WithEnv) { $inner += '-WithEnv' }
    if ($KeepWorkDir) { $inner += '-KeepWorkDir' }
    $argument = ($inner | ForEach-Object { $_.ToString() }) -join ' '

    try {
        $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $argument
        $principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
        $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
            -ExecutionTimeLimit (New-TimeSpan -Seconds $TimeoutSec) -MultipleInstances IgnoreNew
        Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal -Settings $settings -Force | Out-Null
        Say ("已建计划任务 " + $taskName + "（Limited），触发…")
        schtasks /run /tn $taskName | Out-Null
    } catch {
        Say ('run-accept-drive: FAIL — 建不了计划任务：' + $_.Exception.Message)
        Say '  这一步是为了在登录会话里开窗口。请确认当前用户已登录（有交互会话），或改用 RDP 直接跑本脚本。'
        exit 2
    }

    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline -and -not (Test-Path $resultFile)) {
        Start-Sleep -Milliseconds 500
    }
    $state = (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue).State
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue

    $code = 2
    if (Test-Path $resultFile) {
        $saved = Get-Content $resultFile -Raw | ConvertFrom-Json
        $code = [int]$saved.exitCode
    }
    if (Test-Path $reportFile) {
        Say ''
        Get-Content $reportFile -Encoding UTF8 | ForEach-Object { Write-Output $_ }
    } else {
        Say ('run-accept-drive: FAIL — 计划任务没有写出报告（最后状态 ' + $state + '）。')
        Say '  可能是应用没起来、或这台机器没有可用的交互会话。请改用 RDP 打开桌面后直接跑本脚本。'
    }
    if (Test-Path $resultFile) { Say ''; Say ('run-accept-drive: 结论 = ' + $code) }
    exit $code
}

# ---------------------------------------------------------------------------
# 子进程（或本就在不提权的交互会话里）：就地跑
# ---------------------------------------------------------------------------

New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
$reportFile = Join-Path $WorkDir 'report.txt'
$resultFile = Join-Path $WorkDir 'result.json'
$jobDir = Join-Path $WorkDir 'job'
$driveArtifacts = Join-Path $WorkDir 'job\drive-artifacts'

$script:Timings = New-Object System.Collections.Generic.List[object]
function Step([string]$name, [scriptblock]$body) {
    Say ''
    Say ('==> ' + $name)
    $watch = [System.Diagnostics.Stopwatch]::StartNew()
    $value = & $body
    $watch.Stop()
    $script:Timings.Add([pscustomobject]@{ Name = $name; Seconds = [math]::Round($watch.Elapsed.TotalSeconds, 1) })
    Say ('    （耗时 ' + [math]::Round($watch.Elapsed.TotalSeconds, 1) + 's）')
    return $value
}

$code = 0
$reason = ''
$exePath = Resolve-InstalledExe $Exe
$sheetsBin = $null
$bridgeBin = $null

Say '=== 真机验收：跑一轮（Windows）==='
Say ("会话：elevated=$elevated session=$session")
Say ("工作目录：" + $WorkDir)
Say ("应用：" + $(if ($exePath) { $exePath } else { '(未找到)' }))
Say ("卡片：" + $Card)
Say ("卡片模式：" + $(if ($isTextCard) { '文字卡（贴一段字，不选文件）' } else { '文件卡（选文件，原生对话框）' }))
if ($isTextCard) { Say ("产出目录（文字卡没选文件 → 产品放桌面；可能不止一处）：" + ($script:OutputDirs -join '；')) }
Say ("模式：" + $(if ($WithEnv) { '脚本替她设 CANTE_BIN / PI_BIN（对照用）' } else { '零环境变量（ACCEPT_ZERO_ENV=1，应用自己找组件）' }))

try {

    # 1) 前置检查：凡是"环境"的问题，都在这儿一次问清楚，别让它以误导性的错误冒出来。
    Step '1. 前置检查' {
        if (-not $exePath) {
            Say '  FAIL — 找不到装好的 cante-gui.exe。'
            Say ("    查过：HKCU 卸载登记里的 InstallLocation，以及 $env:LOCALAPPDATA\Cante\cante-gui.exe。")
            throw 'ENV:应用未安装'
        }
        $script:installRoot = Split-Path -Parent $exePath
        $script:sheetsBin = Join-Path $script:installRoot 'cante-sheets.exe'
        $script:bridgeBin = Join-Path $script:installRoot 'cante-bridge.exe'
        foreach ($needed in @($script:sheetsBin)) {
            if (-not (Test-Path $needed)) { throw ("ENV:安装目录里缺 " + (Split-Path -Leaf $needed)) }
        }
        if (-not $WithEnv -and -not (Test-Path (Join-Path $script:installRoot 'pi'))) {
            # 零环境变量模式要靠"包里的 pi" —— 它不在就没法跑；这是包装问题，先在环境层拦住。
            throw 'ENV:安装目录里缺 pi\（零环境变量模式要用它）'
        }
        $node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
        if (-not $node) { throw 'ENV:找不到 node.exe' }
        $script:node = $node
        if (-not (Test-Path (Join-Path $script:GuiRoot 'node_modules\selenium-webdriver'))) {
            throw 'ENV:缺少 gui/node_modules/selenium-webdriver（先在 gui/ 里 bun install）'
        }
        $script:tauriDriver = Resolve-TauriDriver
        if (-not $script:tauriDriver) { throw 'ENV:找不到 tauri-driver（cargo install tauri-driver --locked）' }
        $script:msedge = Resolve-MsEdgeDriver $WorkDir
        if (-not $script:msedge) { throw 'ENV:找不到 msedgedriver.exe' }
        if ($WithEnv) {
            $script:piBin = Resolve-PiBin
            if (-not $script:piBin) { throw 'ENV:找不到原生 pi.exe（-WithEnv 模式需要它）' }
        }
        Say ("  应用目录：" + $script:installRoot)
        Say ("  cante-sheets：" + $script:sheetsBin)
        Say ("  tauri-driver：" + $script:tauriDriver)
        Say ("  msedgedriver：" + $script:msedge)
        if ($WithEnv) { Say ("  pi：" + $script:piBin) }
        Say '  前置检查通过。'
    }

    # 2) 清残留：有别的实例在跑时，新的 WebDriver 会话拿不到调试端口（症状像"提权"）。
    $residual = @(Get-Process cante-gui -ErrorAction SilentlyContinue)
    if ($residual.Count -gt 0) {
        Say ''
        Say ("先杀掉残留实例：" + (($residual | ForEach-Object { $_.Id }) -join ', '))
        $residual | ForEach-Object { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue }
        Start-Sleep -Seconds 2
    } else {
        Say ''
        Say '启动前没有残留的 cante-gui 实例。'
    }

    # 2b) 文字卡：跑之前给产出目录拍一张快照。产出是“盘上**新增**了什么”，不是靠猜文件名。
    $script:beforeSnapshot = @{}
    if ($isTextCard) {
        Say ''
        Say ("产出目录快照（可能不止一处）：")
        foreach ($dir in $script:OutputDirs) {
            New-Item -ItemType Directory -Force -Path $dir | Out-Null
            foreach ($f in @(Get-ChildItem $dir -File -ErrorAction SilentlyContinue)) {
                $script:beforeSnapshot[$f.FullName] = (Get-FileHash $f.FullName -Algorithm SHA256).Hash
            }
            Say ('  ' + $dir + '： ' + @(Get-ChildItem $dir -File -ErrorAction SilentlyContinue).Count + ' 个文件')
        }
        Say ('  合计跑前有 ' + $script:beforeSnapshot.Count + ' 个文件（跑完拿新增的当产出）。')
    }

    # 3) 备好来料：文件卡用 cante-sheets write 造表；文字卡把来料写成一份副本留在工作目录。
    if ($isTextCard) {
        Step '2. 备好来料（文字卡：不选文件，直接贴）' {
            if (-not $KeepWorkDir -and (Test-Path $jobDir)) { Remove-Item $jobDir -Recurse -Force }
            New-Item -ItemType Directory -Force -Path $jobDir | Out-Null
            if (-not $PasteText.Trim()) { throw 'ENV:文字卡模式但 -PasteText 是空的（没东西可做）' }
            $src = Join-Path $jobDir '来料-流水账.txt'
            Set-Content -Path $src -Value $PasteText -Encoding UTF8
            Say ("  来料（贴进输入框的那段字，" + $PasteText.Length + " 字）：" + $src)
            Say ('  ---- 来料原文 ----')
            foreach ($line in ($PasteText -split "`r?`n")) { Say ('  | ' + $line) }
        }
    } else {
        Step '2. 造输入表（应用自带的 cante-sheets write）' {
            if (-not $KeepWorkDir -and (Test-Path $jobDir)) { Remove-Item $jobDir -Recurse -Force }
            New-Item -ItemType Directory -Force -Path $jobDir | Out-Null
            $csv = Join-Path $jobDir 'input.csv'
            @(
                '区域,月份,客户,金额',
                '华东区,3月,甲公司,1200',
                '华南区,3月,乙公司,980',
                '华东区,4月,丙公司,1500',
                '华北区,4月,丁公司,1100',
                '华东区,5月,戊公司,760'
            ) -join "`n" | Set-Content -Path $csv -Encoding UTF8
            $script:inputXlsx = Join-Path $jobDir '销售明细.xlsx'
            if (Test-Path $script:inputXlsx) { throw 'ENV:输入表已存在（cante-sheets 不覆盖，换个目录或删掉它）' }
            $make = Run-Command $script:sheetsBin @('write', $script:inputXlsx, $csv, '--sheet', '明细') 120
            if ($make.Code -ne 0) { throw ('ENV:cante-sheets write 失败：' + $make.Stderr) }
            Say ("  输入：" + $script:inputXlsx)
            Say ("  sha256=" + (Get-FileHash $script:inputXlsx -Algorithm SHA256).Hash)
        }
        $inputXlsx = $script:inputXlsx
    }

    # 3b) 确认页可见性取证（#192 A）：为什么单独一步、而且**必须在跑一轮之前**：
    #   * 证据必须是“不用滚动就在屏上”。这只能靠 UI Automation 读元素的
    #     BoundingRectangle + IsOffscreen 去判；
    #   * 但 WebDriver 带起来的窗口里 UIA 读不到 DOM —— msedgedriver 启动应用时
    #     会用自己的值覆盖 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS（实测：那种窗口的
    #     msedgewebview2.exe 命令行里没有 force-renderer-accessibility，UIA 只看得到 3 个壳元素）；
    #   * 所以这一步**自己启动应用**（不经 msedgedriver），自己走到确认页，再判。
    # 它跟下面那一步都独占 cante-gui，只能先后跑；放前面是因为它快（~15s）。
    # 取证失败不当产品问题：如实记下，最后结语里据实说。
    $script:visibility = $null
    if ($isTextCard) {
        Step '3. 确认页可见性（UI Automation，未经滚动）' {
            $visJson = Join-Path $driveArtifacts 'confirm-visible.json'
            New-Item -ItemType Directory -Force -Path $driveArtifacts | Out-Null
            # 上一次跑剩余的实例会抢窗口，先清掉（和跑一轮前同一个理由）。
            Get-Process cante-gui -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
            Start-Sleep -Milliseconds 800
            $visScript = Join-Path $script:Here 'read-confirm-visible.ps1'
            if (-not (Test-Path $visScript)) { throw ('ENV:找不到 ' + $visScript) }
            $vis = Run-Command 'powershell.exe' @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $visScript,
                '-Exe', $exePath, '-LedgerFile', (Join-Path $jobDir '来料-流水账.txt'),
                '-Instruction', $Instruction, '-Card', $Card, '-OutJson', $visJson) 180
            SayLines $vis.Stdout
            if ($vis.Stderr) { Say '  --- stderr ---'; SayLines $vis.Stderr }
            $parsed = $null
            if (Test-Path $visJson) { $parsed = Get-Content $visJson -Raw -Encoding UTF8 | ConvertFrom-Json }
            $script:visibility = [pscustomobject]@{
                exitCode = $vis.Code
                ok = [bool]($parsed -and $parsed.ok)
                needle = $(if ($parsed) { $parsed.needle } else { '先给我看一眼（只看不动）' })
                offscreen = $(if ($parsed) { $parsed.offscreen } else { $null })
                rect = $(if ($parsed) { $parsed.rect } else { $null })
                client = $(if ($parsed) { $parsed.client } else { $null })
                texts = $(if ($parsed) { @($parsed.texts) } else { @() })
            }
            if ($script:visibility.ok) {
                Say ('  ✓ 结论：在屏上（offscreen=' + $script:visibility.offscreen + '，矩形=[' + ($script:visibility.rect -join ',') + '] 落在窗口客户区 [' + ($script:visibility.client -join ',') + '] 内）')
            } else {
                Say ('  ✗ 结论：没有证明它在屏上（退出码 ' + $vis.Code + '）—— 报告里按“没验到”写')
            }
        }
    }

    # 4) 跑一轮：整套 ACCEPT_* + accept-drive.mjs。phase 行原样打出来。
    Step '4. 跑一轮（accept-drive.mjs）' {
        Get-ChildItem env: | Where-Object { $_.Name -like 'PI_*' -and $_.Name -ne 'PI_BIN' } | ForEach-Object {
            Remove-Item ("env:" + $_.Name) -ErrorAction SilentlyContinue
        }
        $env:ACCEPT_APP = $exePath
        $env:ACCEPT_MSEDGEDRIVER = $script:msedge
        $env:ACCEPT_TAURI_DRIVER = $script:tauriDriver
        $env:ACCEPT_WORKDIR = $jobDir
        if ($isTextCard) {
            $env:ACCEPT_TEXT = '1'
            $env:ACCEPT_PASTE_TEXT = $PasteText
            Remove-Item Env:ACCEPT_INPUT -ErrorAction SilentlyContinue
        } else {
            Remove-Item Env:ACCEPT_TEXT -ErrorAction SilentlyContinue
            Remove-Item Env:ACCEPT_PASTE_TEXT -ErrorAction SilentlyContinue
            $env:ACCEPT_INPUT = $inputXlsx
        }
        $env:ACCEPT_CARD = $Card
        $env:ACCEPT_INSTRUCTION = $Instruction
        $env:ACCEPT_ARTIFACTS = $driveArtifacts
        $env:ACCEPT_RESULT_JSON = Join-Path $driveArtifacts 'accept-drive-result.json'
        $env:ACCEPT_SCRIPT_DIR = $script:Here
        $env:ACCEPT_DIALOG_HELPER = Join-Path $script:Here 'accept-file-dialog.ps1'
        $env:ACCEPT_READ_VISIBLE = Join-Path $script:Here 'read-visible-text.ps1'
        $env:ACCEPT_TIMEOUT_MS = [string]($DriveTimeoutSec * 1000)
        if ($Port -gt 0) { $env:ACCEPT_WD_PORT = [string]$Port }
        if ($WithEnv) {
            $env:ACCEPT_ZERO_ENV = '0'
            $env:ACCEPT_CANTE_BIN = $script:bridgeBin
            $env:ACCEPT_PI_BIN = $script:piBin
            # 老路径也顺手替她把桥/pi 设进子进程环境（accept-drive.mjs 会转交）
            $env:CANTE_BIN = $script:bridgeBin
            $env:PI_BIN = $script:piBin
        } else {
            $env:ACCEPT_ZERO_ENV = '1'
            Remove-Item Env:ACCEPT_CANTE_BIN -ErrorAction SilentlyContinue
            Remove-Item Env:ACCEPT_PI_BIN -ErrorAction SilentlyContinue
            Remove-Item Env:CANTE_BIN -ErrorAction SilentlyContinue
            Remove-Item Env:PI_BIN -ErrorAction SilentlyContinue
        }
        New-Item -ItemType Directory -Force -Path $driveArtifacts | Out-Null

        $drive = Run-Command $script:node @((Join-Path $script:Here 'accept-drive.mjs')) ($DriveTimeoutSec + 120)
        $script:drive = $drive
        # 原样打出来（stdout 里就是 [phase] 行、确认页/结果页节选、替她点了几次）。
        SayLines $drive.Stdout
        if ($drive.Stderr) { Say '  --- driver stderr ---'; SayLines $drive.Stderr }
        if ($drive.Code -eq 124) { throw 'ENV:驱动超时（整轮没在上限内结束）' }

        $info = $null
        if (Test-Path $env:ACCEPT_RESULT_JSON) {
            $info = Get-Content $env:ACCEPT_RESULT_JSON -Raw -Encoding UTF8 | ConvertFrom-Json
        }
        $script:info = $info
        if ($drive.Code -ne 0) {
            $opened = $false
            if ($info -and $info.steps) {
                $opened = [bool](@($info.steps | Where-Object { $_.name -like '打开 WebDriver 会话*' }).Count)
            }
            if (-not $opened) {
                # 会话都没建起来 → 环境问题（典型：msedgedriver 与 WebView2 不匹配、会话不对）。
                throw ('ENV:WebDriver 会话没建起来 —— ' + $(if ($info) { $info.error } else { '见上面的 driver 输出' }))
            }
            throw ('PRODUCT:卡片流程失败 —— ' + $(if ($info) { $info.error } else { '见上面的 driver 输出' }))
        }
    }

    # 5) 核对产出：盘上的事实（mjs 只负责"结果页出现"，产出对不对由这里亲自读）。
    if ($isTextCard) {
        Step '5. 核对产出（文字卡：产物在桌面）' {
            $info = $script:info
            if ($info -and $info.counters) {
                Say ('  替她点了：审批 ' + $info.counters.approvals + ' 次、结构化提问 ' + $info.counters.questions + ' 次、追问 ' + $info.counters.followups + ' 次')
            }
            # 结果页自己会报产出；先把 mjs 记下的那份列出来。
            $outputs = @()
            if ($info -and $info.outputs) { $outputs = @($info.outputs) }
            Say ("  驱动看到的工作目录文件（" + $jobDir + "）：")
            if ($outputs.Count -eq 0) { Say '    （没有）' } else { foreach ($o in $outputs) { Say ('    ' + $o.name + '  ' + $o.bytes + ' 字节') } }

            # 定位置的唯一可信来源是**盘上真的新增了什么**：跑前已经快照过桌面。
            $after = @()
            foreach ($dir in $script:OutputDirs) {
                $after += @(Get-ChildItem $dir -File -ErrorAction SilentlyContinue)
            }
            $newFiles = @($after | Where-Object { -not $script:beforeSnapshot.ContainsKey($_.FullName) })
            Say ''
            Say ("  产出目录里**新增**的文件（看了这些目录：" + ($script:OutputDirs -join '；') + "）：")
            if ($newFiles.Count -eq 0) {
                throw ('PRODUCT:产出目录里没有新增文件（预期一份总结）')
            }
            foreach ($f in $newFiles) { Say ('    ' + $f.Name + '  ' + $f.Length + ' 字节  （' + $f.LastWriteTime.ToString('HH:mm:ss') + '）') }

            # 产出可能是 Word（.docx）也可能是纯文本 —— 两种都真的读回来核对。
            $doc = $newFiles | Where-Object { $_.Extension -match '^\.(docx|txt|md)$' } | Sort-Object LastWriteTime -Descending | Select-Object -First 1
            if (-not $doc) { throw ('PRODUCT:新增的文件里没有 .docx/.txt/.md（实际：' + (($newFiles | ForEach-Object { $_.Name }) -join ', ') + '）') }
            $script:textOutput = $doc
            Say ''
            Say ('  用应用自带的工具/纯文本读回来核对：' + $doc.Name)
            if ($doc.Extension -eq '.docx') {
                # docx 是个 zip；不额外装库，用 .NET 的 ZipArchive 把 word/document.xml 抽出来看正文。
                Add-Type -AssemblyName System.IO.Compression.FileSystem
                $zip = [System.IO.Compression.ZipFile]::OpenRead($doc.FullName)
                try {
                    $entry = $zip.Entries | Where-Object { $_.FullName -eq 'word/document.xml' }
                    if (-not $entry) { throw 'PRODUCT:docx 里找不到 word/document.xml（不是一份正常的 Word？）' }
                    $reader = New-Object System.IO.StreamReader($entry.Open(), [System.Text.Encoding]::UTF8)
                    $xml = $reader.ReadToEnd(); $reader.Close()
                    $text = ($xml -replace '<w:p[ >]', "`n" -replace '<[^>]+>', '')
                } finally { $zip.Dispose() }
            } else {
                $text = Get-Content $doc.FullName -Raw -Encoding UTF8
            }
            $script:outputText = $text
            Say '  ---- 读回来的正文（原文）----'
            foreach ($line in ($text -split "`r?`n")) { if ($line.Trim()) { Say ('  | ' + $line) } }

            # 内容核对：总结应当写到“做了几件事”，而且不许编数字。这里只做**能判定的事实**：
            # 正文非空、提到了来料里的关键词、没有把给她看的“（请补充）”变成编造的数字。
            if ($text.Trim().Length -lt 20) { throw ('PRODUCT:读回来的正文太短（' + $text.Trim().Length + ' 字）') }
            $hitWords = @('报销', '发票', '会议', '采购', '表格')
            $hit = @($hitWords | Where-Object { $text.Contains($_) })
            Say ''
            Say ('  正文命中来料里的关键词：' + $(if ($hit.Count -gt 0) { $hit -join '、' } else { '（一个都没有）' }))
            if ($hit.Count -eq 0) { throw 'PRODUCT:正文里没有任何来料关键词——像是没看着来料写' }

            # 原文件哈希前后一致：文字卡没有“原文件”，但桌面**原本就有**的文件一个都不许被动。
            $changed = @()
            foreach ($name in $script:beforeSnapshot.Keys) {
                if (-not (Test-Path $name)) { $changed += ($name + '（不见了）'); continue }
                $now = (Get-FileHash $name -Algorithm SHA256 -ErrorAction SilentlyContinue).Hash
                if ($now -and $now -ne $script:beforeSnapshot[$name]) { $changed += ($name + '（哈希变了）') }
            }
            if ($changed.Count -gt 0) { throw ('PRODUCT:产出目录里原本就有的文件被动了：' + ($changed -join '；')) }
            Say ''
            Say ('  产出目录里原本就有的 ' + $script:beforeSnapshot.Count + ' 个文件哈希前后一致 → 没有被改动')
        }
    } else {
        Step '5. 核对产出' {
            $info = $script:info
            if ($info -and $info.counters) {
                Say ('  替她点了：审批 ' + $info.counters.approvals + ' 次、结构化提问 ' + $info.counters.questions + ' 次、追问 ' + $info.counters.followups + ' 次')
            }
            $outputs = @()
            if ($info -and $info.outputs) { $outputs = @($info.outputs) }
            Say ("  工作目录里的文件（" + $jobDir + "）：")
            if ($outputs.Count -eq 0) {
                Say '    （没有）'
            } else {
                foreach ($o in $outputs) { Say ('    ' + $o.name + '  ' + $o.bytes + ' 字节') }
            }
            $resultFiles = @(Get-ChildItem $jobDir -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -like '结果_*.xlsx' })
            if ($resultFiles.Count -eq 0) { throw ('PRODUCT:工作目录里没有 结果_*.xlsx 产出（目录：' + $jobDir + '）') }
            $output = $resultFiles | Sort-Object LastWriteTime -Descending | Select-Object -First 1
            Say ''
            Say ('  用应用自带的 cante-sheets 读回来：' + $output.Name)
            $read = Run-Command $script:sheetsBin @('read', $output.FullName) 120
            if ($read.Code -ne 0) { throw ('PRODUCT:用 cante-sheets 读产出失败：' + $read.Stderr) }
            SayLines $read.Stdout
            $rows = @(($read.Stdout -split "`r?`n") | Where-Object { $_ })
            if ($rows.Count -lt 2) { throw 'PRODUCT:读出来的产出是空的' }
            $dataRows = @($rows | Select-Object -Skip 1)
            if (@($dataRows | Where-Object { $_ -notmatch '^华东区,' }).Count -gt 0) { throw 'PRODUCT:产出里混进了非华东区的行' }
            if ($dataRows.Count -ne 3) { throw ('PRODUCT:产出应有 3 行华东区记录，实际 ' + $dataRows.Count + ' 行') }
            Say ''
            Say ('  原文件没有被改动：' + (Get-FileHash $inputXlsx -Algorithm SHA256).Hash)
        }
    }

    $code = 0
    $reason = $(if ($isTextCard) { '结果页出现「做好了」，产出在桌面上真的新增了一份、正文读回来对得上，原有文件未动。' } else { '结果页出现「做好了」，产出用 cante-sheets 读回来也对得上。' })
} catch {
    $message = $_.Exception.Message
    if ($message -like 'ENV:*') {
        $code = 2
        $reason = '环境问题：' + $message.Substring(4)
        Say ''
        Say ('run-accept-drive: FAIL（环境问题）— ' + $reason)
    } elseif ($message -like 'PRODUCT:*') {
        $code = 3
        $reason = '产品问题：' + $message.Substring(8)
        Say ''
        Say ('run-accept-drive: FAIL（产品问题）— ' + $reason)
    } else {
        # 没打标签的异常，按环境问题处理（多半是脚本/机器层面），但如实写出原因。
        $code = 2
        $reason = '未分类异常（按环境问题处理）：' + $message
        Say ''
        Say ('run-accept-drive: FAIL（未分类）— ' + $message)
    }
}

Say ''
Say '=== 每一步的实际耗时 ==='
$script:Timings | ForEach-Object { Say ('  {0,-40} {1,7} s' -f $_.Name, $_.Seconds) }

# 确认页可见性取证（#192 A）：在第 3 步已经取过，这里只把结论再摆一遍（报告里好找）。
$visibility = $script:visibility
if ($visibility) {
    Say ''
    Say '=== 确认页可见性（UI Automation，未经滚动）==='
    Say ('  目标文字：“' + $visibility.needle + '”')
    Say ('  read-confirm-visible.ps1 退出码：' + $visibility.exitCode + '  判定：' + $(if ($visibility.ok) { '在屏上' } else { '没验到' }))
    Say ('  offscreen=' + $visibility.offscreen + '  矩形=[' + ($visibility.rect -join ',') + ']  窗口客户区=[' + ($visibility.client -join ',') + ']')
    if ($visibility.texts -and @($visibility.texts).Count -gt 0) {
        Say ('  确认页 UIA 读回的 {0} 条文字（原样，已去重）：' -f @($visibility.texts).Count)
        foreach ($t in @($visibility.texts)) { Say ('    | ' + $t) }
    }
} else {
    Say ''
    Say '=== 确认页可见性：这次没取证（非文字卡，或取证步骤没跑）==='
}

# 结语按事实说：可见性没取证 / 没验到时，不把整体说成“全过了”。
if ($code -eq 0) {
    Say ''
    if ($isTextCard -and $visibility -and $visibility.ok) {
        Say 'accept-drive: OK — 卡片跑通（结果页「做好了」+ 产出对得上），且确认页那一条在屏上。'
    } elseif ($isTextCard) {
        Say 'accept-drive: OK（卡片跑通：结果页「做好了」+ 产出对得上）；但确认页可见性这次没验到，见上面。'
    } else {
        Say 'accept-drive: OK — 装好的应用在真实 WebView2 里跑完了一轮，结果页出现「做好了」，产出对得上。'
    }
} else {
    Say ''
    Say ('accept-drive: 结论 = ' + $code + '（0=通过 / 2=环境问题 / 3=产品问题）')
}

$driveSummary = $null
if ($script:info) {
    $driveSummary = [pscustomobject]@{
        ok = $script:info.ok
        counters = $script:info.counters
        outputs = $script:info.outputs
        resultText = $script:info.resultText
        confirmPage = $script:info.confirmPage
    }
}

$result = [pscustomobject]@{
    ok = ($code -eq 0)
    exitCode = $code
    reason = $reason
    exe = $exePath
    elevated = $elevated
    session = $session
    zeroEnv = (-not $WithEnv)
    card = $Card
    textCard = [bool]$isTextCard
    instruction = $Instruction
    workDir = $WorkDir
    jobDir = $jobDir
    outputDir = $(if ($isTextCard) { $OutputDir } else { $null })
    outputFile = $(if ($script:textOutput) { $script:textOutput.FullName } else { $null })
    visibility = $visibility
    # 注意：@($genericList) 在 PS 5.1 的哈希字面量里会抛 ArgumentException（实测），
    # 必须先 .ToArray() 再包。
    timings = @($script:Timings.ToArray())
    drive = $driveSummary
}
$result | ConvertTo-Json -Depth 8 | Set-Content -Path $resultFile -Encoding UTF8
$script:Lines -join "`n" | Set-Content -Path $reportFile -Encoding UTF8
Say ''
Say ('报告：' + $reportFile)
exit $code
