# 首屏验收（Windows 真机）：装好的应用**第一次**打开时，第一屏真的是中文简单模式向导第 1 步吗？
#
# 这是 #150 的最后一块：安装 ✓、安装目录 ✓、驱动应用跑完一轮 ✓ —— 但「她第一次打开看到
# 的那一屏」从没被单独验过。它**不驱动任务**（那会污染首启状态），只做三件事：
#   1. 把应用状态清干净，保证看到的是「第一次」；
#   2. 启动装好的应用；
#   3. 用 UI Automation 把窗口里**真实渲染出来的文字**读回来（原文），逐条对照 copy.ts 的向导文案。
#
# 为什么复用 dump-window-text.ps1，而不是自己发明 UIA / 截图（AGENTS.md §3.6）：
#   「已经验证」的前提是「我看的，是它真的产出的那个东西」。截图只能证明「画了东西」，
#   证明不了「画的是哪句话」；WebView2 把渲染出来的 DOM 暴露成 UIA 树，把它读回来才是**可以
#   逐字核对**的证据。dump-window-text.ps1 正是干这件事的，accept-install.ps1 第 3 步一直用它。
#   所以本脚本**只做编排 + 断言**，读窗口一律交给它。
#
# 为什么不能直接在任意会话里跑（本机实测，务必看）：
#   * 从 SSH 起的会话是 **提权、session 0**（实测 elevated=True session=0）。WebView2 在提权进程里
#     会忽略 WEBVIEW2_* 环境变量（README 与 DEVELOPING-WINDOWS.md 都写过），于是
#     --force-renderer-accessibility 不生效，读回来的是**空树 / 没有主窗口句柄** ✗ ——
#     看着像「界面没渲染」，其实是**会话不对** ✗。
#   * 实测：提权 session 0 → dump 报「进程已退出」或读不到窗口；改成「当前用户 + Interactive +
#     RunLevel Limited」的计划任务（weekly-sweep 早用过同一套）→ 一次读出真实文案 ✓。
#   所以：**在不提权的交互会话里跑**，就地跑；**提权或 session 0**，本脚本自动把「启动应用 +
#   读窗口」那一步交给一个 Limited 计划任务去跑，再把它的输出**原样**带回来。
#   你不需要手动提权或降权，直接跑就行。
#
# 用法（Windows PowerShell 5.1）：
#   powershell -NoProfile -ExecutionPolicy Bypass -File gui\scripts\windows\accept-first-screen.ps1
#   ... -Exe "C:\...\cante-gui.exe"     # 不查注册表，直接指一个可执行文件
#   ... -KeepState                      # 不清应用状态，看「现在这一屏」（用于对照）
#   ... -WaitSeconds 25                 # 慢机器上多等一会儿
#
# 产物（默认 %TEMP%\cante-first-screen\）：
#   report.txt    人看的报告（含窗口文字原文 + 逐条对照表）
#   dump-raw.txt  dump-window-text.ps1 的原始 stdout/stderr
#   result.json   结构化结果（给脚本/CI 用）
#
# 退出码：0 = 第一屏就是向导第 1 步、且 10 条文案全部对上；2 = 环境问题（应用起不来 / 读不到窗口 /
#        有企业预置会把向导跳过）；3 = 窗口读到了，但文案对不上。
#
# 注意：本文件必须保存为 UTF-8 with BOM（Windows PowerShell 5.1 否则按 GBK 解析，中文会乱码）。

param(
    [string]$Exe = "",
    [int]$WaitSeconds = 20,
    [string]$WorkDir = (Join-Path $env:TEMP 'cante-first-screen'),
    [string]$DumpScript = "",
    [switch]$KeepState,
    # 内部使用：子进程模式。父进程（提权 / session 0）复用它，避免无限自我重启。
    [switch]$Child,
    [int]$TimeoutSec = 300
)

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$script:Lines = New-Object System.Collections.Generic.List[string]
function Say([string]$text) { Write-Output $text; [void]$script:Lines.Add($text) }

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

