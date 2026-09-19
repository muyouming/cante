# 在真 Windows 上读「结果页」与「我做的结果」两屏的**真实文字**（UI Automation）。
#
# 为什么需要它：WebDriver 那条路（accept-drive.mjs）只能拿到 `body` 的 textContent，
# 而且它一走到结果页就退出；而这一轮要核的是**结果页上的新文案**（文件在哪、怎么打印）
# 和**「我做的结果」面板里有没有机器路径**。两件事都要在人看的那一屏上读到**渲染出来的字**。
#
# 为什么不用 WebDriver 读结果页：msedgedriver 启动应用时会覆盖
# WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS（实测），于是 UIA 树读不到 DOM。所以这里
# **自己启动应用**并设 --force-renderer-accessibility（与 read-confirm-visible.ps1 同一套）。
#
# 它做三件事：
#   1. 自己启动应用（应用旁边有随包的 pi/，零环境变量也能干活）；
#   2. 点一张**文字卡**（不需要原生文件对话框，UIA 能独自走完全程）→ 贴一段来料 →
#      生成计划 → 开始 → 替她点审批/提问，直到结果页；把结果页的**所有文字**原样落盘；
#   3. 回首页 → 打开「我做的结果」→ 把面板里的**所有文字**原样落盘（用来查有没有机器路径）。
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File read-result-page.ps1 `
#     -Exe "<装好的 cante-gui.exe>" -OutDir "<落盘目录>" -LedgerFile "<来料.txt>"
#
# 退出码：0 = 两屏都读到了；2 = 环境问题（进程/窗口起不来）；3 = 没走到结果页。
#
# 注意：本文件必须保存为 UTF-8 with BOM（Windows PowerShell 5.1 否则按 GBK 解析中文）。

param(
    [string]$Exe = "$env:LOCALAPPDATA\Cante\cante-gui.exe",
    [Parameter(Mandatory = $true)][string]$OutDir,
    # 文字卡：needs:"text"，不用选文件（UIA 驱动不了原生对话框）。
    [string]$Card = "把这段时间做的事写成一份总结",
    [string]$Instruction = "把我这几个月的流水账写成一份工作总结，别写得太长",
    [string]$LedgerFile = "",
    [string]$AdminConfig = "",
    [int]$ResultTimeoutSec = 1800,
    [switch]$KeepRunning,
    # 只读「我做的结果」面板（不跑任务）：用来单独查面板里有没有机器路径。
    # runs.json 里有历史运行时这条很快（秒级），比驱动一整张卡稳得多。
    [switch]$PanelOnly,
    # 文件卡模式：走「点卡 → 选文件 → 下一步 → 写一句 → 生成计划 → 开始」。
    # 比文字卡快得多（文件卡约半分钟；文字卡实测过 10 分钟以上）。原生对话框
    # 由 accept-file-dialog.ps1（Win32 WM_SETTEXT）填，不是 UIA 干的。
    [string]$InputFile = "",
    [string]$DialogHelper = "",
    [int]$DialogTimeoutSec = 90
)

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

# WebView2 把 DOM 暴露成 UIA 树：必须在**应用启动前**设，且只能在应用自己启动时生效。
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--force-renderer-accessibility'

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

# 企业预置：让向导不拦路（没走过向导的机器上，卡片不会在首页出现）。
# 无 BOM 写（PS5.1 的 -Encoding UTF8 会加 BOM，应用读不出来）。
if (-not $AdminConfig) { $AdminConfig = Join-Path $OutDir 'admin.json' }
if (-not (Test-Path $AdminConfig)) {
    $json = '{"default_provider":null,"default_model":null,"allow_network":true,"disabled_tasks":[]}'
    [System.IO.File]::WriteAllText($AdminConfig, $json, (New-Object System.Text.UTF8Encoding($false)))
}
$env:CANTE_ADMIN_CONFIG = $AdminConfig

$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
$CT = [System.Windows.Automation.ControlType]

$script:Lines = New-Object System.Collections.Generic.List[string]
function Say([string]$t) { Write-Output $t; [void]$script:Lines.Add($t) }

$script:Result = [ordered]@{ ok = $false; card = $Card; exe = $Exe; gates = @{ approvals = 0; questions = 0; followups = 0 }; panelOnly = [bool]$PanelOnly }
function Write-Result {
    $script:Result | ConvertTo-Json -Depth 6 | Set-Content -Path (Join-Path $OutDir 'read-result.json') -Encoding UTF8
    ($script:Lines -join "`r`n") | Set-Content -Path (Join-Path $OutDir 'read-result-report.txt') -Encoding UTF8
}

function All-Descendants($root) { return $root.FindAll($TS::Descendants, [System.Windows.Automation.Condition]::TrueCondition) }

function Dump-Text($root) {
    $out = @()
    foreach ($t in (All-Descendants $root)) {
        $n = $t.Current.Name
        if ($n -and $n.Trim() -and ($out -notcontains $n)) { $out += $n }
    }
    return $out
}

function Find-ByName($root, [string]$name, [int]$timeoutSec = 20) {
    $deadline = (Get-Date).AddSeconds($timeoutSec)
    while ((Get-Date) -lt $deadline) {
        $cond = New-Object System.Windows.Automation.PropertyCondition($AE::NameProperty, $name)
        $el = $root.FindFirst($TS::Descendants, $cond)
        if ($el) { return $el }
        Start-Sleep -Milliseconds 400
    }
    return $null
}

function Find-ByNamePrefix($root, [string]$prefix, [int]$timeoutSec = 20) {
    $deadline = (Get-Date).AddSeconds($timeoutSec)
    while ((Get-Date) -lt $deadline) {
        foreach ($el in (All-Descendants $root)) {
            $n = $el.Current.Name
            if ($n -and $n.StartsWith($prefix)) { return $el }
        }
        Start-Sleep -Milliseconds 400
    }
    return $null
}

function Click-El($el) {
    $p = $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
    $p.Invoke()
}

function Body-Text($root) {
    return ((Dump-Text $root) -join "`n")
}

