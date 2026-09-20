# 「读屏会怎么念」清单（真机，UIAutomation）—— 可按视图走。
#
# 为什么需要它：`-19.md` / `-20.md` 验到了「每个控件**有**名字」「结果面板每行**名字不同**」
# （M 从 3 涨到 95），但**读屏实际念出来是什么**一次都没验过（`-19.md` §6 自己写的：没有读屏软件）。
# 这一份把「读屏会念成什么」**在真机上算出来** —— 不是猜：
#
#   * 走的是**真应用**经 WebView2 暴露出来的 **UIA 树**（`--force-renderer-accessibility`）；
#   * 顺序用 UIA 的树序（深度优先 = 文档顺序 = 读屏朗读顺序）；
#   * 每条给 **`ControlType` + `Name`**，因为读屏念的就是这两样（控件类型 + 名字）；
#   * 另外单列 **`HeadingLevel`**（能不能按标题跳）与 **`IsKeyboardFocusable`**（能不能 Tab 到）。
#
# **为什么要有 `-View` 这个开关**（这一条很关键）：UIA 有三个视图 ——
# RawView（一切节点）/ ControlView（控件）/ ContentView（内容）。**读屏念的是
# ControlView / ContentView**，不是 RawView。同一棵树上两者差别很大（实测首页：
# RawView 146 个节点，其中 74 个 `IsControlElement=False`；ControlView 只有 72 个）。
# 只走 RawView 会把**读屏根本不念**的布局节点当成会被念的东西，得出**反向结论**
# （例如把「同一个标题念两遍」当成产品问题 —— 其实那是 RawView 里一个 `IsControlElement=False`
# 的布局节点，ControlView 里那个标题只出现一次）。所以这里默认走 **Control**，并把视图打出来。
#
# 它**不**驱动 Narrator（做不到：Narrator.exe 没有命令行开关、没有可驱动窗口、且起不来 →
# 见 `WINDOWS-ACCEPTANCE-22.md` §1）。它做的是**把读屏会用的那两个字段读出来**，
# 让看报告的人判断"她听到的是不是人话"。
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File gui\scripts\windows\a11y\narrate-views.ps1 -Scenario home
#   ... -Scenario confirm
#   ... -Scenario results
#   ... -Scenario home -View Raw     （对照用）
#
# 退出码：0 = 取到并落盘；2 = 环境问题（应用/窗口读不到）；3 = 没取到任何可朗读节点。
#
# 注意：本文件必须保存为 UTF-8 with BOM（Windows PowerShell 5.1 否则按 GBK 解析中文）。
#
# Session 1 提示：SSH 落在会话 0（没有桌面），UIA 与真键盘在那里不工作。
# 要走**交互桌面会话**（会话 1），用一条 Interactive 的计划任务来跑这个脚本。
param(
    [ValidateSet('home', 'confirm', 'results')][string]$Scenario = 'home',
    [ValidateSet('Raw', 'Control', 'Content')][string]$View = 'Control',
    [string]$Exe = "",
    [string]$WorkDir = "",
    [int]$StartupSecs = 14
)

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$script:Here = $PSScriptRoot
# 本脚本在 gui\scripts\windows\a11y\ —— 比 a11y-uia.ps1（在 windows\ 下）**多一层**，
# 所以往上数三层才是 gui\（少算一层会让 Resolve-AppExe 找不到现构建，静默回退到装好的那份）。
$script:GuiRoot = (Resolve-Path (Join-Path $script:Here '..\..\..')).Path
$script:RepoRoot = (Resolve-Path (Join-Path $script:GuiRoot '..')).Path
$script:Lines = New-Object System.Collections.Generic.List[string]
function Say([string]$t) { Write-Host $t; [void]$script:Lines.Add($t) }
# 报告里绝不出现真实家目录 / 内网地址（CI 的秘密扫描会判红，见 gui/scripts/secret-scan.sh）。
function Redact([string]$text) {
    if ([string]::IsNullOrEmpty($text)) { return $text }
    $out = $text
    $homeDir = $env:USERPROFILE
    if ($homeDir -and $homeDir -match '^[A-Za-z]:[\\/]+Users[\\/]+([^\\/]+)$') {
        $userSeg = $Matches[1]
        $out = $out -replace ('(?i)[A-Za-z]:[\\/]+Users[\\/]+' + [regex]::Escape($userSeg) + '(?![A-Za-z0-9._-])'), '<用户目录>'
    }
    $out = $out -replace '\b192\.168\.\d{1,3}\.\d{1,3}(?::\d+)?', '<内网地址>'
    $out = $out -replace '\b172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}(?::\d+)?', '<内网地址>'
    $out = $out -replace '\b10\.\d{1,3}\.\d{1,3}\.\d{1,3}(?::\d+)?', '<内网地址>'
    return $out
}
function SayR([string]$t) { Say (Redact $t) }

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
Say ('会话：session=' + (Get-Process -Id $PID).SessionId + ' elevated=' + $isAdmin + ' 有桌面=' + [bool](Get-Process explorer -ErrorAction SilentlyContinue))
if ($isAdmin) { Say '环境问题：提权会话'; exit 2 }

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class NV2 {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, int d, UIntPtr e);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
}
"@
$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--force-renderer-accessibility'