# copy.ts 里向导第 1 步真正用到的字符串。逐条带上来源常量名，改一处好对照。
# （copy.ts 里**没有** WELCOME 常量：向导文案都在 WIZARD；首页/最后一步在 FIRST_RUN。）
$expectations = @(
    [pscustomobject]@{ Source = 'WIZARD.progressLabel';  Expected = '进度' },
    [pscustomobject]@{ Source = 'WIZARD.stepLabels[0]';  Expected = '欢迎' },
    [pscustomobject]@{ Source = 'WIZARD.stepLabels[1]';  Expected = '检查电脑' },
    [pscustomobject]@{ Source = 'WIZARD.stepLabels[2]';  Expected = '开始使用' },
    [pscustomobject]@{ Source = 'WIZARD.welcomeTitle';   Expected = '欢迎使用 Cante' },
    [pscustomobject]@{ Source = 'WIZARD.welcomeBody';    Expected = '我帮你把表格、文件这些麻烦事做完。原文件我不会乱动，动手前会先让你确认。先检查一下你的电脑，好吗？' },
    [pscustomobject]@{ Source = 'WIZARD.welcomeButton';  Expected = '开始检查' },
    [pscustomobject]@{ Source = 'COMMON.history';        Expected = '历史' },
    [pscustomobject]@{ Source = 'COMMON.privacy';        Expected = '隐私' },
    [pscustomobject]@{ Source = 'COMMON.about';          Expected = '关于' }
)

$scriptPath = $PSCommandPath
if (-not $DumpScript) { $DumpScript = Join-Path $PSScriptRoot 'dump-window-text.ps1' }

$elevated = Test-IsElevated
$session = Get-SessionId

# ---------------------------------------------------------------------------
# 父进程：提权或 session 0 时，把真正那一步交给 Limited 计划任务
# ---------------------------------------------------------------------------

if (-not $Child -and ($elevated -or $session -eq 0)) {
    New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
    $resultFile = Join-Path $WorkDir 'result.json'
    $reportFile = Join-Path $WorkDir 'report.txt'
    Remove-Item $resultFile, $reportFile -Force -ErrorAction SilentlyContinue

    Say '=== 首屏验收（Windows 真机）==='
    Say ("当前会话：elevated=$elevated session=$session")
    Say '这个会话读不到窗口（提权进程里 WebView2 不打开无障碍树；session 0 没有交互桌面）。'
    Say '改由「当前用户 + Interactive + RunLevel Limited」的计划任务在登录会话里跑，再把报告原样带回来。'

    $exePath = Resolve-InstalledExe $Exe
    if (-not $exePath) {
        Say 'accept-first-screen: FAIL — 找不到装好的 cante-gui.exe。'
        Say ("  查过：HKCU 卸载登记里的 InstallLocation，以及 $env:LOCALAPPDATA\Cante\cante-gui.exe。")
        Say '  先装一次（见 gui/DEVELOPING-WINDOWS.md），或用 -Exe 指一个绝对路径。'
        exit 2
    }
    Say ("应用：" + $exePath)

    $taskName = 'CanteFirstScreenAcceptance'
    $innerTimeout = [Math]::Max(60, $TimeoutSec - 20)
    $inner = @(
        '-NoProfile', '-ExecutionPolicy', 'Bypass',
        '-File', ('"' + $scriptPath + '"'),
        '-Child',
        '-Exe', ('"' + $exePath + '"'),
        '-WaitSeconds', $WaitSeconds.ToString(),
        '-WorkDir', ('"' + $WorkDir + '"'),
        '-DumpScript', ('"' + $DumpScript + '"'),
        '-TimeoutSec', $innerTimeout.ToString()
    )
    if ($KeepState) { $inner += '-KeepState' }
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
        Say ('accept-first-screen: FAIL — 建不了计划任务：' + $_.Exception.Message)
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
        Say ('accept-first-screen: FAIL — 计划任务没有写出报告（最后状态 ' + $state + '）。')
        Say '  可能是应用没起来、或这台机器没有可用的交互会话。请改用 RDP 打开桌面后直接跑本脚本。'
    }
    if (Test-Path $resultFile) { Say ''; Say ('accept-first-screen: 结论 = ' + $code) }
    exit $code
}