# 等她屏幕上出现某句话；出现就返回整屏文字。
function Wait-For($root, [string]$needle, [int]$timeoutSec) {
    $deadline = (Get-Date).AddSeconds($timeoutSec)
    while ((Get-Date) -lt $deadline) {
        $text = Body-Text $root
        if ($text -match [regex]::Escape($needle)) { return $text }
        Start-Sleep -Seconds 1
    }
    return $null
}

# 处理挡路的浮层：审批 → 允许这次；结构化提问 → 按它的建议来；追问 → 你看着办。
# 返回这一轮替她点了几次（都是产品里真实存在的按钮名字）。
#
# **必须先用浮层标题判断它是不是真的开着**：UIA 会暴露「已渲染但不显示」的元素，
# 所以 Find-ByName 能找到按钮、它却并不在那个浮层上（实测：不判断标题就会每秒盲点
# 同一个按钮，一轮点了 92 次，把模型问疯了 ✗）。同时要求按钮元素**不在屏外**。
function Clear-Gates($root) {
    $counts = @{ approvals = 0; questions = 0; followups = 0 }
    $text = Body-Text $root
    foreach ($pair in @(
        @('要不要允许它继续？', '允许这次',     'approvals'),
        @('它想问你几件事',    '按它的建议来', 'questions'),
        @('它有一件事想问你',  '你看着办',     'followups')
    )) {
        if ($text -notmatch [regex]::Escape($pair[0])) { continue }
        $el = Find-ByName $root $pair[1] 2
        if (-not $el) { continue }
        if ($el.Current.IsOffscreen) { continue }
        Click-El $el
        $counts[$pair[2]]++
        # 点完等浮层真关掉（标题消失）再继续；关不掉也别在同一秒里重点。
        $deadline = (Get-Date).AddSeconds(20)
        while ((Get-Date) -lt $deadline) {
            Start-Sleep -Milliseconds 500
            if ((Body-Text $root) -notmatch [regex]::Escape($pair[0])) { break }
        }
    }
    return $counts
}

# --- 启动 ---
$proc = Start-Process -FilePath (Resolve-Path $Exe).Path -PassThru
Start-Sleep -Seconds 12
$proc.Refresh()
if ($proc.HasExited) { Say ("应用已退出（exit " + $proc.ExitCode + "）"); Say 'ENV:应用起不来'; exit 2 }
$root = $AE::FromHandle($proc.MainWindowHandle)
if ($null -eq $root) { Say '读不到主窗口'; Stop-Process -Id $proc.Id -Force; Say 'ENV:没有主窗口'; exit 2 }
Say ("应用 pid=" + $proc.Id + " 句柄=" + $proc.MainWindowHandle)

$result = $script:Result

function Open-Panel($root) {
    $panelEl = Find-ByNamePrefix $root '打开我做的结果' 20
    if (-not $panelEl) { return $null }
    Click-El $panelEl
    Start-Sleep -Seconds 3
    return (Body-Text $root)
}