if (-not $WorkDir) { $WorkDir = Join-Path $env:TEMP ('cante-nv-' + $Scenario + '-' + $View) }
New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null

function Resolve-AppExe([string]$Given) {
    if ($Given) { if (Test-Path $Given) { return (Resolve-Path $Given).Path } else { return $null } }
    foreach ($c in @(
        (Join-Path $script:RepoRoot 'gui\src-tauri\target\debug\cante-gui.exe'),
        (Join-Path $script:RepoRoot 'gui\src-tauri\target\release\cante-gui.exe')
    )) { if (Test-Path $c) { return (Resolve-Path $c).Path } }
    $installed = Join-Path $env:LOCALAPPDATA 'Cante\cante-gui.exe'
    if (Test-Path $installed) { return (Resolve-Path $installed).Path }
    return $null
}
function Clear-Stale {
    Get-Process cante-gui, cante-bridge -ErrorAction SilentlyContinue | ForEach-Object { try { Stop-Process -Id $_.Id -Force -ErrorAction Stop } catch {} }
    Start-Sleep -Seconds 2
}
function Kind-Of($el) {
    $t = $el.Current.ControlType.ProgrammaticName
    if ($t -and $t.Contains('.')) { return $t.Substring($t.LastIndexOf('.') + 1) }
    return $t
}
function Wait-Contains($root, [string]$needle, [int]$timeoutSec = 20) {
    $d = (Get-Date).AddSeconds($timeoutSec)
    while ((Get-Date) -lt $d) {
        foreach ($e in $root.FindAll($TS::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) {
            $n = [string]$e.Current.Name
            if ($n -and $n.Contains($needle)) { return $e }
        }
        Start-Sleep -Milliseconds 400
    }
    return $null
}
function Click-El($el) { try { $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke(); return $true } catch { return $false } }
function Click-Named($root, [string]$name) {
    foreach ($c in $root.FindAll($TS::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) {
        $n = [string]$c.Current.Name
        if ($n -and $n.Trim() -eq $name) { return (Click-El $c) }
    }
    return $false
}
function Advance-Wizard($root, [int]$timeoutSec = 60) {
    $d = (Get-Date).AddSeconds($timeoutSec)
    while ((Get-Date) -lt $d) {
        if (Wait-Contains $root '需要我帮你做什么' 2) { return $true }
        $clicked = $false
        foreach ($label in @('开始检查', '下一步', '先看看界面', '开始使用')) {
            if (Click-Named $root $label) { Start-Sleep -Seconds 3; $clicked = $true; break }
        }
        if (-not $clicked) { Start-Sleep -Milliseconds 600 }
    }
    return $false
}

$exePath = Resolve-AppExe $Exe
if (-not $exePath) { Say '环境问题：找不到现构建的 cante-gui.exe'; exit 2 }
Say ('应用：' + $exePath)
Say ('场景：' + $Scenario + '  视图：' + $View)

$profileDir = Join-Path $env:LOCALAPPDATA 'dev.cante.gui'
$historyDir = Join-Path $env:APPDATA 'dev.cante.gui'
Clear-Stale
if ($Scenario -ne 'results') {
    foreach ($d in @($profileDir, $historyDir)) { if (Test-Path $d) { Remove-Item $d -Recurse -Force -ErrorAction SilentlyContinue } }
}
$p = Start-Process -FilePath $exePath -PassThru
Start-Sleep -Seconds $StartupSecs
$p.Refresh()
if ($p.HasExited -or $p.MainWindowHandle -eq 0) { Say '环境问题：应用起不来'; exit 2 }
$hwnd = $p.MainWindowHandle
$root = $AE::FromHandle($hwnd)
Say ('窗口句柄=' + $hwnd)
[void][NV2]::SetForegroundWindow($hwnd)

switch ($Scenario) {
    'home' {
        if (-not (Wait-Contains $root '需要我帮你做什么' 20)) { [void](Advance-Wizard $root 60) }
        if (-not (Wait-Contains $root '需要我帮你做什么' 15)) { Say '环境问题：没走到首页'; exit 2 }
    }
    'confirm' {
        if (-not (Wait-Contains $root '需要我帮你做什么' 20)) { [void](Advance-Wizard $root 60) }
        $card = Wait-Contains $root '把这段时间做的事写成一份总结' 20
        if (-not $card) { Say '环境问题：找不到文字卡'; exit 2 }
        [void](Click-El $card); Start-Sleep -Seconds 2
        $instr = $root.FindFirst($TS::Descendants, (New-Object System.Windows.Automation.PropertyCondition($AE::AutomationIdProperty, 'task-instruction')))
        if ($instr) { try { $instr.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue('把这段时间做的事写成一份总结') } catch {} }
        [void](Click-Named $root '生成计划'); Start-Sleep -Seconds 3
        if (-not (Wait-Contains $root '它打算这样做' 20)) { Say '环境问题：没走到确认页'; exit 2 }
    }
    'results' {
        if (-not (Wait-Contains $root '需要我帮你做什么' 20)) { [void](Advance-Wizard $root 60) }
        $entry = Wait-Contains $root '打开我做的结果' 20
        if (-not $entry) { Say '环境问题：找不到结果入口'; exit 2 }
        [void](Click-El $entry); Start-Sleep -Seconds 2
        if (-not (Wait-Contains $root '回到首页' 15)) { Say '环境问题：面板没打开'; exit 2 }
        Start-Sleep -Milliseconds 800
    }
}

# 选视图
if ($View -eq 'Raw') { $walker = [System.Windows.Automation.TreeWalker]::RawViewWalker }
elseif ($View -eq 'Control') { $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker }
else { $walker = [System.Windows.Automation.TreeWalker]::ContentViewWalker }
$HEADPROP = $AE::HeadingLevelProperty

$docCond = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::Document)
$doc = $root.FindFirst($TS::Descendants, $docCond)
$start = if ($doc) { $doc } else { $root }
Say ('（遍历起点 = ' + $(if ($doc) { 'Document 元素' } else { '窗口根' }) + '，视图 = ' + $View + '）')

$rows = New-Object System.Collections.Generic.List[object]
$stack = New-Object System.Collections.Stack
$stack.Push(@($start, 0))
$guard = 0
while ($stack.Count -gt 0 -and $guard -lt 60000) {
    $guard++
    $item = $stack.Pop()
    $el = $item[0]; $depth = [int]$item[1]
    if (-not $el) { continue }
    $n = ''; $t = ''; $hl = $null; $focusable = $false; $items = $null; $isContent = $null; $isCtl = $null; $cls = ''
    try { $n = [string]$el.Current.Name } catch { continue }
    try { $t = (Kind-Of $el) } catch {}
    try { $focusable = [bool]$el.Current.IsKeyboardFocusable } catch {}
    try { $cls = [string]$el.Current.ClassName } catch {}
    try { $isCtl = [bool]$el.Current.IsControlElement } catch {}
    try { $isContent = [bool]$el.Current.IsContentElement } catch {}
    try { $h = $el.GetCurrentPropertyValue($HEADPROP); if ($h -and "$h" -match '^Level([1-9])$') { $hl = $Matches[1] } } catch {}
    $structural = @('List', 'ToolBar', 'Table', 'Tab', 'Menu', 'Tree')
    if ((-not ($n -and $n.Trim())) -and ($structural -contains $t)) {
        try { $items = $el.FindAll($TS::Children, [System.Windows.Automation.Condition]::TrueCondition).Count } catch {}
    }
    if (($n -and $n.Trim()) -or $null -ne $items -or $hl) {
        $rows.Add([pscustomobject]@{ depth = $depth; kind = $t; name = $n; heading = $hl; focusable = $focusable; items = $items; isControl = $isCtl; isContent = $isContent; cls = $cls })
    }
    $kids = New-Object System.Collections.ArrayList
    $c = $walker.GetFirstChild($el); $g = 0
    while ($c -and $g -lt 5000) { [void]$kids.Add($c); $c = $walker.GetNextSibling($c); $g++ }
    for ($i = $kids.Count - 1; $i -ge 0; $i--) { $stack.Push(@($kids[$i], ($depth + 1))) }
}

Say ('可朗读节点 = ' + $rows.Count)
Say ''
Say '=== 逐条（序号 | 控件类型 | 名字 | 标题级别 | 可Tab）==='
$i = 0
foreach ($r in $rows) {
    $i++
    $nm = if ($r.name -and $r.name.Trim()) { $r.name } elseif ($null -ne $r.items) { '(无名容器，' + $r.items + ' 个子项)' } else { '(无名)' }
    SayR (('  ' + $i).PadLeft(5) + ' | ' + $r.kind.PadRight(12) + ' | ' + $nm + $(if ($r.heading) { '  [标题' + $r.heading + '级]' } else { '' }) + $(if ($r.focusable) { '  [可Tab]' } else { '' }))
}

# 读屏念出来的样子（控件类型 + 名字）—— 读屏念的就是这两样。
function Announce($r) {
    $kindZh = switch ($r.kind) {
        'Button' { '按钮' }; 'Text' { '文字' }; 'Edit' { '编辑框' }; 'ListItem' { '列表项' }
        'List' { '列表' }; 'CheckBox' { '复选框' }; 'RadioButton' { '单选按钮' }; 'Hyperlink' { '链接' }
        'Document' { '文档' }; 'Pane' { '区域' }; 'Group' { '分组' }; 'Image' { '图片' }
        'Header' { '标题' }; 'HeaderItem' { '列标题' }; 'TabItem' { '选项卡' }; 'ComboBox' { '下拉框' }
        default { $r.kind }
    }
    $prefix = ''
    if ($r.heading) { $prefix = '标题（第' + $r.heading + '级）：' }
    if ($r.kind -eq 'List' -and -not ($r.name -and $r.name.Trim())) {
        $c = if ($null -ne $r.items) { $r.items } else { 0 }
        return ($prefix + '列表，' + $c + ' 个项目')
    }
    return ($prefix + $r.name + '，' + $kindZh)
}
Say ''
Say '=== 读屏念出来的样子（一句话一句）==='
$spoken = New-Object System.Collections.Generic.List[string]
foreach ($r in $rows) { $a = Announce $r; SayR ('  「' + $a + '」'); $spoken.Add($a) }

Say ''
Say '=== 统计 ==='
$heads = @($rows | Where-Object { $_.heading })
Say ('  标题节点 = ' + $heads.Count)
foreach ($h in $heads) { Say ('    · L' + $h.heading + ' ' + $h.name) }
$btns = @($rows | Where-Object { $_.kind -eq 'Button' -and $_.focusable -and ($_.name -and $_.name.Trim()) })
Say ('  可 Tab 按钮 N = ' + $btns.Count + '，不同名字 M = ' + @($btns | Select-Object -ExpandProperty name -Unique).Count)
$li = @($rows | Where-Object { $_.kind -eq 'ListItem' })
Say ('  ListItem = ' + $li.Count)
$lc = @($rows | Where-Object { $_.kind -eq 'List' })
foreach ($x in $lc) { Say ('    列表容器（' + $x.items + ' 个子项）→「列表，' + $x.items + ' 个项目」') }

$rows | ConvertTo-Json -Depth 4 | Set-Content -Path (Join-Path $WorkDir ('nv-' + $Scenario + '-' + $View + '.json')) -Encoding UTF8
$spoken | Set-Content -Path (Join-Path $WorkDir ('nv-' + $Scenario + '-' + $View + '-spoken.txt')) -Encoding UTF8
SayR ('产物目录：' + $WorkDir)

if ($rows.Count -eq 0) { Say '没取到任何可朗读节点 —— 这一场没验成。'; Set-Content -Path (Join-Path $WorkDir ('nv-' + $Scenario + '-' + $View + '.txt')) -Value $script:Lines -Encoding UTF8; exit 3 }
Say 'narrate-views: OK —— 读屏清单已落盘。'
Set-Content -Path (Join-Path $WorkDir ('nv-' + $Scenario + '-' + $View + '.txt')) -Value $script:Lines -Encoding UTF8

try { Stop-Process -Id $p.Id -Force } catch {}
Clear-Stale
exit 0