# ---------------------------------------------------------------------------
# 子进程（或本就在不提权的交互会话里）：就地跑
# ---------------------------------------------------------------------------

New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
$reportFile = Join-Path $WorkDir 'report.txt'
$rawFile = Join-Path $WorkDir 'dump-raw.txt'
$resultFile = Join-Path $WorkDir 'result.json'

$code = 0
$dumpExit = -1
$raw = ''
$cleared = New-Object System.Collections.Generic.List[string]
$rows = @()
$exePath = Resolve-InstalledExe $Exe

Say '=== 首屏验收（Windows 真机）==='
Say ("会话：elevated=$elevated session=$session")
Say ("工作目录：" + $WorkDir)
Say ("应用：" + $(if ($exePath) { $exePath } else { '(未找到)' }))

$profileDir = Join-Path $env:LOCALAPPDATA 'dev.cante.gui'
$historyDir = Join-Path $env:APPDATA 'dev.cante.gui'
$adminFile = Join-Path $env:USERPROFILE '.cante\admin.json'

if (-not $exePath) {
    Say 'accept-first-screen: FAIL — 找不到装好的 cante-gui.exe。'
    Say ("  查过：HKCU 卸载登记里的 InstallLocation，以及 $env:LOCALAPPDATA\Cante\cante-gui.exe。")
    Say '  先装一次（见 gui/DEVELOPING-WINDOWS.md），或用 -Exe 指一个绝对路径。'
    $code = 2
} elseif (-not (Test-Path $DumpScript)) {
    Say ('accept-first-screen: FAIL — 找不到读窗口的脚本：' + $DumpScript)
    Say "  它应该在 gui\scripts\windows\dump-window-text.ps1；用 -DumpScript 指一个绝对路径。"
    $code = 2
} elseif (Test-Path $adminFile) {
    # 有企业预置时向导会被**跳过**（adminConfigured()），第一屏会是首页 —— 那样断言必然对不上，
    # 而且看起来像产品出了问题。如实说清，并且**不替她删用户配置**。
    Say ('accept-first-screen: FAIL — 这台机器有企业预置 ' + $adminFile + '，向导会被跳过。')
    Say '  本脚本不会删用户配置。要验收首屏，请先把该文件移开（例如改名 admin.json.bak）再跑；'
    Say '  验收完再放回去。'
    $code = 2
} else {
    # 读到可疑结果（读不到窗口）时**重跑一次**再下结论：这台机器上别的残留任务可能在跑
    # 同一个应用、或正好在清状态（AGENTS.md §3.6："读到可疑结果时，先重新挂载 / 重跑一次复核"）。
    # 本机实测：第一次跑撞上残留实例 → 读到"进程已退出"；清干净后连跑三次全绿。
    for ($attempt = 1; $attempt -le 2; $attempt++) {
        Say ''
        Say ("=== 第 " + $attempt + " 次尝试 ===")

        # 1) 清掉残留在跑的实例：有别的实例在跑时，新实例可能直接退出（症状像「起不来」）。
        $residual = @(Get-Process cante-gui -ErrorAction SilentlyContinue)
        if ($residual.Count -gt 0) {
            Say ("先杀掉残留实例：" + (($residual | ForEach-Object { $_.Id }) -join ', '))
            $residual | ForEach-Object { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue }
            Start-Sleep -Seconds 2
        } else {
            Say '启动前没有残留的 cante-gui 实例。'
        }

        # 2) 清状态，保证看到的是「第一次打开」：向导的「已完成」标记 localStorage 就在 WebView2 的
        #    用户数据里，运行记录在 %APPDATA%\dev.cante.gui。清不掉旧状态，看到的就不是首屏。
        if ($KeepState) {
            Say '-KeepState：不清应用状态（看当前这一屏）。'
        } else {
            foreach ($dir in @($profileDir, $historyDir)) {
                if (Test-Path $dir) {
                    Remove-Item $dir -Recurse -Force -ErrorAction SilentlyContinue
                    [void]$cleared.Add(($dir + $(if (Test-Path $dir) { '（删不掉，还在）' } else { '（已删）' })))
                } else {
                    [void]$cleared.Add(($dir + '（本来就不在）'))
                }
            }
        }
        Say ''
        Say '=== 清掉的状态（保证是首启）==='
        if ($cleared.Count -eq 0) { Say '  （未清任何东西）' } else { $cleared | ForEach-Object { Say ('  ' + $_) } }

        # 3) 启动 + 用 UI Automation 读窗口文字（复用已被验过的 dump-window-text.ps1）。
        Say ''
        Say '=== 启动应用并读窗口文字（dump-window-text.ps1）==='
        $dump = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $DumpScript `
            -Exe $exePath -WaitSeconds $WaitSeconds -ForceAccessibility 2>&1
        $dumpExit = $LASTEXITCODE
        $raw = (@($dump) | ForEach-Object { $_.ToString() }) -join "`n"
        Set-Content -Path $rawFile -Value $raw -Encoding UTF8

        if ($dumpExit -eq 0) { break }
        Say ("读窗口退出码 " + $dumpExit + "（原文见 " + $rawFile + "）")
        if ($attempt -lt 2) {
            Say '这一次没读出来，清干净再复核一次（AGENTS.md §3.6）…'
            continue
        }
        Say 'accept-first-screen: FAIL — 没能读出第一屏（已复核一次）。'
        Say '  常见原因（按脚本实测）：① 别的任务／人在同一台机器上跑着这个应用；② 没有可用的交互会话'
        Say '  （本脚本在提权 / session 0 下会自动改走 Limited 计划任务，仍失败多半就是这条）；'
        Say '  ③ 应用刚启动就退出（看上面的原文与退出码）。要看看真实画面，请用 RDP 登录桌面后再跑一次。'
        $code = 2
        break
    }

    if ($dumpExit -eq 0) {
        Say '读窗口成功（退出码 0）。窗口文字原文见下。'
        Say ''
        Say '=== 窗口里真实渲染出来的文字（原始输出）==='
        $raw -split "`r?`n" | ForEach-Object { Say ('  ' + $_) }

        # 4) 逐条对照 copy.ts
        Say ''
        Say '=== 第一屏逐条对照（对照 copy.ts）==='
        $rows = @(foreach ($item in $expectations) {
            [pscustomobject]@{
                source = $item.Source
                expected = $item.Expected
                found = $raw.Contains($item.Expected)
            }
        })
        foreach ($row in $rows) {
            $mark = if ($row.found) { '[对]' } else { '[错]' }
            Say ('  {0} {1,-24} {2}' -f $mark, $row.source, $row.expected)
        }
        $hit = @($rows | Where-Object { $_.found }).Count
        Say ('  共 ' + $rows.Count + ' 条，对上 ' + $hit + ' 条，对不上 ' + ($rows.Count - $hit) + ' 条。')

        if ($hit -eq $rows.Count) {
            Say ''
            Say 'accept-first-screen: OK — 第一屏是中文简单模式向导第 1 步，文案逐条对上。'
            $code = 0
            if ($attempt -gt 1) { Say ('  （第 1 次没读出来，复核这一次才通过 —— 见上面的原文。）') }
        } else {
            Say ''
            Say 'accept-first-screen: FAIL — 窗口读到了，但有文案对不上（见上面的 [错] 行）。'
            Say '  先确认这不是环境问题（-KeepState 看当前这一屏，或 RDP 里人眼看一次）；'
            Say '  若窗口里确实是另一屏/另一句话，那是产品的问题。'
            $code = 3
        }
    }
}

# 5) 收尾：把结果写下来（父进程/CI 只看这两份文件）。
$result = [pscustomobject]@{
    ok = ($code -eq 0)
    exitCode = $code
    exe = $exePath
    elevated = $elevated
    session = $session
    keepState = [bool]$KeepState
    dumpExit = $dumpExit
    cleared = @($cleared)
    checks = @($rows)
    workDir = $WorkDir
}
$result | ConvertTo-Json -Depth 6 | Set-Content -Path $resultFile -Encoding UTF8
$script:Lines -join "`n" | Set-Content -Path $reportFile -Encoding UTF8
Say ''
Say ("报告：" + $reportFile)
exit $code
