# 「结果交付」那一条的真机验收（#197 第四条）：结果文件找不到时，屏幕说什么。
#
# 她要的最后一公里是「东西在哪」。产品律要的是把麻烦事做完，所以找不到时我们要**如实说**、
# 并给一条她做得到的路。这一条把下面四种现场各跑一遍，把「我做的结果」面板上的**逐字话**
# 落盘：
#
#   normal   —— 正常一轮（对照）：面板说「现在还在，能打开」，「打开所在文件夹」真的能到；
#   deleted  —— 结果文件被删掉（跑完之后手动删）；
#   renamed  —— 结果文件被改名（模拟她重命名过）；
#   moved    —— 结果文件被移走（挪到别处）。
#
# 判据（不许放松）：
#   * 三种「找不到」都要**如实说不在了**，不许显示成还在，也不许显示空白；
#   * normal 那一条，「打开所在文件夹」点下去要真的开出那个文件夹（用 Shell.Application 看，
#     不信 DOM 自己说）；
#   * 后三种现场都要先证「破坏真的做成了」（文件确实删/改名/移走了）再读面板 ——
#     否则一次没生效的删除会看着像「产品把不在的文件说成还在」。
#
# 它**不重写**跑任务那部分：那一份已经有验过的入口 `run-accept-drive.ps1`（装好的应用 →
# 点卡 → 真出一份文件 → 用 cante-sheets 读回来核对）。这里只调它，再用
# `results-audit.mjs` 分「破坏前 / 破坏后」各看一次面板。
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File gui\scripts\windows\run-results-audit.ps1
#   ... -Scenario deleted
#   ... -WorkDir "D:\results-audit"
#   ... -SkipRun                 # 不跑任务，只看现有结果（面板里已有的那些）
#
# 退出码（照 0/2/3 约定）：
#   0 = 这一场跑通且判据都满足；
#   2 = **环境问题**（找不到应用/驱动/执行组件、没有交互会话、会话建不起来、破坏没生效）；
#   3 = **产品问题**（窗口起来了但这些失败页/面板文字不符合判据）。
#
# 注意：本文件必须保存为 UTF-8 with BOM（Windows PowerShell 5.1 否则按 GBK 解析，中文会乱码）。

param(
    [ValidateSet('all', 'normal', 'deleted', 'renamed', 'moved')][string]$Scenario = 'all',
    [string]$Exe = "",
    [string]$WorkDir = "",
    [string]$Card = "从大表里挑出想要的行",
    [string]$Instruction = "把华东区的记录挑出来，另存成一张新表",
    # 跑一轮任务的上限；单卡别低于 1800s（AGENTS.md §5：慢模型实测 850s）。
    [int]$RunTimeoutSec = 2100,
    # SkipRun：不跑任务，直接看面板里已有的结果（省时间；用于反复调面板读取那一段）。
    [switch]$SkipRun,
    # ReuseExisting：不跑任务，改用一条**现有的**结果记录（文件名在本机唯一）来验
    # 「改名 / 移走 / 删掉」—— 这三场要的只是一个已经登记在册、又真的在盘上的文件，
    # 不需要新跑一轮模型。报告里必须写明哪一场是这么做的（没有跑任务）。
    [switch]$ReuseExisting,
    # 用于 ReuseExisting：直接指定要复用的那一条的文件名（不指定就自动挑一条唯一的）。
    [string]$ReuseName = "",
    # 每一场用不同的 WebDriver 端口，避免 TIME_WAIT 复用把它们绊倒（实跑踩过）。
    [int]$Port = 0,
    [switch]$KeepWorkDir
)

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$script:Here = $PSScriptRoot
$script:GuiRoot = (Resolve-Path (Join-Path $script:Here '..\..')).Path
$script:RepoRoot = (Resolve-Path (Join-Path $script:GuiRoot '..')).Path
$script:Lines = New-Object System.Collections.Generic.List[string]
function Say([string]$text) { Write-Output $text; [void]$script:Lines.Add($text) }
function SayLines([string]$text) {
    if ([string]::IsNullOrEmpty($text)) { return }
    foreach ($line in ($text -split "`r?`n")) { Say $line }
}

