# 量 #239 修复**之后**的「我做的结果」面板结构（真机 UIA）。
#
# #239 之前（`-22.md` §2.5 量的）：面板里有标题（标题级别 2），但**没有一条落在结果上** ——
# 47 份结果只是 47 个并列的 <li>，读屏跳不到「下一份」。
# #239 把每一份的名字做成真 <h3>，并给每个 <ul> 加可数清单（`aria-label="一共 N 份结果"`）。
#
# 这个脚本量三件事（都从**真应用经 WebView2 暴露的 UIA 树**取，不是读源码）：
#   ① 每份结果是不是一个**标题元素**（HeadingLevel 有值）→ 数「有标题的结果数 / 总结果数」；
#   ② 每个 <ul> 的**可访问名字**（读屏进列表时先念的那句）→ 期望 `一共 N 份结果`；
#   ③ 顺手量**确认页**那一屏的标题（上一轮补的那半张）。
#
# 判「一份结果」的锚点：面板里每份结果都是一个 `ListItem`（`<li>`），
# 它的**第一个标题后代**就是这一份的名字（`<h3>`）。这样不依赖 CSS 类名。
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File gui\scripts\windows\a11y\probe-result-headings.ps1 -Exe <exe> -OutDir <目录>
#
# 退出码：0 = 量到并落盘；2 = 环境问题（应用/窗口读不到 / 面板没打开）；3 = 没量到任何结果行。
#
# 注意：本文件必须保存为 UTF-8 with BOM（Windows PowerShell 5.1 否则按 GBK 解析中文）。

param(
    [string]$Exe = "",
    [Parameter(Mandatory = $true)][string]$OutDir,
    [int]$StartupSecs = 14,
    [switch]$KeepRunning
)

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$script:Here = $PSScriptRoot
$script:RepoRoot = (Resolve-Path (Join-Path $script:Here '..\..\..')).Path
$script:Lines = New-Object System.Collections.Generic.List[string]
function Say([string]$t) { Write-Host $t; [void]$script:Lines.Add($t) }
function Redact([string]$text) {
    if ([string]::IsNullOrEmpty($text)) { return $text }
    $out = $text
    $homeDir = $env:USERPROFILE
    if ($homeDir -and $homeDir -match '^[A-Za-z]:[\\/]+Users[\\/]+([^\\/]+)$') {
        $out = $out -replace ('(?i)[A-Za-z]:[\\/]+Users[\\/]+' + [regex]::Escape($Matches[1]) + '(?![A-Za-z0-9._-])'), '<用户目录>'
    }
    $out = $out -replace '\b192\.168\.\d{1,3}\.\d{1,3}', '<内网地址>'
    return $out
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

if ($Exe) { $exePath = (Resolve-Path $Exe).Path }
else {
    $c = Join-Path $script:RepoRoot 'gui\src-tauri\target\debug\cante-gui.exe'
    if (Test-Path $c) { $exePath = $c } else {
        $i = Join-Path $env:LOCALAPPDATA 'Cante\cante-gui.exe'
        if (Test-Path $i) { $exePath = $i } else { Say '环境问题：找不到 cante-gui.exe'; exit 2 }
    }
}

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--force-renderer-accessibility'
$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
$CVR = [System.Windows.Automation.TreeWalker]::ControlViewWalker

function Clear-Stale {
    Get-Process cante-gui -ErrorAction SilentlyContinue | ForEach-Object { try { Stop-Process -Id $_.Id -Force } catch {} }
    Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like '*dev.cante.gui*' } |
        ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force } catch {} }
    Start-Sleep -Seconds 2
}
function All($r) { return $r.FindAll($TS::Descendants, [System.Windows.Automation.Condition]::TrueCondition) }
function FindC($r, $n, [int]$t = 15) {
    $d = (Get-Date).AddSeconds($t)
    while ((Get-Date) -lt $d) {
        foreach ($e in (All $r)) { if (([string]$e.Current.Name).Contains($n)) { return $e } }
        Start-Sleep -Milliseconds 400
    }
    return $null
}
function Kind($e) { $t = $e.Current.ControlType.ProgrammaticName; if ($t.Contains('.')) { $t = $t.Substring($t.LastIndexOf('.') + 1) }; return $t }
function HeadingLevel($e) {
    try { $hl = $e.GetCurrentPropertyValue([System.Windows.Automation.AutomationElement]::HeadingLevelProperty) } catch { return $null }
    $s = "$hl"
    if ($s -match '^Level([1-9])$') { return [int]$Matches[1] }
    return $null
}
# 一个元素下面所有后代（ControlView）
function Desc($e) { return $e.FindAll($TS::Descendants, [System.Windows.Automation.Condition]::TrueCondition) }

