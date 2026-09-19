# 三种「麻烦路径」各驱动一轮真机验收（#197 第二条）：
#   r1 纯中文目录、r2 带空格的中文目录、r3 桌面（操作系统报告的位置；通常就是 OneDrive 重定向桌面）。
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File gui\scripts\windows\accept-paths.ps1
#
# 它做四件事：
#   1. 造三个目标目录，每轮把 -WorkDir 指过去；
#   2. 每轮调用 run-accept-drive.ps1（#194 那一行命令），把它的原始输出**原样**打出来
#      —— 会话判断 / 清残留 / 造输入表 / 开窗口都复用那一套，这里**不另起**第二套（AGENTS.md §3.6）；
#   3. 每轮**独立**核对：产出真的在盘上、能用应用自带的 cante-sheets 读回内容、
#      原文件 sha256 前后一致（从 run-accept-drive 的 report.txt 取"前/后"两个哈希，
#      再和盘上现算的哈希对）；
#   4. 把结论写进 <BaseDir>\accept-paths-result.json 与 accept-paths-report.txt。
#
# 退出码：0 = 三轮全通过；3 = 有**产品问题**轮次；2 = 有**环境问题**轮次（且无产品问题）；
#         1 = 脚本自身出错。内层 run-accept-drive.ps1 的 0/2/3 原样透传，不自己发明。
#
# 桌面那一轮（r3）取的是**操作系统自己报告的位置** `[Environment]::GetFolderPath('Desktop')`：
#   - 它已经在 OneDrive 下 → 直接用（真正的重定向桌面）；
#   - 它不在 OneDrive 下、但机器上有一处 OneDrive → 默认仍落在 `%OneDrive%\桌面` 这个**同形**路径上
#     （应用拿到的是脚本显式传的路径，不依赖已知文件夹解析，所以路径形状一致）；
#     想让它**真的**被重定向，加 `-RedirectDesktop`：脚本会临时把「桌面」已知文件夹指到
#     `%OneDrive%\桌面`，在**全新进程**与**登录会话**两处都读回确认，跑完**还原并再确认**（见下）。
#   - 机器上连 OneDrive 都没有 → r3 退化为操作系统报告的桌面，并在报告里**如实写"这不构成 OneDrive 证据"**。
#
# 用法：
#   ... -Only r1,r3                 # 只跑其中几轮（r1 / r2 / r3）
#   ... -BaseDir "D:\路径验收"       # 换基目录（默认 %TEMP%\cante-accept-paths-<时间戳>）
#   ... -Exe "C:\...\cante-gui.exe" # 透传给 run-accept-drive.ps1（不查注册表）
#   ... -RoundTimeoutSec 1800 -DriveTimeoutSec 1500
#   ... -RedirectDesktop            # 临时把桌面已知文件夹重定向到 %OneDrive%\桌面（可逆）
#   ... -Cleanup                    # 跑完删掉三个目标目录（默认保留，便于人工复核）
#
# 隐私：本文件所有输出（控制台 / report.txt / result.json）都会把真实用户名收敛成 `<用户名>`
#       （报告里不许出现真实用户名）。
#
# 注意：本文件必须保存为 UTF-8 with BOM（Windows PowerShell 5.1 否则按 GBK 解析中文，直接乱码）。

param(
    [string]$BaseDir = "",
    [string]$Exe = "",
    [int]$RoundTimeoutSec = 1800,
    [int]$DriveTimeoutSec = 1500,
    # 这台验收机可能同时有别的 agent 在驱动窗口（共用桌面/WebDriver 端口会互相撞）。
    # 默认用一个不常见的端口与任务名，避免和别人抢；可用 -WdPort / -InnerTaskName 改。
    [int]$WdPort = 4427,
    [string]$InnerTaskName = 'CanteAcceptPathsDrive',
    [string[]]$Only = @('r1', 'r2', 'r3'),
    [switch]$RedirectDesktop,
    [switch]$Cleanup
)

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$script:Here = $PSScriptRoot
$script:RunScript = Join-Path $script:Here 'run-accept-drive.ps1'
$script:Lines = New-Object System.Collections.Generic.List[string]