# 报告里绝不出现真实家目录 / 内网地址 / 用户名（CI 的秘密扫描会判红）。
# 这台机器的路径里同时含用户名与盘符，所以打印路径前统一过一遍这个函数。
# 报告里绝不出现真实家目录 / 内网地址（CI 的秘密扫描会判红，见 gui/scripts/secret-scan.sh）。
#
# 只换**路径形式**的家目录（C:\Users\<名字>），不要拿裸用户名做全局替换 —— 这台机器的
# 用户名恰好就是 "cante"，而产品每处都写着 cante-gui.exe / Cante，全局换会把报告
# 改成一堆「<用户名>-gui.exe」「<用户名>」这种看不出是什么的东西（实跑踩过）。
# 内网地址照 secret-scan 的私有网段规则换。
function Redact([string]$text) {
    if ([string]::IsNullOrEmpty($text)) { return $text }
    $out = $text
    $homeDir = $env:USERPROFILE
    if ($homeDir -and $homeDir -match '^[A-Za-z]:[\\/]+Users[\\/]+([^\\/]+)$') {
        $userSeg = $Matches[1]
        # home 的两种分隔符写法都要换（报告里两种都可能出现）。
        $out = $out -replace ('(?i)[A-Za-z]:[\\/]+Users[\\/]+' + [regex]::Escape($userSeg) + '(?![A-Za-z0-9._-])'), '<用户目录>'
    }
    # 私有网段（和 secret-scan.sh 的 PRIVATE_IP_RE 同形）：192.168.x / 172.16-31.x / 10.x。
    $out = $out -replace '\b192\.168\.\d{1,3}\.\d{1,3}(?::\d+)?', '<内网地址>'
    $out = $out -replace '\b172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}(?::\d+)?', '<内网地址>'
    $out = $out -replace '\b10\.\d{1,3}\.\d{1,3}\.\d{1,3}(?::\d+)?', '<内网地址>'
    return $out
}
function SayR([string]$text) { Say (Redact $text) }

function Run-Command([string]$File, [string[]]$Arguments, [int]$TimeoutSec = 300) {
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
        try { $proc.Kill() } catch {}
        return [pscustomobject]@{ Code = 124; Stdout = ''; Stderr = "超时：超过 ${TimeoutSec}s 没结束" }
    }
    return [pscustomobject]@{ Code = $proc.ExitCode; Stdout = $outTask.Result; Stderr = $errTask.Result }
}

# ---------------------------------------------------------------------------
# 前置（照 run-accept-drive.ps1 那套，不另发明）
# ---------------------------------------------------------------------------

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
$sessionId = (Get-Process -Id $PID).SessionId
$hasDesktop = [bool](Get-Process explorer -ErrorAction SilentlyContinue)
Say ("会话：session=$sessionId elevated=$isAdmin 有桌面=$hasDesktop")
if ($isAdmin) {
    Say '环境问题：当前是提权会话。WebView2 150+ 在提权进程里会忽略 WEBVIEW2_* 调试端口变量，'
    Say '          WebDriver 会以「DevToolsActivePort file doesn''t exist」失败。'
    Say '          请用不提权的交互会话跑。'
    exit 2
}
if (-not $hasDesktop) {
    Say '环境问题：这个会话没有交互桌面，GUI 建不出窗口。'
    exit 2
}

function Resolve-InstalledExe([string]$Given) {
    if ($Given) { if (Test-Path $Given) { return (Resolve-Path $Given).Path } ; return $null }
    try {
        $entry = Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' -ErrorAction SilentlyContinue |
            Where-Object { $_.GetValue('DisplayName') -like '*Cante*' } | Select-Object -First 1
        if ($entry) {
            $location = $entry.GetValue('InstallLocation')
            # 注册表里这个值**带字面引号**（实测：`"C:\...\Cante"`），不剪掉的话
            # Join-Path 会报「找不到驱动器 "C」—— 上一轮就是这么绕过去、退到了 fallback。
            if ($location) { $location = $location.Trim().Trim('"') }
            if ($location -and (Test-Path (Join-Path $location 'cante-gui.exe'))) {
                return (Resolve-Path (Join-Path $location 'cante-gui.exe')).Path
            }
        }
    } catch {}
    $fallback = Join-Path $env:LOCALAPPDATA 'Cante\cante-gui.exe'
    if (Test-Path $fallback) { return (Resolve-Path $fallback).Path }
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
    $candidates = @(
        (Join-Path $script:GuiRoot 'e2e-windows\msedgedriver\msedgedriver.exe'),
        (Join-Path $HOME 'msedgedriver\msedgedriver.exe'),
        (Join-Path $workDir 'msedgedriver\msedgedriver.exe')
    )
    foreach ($c in $candidates) { if (Test-Path $c) { return $c } }
    return $null
}

function Get-FreePort {
    for ($i = 0; $i -lt 30; $i++) {
        $p = Get-Random -Minimum 25000 -Maximum 45000
        if (-not (Get-NetTCPConnection -LocalPort $p -ErrorAction SilentlyContinue)) { return $p }
    }
    return 4455
}

function Clear-StaleApp {
    foreach ($name in @('cante-gui', 'tauri-driver', 'msedgedriver')) {
        Get-Process -Name $name -ErrorAction SilentlyContinue | ForEach-Object {
            try { Stop-Process -Id $_.Id -Force } catch {}
        }
    }
    Start-Sleep -Seconds 2
}

# ---------------------------------------------------------------------------
# 「打开所在文件夹」到底有没有真的开出那个文件夹：**不信 DOM 自己说**。
# 证据由驱动在**同一次会话**里成对取（点击前 / 点击后各列一次 Shell 里打开的文件夹）——
# 隔到这边再查时应用已经退了，窗口还在不在就说不准了（所以不在 PowerShell 里做）。
# ---------------------------------------------------------------------------