# --- 首页 ---
if (-not (Wait-For $root '需要我帮你做什么' 30)) {
    Say '首页没出现（是向导拦路吗？）——当前屏幕：'
    foreach ($t in (Dump-Text $root)) { Say ('  | ' + $t) }
    Stop-Process -Id $proc.Id -Force
    Say 'ENV:首页没出现'
    exit 2
}
Say ''
Say '=== 首页已到 ==='

if ($PanelOnly) {
    Say '（PanelOnly：跑一张卡，只读「我做的结果」面板）'
    $panelText = Open-Panel $root
    if (-not $panelText) { Stop-Process -Id $proc.Id -Force; Say 'PRODUCT:没有结果面板入口'; Write-Result; exit 3 }
    $panelPath = Join-Path $OutDir 'results-panel.txt'
    $panelText | Set-Content -Path $panelPath -Encoding UTF8
    Say ''
    Say '=== 「我做的结果」面板（UIA 原样读回）==='
    foreach ($t in (Dump-Text $root)) { Say ('  | ' + $t) }
    Say ("（面板文字落盘：" + $panelPath + "）")
    $result.ok = $true
    if (-not $KeepRunning) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
    Write-Result
    Say ''
    Say 'read-result-page: OK — 「我做的结果」面板已读回。'
    exit 0
}

Say '=== 点卡片 ==='

# --- 点卡片 ---
$cardEl = Find-ByNamePrefix $root $Card 30
if (-not $cardEl) {
    Say ("找不到卡片：" + $Card + "；当前按钮/文字：")
    foreach ($t in (Dump-Text $root)) { Say ('  | ' + $t) }
    Stop-Process -Id $proc.Id -Force
    Say 'PRODUCT:找不到卡片'
    exit 3
}
Say ("卡片按钮 Name=" + $cardEl.Current.Name)
Click-El $cardEl
Start-Sleep -Seconds 2

# --- 文件卡：先用 Win32 助手填掉原生对话框，再「下一步」 ---
if ($InputFile) {
    if (-not (Wait-For $root '选择文件' 30)) {
        Say '选文件这一步没出现；当前屏幕：'
        foreach ($t in (Dump-Text $root)) { Say ('  | ' + $t) }
        Stop-Process -Id $proc.Id -Force
        Say 'PRODUCT:选文件这一步不在'
        exit 3
    }
    $helperArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $DialogHelper, '-Path', $InputFile, '-TimeoutSec', [string]$DialogTimeoutSec)
    $helper = Start-Process -FilePath 'powershell' -ArgumentList $helperArgs -PassThru -NoNewWindow -RedirectStandardOutput (Join-Path $OutDir 'dialog.log') -RedirectStandardError (Join-Path $OutDir 'dialog.err')
    $chooseEl = Find-ByName $root '选择文件' 20
    if (-not $chooseEl) { Say '找不到「选择文件」按钮'; Stop-Process -Id $proc.Id -Force; Say 'PRODUCT:没有选择文件按钮'; exit 3 }
    Click-El $chooseEl
    $helper.WaitForExit(($DialogTimeoutSec + 30) * 1000) | Out-Null
    Say ("填对话框助手退出码=" + $helper.ExitCode + "（日志：" + (Join-Path $OutDir 'dialog.log') + "）")
    $basename = Split-Path -Leaf $InputFile
    if (-not (Wait-For $root $basename 30)) {
        Say ("选中文件后屏幕里没出现「" + $basename + "」；当前屏幕：")
        foreach ($t in (Dump-Text $root)) { Say ('  | ' + $t) }
        Stop-Process -Id $proc.Id -Force
        Say 'PRODUCT:文件没选上'
        exit 3
    }
    $nextEl = Find-ByName $root '下一步' 20
    if ($nextEl) { Click-El $nextEl; Start-Sleep -Seconds 2 }
    Say ("已选文件并下一步：" + $basename)
}

# --- 写需求（文字卡没有选文件那一步） ---
$instrEl = $root.FindFirst($TS::Descendants, (New-Object System.Windows.Automation.PropertyCondition($AE::AutomationIdProperty, 'task-instruction')))
if (-not $instrEl) {
    Say '找不到 #task-instruction（这张卡也许要选文件）——当前屏幕：'
    foreach ($t in (Dump-Text $root)) { Say ('  | ' + $t) }
    Stop-Process -Id $proc.Id -Force
    Say 'PRODUCT:输入框不在（可能不是文字卡）'
    exit 3
}
$payload = $Instruction
if ($LedgerFile -and (Test-Path $LedgerFile)) {
    $ledger = Get-Content $LedgerFile -Raw -Encoding UTF8
    $payload = $Instruction + "`r`n`r`n" + $ledger
}
$vp = $instrEl.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
$vp.SetValue($payload)
Say '已写入输入框'

