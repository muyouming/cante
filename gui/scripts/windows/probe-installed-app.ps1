# 启动装好的 Cante，记录它到底做了什么（进程、子进程、窗口、写出的文件、事件日志）。
#
# 注意：本文件必须保存为 UTF-8 with BOM（Windows PowerShell 5.1 否则按 GBK 解析，
# 中文会变乱码并报语法错）。
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File probe-installed-app.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File probe-installed-app.ps1 -WaitSeconds 25 -KeepRunning
#
# 对应用户文档：gui/WINDOWS-ACCEPTANCE-1.md 的「启动行为」一节。
# 局限（脚本自己在结尾也会再打一遍）：SSH 会话没有交互桌面，脚本只能读进程/日志/文件，
# 截不到真实画面 —— 那一步必须在 RDP 里人工做。

param(
    [string]$Exe = "$env:LOCALAPPDATA\Cante\cante-gui.exe",
    [int]$WaitSeconds = 20,
    [string]$WorkDir = "$env:TEMP\cante-acc-probe",
    [switch]$KeepRunning
)

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Section($title) { Write-Output ''; Write-Output ("=== " + $title + " ===") }

if (Test-Path $WorkDir) { Remove-Item $WorkDir -Recurse -Force }
New-Item -ItemType Directory -Path $WorkDir | Out-Null

$watchDirs = @(
    "$env:USERPROFILE\.cante",
    "$env:USERPROFILE\.ante",
    "$env:LOCALAPPDATA\Cante",
    "$env:LOCALAPPDATA\dev.cante.gui",
    "$env:LOCALAPPDATA\Temp",
    "$env:APPDATA\Cante"
)

function Snapshot($paths) {
    $set = @{}
    foreach ($p in $paths) {
        if (Test-Path $p) {
            Get-ChildItem $p -Recurse -File -Force -ErrorAction SilentlyContinue |
                ForEach-Object { $set[$_.FullName] = $_.Length }
        }
    }
    return $set
}

Section '启动前'
Write-Output ("目标程序：" + $Exe)
Write-Output ("存在：" + (Test-Path $Exe))
Write-Output '相关进程（启动前）：'
$existing = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match 'cante|ante' }
if ($existing) { $existing | Select-Object Id, ProcessName, StartTime | Format-Table -AutoSize } else { Write-Output '  无' }

$beforeFiles = Snapshot $watchDirs
$logStart = Get-Date
Write-Output ("事件日志起点：" + $logStart.ToString('s'))

Section '启动'
$exePath = (Resolve-Path $Exe).Path
$outLog = Join-Path $WorkDir 'app-stdout.txt'
$errLog = Join-Path $WorkDir 'app-stderr.txt'
$proc = Start-Process -FilePath $exePath -PassThru -RedirectStandardOutput $outLog -RedirectStandardError $errLog
Write-Output ("PID = " + $proc.Id)
Write-Output ("启动时刻 = " + (Get-Date).ToString('s'))

# 每 200ms 采样一次，避免漏掉活得很短的子进程（例如去找 cante）。
$seenProcesses = @{}
$deadline = (Get-Date).AddSeconds($WaitSeconds)
while ((Get-Date) -lt $deadline) {
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object { $_.ParentProcessId -eq $proc.Id -or $_.Name -match '^(cante|ante)' } |
        ForEach-Object {
            $seenProcesses[$_.ProcessId] = ("{0} | pid={1} | ppid={2} | cmd={3}" -f $_.Name, $_.ProcessId, $_.ParentProcessId, $_.CommandLine)
        }
    Start-Sleep -Milliseconds 200
}

Section ("" + $WaitSeconds + " 秒后的状态")
$proc.Refresh()
Write-Output ("HasExited    = " + $proc.HasExited)
if ($proc.HasExited) {
    Write-Output ("ExitCode     = " + $proc.ExitCode)
} else {
    Write-Output ("MainWindowHandle = " + $proc.MainWindowHandle)
    Write-Output ("MainWindowTitle  = '" + $proc.MainWindowTitle + "'")
    Write-Output ("Responding       = " + $proc.Responding)
    Write-Output ("WorkingSetMB     = " + [math]::Round($proc.WorkingSet64 / 1MB, 1))
    $top = Get-CimInstance Win32_Process -Filter ("ProcessId = " + $proc.Id)
    Write-Output ("ParentProcessId  = " + $top.ParentProcessId)
    Write-Output ("ProcessName      = " + $top.Name)
}

Section '期间出现过的相关进程（含 cante / ante 子进程）'
if ($seenProcesses.Count -eq 0) {
    Write-Output '  一个都没有：它没有去拉起任何 cante / ante 进程。'
} else {
    $seenProcesses.Values | Sort-Object | ForEach-Object { Write-Output ('  ' + $_) }
}
Write-Output '启动后当前仍存在的相关进程：'
$now = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match 'cante|ante' }
if ($now) { $now | Select-Object Id, ProcessName | Format-Table -AutoSize } else { Write-Output '  无' }