$exePath = Resolve-InstalledExe $Exe
if (-not $exePath) { Say '环境问题：找不到 cante-gui.exe（查过 HKCU 卸载登记的 InstallLocation 与 %LOCALAPPDATA%\Cante）'; exit 2 }
$tauriDriver = Resolve-TauriDriver
if (-not $tauriDriver) { Say '环境问题：找不到 tauri-driver.exe'; exit 2 }
$node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $node) { Say '环境问题：找不到 node.exe'; exit 2 }
if (-not (Test-Path (Join-Path $script:GuiRoot 'node_modules\selenium-webdriver'))) {
    Say '环境问题：缺少 gui/node_modules/selenium-webdriver（先在 gui/ 里 bun install）'; exit 2
}
if (-not $WorkDir) { $WorkDir = Join-Path $env:TEMP ('cante-results-audit-' + (Get-Date -Format 'yyyyMMdd-HHmmss')) }
New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
$msedge = Resolve-MsEdgeDriver $WorkDir
if (-not $msedge) { Say '环境问题：找不到 msedgedriver.exe'; exit 2 }
$sheetsBin = Join-Path (Split-Path -Parent $exePath) 'cante-sheets.exe'
if (-not (Test-Path $sheetsBin)) { Say '环境问题：安装目录里缺 cante-sheets.exe'; exit 2 }
$acceptRunner = Join-Path $script:Here 'run-accept-drive.ps1'
if (-not (Test-Path $acceptRunner)) { Say ('环境问题：找不到 run-accept-drive.ps1（' + $acceptRunner + '）'); exit 2 }
$driveScript = Join-Path $script:Here 'results-audit.mjs'
if (-not (Test-Path $driveScript)) { Say ('环境问题：找不到 results-audit.mjs（' + $driveScript + '）'); exit 2 }

Say ''
Say '=== 结果交付真机验收（#197 第四条）==='
SayR ("工作目录：" + $WorkDir)
SayR ("应用：" + $exePath)
SayR ("tauri-driver：" + $tauriDriver)
SayR ("msedgedriver：" + $msedge)
Say ("场景：" + $Scenario + $(if ($SkipRun) { '（-SkipRun：不跑任务，只看现有面板）' } else { '' }))

$scenarios = if ($Scenario -eq 'all') { @('normal', 'deleted', 'renamed', 'moved') } else { @($Scenario) }

$script:verdicts = @()
$script:anyEnv = $false
$script:anyProduct = $false
# 每一场到底“跑没跑任务”（报告要如实写：ReuseExisting 那几场没跑）。
$script:ranTaskByScenario = @{}
# 有没有哪一场的靶子没能还原（验收不该把她的文件留在新位置）。
$script:restoreFailed = $false
$script:restoreStash = $null

function Invoke-PanelRead([string]$tag, [switch]$ClickReveal, [string]$matchLine = "", [string]$matchName = "") {
    # 最多试两次：实测 WebDriver 偶发拿到一个**空白页**（会话建起来了、body 却是空的，
    # 等首页超时）。那是工具链的一次抖动，不是产品现象 —— 重试一次能消掉它；
    # 两次都失败才当真失败（如实报“没读到”，不当成产品结论）。
    for ($attempt = 1; $attempt -le 2; $attempt++) {
        Clear-StaleApp
        if ($Port -eq 0) { $port = Get-FreePort } else { $port = $Port }
        $artifacts = Join-Path $WorkDir "panel-$tag"
        New-Item -ItemType Directory -Force -Path $artifacts | Out-Null
        $resultJson = Join-Path $artifacts 'results-audit.json'
        $env:RESULTS_APP = $exePath
        $env:RESULTS_ARTIFACTS = $artifacts
        $env:RESULTS_RESULT_JSON = $resultJson
        $env:RESULTS_TAG = $tag
        $env:RESULTS_MSEDGEDRIVER = $msedge
        $env:RESULTS_TAURI_DRIVER = $tauriDriver
        $env:RESULTS_WD_PORT = [string]$port
        if ($matchLine) { $env:RESULTS_MATCH_LINE = $matchLine } else { Remove-Item Env:RESULTS_MATCH_LINE -ErrorAction SilentlyContinue }
        if ($matchName) { $env:RESULTS_MATCH_NAME = $matchName } else { Remove-Item Env:RESULTS_MATCH_NAME -ErrorAction SilentlyContinue }
        Remove-Item Env:RESULTS_MATCH_TAG -ErrorAction SilentlyContinue
        if ($ClickReveal) { $env:RESULTS_CLICK_REVEAL = '1' } else { Remove-Item Env:RESULTS_CLICK_REVEAL -ErrorAction SilentlyContinue }

        if ($attempt -gt 1) { Say ('  （读面板第 ' + $attempt + ' 次 —— 上一次没拿到面板，重试）') }
        $r = Run-Command $node @($driveScript) 400
        SayLines $r.Stdout
        if ($r.Stderr) { Say '  --- driver stderr ---'; SayLines $r.Stderr }
        if (Test-Path $resultJson) {
            $parsed = Get-Content $resultJson -Raw -Encoding UTF8 | ConvertFrom-Json
            if ($parsed.ok -and $parsed.panel) { return $parsed }
        }
        Start-Sleep -Seconds 2
    }
    return $null
}