# 真实用户名只在报告里写 `<用户名>`（AGENTS.md / 任务硬约束）。
function Redact([string]$text) {
    if ([string]::IsNullOrEmpty($text)) { return $text }
    $out = $text
    if ($env:USERPROFILE) { $out = $out.Replace($env:USERPROFILE, 'C:\Users\<用户名>') }
    if ($env:USERNAME) {
        # 只在"独立成段"时替换：前后若紧挨字母/数字/下划线/点/连字符就不动
        # （这样 cante-gui / cante-sheets / C:\cante-wt 这些产品与目录名不会被误伤）。
        $pattern = '(?<![A-Za-z0-9_.-])' + [regex]::Escape($env:USERNAME) + '(?![A-Za-z0-9_.-])'
        $out = [regex]::Replace($out, $pattern, '<用户名>')
    }
    return $out
}

function Say([string]$text) {
    $safe = Redact $text
    # 用 [Console]::WriteLine 而不是 Write-Output：Write-Output 会把日志行混进函数返回值，
    # 于是 Invoke-Round 的返回值就不再是“那个结果对象”而是“一大堆日志 + 结果对象”
    # （实测：会让 result.json 的 rounds 变成嵌套数组）。日志决不该进管道。
    [Console]::WriteLine($safe)
    [void]$script:Lines.Add($safe)
}
function SayLines([string]$text) {
    if ([string]::IsNullOrEmpty($text)) { return }
    foreach ($line in ($text -split "`r?`n")) { Say $line }
}

