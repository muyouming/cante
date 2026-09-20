# 「读屏会怎么念」清单（真机，UIAutomation）—— #197 读屏那一条的主要交付。
#
# 为什么需要它：`-19.md` / `-20.md` 验到了「每个控件**有**名字」「结果面板每行**名字不同**」
# （M 从 3 涨到 95），但**读屏实际念出来是什么**一次都没验过（-19.md §6 自己写的：没有读屏软件）。
# 这一份把「读屏会念成什么」**在真机上算出来** —— 不是猜：
#
#   * 走的是**真应用**经 WebView2 暴露出来的 **UIA 树**（`--force-renderer-accessibility`）；
#   * 顺序用 **UIA 的树序**（`RawViewWalker`，深度优先）—— 读屏按文档顺序朗读，
#     而 UIA 树序就是文档顺序（这一点在 §「怎么读」里说明）；
#   * 每条给 **`ControlType` + `Name`**，因为读屏念的就是这两样（控件类型 + 名字）；
#   * 另外单列 **`HeadingLevel`**（能不能按标题跳）与 **`IsKeyboardFocusable`**（能不能 Tab 到）。
#
# 它**不**驱动 Narrator（做不到：Narrator.exe 没有命令行开关、没有可驱动窗口，见报告 §1）。
# 它做的是**把读屏会用的那两个字段读出来**，让看报告的人判断"她听到的是不是人话"。
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File gui\scripts\windows\a11y\narrate-script.ps1 -Scenario home
#   ... -Scenario confirm
#   ... -Scenario results
#
# 退出码：0 = 取到并落盘；2 = 环境问题（应用/窗口读不到）；3 = 没取到任何可朗读节点。
#
# 注意：本文件必须保存为 UTF-8 with BOM（Windows PowerShell 5.1 否则按 GBK 解析中文）。

param(
    [ValidateSet('home', 'confirm', 'results')][string]$Scenario = 'home',
    [string]$Exe = "",
    [string]$WorkDir = "",
    [int]$StartupSecs = 14,
    # 最多写多少条（面板可能有几百个节点）。0 = 不限。
    [int]$MaxLines = 0
)

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$script:Here = $PSScriptRoot
# 本脚本在 gui\scripts\windows\a11y\ —— 比 a11y-uia.ps1（在 windows\ 下）**多一层**，
# 所以往上数三层才是 gui\（实测踩到：少算一层会让 Resolve-AppExe 找不到现构建，
# 静默回退到**装好的**那份 —— 于是验的是旧应用，看着像“#230 没生效”✗）。
$script:GuiRoot = (Resolve-Path (Join-Path $script:Here '..\..\..')).Path
$script:RepoRoot = (Resolve-Path (Join-Path $script:GuiRoot '..')).Path
$script:Lines = New-Object System.Collections.Generic.List[string]
function Say([string]$t) { Write-Output $t; [void]$script:Lines.Add($t) }
function SayLines([string]$t) {
    if ([string]::IsNullOrEmpty($t)) { return }
    foreach ($line in ($t -split "`r?`n")) { Say $line }
}
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

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
$sessionId = (Get-Process -Id $PID).SessionId
$hasDesktop = [bool](Get-Process explorer -ErrorAction SilentlyContinue)
Say ("会话：session=$sessionId elevated=$isAdmin 有桌面=$hasDesktop")
if ($isAdmin) { Say '环境问题：提权会话里 WebView2 会忽略 WEBVIEW2_*，UIA 读不到 DOM。'; exit 2 }
if (-not $hasDesktop) { Say '环境问题：这个会话没有交互桌面。'; exit 2 }

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class NW {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, int d, UIntPtr e);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
}
"@
$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
# RawViewWalker：包含**所有**元素（含纯文本），是读屏走的那条；ControlView 会漏掉正文。
$RAW = [System.Windows.Automation.TreeWalker]::RawViewWalker
$CV = [System.Windows.Automation.TreeWalker]::ControlViewWalker

# WebView2 默认把 DOM 的 UIA 树藏起来；这个变量让它一启动就开。（必须自己启动应用 —— 
# msedgedriver 启动时会用自己的值覆盖 WEBVIEW2_*，那样读不到 DOM。）
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--force-renderer-accessibility'