$gpEl = Find-ByName $root '生成计划' 30
if (-not $gpEl) { Say '找不到「生成计划」'; Stop-Process -Id $proc.Id -Force; Say 'PRODUCT:没有生成计划'; exit 3 }
Click-El $gpEl
Say '已点「生成计划」'

# --- 确认页 → 开始 ---
if (-not (Wait-For $root '它打算这样做' 60)) {
    Say '确认页没出现——当前屏幕：'
    foreach ($t in (Dump-Text $root)) { Say ('  | ' + $t) }
    Stop-Process -Id $proc.Id -Force
    Say 'PRODUCT:确认页没出现'
    exit 3
}
Say '确认页已到'
$startEl = Find-ByName $root '开始' 20
if (-not $startEl) { Say '找不到「开始」'; Stop-Process -Id $proc.Id -Force; Say 'PRODUCT:没有开始按钮'; exit 3 }
Click-El $startEl
Say '已点「开始」'

# --- 等她做完：一边等一边替她点审批/提问 ---
Say ''
Say '=== 干活中（含替她点审批/提问）==='
$deadline = (Get-Date).AddSeconds($ResultTimeoutSec)
$sawResult = $false
$totals = @{ approvals = 0; questions = 0; followups = 0 }
while ((Get-Date) -lt $deadline) {
    $c = Clear-Gates $root
    $totals.approvals += $c.approvals; $totals.questions += $c.questions; $totals.followups += $c.followups
    $text = Body-Text $root
    if ($text -match '做好了' -or $text -match '这件事没有做完' -or $text -match '这次没能做完') { $sawResult = $true; break }
    Start-Sleep -Seconds 1
}
$result.gates = $totals
Say ("替她点了：审批 " + $totals.approvals + " 次、结构化提问 " + $totals.questions + " 次、追问 " + $totals.followups + " 次")

$resultText = Body-Text $root
$resultTextPath = Join-Path $OutDir 'result-page.txt'
$resultText | Set-Content -Path $resultTextPath -Encoding UTF8
Say ''
Say '=== 结果页（UIA 原样读回）==='
foreach ($t in (Dump-Text $root)) { Say ('  | ' + $t) }
Say ("（结果页文字落盘：" + $resultTextPath + "）")

if (-not $sawResult) {
    if (-not $KeepRunning) { Stop-Process -Id $proc.Id -Force }
    Say 'PRODUCT:到上限也没看到结果页'
    Write-Result
    exit 3
}

# --- 回首页 → 打开「我做的结果」 ---
Say ''
Say '=== 回首页，打开「我做的结果」==='
$homeEl = Find-ByName $root '返回首页' 20
if ($homeEl) { Click-El $homeEl; Start-Sleep -Seconds 2 }
if (-not (Wait-For $root '需要我帮你做什么' 30)) {
    Say '回不到首页——当前屏幕：'
    foreach ($t in (Dump-Text $root)) { Say ('  | ' + $t) }
    if (-not $KeepRunning) { Stop-Process -Id $proc.Id -Force }
    Say 'PRODUCT:回不到首页'
    Write-Result
    exit 3
}

$panelEl = Find-ByNamePrefix $root '打开我做的结果' 20
if (-not $panelEl) { Say '找不到「打开我做的结果」入口'; if (-not $KeepRunning) { Stop-Process -Id $proc.Id -Force } ; Say 'PRODUCT:没有结果面板入口'; Write-Result; exit 3 }
Say ("入口按钮 Name=" + $panelEl.Current.Name)
Click-El $panelEl
Start-Sleep -Seconds 3

$panelText = Body-Text $root
$panelPath = Join-Path $OutDir 'results-panel.txt'
$panelText | Set-Content -Path $panelPath -Encoding UTF8
Say ''
Say '=== 「我做的结果」面板（UIA 原样读回）==='
foreach ($t in (Dump-Text $root)) { Say ('  | ' + $t) }
Say ("（面板文字落盘：" + $panelPath + "）")

$result.ok = $true
if (-not $KeepRunning) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }

Write-Result
Say ''
Say 'read-result-page: OK — 结果页与「我做的结果」两屏都读到了。'
exit 0