Say ('应用：' + (Redact $exePath))
Clear-Stale
$p = Start-Process -FilePath $exePath -PassThru
Start-Sleep -Seconds $StartupSecs
$p.Refresh()
if ($p.HasExited) {
    Say ('应用退出了（exit ' + $p.ExitCode + '），清残留重试一次')
    Clear-Stale
    $p = Start-Process -FilePath $exePath -PassThru
    Start-Sleep -Seconds $StartupSecs
    $p.Refresh()
}
if ($p.HasExited -or $p.MainWindowHandle -eq 0) { Say '环境问题：应用起不来 / 拿不到窗口'; exit 2 }
$root = $AE::FromHandle($p.MainWindowHandle)
Say ('窗口句柄=' + $p.MainWindowHandle)

function ClickN($r, $n, [int]$t = 12) { $e = FindC $r $n $t; if ($e) { try { $e.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke(); return $true } catch { return $false } }; return $false }

# 走完向导（若出现）
if (-not (FindC $root '需要我帮你做什么' 20)) {
    foreach ($s in @('开始检查', '下一步', '先看看界面', '开始使用')) { if (ClickN $root $s 8) { Say ('  向导：点了「' + $s + '」') }; Start-Sleep -Seconds 2 }
    Start-Sleep -Seconds 2
}
Say ('到首页 = ' + [bool](FindC $root '需要我帮你做什么' 15))

# ---------------------------------------------------------------- 面板
Say ''
Say '=== 「我做的结果」面板 ==='
$entry = FindC $root '打开我做的结果' 20
if (-not $entry) { Say '环境问题：首页上找不到「我做的结果」入口'; if (-not $KeepRunning) { Stop-Process -Id $p.Id -Force }; exit 2 }
[void](ClickN $root '打开我做的结果' 10)
Start-Sleep -Seconds 3
if (-not (FindC $root '回到首页' 15)) { Say '环境问题：面板没打开'; if (-not $KeepRunning) { Stop-Process -Id $p.Id -Force }; exit 2 }
Say '面板已打开'

$all = All $root
$items = @($all | Where-Object { (Kind $_) -eq 'ListItem' })
$lists = @($all | Where-Object { (Kind $_) -eq 'List' })
$headings = @()
foreach ($e in $all) { $lv = HeadingLevel $e; if ($lv) { $headings += [pscustomobject]@{ name = $e.Current.Name; level = $lv } } }

Say ('List 节点 = ' + $lists.Count + ' ; ListItem 节点 = ' + $items.Count + ' ; 有标题级别的节点 = ' + $headings.Count)