if (-not $WorkDir) { $WorkDir = Join-Path $env:TEMP ('cante-narrate-' + $Scenario + '-' + (Get-Date -Format 'yyyyMMdd-HHmmss')) }
New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
$profileDir = Join-Path $env:LOCALAPPDATA 'dev.cante.gui'
$historyDir = Join-Path $env:APPDATA 'dev.cante.gui'

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
    foreach ($name in @('cante-gui', 'cante-bridge')) {
        Get-Process -Name $name -ErrorAction SilentlyContinue | ForEach-Object { try { Stop-Process -Id $_.Id -Force } catch {} }
    }
    # WebView2 渲染进程也会占住应用档案（实测：不清会 exit=-1）
    Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and ($_.CommandLine -like '*dev.cante.gui*') } |
        ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {} }
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

# 点一个按钮，**先把它滚进视口**再点。
# 为何必要（实测踩到）：「开始使用」在 1280x800 上底部在折叠之下，此时 UIA 对它
# **不支持 Invoke 模式**（报「不支持的模式」）—— 不是产品的问题，是它没在视口里。
# 先用 ScrollIntoView（UIA 自带）+ 真滚轮把它弄出来，再 invoke。
function Click-El-Scrolled($el, [IntPtr]$hwnd) {
    if (-not $el) { return $false }
    try { $el.SetFocus() } catch {}
    try { $el.GetCurrentPattern([System.Windows.Automation.ScrollItemPattern]::Pattern).ScrollIntoView() } catch {}
    Start-Sleep -Milliseconds 300
    if (Click-El $el) { return $true }
    # 还不支持：用真滚轮往下推几格再试（把它推进视口）
    $cr = New-Object NW+RECT; [void][NW]::GetClientRect($hwnd, [ref]$cr)
    $o = New-Object NW+POINT; [void][NW]::ClientToScreen($hwnd, [ref]$o)
    [void][NW]::SetCursorPos(($o.X + [int]($cr.Right / 2)), ($o.Y + [int]($cr.Bottom / 2)))
    for ($i = 1; $i -le 8; $i++) {
        [NW]::mouse_event(0x0800, 0, 0, -120, [UIntPtr]::Zero)
        Start-Sleep -Milliseconds 250
        if (Click-El $el) { return $true }
    }
    return $false
}
function Click-Name($root, [string]$name, [int]$timeoutSec = 15, [IntPtr]$hwnd = [IntPtr]::Zero) {
    $e = Wait-Contains $root $name $timeoutSec
    if (-not $e) { return $false }
    $h = if ($hwnd -ne [IntPtr]::Zero) { $hwnd } else { $script:appHwnd }
    [void][NW]::SetForegroundWindow($h)
    return (Click-El-Scrolled $e $h)
}
function Scroll-ToTop([IntPtr]$hwnd) {
    $cr = New-Object NW+RECT; [void][NW]::GetClientRect($hwnd, [ref]$cr)
    $o = New-Object NW+POINT; [void][NW]::ClientToScreen($hwnd, [ref]$o)
    [void][NW]::SetCursorPos(($o.X + [int]($cr.Right / 2)), ($o.Y + [int]($cr.Bottom / 2)))
    for ($i = 1; $i -le 12; $i++) { [NW]::mouse_event(0x0800, 0, 0, 120, [UIntPtr]::Zero); Start-Sleep -Milliseconds 80 }
    Start-Sleep -Milliseconds 300
}