# 外部命令统一带超时 + 显式按 UTF-8 读回（照 run-accept-drive.ps1 的 Run-Command，同一套做法）。
function Run-Process([string]$File, [string[]]$Arguments, [int]$TimeoutSec) {
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

# 「已装好的应用在哪」只有一个可信来源：卸载注册表项里的 InstallLocation（照 DEVELOPING-WINDOWS.md）。
function Resolve-InstallDir {
    $entry = Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' -ErrorAction SilentlyContinue |
        Where-Object { $_.GetValue('DisplayName') -like '*Cante*' } | Select-Object -First 1
    if ($entry) {
        $location = $entry.GetValue('InstallLocation')
        if ($location) {
            $trimmed = $location.Trim('"')
            if (Test-Path $trimmed) { return $trimmed }
        }
    }
    $fallback = Join-Path $env:LOCALAPPDATA 'Cante'
    if (Test-Path $fallback) { return $fallback }
    return $null
}

function Get-FirstGroup([string]$text, [string]$pattern) {
    $m = [regex]::Match($text, $pattern)
    if ($m.Success) { return $m.Groups[1].Value.ToUpper() }
    return $null
}

# ---------------------------------------------------------------------------
# 「桌面」已知文件夹：读、临时重定向、还原
# ---------------------------------------------------------------------------

Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class AcceptKf {
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    public static extern int SHSetKnownFolderPath(ref Guid rfid, uint dwFlags, IntPtr hwndOwner, string pszPath);
}
'@
$script:DesktopFolderId = [Guid]'B4BFCC3A-DB2C-424C-B029-7FE99A87C641'

function Get-DesktopFresh {
    # 在**全新进程**里问，避开 [Environment] 的每进程缓存。
    $out = & powershell.exe -NoProfile -Command "[Environment]::GetFolderPath('Desktop')"
    return ($out | Out-String).Trim()
}

function Set-DesktopKnownFolder([string]$Path) {
    $id = $script:DesktopFolderId
    return [AcceptKf]::SHSetKnownFolderPath([ref]$id, 0, [IntPtr]::Zero, $Path)
}

function Get-DesktopInInteractiveSession {
    # 在**登录会话**里问一次（应用就跑在那里）：一次性计划任务 → 把结果写进临时文件。
    $marker = Join-Path $env:TEMP ('cante-desktop-probe-' + [guid]::NewGuid().ToString('N') + '.txt')
    Remove-Item -LiteralPath $marker -Force -ErrorAction SilentlyContinue
    $taskName = 'CanteAcceptDesktopProbe'
    try {
        $argument = "-NoProfile -ExecutionPolicy Bypass -Command `"& { [Environment]::GetFolderPath('Desktop') | Out-File -LiteralPath '$marker' -Encoding UTF8 }`""
        $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $argument
        $principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
        $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Seconds 60)
        Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal -Settings $settings -Force | Out-Null
        schtasks /run /tn $taskName | Out-Null
        $deadline = (Get-Date).AddSeconds(30)
        while ((Get-Date) -lt $deadline -and -not (Test-Path -LiteralPath $marker)) { Start-Sleep -Milliseconds 400 }
        if (Test-Path -LiteralPath $marker) {
            $value = (Get-Content -LiteralPath $marker -Raw -Encoding UTF8).Trim()
            Remove-Item -LiteralPath $marker -Force -ErrorAction SilentlyContinue
            return $value
        }
        return $null
    } catch {
        return $null
    } finally {
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    }
}

# ---------------------------------------------------------------------------
# 准备
# ---------------------------------------------------------------------------

function Get-Contention {
    # 这台机器是共用的：别的 agent 可能也在驱动窗口 / 起 tauri-driver / 占 WebDriver 端口。
    # 把“现在还有谁在跑”记下来 —— 失败时才能分清是路径问题还是环境竞争。
    $marks = @()
    foreach ($name in @('tauri-driver', 'msedgedriver', 'cante-gui')) {
        $n = @(Get-Process $name -ErrorAction SilentlyContinue).Count
        if ($n -gt 0) { $marks += ($name + '×' + $n) }
    }
    $others = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        $c = [string]$_.CommandLine
        ($_.Name -eq 'node.exe') -and ($c -match 'accept-drive\.mjs|drive-offline\.mjs|offline-probe')
    })
    if ($others.Count -gt 0) { $marks += ('别的驱动进程×' + $others.Count) }
    if ($marks.Count -eq 0) { return '没有探测到竞争进程' }
    return ($marks -join '，')
}

$script:Elevated = (New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$script:Session = (Get-Process -Id $PID).SessionId

if (-not (Test-Path $script:RunScript)) {
    Write-Output ('accept-paths: FAIL — 找不到 ' + $script:RunScript)
    exit 1
}
if (-not $BaseDir) {
    $BaseDir = Join-Path $env:TEMP ('cante-accept-paths-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
}
New-Item -ItemType Directory -Force -Path $BaseDir | Out-Null
$reportFile = Join-Path $BaseDir 'accept-paths-report.txt'
$resultFile = Join-Path $BaseDir 'accept-paths-result.json'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

Say '=== 真机验收：中文 / 空格 / 桌面 三种路径各跑一轮（#197 第二条）==='
Say ("会话：elevated=$($script:Elevated) session=$($script:Session)")
Say ("基目录：" + $BaseDir)
Say ("内层脚本：" + $script:RunScript)

$desktopReal = Get-DesktopFresh
$desktopInOneDrive = ($desktopReal -like '*OneDrive*')
$oneDriveRoot = $env:OneDrive
$oneDriveUsable = [bool]($oneDriveRoot -and (Test-Path -LiteralPath $oneDriveRoot))

# 三个基准：r1/r2 落在 **-BaseDir 下**（不往桌面扔东西，除非用户把 BaseDir 指到桌面）。
$splitBase = Join-Path $BaseDir '路径验收'

# --- 可选：临时把「桌面」已知文件夹重定向到 %OneDrive%\桌面（可逆）---
# 必须在算 r3 之前做：这样 r3 用的就是**重定向之后**操作系统真正报告的桌面，证据才不含糊。
$redirectState = [pscustomobject]@{
    requested = [bool]$RedirectDesktop
    attempted = $false
    applied = $false
    original = $desktopReal
    target = $(if ($oneDriveUsable) { Join-Path $oneDriveRoot '桌面' } else { $null })
    hr = $null
    freshAfter = $null
    sessionAfter = $null
    reverted = $false
    freshAfterRevert = $null
    sessionAfterRevert = $null
    error = $null
}

if ($RedirectDesktop -and -not $desktopInOneDrive -and $oneDriveUsable) {
    Say ''
    Say '--- 临时重定向「桌面」已知文件夹（可逆）---'
    $redirectState.attempted = $true
    New-Item -ItemType Directory -Force -Path $redirectState.target | Out-Null
    $redirectState.hr = Set-DesktopKnownFolder $redirectState.target
    $redirectState.freshAfter = Get-DesktopFresh
    $redirectState.applied = ($redirectState.hr -eq 0 -and $redirectState.freshAfter -eq $redirectState.target)
    Say ('  重定向返回码=' + $redirectState.hr + '；全新进程读到的桌面=' + $redirectState.freshAfter)
    Say ('  重定向已生效（全新进程）：' + $redirectState.applied)
    if ($redirectState.applied) {
        $redirectState.sessionAfter = Get-DesktopInInteractiveSession
        Say ('  登录会话里读到的桌面=' + $(if ($redirectState.sessionAfter) { $redirectState.sessionAfter } else { '(没读到：30s 内没写出结果)' }))
    }
}

# r3 的基准 = **现在**操作系统报告的桌面（若刚重定向过，这里就是重定向后的位置）。
$desktopNow = Get-DesktopFresh
if ($desktopNow -like '*OneDrive*') {
    $r3Base = $desktopNow
    if ($redirectState.applied) {
        $r3Kind = '操作系统报告的桌面（脚本刚把它临时重定向到此处；本轮跑时操作系统也是这样报告的）'
    } else {
        $r3Kind = '操作系统报告的桌面（已在 OneDrive 下 → 真正的重定向桌面）'
    }
} elseif ($oneDriveUsable) {
    $r3Base = Join-Path $oneDriveRoot '桌面'
    $r3Kind = '本机桌面不在 OneDrive 下；用 %OneDrive%\桌面 这个同形路径（未做真正的重定向）→ 本轮不构成 OneDrive 重定向的证据'
} else {
    $r3Base = $desktopNow
    $r3Kind = '本机桌面不在 OneDrive 下，也找不到 %OneDrive% → 退化为操作系统报告的桌面（本轮不构成 OneDrive 证据）'
}

Say ("操作系统报告的桌面（重定向前）：" + $desktopReal)
Say ("操作系统报告的桌面（现在）：" + $desktopNow)
Say ("桌面是否在 OneDrive 下：" + ($desktopNow -like '*OneDrive*'))
Say ("%OneDrive%：" + $(if ($oneDriveRoot) { $oneDriveRoot + '（存在）' } else { '(没有)' }))
Say ("桌面这一轮（r3）的基准：" + $r3Base)
Say ("桌面这一轮（r3）的做法：" + $r3Kind)

$rounds = @(
    [pscustomobject]@{ id = 'r1'; label = '纯中文目录（无空格）'; kind = '纯中文'; dir = (Join-Path $splitBase '2026年报销') },
    [pscustomobject]@{ id = 'r2'; label = '带空格的中文目录'; kind = '中文 + 空格'; dir = (Join-Path $splitBase '我的 表格') },
    [pscustomobject]@{ id = 'r3'; label = '桌面（操作系统报告的位置）'; kind = $r3Kind; dir = (Join-Path $r3Base ('Cante路径验收-' + $stamp)) }
)

# 先杀掉残留 cante-gui：残留实例会让 WebDriver 拿不到调试端口（症状像"提权"，坑记过）。
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

$installDir = Resolve-InstallDir
$sheetsBin = $null
if ($installDir) { $sheetsBin = Join-Path $installDir 'cante-sheets.exe' }
Say ("应用目录：" + $(if ($installDir) { $installDir } else { '(未找到)' }))
Say ("cante-sheets：" + $(if ($sheetsBin -and (Test-Path $sheetsBin)) { $sheetsBin } else { '(未找到)' }))
Say ("WebDriver 端口：" + $WdPort + "；计划任务名：" + $InnerTaskName)
Say ("开机时的竞争情况：" + (Get-Contention))

# ---------------------------------------------------------------------------
# 每一轮
# ---------------------------------------------------------------------------

$roundResults = New-Object System.Collections.Generic.List[object]

function Invoke-Round([pscustomobject]$Round) {
    Say ''
    Say ('================ ' + $Round.id + '：' + $Round.label + ' ================')
    Say ('路径形状：' + $Round.kind)
    Say ('完整路径：' + $Round.dir)

    $reasons = New-Object System.Collections.Generic.List[string]
    New-Item -ItemType Directory -Force -Path $Round.dir | Out-Null
    $dirCreated = Test-Path -LiteralPath $Round.dir
    Say ('目录已建：' + $dirCreated)
    if (-not $dirCreated) { $reasons.Add('目录建不出来') }

    $innerArgs = @(
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $script:RunScript,
        '-WorkDir', $Round.dir,
        '-TimeoutSec', [string]$RoundTimeoutSec,
        '-DriveTimeoutSec', [string]$DriveTimeoutSec,
        '-WdPort', [string]$WdPort,
        '-TaskName', $InnerTaskName
    )
    if ($Exe) { $innerArgs += @('-Exe', $Exe) }

    $watch = [System.Diagnostics.Stopwatch]::StartNew()
    $proc = Run-Process 'powershell.exe' $innerArgs ($RoundTimeoutSec + 180)
    $watch.Stop()
    $seconds = [math]::Round($watch.Elapsed.TotalSeconds, 1)

    Say ('--- run-accept-drive.ps1 原始输出（本轮耗时 ' + $seconds + 's）---')
    SayLines $proc.Stdout
    if ($proc.Stderr) { Say '--- run-accept-drive.ps1 stderr ---'; SayLines $proc.Stderr }
    Say ('--- 原始输出结束（退出码 ' + $proc.Code + '：0=通过 / 2=环境 / 3=产品 / 124=包装层超时）---')

    $innerCode = $proc.Code
    if ($innerCode -eq 124) { $reasons.Add('内层脚本超过包装层超时（' + ($RoundTimeoutSec + 180) + 's）') }
    elseif ($innerCode -ne 0) { $reasons.Add('内层退出码 ' + $innerCode) }

    # 失败的轮次：把“是否有别人在同时驱动窗口”记下来（区分路径问题 vs 环境竞争）。
    $driveErrPort = [bool]($proc.Stdout -match 'bind\(\) returned an error')
    if ($innerCode -ne 0) {
        Say ('[竞争] 本轮结束时：' + (Get-Contention))
        if ($driveErrPort) { Say '[竞争] 内层输出里出现了 WebDriver 端口 bind 失败 —— 多半是别处已有驱动占着同一个端口。' }
    }

    # ---- 独立核对：不靠"界面说成功"，靠盘上的事实（AGENTS.md §3.6）----
    $jobDir = Join-Path $Round.dir 'job'
    $inputFile = Join-Path $jobDir '销售明细.xlsx'
    $inputExists = Test-Path -LiteralPath $inputFile
    Say ''
    Say ('[核对] 输入文件在盘上：' + $inputExists + '  ' + $inputFile)

    $shaBefore = $null
    $shaAfterReport = $null
    $shaNow = $null
    $inputUnchanged = $false
    $reportTxt = Join-Path $Round.dir 'report.txt'
    if (Test-Path -LiteralPath $reportTxt) {
        $raw = Get-Content $reportTxt -Raw -Encoding UTF8
        $shaBefore = Get-FirstGroup $raw 'sha256=([0-9A-Fa-f]{64})'
        $shaAfterReport = Get-FirstGroup $raw '原文件没有被改动：([0-9A-Fa-f]{64})'
    } else {
        $reasons.Add('run-accept-drive 没写出 report.txt（拿不到"前"哈希）')
    }
    if ($inputExists) { $shaNow = (Get-FileHash -LiteralPath $inputFile -Algorithm SHA256).Hash.ToUpper() }
    Say ('[核对] 原文件 sha256：run 前=' + $(if ($shaBefore) { $shaBefore } else { '(未取到)' }) + '  run 后(报告)=' + $(if ($shaAfterReport) { $shaAfterReport } else { '(未取到)' }))
    Say ('[核对] 原文件 sha256：现在盘上=' + $(if ($shaNow) { $shaNow } else { '(文件不在)' }))
    if ($shaBefore -and $shaNow -and $shaBefore -eq $shaNow -and ((-not $shaAfterReport) -or $shaAfterReport -eq $shaNow)) {
        $inputUnchanged = $true
        Say '[核对] 原文件 sha256 前后一致：是'
    } else {
        Say '[核对] 原文件 sha256 前后一致：否（或有哈希取不到）'
        if (-not $shaBefore) { $reasons.Add('从 report.txt 取不到 run 前哈希') }
        if (-not $shaNow) { $reasons.Add('盘上没有输入文件，算不了哈希') }
        if ($shaBefore -and $shaNow -and $shaBefore -ne $shaNow) { $reasons.Add('原文件被改动了（哈希不一致）') }
    }

    $outputs = @()
    if (Test-Path -LiteralPath $jobDir) {
        $outputs = @(Get-ChildItem -LiteralPath $jobDir -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -like '结果_*.xlsx' })
    }
    Say ('[核对] 工作目录里的产出（' + $jobDir + '）：')
    if ($outputs.Count -eq 0) {
        Say '  （没有 结果_*.xlsx）'
        $reasons.Add('工作目录里没有 结果_*.xlsx 产出')
    } else {
        foreach ($o in $outputs) { Say ('  ' + $o.Name + '  ' + $o.Length + ' 字节  sha256=' + (Get-FileHash -LiteralPath $o.FullName -Algorithm SHA256).Hash) }
    }

    $sheetsRows = 0
    $sheetsOk = $false
    if (($outputs.Count -gt 0) -and $sheetsBin -and (Test-Path $sheetsBin)) {
        $output = $outputs | Sort-Object LastWriteTime -Descending | Select-Object -First 1
        $read = Run-Process $sheetsBin @('read', $output.FullName) 120
        Say ('[核对] 用应用自带的 cante-sheets 读回（' + $output.Name + '，退出码 ' + $read.Code + '）：')
        SayLines $read.Stdout
        if ($read.Stderr) { SayLines $read.Stderr }
        $rows = @(($read.Stdout -split "`r?`n") | Where-Object { $_ })
        if ($read.Code -ne 0) {
            $reasons.Add('cante-sheets 读产出失败（退出码 ' + $read.Code + '）')
        } elseif ($rows.Count -lt 2) {
            $reasons.Add('cante-sheets 读出来的产出是空的')
        } else {
            $dataRows = @($rows | Select-Object -Skip 1)
            $sheetsRows = $dataRows.Count
            $nonEast = @($dataRows | Where-Object { $_ -notmatch '^华东区,' })
            if ($nonEast.Count -gt 0) {
                $reasons.Add('产出里混进了非华东区的行')
            } elseif ($dataRows.Count -ne 3) {
                $reasons.Add('产出应有 3 行华东区记录，实际 ' + $dataRows.Count + ' 行')
            } else {
                $sheetsOk = $true
            }
        }
    } elseif (-not $sheetsBin -or -not (Test-Path $sheetsBin)) {
        $reasons.Add('找不到 cante-sheets.exe，没法读回核对')
    }

    $ok = ($reasons.Count -eq 0)
    Say ''
    if ($ok) {
        Say ('[' + $Round.id + '] 结论：通过（产出在盘上、cante-sheets 读回 3 行华东区、原文件 sha256 前后一致）')
    } else {
        Say ('[' + $Round.id + '] 结论：失败 — ' + ($reasons -join '；'))
        if ($innerCode -eq 2) {
            Say '  分类：内层退出码 2 = **环境问题**（应用/驱动/交互会话，或路径本身让应用/驱动起不来）。'
        } elseif ($innerCode -eq 3) {
            Say '  分类：内层退出码 3 = **产品问题**（窗口起来了，但卡片流程失败）。'
        } elseif ($innerCode -eq 124) {
            Say '  分类：包装层超时 —— "没等到结果"，**不等于**"没有结果"（AGENTS.md §5）。'
        } else {
            Say ('  分类：内层退出码 ' + $innerCode + '（见上面的原始输出）。')
        }
        Say '  上面"完整路径"就是本轮实际用的路径；行不行、卡在哪，照它最小复现。'
    }

    return [pscustomobject]@{
        id = $Round.id
        label = $Round.label
        kind = $Round.kind
        dir = $Round.dir
        dirCreated = $dirCreated
        innerExitCode = $innerCode
        seconds = $seconds
        inputExists = $inputExists
        inputSha256Before = $shaBefore
        inputSha256AfterReport = $shaAfterReport
        inputSha256Now = $shaNow
        inputUnchanged = $inputUnchanged
        outputs = @($outputs | ForEach-Object { $_.Name })
        sheetsReadOk = $sheetsOk
        sheetsRows = $sheetsRows
        ok = $ok
        reasons = @($reasons.ToArray())
        portBindError = $driveErrPort
    }
}

$exitCode = 1
try {
    # -Only r1,r3 从命令行传进来时 PowerShell **不拆**，它是字面量 'r1,r3' ✗
    # -> 对不上任何 id -> 一轮都不跑，而旧代码把「0 轮」汇总成 0 = 全通过 ✗✗
    # （AGENTS.md §3.3：把「没验证」写成「通过」）。这里显式拆开。
    $onlyIds = @()
    foreach ($piece in $Only) {
        foreach ($part in ($piece -split '[,;\s]+')) {
            if ($part.Trim()) { $onlyIds += $part.Trim() }
        }
    }
    $onlyIds = @($onlyIds | Select-Object -Unique)
    foreach ($round in $rounds) {
        if ($onlyIds -notcontains $round.id) {
            Say ''
            Say ('（跳过 ' + $round.id + '：不在 -Only 里）')
            continue
        }
        $roundResults.Add((Invoke-Round $round))
    }
} finally {
    if ($redirectState.applied) {
        Say ''
        Say '--- 还原「桌面」已知文件夹 ---'
        try {
            $hr = Set-DesktopKnownFolder $redirectState.original
            $redirectState.freshAfterRevert = Get-DesktopFresh
            $redirectState.sessionAfterRevert = Get-DesktopInInteractiveSession
            $redirectState.reverted = ($hr -eq 0 -and $redirectState.freshAfterRevert -eq $redirectState.original)
            Say ('  还原返回码=' + $hr + '；全新进程读到的桌面=' + $redirectState.freshAfterRevert)
            Say ('  登录会话里读到的桌面=' + $(if ($redirectState.sessionAfterRevert) { $redirectState.sessionAfterRevert } else { '(没读到)' }))
            Say ('  已还原：' + $redirectState.reverted)
            if (-not $redirectState.reverted) {
                Say '  !! 还原失败：请人工把「桌面」改回 ' + $redirectState.original
                Say '     （资源管理器 → 桌面 → 属性 → 位置，或 PowerShell: 见本文件顶部说明）'
            }
        } catch {
            $redirectState.error = $_.Exception.Message
            Say ('  !! 还原时出错：' + $_.Exception.Message)
        }
    }
}

# ---- 汇总 ----
$total = $roundResults.Count
$passed = @($roundResults | Where-Object { $_.ok }).Count
$productFail = @($roundResults | Where-Object { $_.innerExitCode -eq 3 }).Count
$envFail = @($roundResults | Where-Object { $_.innerExitCode -eq 2 }).Count

Say ''
Say '=== 汇总 ==='
foreach ($r in $roundResults) {
    Say ('  {0}  {1}  {2}  {3}s  {4}' -f $r.id, $(if ($r.ok) { '通过' } else { '失败' }), $r.kind, $r.seconds, $r.dir)
}
Say ("  通过 $passed / $total")

if ($total -eq 0) {
    Say '  !! 一轮都没跑：-Only 没匹配上任何一轮 → 这条不算通过 ✗'
    Say ('     你给的 -Only = ' + (($Only | ForEach-Object { $_.ToString() }) -join '|'))
    Say ('     可选轮次 id = ' + (($rounds | ForEach-Object { $_.id }) -join ','))
    $exitCode = 1
} else {
    $exitCode = 0
    if ($productFail -gt 0) { $exitCode = 3 }
    elseif ($envFail -gt 0) { $exitCode = 2 }
}
Say ('accept-paths: 结论 = ' + $exitCode + '（0=全通过 / 1=脚本自身出错・一轮都没跑 / 2=环境问题 / 3=产品问题）')

if ($Cleanup) {
    Say ''
    Say '--- 清理三个目标目录（-Cleanup）---'
    foreach ($r in $roundResults) {
        if (Test-Path -LiteralPath $r.dir) {
            Remove-Item -LiteralPath $r.dir -Recurse -Force -ErrorAction SilentlyContinue
            Say ('  删掉 ' + $r.dir + ' → 还在：' + (Test-Path -LiteralPath $r.dir))
        }
    }
}

$result = [pscustomobject]@{
    ok = ($exitCode -eq 0)
    exitCode = $exitCode
    elevated = $script:Elevated
    session = $script:Session
    baseDir = $BaseDir
    desktop = $desktopReal
    desktopInOneDrive = $desktopInOneDrive
    oneDrive = $oneDriveRoot
    redirect = $redirectState
    rounds = $roundResults.ToArray()
}
(Redact ($result | ConvertTo-Json -Depth 8)) | Set-Content -Path $resultFile -Encoding UTF8
$script:Lines -join "`n" | Set-Content -Path $reportFile -Encoding UTF8
Say ''
Say ('报告：' + $reportFile)
Say ('结构化结果：' + $resultFile)
exit $exitCode