# ① 每份结果：ListItem 里有没有标题后代
Say ''
Say '=== ① 每份结果是不是一个标题元素（ListItem 的第一个标题后代）==='
$rows = 0; $withHeading = 0
$detail = @()
foreach ($it in $items) {
    $rows++
    $name = [string]$it.Current.Name
    $h = $null
    foreach ($d in (Desc $it)) {
        $lv = HeadingLevel $d
        if ($lv) { $h = [pscustomobject]@{ text = $d.Current.Name; level = $lv }; break }
    }
    if ($h) { $withHeading++ }
    $detail += [pscustomobject]@{
        row = $rows
        itemName = $name
        headingText = $(if ($h) { $h.text } else { $null })
        headingLevel = $(if ($h) { $h.level } else { $null })
    }
    $shown = $(if ($h) { ('L' + $h.level + '「' + (Redact $h.text) + '」') } else { '（没有标题）' })
    Say (('  #' + $rows).PadRight(5) + $shown)
}
$script:rows = $rows
$script:withHeading = $withHeading
Say ''
Say ('有标题的结果数 = ' + $withHeading + ' / 总结果数 = ' + $rows + '  → ' + $(if ($rows -gt 0 -and $withHeading -eq $rows) { '每一份都有标题 ✓' } else { '有结果没有标题 ✗' }))
if ($rows -eq 0) { Say '（这个面板里一份结果都没有 —— 需要先铺夹具：seed-result-rows.ps1）' }

# ② 每个 <ul> 的可访问名字
Say ''
Say '=== ② 每个列表的可访问名字（期望「一共 N 份结果」）==='
$ulOk = 0; $ulBad = 0
foreach ($l in $lists) {
    $nm = [string]$l.Current.Name
    $ok = ($nm -match '^一共 \d+ 份结果$')
    if ($ok) { $ulOk++ } else { $ulBad++ }
    Say ('  List  name=[' + $nm + ']  ' + $(if ($ok) { '✓' } else { '✗ 不是「一共 N 份结果」' }))
}
Say ('列表名字合规 = ' + $ulOk + ' / ' + $lists.Count)
# 分组标题（h3 的组名）也要单列出来，便于看层级
$groupHeads = @($headings | Where-Object { $_.level -eq 3 -and $_.name -notmatch '\.xlsx|\.csv|\.docx|\.txt' })
Say ('  另外，像「组名」的三级标题 = ' + $groupHeads.Count + '（今天做的/这周做的/更早做的 之类）')

# ---------------------------------------------------------------- 确认页（顺带）
Say ''
Say '=== ③ 顺带：确认页那一屏的标题 ==='
# 回首页 → 点文字卡 → 贴一句 → 生成计划（不需要模型）
[void](ClickN $root '回到首页' 10)
Start-Sleep -Seconds 2
$card = FindC $root '把这段时间做的事写成一份总结' 15
if ($card) {
    [void](ClickN $root '把这段时间做的事写成一份总结' 10)
    Start-Sleep -Seconds 2
    $box = $null
    foreach ($e in (All $root)) { if ($e.Current.AutomationId -eq 'task-instruction') { $box = $e; break } }
    if ($box) { try { $box.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue('把这段时间做的事写成一份总结') } catch {} }
    [void](ClickN $root '生成计划' 15)
    Start-Sleep -Seconds 3
    if (FindC $root '它打算这样做' 20) {
        $cf = All $root
        $cfHeads = @()
        foreach ($e in $cf) { $lv = HeadingLevel $e; if ($lv) { $cfHeads += ('L' + $lv + '「' + (Redact $e.Current.Name) + '」') } }
        Say ('确认页标题数 = ' + $cfHeads.Count)
        foreach ($h in $cfHeads) { Say ('  ' + $h) }
    } else { Say '确认页没走到（这一场没验成 —— 只报事实）' }
} else { Say '首页上找不到文字卡（这一场没验成）' }

# 落盘
($script:Lines -join "`r`n") | Set-Content -Path (Join-Path $OutDir 'result-headings.txt') -Encoding UTF8
[pscustomobject]@{
    rows = $rows; withHeading = $withHeading
    lists = $lists.Count; ulNamed = $ulOk
    headings = $headings
    detail = $detail
} | ConvertTo-Json -Depth 6 | Set-Content -Path (Join-Path $OutDir 'result-headings.json') -Encoding UTF8
Say ''
Say ('产物：' + (Redact $OutDir))

if (-not $KeepRunning) { try { Stop-Process -Id $p.Id -Force } catch {} }
Clear-Stale
if ($rows -eq 0) { exit 3 }
Say 'probe-result-headings: OK'
exit 0