# ---------------------------------------------------------------------------
# 核心：按**树序**（读屏的朗读顺序）遍历，把「读屏会念的」写出来。
#
# 读屏念一个元素，念的是 **控件类型 + 名字**（例如「打开 X，按钮」）。
# UIA 给我们的两样正好是这两样：
#   * `ControlType`（Button / Text / ListItem / Header …）→ 读屏用它加"按钮/列表项"这类词；
#   * `Name` → 念出来的正文。
# 顺序：RawView 深度优先 = 文档顺序（读屏就是按这个顺序往下念）。
# ---------------------------------------------------------------------------
# 向导推进：反复点「当前这一步上真有的那个按钮」，直到首页出现。
# 为何写成一个循环而不是写死顺序（实测踩到）：第一步点「开始检查」之后，第二步出来的是
# 「下一步」（就绪）**或者**「先看看界面」（缺组件）—— 哪个在就点哪个；写死顺序会卡住。
function Advance-Wizard($root, [int]$timeoutSec = 60) {
    $d = (Get-Date).AddSeconds($timeoutSec)
    $last = ''
    while ((Get-Date) -lt $d) {
        if (Wait-Contains $root '需要我帮你做什么' 2) { return $true }
        $clicked = $false
        foreach ($label in @('开始检查', '下一步', '先看看界面', '开始使用')) {
            $e = $null
            foreach ($c in $root.FindAll($TS::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) {
                $n = [string]$c.Current.Name
                if ($n -and $n.Trim() -eq $label) { $e = $c; break }
            }
            if ($e) {
                if ($label -ne $last) { Say ('    （向导：点「' + $label + '」）') }
                $last = $label
                [void][NW]::SetForegroundWindow($script:appHwnd)
                [void](Click-El-Scrolled $e $script:appHwnd)
                Start-Sleep -Seconds 3
                $clicked = $true
                break
            }
        }
        if (-not $clicked) { Start-Sleep -Milliseconds 600 }
    }
    return $false
}

$script:rows = New-Object System.Collections.Generic.List[object]

function Walk($el, [int]$depth) {
    if (-not $el) { return }
    $t = Kind-Of $el
    $n = [string]$el.Current.Name
    $cls = ''
    try { $cls = [string]$el.Current.ClassName } catch {}
    # 只跳**浏览器自己的 chrome**：WebView2 宿主里挂着 Edge 的窗口按钮/地址栏/信息栏
    # （最小化/最大化/关闭、翻译/收藏/自动填充那些）。那些**不是 Cante 的界面**。
    #
    # 上一次写宽了（实测踩到）：连顶层 Window（ClassName 也含 "Chrome_Widget"）一起被剪掉，
    # 结果只剩 1 条（整个应用都没了）。所以**只在深度 > 0**时看这个判据。
    # 但更可靠的做法是**从应用的 Document 出发**走（见下面的 $script:walkRoot）—— 这里只当兼底。
    $skipSubtree = $false
    if ($depth -gt 0 -and (
        $cls -match '^Chrome_(Widget|LegacyWindow|Toolbar|InfoBar|RenderWidgetHost)' -or
        $cls -eq 'Chrome Legacy Window' -or $cls -eq 'Intermediate D3D Window')) {
        $skipSubtree = $true
    }
    $hasName = ($n -and $n.Trim())
    # 有些**结构元素名字为空、但读屏一定会念** —— 典型：列表容器（`<ul>` → `List`）。
    # 读屏会念「列表，N 个项目」；只按“有名字”过滤会把它默默丢掉（实测踩到：
    # 任务给的例子第一行就是「列表，95 个项目」，而我的第一版根本没这一行）。
    # 所以要保留：List / ToolBar / Table 这些**有子项数的容器**（名字空也记）。
    $structural = @('List', 'ToolBar', 'Table', 'Tab', 'Menu', 'Tree')
    $childCount = $null
    if (-not $hasName -and ($structural -contains $t)) {
        try { $cc = $el.FindAll($TS::Children, [System.Windows.Automation.Condition]::TrueCondition); $childCount = $cc.Count } catch { $childCount = $null }
    }
    $hl = $null
    try { $hl = $el.GetCurrentPropertyValue([System.Windows.Automation.AutomationElement]::HeadingLevelProperty) } catch {}
    $hlText = $null
    if ($null -ne $hl) {
        # HeadingLevel 是枚举：None + Level1..Level9。ToString() 得 "Level1"，
        # 报告里要写成人能读的「1 级」（直接拼出来会是「第Level1级」—— 实测踩到）。
        $s = "$hl"
        if ($s -match '^Level([1-9])$') { $hlText = $Matches[1] }
    }
    $focusable = $false
    try { $focusable = [bool]$el.Current.IsKeyboardFocusable } catch {}
    if (($hasName -or $null -ne $childCount) -and -not $skipSubtree) {
        $script:rows.Add([pscustomobject]@{
            depth = $depth; kind = $t; name = $n; heading = $hlText; focusable = $focusable; items = $childCount
        })
    }
    if ($skipSubtree) { return }
    $child = $RAW.GetFirstChild($el)
    $guard = 0
    while ($child -and $guard -lt 5000) {
        Walk $child ($depth + 1)
        $child = $RAW.GetNextSibling($child)
        $guard++
    }
}

# 读屏"会念成什么"的一句话（**这是这一份的核心表达**）：
#   有名字的元素 → 「<名字>，<控件类型中文>」
#   标题 → 前面加「标题」，读屏可用它按标题跳。
function Announce($row) {
    $kindZh = switch ($row.kind) {
        'Button' { '按钮' }
        'Text' { '文字' }
        'Edit' { '编辑框' }
        'ListItem' { '列表项' }
        'List' { '列表' }
        'CheckBox' { '复选框' }
        'RadioButton' { '单选按钮' }
        'Hyperlink' { '链接' }
        'Document' { '文档' }
        'Pane' { '区域' }
        'Group' { '分组' }
        'Image' { '图片' }
        'Header' { '标题' }
        'HeaderItem' { '列标题' }
        'TabItem' { '选项卡' }
        'ComboBox' { '下拉框' }
        'ScrollBar' { '滚动条' }
        default { $row.kind }
    }
    $prefix = ''
    if ($row.heading) { $prefix = '标题（第' + $row.heading + '级）：' }
    # 列表容器名字为空：读屏会念「列表，N 个项目」（任务给的例子就是这么写的）。
    if ($row.kind -eq 'List' -and -not ($row.name -and $row.name.Trim())) {
        $cnt = if ($null -ne $row.items) { $row.items } else { 0 }
        return ($prefix + '列表，' + $cnt + ' 个项目')
    }
    return ($prefix + $row.name + '，' + $kindZh)
}

# ---------------------------------------------------------------------------

$exePath = Resolve-AppExe $Exe
if (-not $exePath) { Say '环境问题：找不到 cante-gui.exe'; exit 2 }
SayR ("应用：" + $exePath)
Say ("场景：" + $Scenario)
Say ("工作目录：" + (Redact $WorkDir))

$p = $null
for ($attempt = 1; $attempt -le 2; $attempt++) {
    Clear-Stale
    if ($attempt -gt 1) { Start-Sleep -Seconds 3 }
    # 每个场景都从"清档案"开始：home/confirm 要首启或稳定首页；results 需要历史行（由夹具铺）。
    # results 场景**不清** history（那会把夹具铺的行删掉）—— 只清 WebView2 档案会让 localStorage 空白，
    # 但 runs.json 在 %APPDATA%，所以面板的行数不受影响。
    if ($Scenario -ne 'results') {
        foreach ($d in @($profileDir, $historyDir)) { if (Test-Path $d) { Remove-Item $d -Recurse -Force -ErrorAction SilentlyContinue } }
    }
    $p = Start-Process -FilePath $exePath -PassThru
    Start-Sleep -Seconds $StartupSecs
    $p.Refresh()
    if ($p.HasExited) { Say ("    （启动尝试 " + $attempt + "：应用退出 exit=" + $p.ExitCode + "；清残留重试）"); continue }
    if ($p.MainWindowHandle -eq 0) { try { Stop-Process -Id $p.Id -Force } catch {}; continue }
    break
}
if (-not $p -or $p.HasExited -or $p.MainWindowHandle -eq 0) { Say '环境问题：应用起不来 / 拿不到窗口'; exit 2 }
$script:appHwnd = $p.MainWindowHandle
$root = $AE::FromHandle($script:appHwnd)
if (-not $root) { Say '环境问题：UIA 读不到主窗口'; exit 2 }
[void][NW]::SetForegroundWindow($script:appHwnd)
Start-Sleep -Seconds 1
Say ("窗口句柄=" + $script:appHwnd)

# 走到目标界面
switch ($Scenario) {
    'home' {
        # 首启是向导；本场景要的是**首页**，所以把向导走完。
        if (-not (Wait-Contains $root '需要我帮你做什么' 20)) {
            [void](Advance-Wizard $root 60)
        }
        if (-not (Wait-Contains $root '需要我帮你做什么' 15)) { Say '环境问题：没走到首页'; exit 2 }
    }
    'confirm' {
        # 首启会先停在向导：先走到首页（文字卡在首页上）。
        if (-not (Wait-Contains $root '需要我帮你做什么' 20)) { [void](Advance-Wizard $root 60) }
        if (-not (Wait-Contains $root '需要我帮你做什么' 15)) { Say '环境问题：没走到首页'; exit 2 }
        # 用**文字卡**走到确认页（不选文件、不弹原生对话框、不需要模型）。
        $card = Wait-Contains $root '把这段时间做的事写成一份总结' 20
        if (-not $card) { Say '环境问题：首页上找不到文字卡'; exit 2 }
        [void](Click-El $card); Start-Sleep -Seconds 2
        $instr = $root.FindFirst($TS::Descendants, (New-Object System.Windows.Automation.PropertyCondition(
            [System.Windows.Automation.AutomationElement]::AutomationIdProperty, 'task-instruction')))
        if ($instr) { try { $instr.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue('把这段时间做的事写成一份总结') } catch {} }
        [void](Click-Name $root '生成计划' 15); Start-Sleep -Seconds 3
        if (-not (Wait-Contains $root '它打算这样做' 20)) { Say '环境问题：没走到确认页'; exit 2 }
    }
    'results' {
        if (-not (Wait-Contains $root '需要我帮你做什么' 20)) {
            [void](Advance-Wizard $root 60)
        }
        $entry = Wait-Contains $root '打开我做的结果' 20
        if (-not $entry) { Say '环境问题：首页上找不到「我做的结果」入口'; exit 2 }
        [void](Click-El $entry); Start-Sleep -Seconds 2
        if (-not (Wait-Contains $root '回到首页' 15)) { Say '环境问题：结果面板没打开'; exit 2 }
        Start-Sleep -Milliseconds 800
    }
}
Scroll-ToTop $script:appHwnd

# 走树序，把"读屏会念的"逐条写出来
$script:rows.Clear()
# **从应用的 Document 出发**走（而不是从窗口根）：这样天然排除窗口按钮（最小化/关闭）与
# Edge 自己的 chrome（地址栏/翻译/收藏）—— 那些不是 Cante 的界面。
# 找不到 Document 就退回从根走（至少不空手）。
$walkRoot = $root
$docCond = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::Document)
$doc = $root.FindFirst($TS::Descendants, $docCond)
if ($doc) { $walkRoot = $doc; Say '（遍历起点 = 应用的 Document 元素，已排除窗口/浏览器 chrome）' }
else { Say '（没找到 Document；从窗口根遍历，可能包含窗口按钮）' }
Walk $walkRoot 0
Say ("可朗读节点（有名字的）= " + $script:rows.Count)