Section '它写出来的文件 / 配置目录'
$afterFiles = Snapshot $watchDirs
$newFiles = @()
foreach ($k in $afterFiles.Keys) { if (-not $beforeFiles.ContainsKey($k)) { $newFiles += $k } }
if ($newFiles.Count -eq 0) {
    Write-Output '  没有新增文件。'
} else {
    $newFiles | Sort-Object | ForEach-Object {
        $rel = $_ -replace [regex]::Escape($env:LOCALAPPDATA), '%LOCALAPPDATA%'
        $rel = $rel -replace [regex]::Escape($env:USERPROFILE), '%USERPROFILE%'
        Write-Output ("  " + $rel + "  (" + $afterFiles[$_] + " bytes)")
    }
}
foreach ($p in @("$env:USERPROFILE\.cante", "$env:USERPROFILE\.ante", "$env:APPDATA\Cante", "$env:LOCALAPPDATA\Cante", "$env:LOCALAPPDATA\dev.cante.gui")) {
    Write-Output ("{0} 存在={1}" -f $p, (Test-Path $p))
}

Section '进程自己写的 stdout / stderr'
foreach ($f in @($outLog, $errLog)) {
    $size = if (Test-Path $f) { (Get-Item $f).Length } else { 'n/a' }
    Write-Output ("--- " + (Split-Path $f -Leaf) + " (" + $size + " bytes) ---")
    if (Test-Path $f) {
        $txt = (Get-Content $f -Raw -ErrorAction SilentlyContinue)
        if ([string]::IsNullOrWhiteSpace($txt)) { Write-Output '  <空>' } else { Write-Output $txt }
    } else { Write-Output '  <文件不存在>' }
}

Section '应用程序事件日志（启动之后、跟它有关的）'
$appEvents = Get-WinEvent -FilterHashtable @{ LogName = 'Application'; StartTime = $logStart } -ErrorAction SilentlyContinue |
    Select-Object -First 30
if ($appEvents) {
    $appEvents | Select-Object TimeCreated, Id, LevelDisplayName, ProviderName, @{n='Message';e={ ($_.Message -split "`n")[0] }} |
        Format-Table -AutoSize -Wrap
} else {
    Write-Output '  启动之后 Application 日志里一条新事件都没有。'
}

Section 'Defender / SmartScreen / AppLocker 相关记录'
foreach ($log in @('Microsoft-Windows-Windows Defender/Operational',
                   'Microsoft-Windows-AppLocker/EXE and DLL',
                   'Microsoft-Windows-AppLocker/MSI and Script',
                   'Microsoft-Windows-SmartScreen/Debug',
                   'Microsoft-Windows-SmartScreen/Operational')) {
    Write-Output ("--- " + $log + " ---")
    # 这台 Windows Home 上有些通道不存在，或者不支持按时间过滤（Get-WinEvent 会报
    # “The parameter is incorrect”）。不存在就是不存在，如实打出来，不要用 try 吃掉。
    $exists = $null -ne (Get-WinEvent -ListLog $log -ErrorAction SilentlyContinue)
    if (-not $exists) { Write-Output '  该日志通道在这台机器上不存在。'; continue }
    try {
        $ev = Get-WinEvent -FilterHashtable @{ LogName = $log; StartTime = $logStart } -ErrorAction Stop | Select-Object -First 10
        if ($ev) {
            $ev | Select-Object TimeCreated, Id, LevelDisplayName, @{n='Message';e={ ($_.Message -split "`n")[0] }} | Format-Table -AutoSize -Wrap
        } else {
            Write-Output '  通道存在，启动之后没有新事件。'
        }
    } catch {
        Write-Output ('  读日志失败：' + $_.Exception.Message)
    }
}
Write-Output 'Defender 威胁记录（Get-MpThreatDetection）：'
$threats = Get-MpThreatDetection -ErrorAction SilentlyContinue
if ($threats) { $threats | Select-Object -Last 5 | Format-List } else { Write-Output '  无' }

Section '收尾'
if (-not $proc.HasExited) {
    if ($KeepRunning) {
        Write-Output ("-KeepRunning：进程 " + $proc.Id + " 留着不杀。")
    } else {
        Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 2
        $proc.Refresh()
        Write-Output ("已停止进程 " + $proc.Id + "，HasExited=" + $proc.HasExited)
    }
}
Write-Output '这一次能验证的到此为止：SSH 会话没有交互桌面，脚本拿不到真实画面。'
Write-Output '要判断「窗口长什么样、字好不好看、有没有闪黑窗」，必须在 RDP 会话里人工看。'