# ---------------------------------------------------------------------------
# 各场共用的一个动作：从面板里挑出「这一次跑出来的那一条」。
#
# 为什么不能只看文件名：面板里会有**好几条同名的**结果文件（每一轮跑出来的都叫
# 结果_挑出华东区.xlsx，之前的运行目录都还在）。只看文件名会认到一条旧记录 ——
# 旧记录的文件往往还好好的，于是屏幕说「现在还在」，看着就像「产品把不在的文件说成还在」✗。
# 所以每一场给一句**唯一**的说明（指令尾巴上的「现场 xxx」），面板那行
# 「来自「…」：<说明>」就把它区分开了。
# ---------------------------------------------------------------------------
function Find-EntryByExactLine($driverResult, [string]$exactLine, [string]$exactName = "") {
    if (-not $driverResult -or -not $driverResult.panel) { return $null }
    $entries = @($driverResult.panel.entries)
    # 优先用驱动算好的 matchedIndex（它在浏览器里按文档顺序找的第一条）。
    if ($driverResult.panel.matchedIndex -ge 0 -and $driverResult.panel.matchedIndex -lt $entries.Count) {
        return $entries[$driverResult.panel.matchedIndex]
    }
    # 退路：文件名（第一行）+ 来自那一行**都对上**才算。
    # 不能只按「来自…」找：面板里好多条来自同一张卡、同一句话（实跑踩到：
    # 挑到了一个旧记录，它的文件还在 → 看着像「产品把不在的文件说成还在」）。
    foreach ($e in $entries) {
        if (-not $e) { continue }
        $nameOk = (-not $exactName) -or (@($e.lines) -contains $exactName)
        $lineOk = (-not $exactLine) -or (@($e.lines) -contains $exactLine)
        if ($nameOk -and $lineOk) { return $e }
    }
    return $null
}

function Assert-Presence($entry, [string]$expectKind, [string]$scenario) {
    # 逐字比对产品文案（唯一来源 copy-results.ts 的 presence 四句）。
    $PRESENT = '现在还在，能打开。'
    $MISSING = '这个文件现在找不到了：它可能被移动或删掉了；原文件没受影响。可以打开所在文件夹找一找。'
    $UNREADABLE = '这个文件还在，但现在打不开；可能被别的程序占着，关掉它再试一次。'
    $UNKNOWN = '这次没能核对它还在不在。可以打开所在文件夹自己看一眼。'
    $joined = ($entry.lines -join ' | ')
    $ok = $true
    $why = ''
    if ($expectKind -eq 'present') {
        if ($joined -notmatch [regex]::Escape($PRESENT)) { $ok = $false; $why = '没有出现「' + $PRESENT + '」' }
    } elseif ($expectKind -eq 'missing') {
        if ($joined -notmatch [regex]::Escape($MISSING)) { $ok = $false; $why = '没有如实说不在了（应有的原句：' + $MISSING + '）' }
        if ($joined -match [regex]::Escape($PRESENT)) { $ok = $false; $why = '仍然显示成「现在还在，能打开」' }
    }
    # 无论哪种，都不许空白：必须至少有一句「现在还在不在」的话。
    if ($ok -and -not ($joined -match [regex]::Escape($PRESENT) -or $joined -match [regex]::Escape($MISSING) -or $joined -match [regex]::Escape($UNREADABLE) -or $joined -match [regex]::Escape($UNKNOWN))) {
        $ok = $false; $why = '这一条没有「还在不在」的话（空白）'
    }
    $script:verdicts += [pscustomobject]@{ Scenario = $scenario; Kind = $expectKind; Ok = $ok; Why = $why }
    return $ok
}