Say ''
Say '=== 读屏会念成什么（按朗读顺序，逐条）==='
Say '（格式：序号 | 控件类型 | 名字 | 是否标题 | 能否 Tab）'
$i = 0
$out = New-Object System.Collections.Generic.List[string]
foreach ($r in $script:rows) {
    $i++
    if ($MaxLines -gt 0 -and $i -gt $MaxLines) { Say ('  ...（只写前 ' + $MaxLines + ' 条）'); break }
    $line = ('' + $i).PadLeft(4) + ' | ' + $r.kind.PadRight(12) + ' | ' + $(if ($r.name -and $r.name.Trim()) { $r.name } elseif ($null -ne $r.items) { '(无名容器，' + $r.items + ' 个子项)' } else { '(无名)' }) +
            $(if ($r.heading) { '  [标题' + $r.heading + '级]' } else { '' }) +
            $(if ($r.focusable) { '  [可Tab]' } else { '' })
    SayR ('  ' + $line)
    $out.Add($line)
}
$out | Set-Content -Path (Join-Path $WorkDir ('narrate-' + $Scenario + '.txt')) -Encoding UTF8

# 「读屏念出来的一句话」：把最有代表性的前若干条 + 所有标题列出来
Say ''
Say '=== 读屏念出来的样子（一句话一句）==='
$i = 0
foreach ($r in $script:rows) {
    $i++
    if ($MaxLines -gt 0 -and $i -gt $MaxLines) { break }
    SayR ('  「' + (Announce $r) + '」')
}

