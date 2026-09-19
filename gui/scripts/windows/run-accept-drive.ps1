# 「跑一轮真机验收」的一行入口（Windows 真机）：装好的应用 + 零环境变量 → 点一张卡 →
# 真的出一份文件。
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File gui\scripts\windows\run-accept-drive.ps1
#
# 它把 accept-install.ps1 的第 3~4 步（起窗口 + 驱动跑一轮 + 核对产出）单独拿出来跑，
# **不装、不卸** —— 适合"应用已经装好，我只想再跑一轮"。它自己负责四件事：
#   1. **判断会话**：不提权的交互会话就地跑；提权 / session 0 自动改走「当前用户 +
#      Interactive + RunLevel Limited』的计划任务（和 accept-first-screen.ps1 同一套做法，
#      这里**不另起**第二套 —— 那正是 AGENTS.md §3.6 说的"别自己发明"）；
#   2. **清残留**：跑前杀掉残留的 cante-gui（残留实例会让 WebDriver 拿不到调试端口，
#      症状和"提权"一模一样，DEV 文档记过）；
#   3. **造输入表**：用应用自带的 cante-sheets write（连输入都是产品自己的工具产出的；
#      它不覆盖已存在文件，所以每次都建在一个新的运行目录里）；
#   4. **设好整套 ACCEPT_\***（默认零环境变量模式 ACCEPT_ZERO_ENV=1）→ 跑 accept-drive.mjs →
#      把它的 phase 行与结果**原样**打出来，再用 cante-sheets 把产出读回来核对。
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
#   ... -WithEnv                               # 老路径：脚本替她设 CANTE_BIN / PI_BIN（对照用）
#   ... -WorkDir "D:\accept-01"                # 换个运行目录（默认 %TEMP%\cante-accept-drive-<时间戳>）
#   ... -TimeoutSec 2400                       # 整轮上限（默认 2100s，AGENTS.md §5：单卡别低于 1800s）
#
# 产物（默认在工作目录里）：
#   report.txt                     人看的报告（phase 行 + 结果页文字 + 产物清单，原文）
#   job\                           工作目录（输入表 + 产出）
#   job\drive-artifacts\           accept-drive.mjs 的截图 / 结果页文字 / accept-drive-result.json
#   result.json                    结构化结果（给脚本/CI 用）
#
# 注意：本文件必须保存为 UTF-8 with BOM（Windows PowerShell 5.1 否则按 GBK 解析，中文会乱码）。

param(
    [string]$Exe = "",
    [string]$Card = "从大表里挑出想要的行",
    [string]$Instruction = "把华东区的记录挑出来，另存成一张新表",
    [string]$WorkDir = "",
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
    $inner = @(
        '-NoProfile', '-ExecutionPolicy', 'Bypass',
        '-File', ('"' + $PSCommandPath + '"'),
        '-Child',
        '-Card', ('"' + $Card + '"'),
        '-Instruction', ('"' + $Instruction + '"'),
        '-WorkDir', ('"' + $WorkDir + '"'),
        '-TimeoutSec', $innerTimeout.ToString(),
        '-DriveTimeoutSec', $DriveTimeoutSec.ToString()
    )
    if ($Exe) { $inner += @('-Exe', ('"' + $Exe + '"')) }
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

    # 3) 造输入表：用应用自带的 cante-sheets write（它不覆盖已存在文件，所以目录总是新的）。
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

    # 4) 跑一轮：整套 ACCEPT_* + accept-drive.mjs。phase 行原样打出来。
    Step '3. 跑一轮（accept-drive.mjs）' {
        Get-ChildItem env: | Where-Object { $_.Name -like 'PI_*' -and $_.Name -ne 'PI_BIN' } | ForEach-Object {
            Remove-Item ("env:" + $_.Name) -ErrorAction SilentlyContinue
        }
        $env:ACCEPT_APP = $exePath
        $env:ACCEPT_MSEDGEDRIVER = $script:msedge
        $env:ACCEPT_TAURI_DRIVER = $script:tauriDriver
        $env:ACCEPT_WORKDIR = $jobDir
        $env:ACCEPT_INPUT = $inputXlsx
        $env:ACCEPT_CARD = $Card
        $env:ACCEPT_INSTRUCTION = $Instruction
        $env:ACCEPT_ARTIFACTS = $driveArtifacts
        $env:ACCEPT_RESULT_JSON = Join-Path $driveArtifacts 'accept-drive-result.json'
        $env:ACCEPT_SCRIPT_DIR = $script:Here
        $env:ACCEPT_DIALOG_HELPER = Join-Path $script:Here 'accept-file-dialog.ps1'
        $env:ACCEPT_TIMEOUT_MS = [string]($DriveTimeoutSec * 1000)
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

    # 5) 核对产出：盘上的事实（mjs 只负责"结果页出现"，产出对不对由这里问 cante-sheets）。
    Step '4. 核对产出' {
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

    $code = 0
    $reason = '结果页出现「做好了」，产出用 cante-sheets 读回来也对得上。'
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

if ($code -eq 0) {
    Say ''
    Say ('accept-drive: OK — 装好的应用在真实 WebView2 里跑完了一轮，结果页出现「做好了」，产出对得上。')
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
    instruction = $Instruction
    workDir = $WorkDir
    jobDir = $jobDir
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