foreach ($sc in $scenarios) {
    $scenarioCode = 0
    try {
    Say ''
    Say ('=== 现场：' + $sc + ' ===')

    $jobDir = Join-Path $WorkDir ("job-" + $sc)
    $outputFile = $null
    $outputName = $null
    # 每一场给一个**唯一**的标识，接在她那句话后面。它会被原样映到面板那一行
    # 「来自「…」：<说明>」，于是面板里那好几条同名结果也能分辨出**这一场是哪个**。
    #
    # 注意：PowerShell 变量名**不区分大小写** —— 刚开始这里写成 $instruction，而参数叫
    # $Instruction，两个其实是**同一个变量** ：第一场把标识追加进去之后，第二场拿到的
    # 已经是「（现场-normal）」，于是它变成「（现场-normal）（现场-deleted）」……
    # 面板那一行越接越长，按标识找就找不到（实跑踩到）。所以用不会撞名的名字。
    $scenarioTag = '现场-' + $sc
    $scenarioInstruction = $Instruction + '（' + $scenarioTag + '）'
    # 面板那一行的**完整预期文字**（来自「<卡名>」：<她说的那句>）——用它精确找那一条。
    $expectedFromLine = '来自「' + $Card + '」：' + $scenarioInstruction
    # 这一场到底跑没跑任务：报告要如实写（ReuseExisting 那几场**没跑**）。
    $ranTask = $false

    if ($SkipRun) {
        # 调试路：不跑任务，只看面板（用于反复调「读面板」那一段）。它不造现场，
        # 也不下判据 —— 只把面板原文落盘，省得每次都花一分钟跑任务。
        Say ''
        Say '--- -SkipRun：只看面板（不跑任务、不造现场、不下判据）---'
        $look = Invoke-PanelRead ('skiprun-' + $sc)
        if (-not $look) { Say '环境问题：读面板失败（没留下结果 JSON）'; throw 'SCENARIO_EXIT_2' }
        Say ('  面板共 ' + $look.panel.itemCount + ' 条；原文见 ' + (Join-Path $WorkDir ('panel-skiprun-' + $sc)))
        continue
    }

    if ($ReuseExisting) {
        # 不跑任务：改从**现有**结果里挑一条（文件名在本机唯一）当靶子。
        # 为什么可以这样做：「改名 / 移走 / 删掉」这三场要的只是一个已经登记在册、
        # 又真的在盘上的结果文件 —— 它怎么来的不影响这三场的判据。不跑任务就省掉了
        # 一次模型调用（那一轮慢而且会碰上瞬时网络失败）。报告里会写明这几场
        # **没有跑任务**。
        Say ''
        Say '--- -ReuseExisting：不跑任务，用现有结果当靶子 ---'
        $runsFile = Join-Path $env:APPDATA 'dev.cante.gui\file-safety\runs.json'
        if (-not (Test-Path $runsFile)) { Say '环境问题：-ReuseExisting 需要 runs.json，但没找到'; throw 'SCENARIO_EXIT_2' }
        $runs = Get-Content $runsFile -Raw -Encoding UTF8 | ConvertFrom-Json
        # 先统计盘上还活着的文件名，只挑**文件名唯一**的那些（否则面板里好几条同名，
        # 分不清哪条是靶子）。
        $liveNames = @{}
        $candidates = @()
        foreach ($r in @($runs)) {
            foreach ($f in @($r.result.files)) {
                if (-not ($f -and $f.path -and (Test-Path $f.path))) { continue }
                $n = Split-Path -Leaf $f.path
                if (-not $liveNames.ContainsKey($n)) { $liveNames[$n] = 0 }
                $liveNames[$n] = $liveNames[$n] + 1
                $candidates += [pscustomobject]@{ path = $f.path; name = $n; taskTitle = $r.taskTitle; instruction = $r.instruction }
            }
        }
        $pick = $null
        if ($ReuseName) {
            $pick = $candidates | Where-Object { $_.name -eq $ReuseName } | Select-Object -First 1
        } else {
            $pick = $candidates | Where-Object { $liveNames[$_.name] -eq 1 -and $_.instruction -notmatch '（现场-' } | Select-Object -First 1
        }
        if (-not $pick) { Say '环境问题：没找到一条文件名唯一、又还在盘上的现有结果当靶子'; throw 'SCENARIO_EXIT_2' }
        $outputFile = $pick.path
        $outputName = $pick.name
        # 面板那一行要用**这条记录自己的**卡名与说明去找（不是本轮拼的那句）。
        $expectedFromLine = '来自「' + $pick.taskTitle + '」：' + $pick.instruction
        if (-not $pick.instruction) { $expectedFromLine = '来自「' + $pick.taskTitle + '」' }
        SayR ('  靶子（现有结果，没跑任务）：' + $outputFile)
        Say ('  面板上要找的那一行：' + $expectedFromLine)
        # 跳掉跑任务那一段：直接进「破坏前看面板」那一节。
    }

    if (-not $ReuseExisting) {
    $ranTask = $true
    # ---- 1) 先跑一轮（四种现场都要先有一个真的结果文件）
    if (-not $KeepWorkDir -and (Test-Path $jobDir)) { Remove-Item $jobDir -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $jobDir | Out-Null
    $runOut = Join-Path $WorkDir ("accept-" + $sc)
    if (-not $KeepWorkDir -and (Test-Path $runOut)) { Remove-Item $runOut -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $runOut | Out-Null
    Say ('--- 先用现成的入口跑一轮（run-accept-drive.ps1，零环境变量）---')
    Say ('    她那一句话（面板上会看到它，用它区分同名的结果），末尾的「' + $scenarioTag + '」是本轮加的唯一标识')
    $acceptArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $acceptRunner,
        '-WorkDir', $runOut, '-Card', $Card, '-Instruction', $scenarioInstruction,
        '-TimeoutSec', "$RunTimeoutSec", '-KeepWorkDir')
    # 跑前先清一次残留：上一次失败可能留下一个 cante-gui，新的会话会拿不到调试端口
    # （症状和「提权」一样）。run-accept-drive.ps1 自己也清，但这一层再清一次更稳。
    #
    # **为什么要重试**：这一条验的是**结果交付**（面板），跑那一轮只是**造出一个结果文件**
    # 的手段 —— 它本身不是被验对象。实测这一台机器上偶尔会碰到一次**瞬时**网络/服务方
    # 失败（产品如实报了「连不上帮你处理的服务方」）或一次**空白页**（工具链抖动）；
    # 这两种都不是我要验的那个东西，拿它们当「这一场没跑成」是错的。所以我最多跑两轮：
    # 第一节先算「真的跑完（结果页出现）」，失败就清掉残留再跑一次；两次都不行才如实报。
    # 重试次数会写进报告（哪一场只跑了一次、哪一场重试过，不藏）。
    $maxRunAttempts = 2
    $runAttempts = 0
    $accept = $null
    $acceptStdout = ''
    while ($runAttempts -lt $maxRunAttempts) {
        $runAttempts += 1
        if ($runAttempts -gt 1) {
            Say ('  上一轮没跑完（瞬时网络/空白页，不是被验的东西）—— 清掉残留，重跑第 ' + $runAttempts + ' 次。')
            Clear-StaleApp
            Start-Sleep -Seconds 3
            if (Test-Path $runOut) { Remove-Item $runOut -Recurse -Force -ErrorAction SilentlyContinue }
            New-Item -ItemType Directory -Force -Path $runOut | Out-Null
        }
        $accept = Run-Command 'powershell.exe' $acceptArgs ($RunTimeoutSec + 300)
        $acceptStdout = $accept.Stdout
        # 只把关键几行贴出来（整份太长），原文完整落在 $runOut\report.txt。
        $keep = @($acceptStdout -split "`r?`n" | Where-Object { $_ -match '^\[phase\]|^accept-drive:|^run-accept-drive:|^  |结论' })
        SayLines (($keep | Select-Object -Last 40) -join "`n")
        if ($accept.Code -eq 124) { Say '环境问题：跑一轮超时'; throw 'SCENARIO_EXIT_2' }
        if ($accept.Code -eq 0) { break }
        # 会话根本没建起来 → 再试也没用，直接当环境问题（不是产品也不是网络）。
        if ($acceptStdout -match 'DevToolsActivePort|No matching capabilities|can not listen') {
            Say '环境问题：WebDriver 会话建不起来（驱动/端口/提权问题），重试也不会好——如实报环境问题。'
            throw 'SCENARIO_EXIT_2'
        }
    }
    $script:runAttempts = $runAttempts

    $runResultFile = Join-Path $runOut 'result.json'
    if (-not (Test-Path $runResultFile)) { Say '环境问题：跑一轮没留下 result.json'; throw 'SCENARIO_EXIT_2' }
    $runInfo = Get-Content $runResultFile -Raw -Encoding UTF8 | ConvertFrom-Json
    if (-not $runInfo.ok) {
            $opened = $false
            if ($runInfo.drive -and $runInfo.drive.steps) {
                $opened = [bool](@($runInfo.drive.steps | Where-Object { $_.name -like '打开 WebDriver 会话*' }).Count)
            }
            if (-not $opened) { Say ('环境问题：WebDriver 会话没建起来 —— ' + $runInfo.reason); throw 'SCENARIO_EXIT_2' }
            # 跑了 $maxRunAttempts 次都没跑完：说清是「跑那一轮」没成，不是面板判据的问题。
            Say ('环境问题：跑那一轮没成（已试 ' + $runAttempts + ' 次）—— ' + $runInfo.reason)
            Say '  这一条不是结果交付的判据：它只是用来造一个结果文件的手段。报告里如实写这一场**没跑成**。'
            throw 'SCENARIO_EXIT_2'
        }

        # 结果文件：盘上**结果_*.xlsx** 里最新那个（和 run-accept-drive.ps1 同一条判据）。
        $found = @(Get-ChildItem $runOut -Recurse -File -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -like '结果_*.xlsx' } | Sort-Object LastWriteTime -Descending)
        if ($found.Count -eq 0) { Say ('产品问题：跑完没有 结果_*.xlsx 产出（' + $runOut + '）'); throw 'SCENARIO_EXIT_3' }
        $outputFile = $found[0].FullName
        $outputName = $found[0].Name
        SayR ('  这一轮的结果文件：' + $outputFile + '  ' + $found[0].Length + ' 字节')
    }  # end: if (-not $ReuseExisting)

    # ---- 2) 破坏前先看一次面板（normal 的判据就落在这里）
    # 「打开所在文件夹」只在 normal 那一场点：那是唯一有文件可开、也是唯一的判据在它身上的。
    # 其余三场点了只是多开一个窗口，没有用处。
    $clickReveal = ($sc -eq 'normal')
    Say ''
    Say '--- 破坏前：读一次「我做的结果」面板 ---'
    $before = Invoke-PanelRead ($sc + '-before') -ClickReveal:$clickReveal -matchLine $expectedFromLine -matchName $outputName
    if (-not $before) { Say '环境问题：读面板失败（没留下结果 JSON）'; throw 'SCENARIO_EXIT_2' }
    $entryBefore = Find-EntryByExactLine $before $expectedFromLine $outputName
    if (-not $entryBefore) {
        Say ('产品问题：面板里找不到这一场那一条（预期那一行：' + $expectedFromLine + '）')
        Say ('  面板共有 ' + $before.panel.itemCount + ' 条；原文见 ' + (Join-Path $WorkDir ("panel-" + $sc + "-before")))
        throw 'SCENARIO_EXIT_3'
    }
    Say '  这一条在屏幕上是：'
    foreach ($line in @($entryBefore.lines)) { SayR ('    | ' + $line) }
    Assert-Presence $entryBefore 'present' $sc | Out-Null

    if ($sc -eq 'normal') {
        # 破坏前那次已经点了「打开所在文件夹」：核对 shell 里真的多出那个文件夹。
        # 证据是驱动在同一次会话里成对取的（点击前 / 点击后各列一次），这里只看差。
        $expectedFolder = (Split-Path -Parent $outputFile)
        Say ''
        Say '--- 「打开所在文件夹」核对（不信 DOM，看 shell 窗口）---'
        $beforeUrls = @($before.reveal.shellBefore)
        $afterUrls = @($before.reveal.shellAfter)
        SayR ('  点击前 shell 里打开的文件夹：' + $(if ($beforeUrls.Count) { ($beforeUrls -join ' ; ') } else { '(一个都没有)' }))
        SayR ('  点击后 shell 里打开的文件夹：' + $(if ($afterUrls.Count) { ($afterUrls -join ' ; ') } else { '(一个都没有)' }))
        # 判据：点击后多出来的那个文件夹 URL，要指向结果文件所在目录（分隔符放宽）。
        $expectUrl = (($expectedFolder -replace '\\', '/')).TrimEnd('/')
        $matched = $false
        foreach ($u in $afterUrls) {
            $uu = (($u -replace '\\', '/')).TrimEnd('/')
            if ($uu -match [regex]::Escape($expectUrl)) { $matched = $true }
        }
        # 已经开着的窗口里本来就有也算数（第二次点同一个文件夹不会新开一个）。
        if (-not $matched) {
            foreach ($u in $beforeUrls) {
                $uu = (($u -replace '\\', '/')).TrimEnd('/')
                if ($uu -match [regex]::Escape($expectUrl)) { $matched = $true }
            }
        }
        $script:revealMatched = $matched
        if ($matched) { SayR ('  ✓ 真的开到了结果文件所在的那个文件夹（' + $expectedFolder + '）。') }
        else {
            SayR ('  ✗ 没能确认它开到了那个文件夹（shell 里没数到 ' + $expectedFolder + '）。')
            Say '     如实标出来：这一条**没验到**。'
        }
        $script:verdicts += [pscustomobject]@{ Scenario = 'normal'; Kind = 'reveal-opens-folder'; Ok = $matched; Why = $(if ($matched) { '' } else { 'shell 里没数到那个文件夹' }) }
    } else {
        # ---- 3) 造「找不到」：删 / 改名 / 移走。先证破坏真的生效，再读面板。
        $folder = Split-Path -Parent $outputFile
        # 破坏动的如果是**现有结果**（ReuseExisting 那两场），跑完要把它还原回去 ——
        # 否则验收会把她的文件留在别的位置/新名字下（验收不该改别人的东西）。
        # deleted 那场本来是**刚跑出来**的结果，不用还原（它就是本轮的产物）。
        $restoreFrom = $null
        Say ''
        Say ('--- 制造现场：' + $sc + ' ---')
        switch ($sc) {
            'deleted' {
                Remove-Item $outputFile -Force -ErrorAction SilentlyContinue
                if (Test-Path $outputFile) { Say '环境问题：删除没生效（文件还在）'; throw 'SCENARIO_EXIT_2' }
                SayR ('  已删除：' + $outputFile)
            }
            'renamed' {
                $renamed = Join-Path $folder ('改名了_' + $outputName)
                if (Test-Path $renamed) { Remove-Item $renamed -Force -ErrorAction SilentlyContinue }
                Move-Item -LiteralPath $outputFile -Destination $renamed -Force
                if ((Test-Path $outputFile) -or -not (Test-Path $renamed)) { Say '环境问题：改名没生效'; throw 'SCENARIO_EXIT_2' }
                SayR ('  已改名：' + $outputFile + ' -> ' + $renamed)
                $restoreFrom = $renamed
            }
            'moved' {
                $elsewhere = Join-Path $WorkDir '别处'
                New-Item -ItemType Directory -Force -Path $elsewhere | Out-Null
                $moved = Join-Path $elsewhere $outputName
                if (Test-Path $moved) { Remove-Item $moved -Force -ErrorAction SilentlyContinue }
                Move-Item -LiteralPath $outputFile -Destination $moved -Force
                if ((Test-Path $outputFile) -or -not (Test-Path $moved)) { Say '环境问题：移动没生效'; throw 'SCENARIO_EXIT_2' }
                SayR ('  已移走：' + $outputFile + ' -> ' + $moved)
                $restoreFrom = $moved
            }
        }
        # 还原（只对「现有结果」那一类）：放回原位、改回原名。删掉的那场没有可还原的源文件。
        # 注意位置：还原必须放在**读完破坏后面板之后** —— 先还原再读面板的话，面板会看到
        # 文件已经回来、如实说「现在还在」，那这一场就白验了（实跑踩过）。
        $script:restoreStash = $restoreFrom

        Say ''
        Say '--- 破坏后：再读一次「我做的结果」面板 ---'
        $after = Invoke-PanelRead ($sc + '-after') -matchLine $expectedFromLine -matchName $outputName
        if (-not $after) { Say '环境问题：读面板失败（没留下结果 JSON）'; throw 'SCENARIO_EXIT_2' }
        $entryAfter = Find-EntryByExactLine $after $expectedFromLine $outputName
        if (-not $entryAfter) {
            Say ('产品问题：破坏之后面板里**整条都不见了**（预期那一行：' + $expectedFromLine + '）—— 判据要求如实说不在了，不是消失')
            throw 'SCENARIO_EXIT_3'
        }
        Say '  这一条在屏幕上是：'
        foreach ($line in @($entryAfter.lines)) { SayR ('    | ' + $line) }
        $ok = Assert-Presence $entryAfter 'missing' $sc
        # 还有一个可核对的点：「打开文件」按钮要按不动（已经不在时点了只会报错）。
        if ($entryAfter.hasOpen -and $entryAfter.openDisabled -ne $true) {
            $script:verdicts += [pscustomobject]@{ Scenario = $sc; Kind = 'open-disabled'; Ok = $false; Why = '文件不在了，「打开文件」却还是可点的' }
            Say '  ✗ 「打开文件」在文件不在时仍然可点。'
        } else {
            $script:verdicts += [pscustomobject]@{ Scenario = $sc; Kind = 'open-disabled'; Ok = $true; Why = '' }
            Say '  ✓ 「打开文件」在文件不在时不可点（判据要求：不让她点一个只会报错的按钮）。'
        }
        # 读完破坏后的面板，再把靶子还原回去（现在挪回来不会影响已经读到的证据）。
        if ($ReuseExisting -and $script:restoreStash) {
            try {
                Move-Item -LiteralPath $script:restoreStash -Destination $outputFile -Force
                $restored = Test-Path $outputFile
                SayR ('  已还原靶子：' + $script:restoreStash + ' -> ' + $outputFile + '（成功=' + $restored + '）')
                if (-not $restored) {
                    Say '  ✗ 靶子没能还原回去 —— 验收不该把她的文件留在新位置，请手动检查。'
                    $script:restoreFailed = $true
                }
            } catch {
                Say ('  ✗ 还原靶子失败：' + $_.Exception.Message)
                $script:restoreFailed = $true
            }
        }
        $script:restoreStash = $null
    }
    } catch {
        $msg = [string]$_.Exception.Message
        if ($msg -like '*SCENARIO_EXIT_2*') { $scenarioCode = 2 }
        elseif ($msg -like '*SCENARIO_EXIT_3*') { $scenarioCode = 3 }
        else { throw }
    }
    if ($scenarioCode -eq 2) { $script:anyEnv = $true }
    if ($scenarioCode -eq 3) { $script:anyProduct = $true }
    $script:ranTaskByScenario[$sc] = $ranTask
}
# ---------------------------------------------------------------------------
# 汇总
# ---------------------------------------------------------------------------
Say ''
Say '=== 每一场是怎么跑的（报告要如实写）==='
foreach ($sc in $scenarios) {
    $ran = $script:ranTaskByScenario[$sc]
    Say ('  [' + $sc + '] ' + $(if ($ran) { '跑了任务（真的出一份文件）' } else { '**没跑任务**（用现有的结果当靶子）' }))
}
Say ''
Say '=== 判据汇总 ==='
foreach ($v in $script:verdicts) {
    Say ('  ' + $(if ($v.Ok) { '✓' } else { '✗' }) + ' [' + $v.Scenario + '] ' + $v.Kind + $(if ($v.Why) { ' —— ' + $v.Why } else { '' }))
}
$bad = @($script:verdicts | Where-Object { -not $_.Ok })
$script:Lines -join "`r`n" | Set-Content -Path (Join-Path $WorkDir 'report.txt') -Encoding UTF8
Say ''
SayR ('报告原文：' + (Join-Path $WorkDir 'report.txt'))

Clear-StaleApp

if ($script:anyEnv) {
    Say '环境问题：至少有一场因为环境/工具链的原因没跑成（见上面每一场的结论）—— 报告里如实写哪一场没跑成。'
    exit 2
}
if ($script:restoreFailed) {
    Say '环境问题：有靶子没能还原回去（验收不该把她的文件留在新位置）—— 先手动检查再说话。'
    exit 2
}
if ($bad.Count -gt 0) {
    Say ('产品问题：' + $bad.Count + ' 条判据不符合（见上面打了 ✗ 的）。')
    exit 3
}
Say 'run-results-audit: OK — 四种现场的面板文字都符合判据。'
exit 0