# 标题统计：能不能按标题跳
$headings = @($script:rows | Where-Object { $_.heading })
Say ''
Say ('=== 能不能按标题跳：标题节点数 = ' + $headings.Count + ' ===')
if ($headings.Count -eq 0) {
    Say '  ✗ 这个界面上**没有任何** UIA 标题节点（HeadingLevel）—— 读屏**不能**按标题在结果之间跳。'
} else {
    foreach ($h in $headings) { SayR ('  · 【标题' + $h.heading + '级】' + $h.name) }
}
# 列表/列表项也算一种"按项跳"的线索，单列出来
$lists = @($script:rows | Where-Object { $_.kind -eq 'List' -or $_.kind -eq 'ListItem' })
Say ('  另外：列表/列表项节点 = ' + $lists.Count + ' 个（读屏可以用"下一个列表项"这类命令走）')
$listContainers = @($script:rows | Where-Object { $_.kind -eq 'List' })
foreach ($lc in $listContainers) {
    Say ('    · 列表容器（' + $lc.items + ' 个子项）会被念成：「列表，' + $lc.items + ' 个项目」')
}

# 落一份结构化 JSON（供报告引用）
$script:rows | ConvertTo-Json -Depth 4 | Set-Content -Path (Join-Path $WorkDir ('narrate-' + $Scenario + '.json')) -Encoding UTF8

Say ''
SayR ("产物目录：" + $WorkDir)
try { Stop-Process -Id $p.Id -Force } catch {}
Clear-Stale

if ($script:rows.Count -eq 0) { Say '没取到任何可朗读节点 —— 这一场没验成。'; exit 3 }
Say 'narrate-script: OK — 读屏清单已落盘。'
exit 0
