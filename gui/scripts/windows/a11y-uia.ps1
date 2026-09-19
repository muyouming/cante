# 真 Windows 上验键盘可达性与读屏（UIAutomation）—— #197 的键盘/读屏那一条。
#
# 为什么需要它：仓库里对键盘可达性的验证**只有**无头浏览器里的源码扫描
# （`gui/src/simple/focus-guard.test.ts` + `gui/scripts/dom-smoke.sh` 的 focus-guard 那一步）。
# 那两样能证明「接线写对了」，但**证明不了**真 WebView2 里 UIA 树长什么样：
#   * Tab 在真窗口里到底怎么走、会不会跳/重复/卡住；
#   * 每个可点元素在 UIA 里有没有**可念的名字**；
#   * 按钮的**真实像素高度**够不够 44（源码扫描只看 Tailwind 类名）。
#
# 它做四件事：
#   1. 自己启动应用（**不能让 msedgedriver 启动** —— 它会用自己的值覆盖
#      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS，UIA 就只能看到 3 个壳元素，读不到 DOM；
#      原因写在 read-confirm-visible.ps1 的文件头，这里沿用同一条路）；
#   2. 用**真键盘**（keybd_event）而不是 DOM 里模拟：盲按 Tab，每一步都用
#      AutomationElement.FocusedElement 读回焦点落在哪个元素上；
#   3. 枚举 UIA 树里的可聚焦元素，导出「名字 / 类型 / 矩形 / 是否可聚焦」；
#   4. 特别验审批卡与确认页：**Esc 不能关掉它们**（有意的 MUST-ANSWER 设计），
#      而 Tab 能在里面走满一圈、回到起点、不卡死。
#
# 关于 44px：UIA 的 BoundingRectangle 给的是**物理像素**（屏幕坐标）。判据用的是
# 逻辑像素，所以要除以缩放（DPI/96）。这里同时记物理高度与算出来的逻辑高度，
# 两者都写进输出，报告里能复核。
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File gui\scripts\windows\a11y-uia.ps1 -Scenario home
#   ... -Scenario confirm
#   ... -Scenario approval
#   ... -Scenario results
#
# 退出码：0 = 这一场的判据都满足；2 = **环境问题**（应用/桌面不在、UIA 读不到、会话不对）；
#         3 = **产品问题**（判据不符合）。
#
# 注意：本文件必须保存为 UTF-8 with BOM（Windows PowerShell 5.1 否则按 GBK 解析中文）。

param(
    [ValidateSet('home', 'confirm', 'approval', 'results')][string]$Scenario = 'home',
    [string]$Exe = "",
    [string]$WorkDir = "",
    [int]$StartupSecs = 14,
    # 审批那一场要用的输入表（用应用自带的 cante-sheets write 造）。不给就自动造一张。
    [string]$InputXlsx = "",
    [switch]$KeepAppRunning
)

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$script:Here = $PSScriptRoot
$script:GuiRoot = (Resolve-Path (Join-Path $script:Here '..\..')).Path
$script:RepoRoot = (Resolve-Path (Join-Path $script:GuiRoot '..')).Path
$script:Lines = New-Object System.Collections.Generic.List[string]
function Say([string]$t) { Write-Output $t; [void]$script:Lines.Add($t) }
function SayLines([string]$t) {
    if ([string]::IsNullOrEmpty($t)) { return }
    foreach ($line in ($t -split "`r?`n")) { Say $line }
}

# 报告里绝不出现真实家目录 / 内网地址（CI 的秘密扫描会判红，见 gui/scripts/secret-scan.sh）。
# 只换**路径形式**的家目录（C:\Users\<名字>），不做裸用户名全局替换 —— 这台机器的用户名
# 恰好是 cante，而产品到处都写着 cante-gui.exe / Cante，全局换会把报告改得看不出是什么。
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

# ---------------------------------------------------------------------------
# 会话判断（照 run-accept-drive.ps1 / read-confirm-visible.ps1 那套，不另发明）
# ---------------------------------------------------------------------------
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
$sessionId = (Get-Process -Id $PID).SessionId
$hasDesktop = [bool](Get-Process explorer -ErrorAction SilentlyContinue)
Say ("会话：session=$sessionId elevated=$isAdmin 有桌面=$hasDesktop")
if ($isAdmin) {
    Say '环境问题：当前是提权会话 —— WebView2 在提权进程里会忽略 WEBVIEW2_* 调试/无障碍变量，'
    Say '          UIA 读不到 DOM（只能看到壳）。请用不提权的交互会话跑。'
    exit 2
}
if (-not $hasDesktop) { Say '环境问题：这个会话没有交互桌面，GUI 建不出窗口、也收不到按键。'; exit 2 }

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class A11yWin {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
}
"@

$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]

# WebView2 默认把 DOM 的 UIA 树藏着（Chromium 只在真有辅助工具请求时才开）。
# 这个变量让它一启动就打开无障碍树。**必须自己启动应用**（见文件头）。
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--force-renderer-accessibility'

if (-not $WorkDir) { $WorkDir = Join-Path $env:TEMP ('cante-a11y-' + (Get-Date -Format 'yyyyMMdd-HHmmss')) }
New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null

# 企业预置：向导不拦路、卡片直接上首页（不设的话第一屏是向导，验的不是首页）。
$adminFile = Join-Path $WorkDir 'admin.json'
[System.IO.File]::WriteAllText($adminFile, '{"default_provider":null,"default_model":null,"allow_network":true,"disabled_tasks":[]}', (New-Object System.Text.UTF8Encoding($false)))
$env:CANTE_ADMIN_CONFIG = $adminFile

function Resolve-AppExe([string]$Given) {
    if ($Given) { if (Test-Path $Given) { return (Resolve-Path $Given).Path } else { return $null } }
    # 优先用**当前 main 现构建的**（debug），它才是这一轮要验的代码；装好的那份可能更旧。
    foreach ($c in @(
        (Join-Path $script:RepoRoot 'gui\src-tauri\target\debug\cante-gui.exe'),
        (Join-Path $script:RepoRoot 'gui\src-tauri\target\release\cante-gui.exe')
    )) { if (Test-Path $c) { return (Resolve-Path $c).Path } }
    $installed = Join-Path $env:LOCALAPPDATA 'Cante\cante-gui.exe'
    if (Test-Path $installed) { return (Resolve-Path $installed).Path }
    return $null
}

$exePath = Resolve-AppExe $Exe
if (-not $exePath) { Say '环境问题：找不到 cante-gui.exe（现构建或装好的都没有）'; exit 2 }
$exeDir = Split-Path -Parent $exePath
SayR ("应用：" + $exePath)
Say ("工作目录：" + (Redact $WorkDir))

# 审批那一场要用的输入表：用应用自带的 cante-sheets write 造（连输入都是产品自己的工具产出的）。
$script:approvalInput = $InputXlsx
if (-not $script:approvalInput) {
    $sheets = Join-Path $exeDir 'cante-sheets.exe'
    if (Test-Path $sheets) {
        $csv = Join-Path $WorkDir 'input.csv'
        @(
            '区域,月份,客户,金额',
            '华东区,3月,甲公司,1200',
            '华南区,3月,乙公司,980',
            '华东区,4月,丙公司,1500',
            '华北区,4月,丁公司,1100',
            '华东区,5月,戊公司,760'
        ) -join "`n" | Set-Content -Path $csv -Encoding UTF8
        $want = Join-Path $WorkDir '销售明细.xlsx'
        if (Test-Path $want) { Remove-Item $want -Force }
        & $sheets write $want $csv --sheet '明细' 2>&1 | Out-Null
        if (Test-Path $want) { $script:approvalInput = $want }
    }
}
if ($script:approvalInput) { SayR ("审批那一场的输入表：" + $script:approvalInput) }
if (-not (Test-Path (Join-Path $exeDir 'pi'))) {
    Say '环境问题：应用旁边没有 pi\ —— 到不了审批卡那一屏（那一屏要真的连上执行组件）。'
    Say '          现构建的话先跑 bun scripts/stage-executor.ts 再 bunx tauri build --debug --no-bundle。'
}

function Clear-StaleApp {
    foreach ($name in @('cante-gui', 'cante-bridge')) {
        Get-Process -Name $name -ErrorAction SilentlyContinue | ForEach-Object {
            try { Stop-Process -Id $_.Id -Force } catch {}
        }
    }
    Start-Sleep -Seconds 2
}

# ---------------------------------------------------------------------------
# UIA 读取小工具
# ---------------------------------------------------------------------------

function All-Descendants($root) {
    return $root.FindAll($TS::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
}

<# 控制类型名（Button / Text / Edit…），去掉命名空间前缀。 #>
function Kind-Of($el) {
    $t = $el.Current.ControlType.ProgrammaticName
    if ($t -and $t.Contains('.')) { return $t.Substring($t.LastIndexOf('.') + 1) }
    return $t
}

<#
 * 一个元素导成一行事实：名字 / 类型 / 矩形 / 是否可聚焦 / 是否在屏上。
 * 矩形同时给物理与逻辑两套（逻辑 = 物理 / (DPI/96)），44px 判据看逻辑那套。
 *
 * 注意：**不在屏上的元素**，UIA 给的 BoundingRectangle 可能是无穷大（实测：
 * `IsOffscreen=True` 的元素 Left/Top 会是 ∞）—— 直接 [int] 转换会抛
 * 「值“∞”对于 Int32 太大」而丢掉整条记录。所以先判有限，非有限就记 null。
 #>
function Describe-El($el, [double]$scale) {
    $r = $el.Current.BoundingRectangle
    $finite = [double]::IsInfinity($r.Left) -eq $false -and [double]::IsNaN($r.Left) -eq $false -and
              [double]::IsInfinity($r.Width) -eq $false -and [double]::IsNaN($r.Width) -eq $false
    if ($finite) {
        $wPhys = [math]::Round($r.Width, 1)
        $hPhys = [math]::Round($r.Height, 1)
        return [pscustomobject]@{
            name = [string]$el.Current.Name
            kind = (Kind-Of $el)
            focusable = [bool]$el.Current.IsKeyboardFocusable
            enabled = [bool]$el.Current.IsEnabled
            offscreen = [bool]$el.Current.IsOffscreen
            automationId = [string]$el.Current.AutomationId
            rectPhys = @([int]$r.Left, [int]$r.Top, [int]$r.Right, [int]$r.Bottom)
            widthPhys = $wPhys
            heightPhys = $hPhys
            widthLogical = [math]::Round($wPhys / $scale, 1)
            heightLogical = [math]::Round($hPhys / $scale, 1)
        }
    }
    return [pscustomobject]@{
        name = [string]$el.Current.Name
        kind = (Kind-Of $el)
        focusable = [bool]$el.Current.IsKeyboardFocusable
        enabled = [bool]$el.Current.IsEnabled
        offscreen = [bool]$el.Current.IsOffscreen
        automationId = [string]$el.Current.AutomationId
        rectPhys = $null
        widthPhys = $null
        heightPhys = $null
        widthLogical = $null
        heightLogical = $null
    }
}

<#
 * 把应用窗口拉到前台，反复试到成功（或超时）。
 *
 * 为什么单独一个函数、而且反复试：Windows 会阻止**后台进程**用 SetForegroundWindow
 * 抢前台（前台锁定）。实测踩过：某一次里 SetForegroundWindow 没生效，于是盲按的
 * Tab/Esc **根本没送到应用**，屏幕上一动没动 —— 看起来像“Tab 卡在搜索框”“Esc 关不掉
 * 面板”✗，而那是**按键没送到**，不是产品行为。
 *
 * 拿不到前台就**返回 false**，由调用方当成环境问题处理，绝不能拿这种读数下结论。
 #>
function Ensure-Foreground([int]$tries = 12) {
    for ($i = 0; $i -lt $tries; $i++) {
        if ([A11yWin]::GetForegroundWindow() -eq $script:appHwnd) { return $true }
        [void][A11yWin]::SetForegroundWindow($script:appHwnd)
        Start-Sleep -Milliseconds 200
    }
    return ([A11yWin]::GetForegroundWindow() -eq $script:appHwnd)
}

<#
 * 真键盘：按一次 Tab（可带 Shift）。用 keybd_event，不走任何 DOM 接口。
 *
 * 按键之前先确保应用真的是前台（Ensure-Foreground）。拿不到就置 `$script:keysUnreliable`
 * —— 那说明这一轮的键盘读数不能用，最后要报**环境问题**，不能报产品问题。
 #>
function Press-Tab([bool]$shift, [int]$settleMs = 320) {
    if (-not (Ensure-Foreground)) { $script:keysUnreliable = $true }
    $VK_TAB = 0x09; $VK_SHIFT = 0x10; $KEYUP = 2
    if ($shift) { [A11yWin]::keybd_event($VK_SHIFT, 0, 0, [UIntPtr]::Zero) }
    [A11yWin]::keybd_event($VK_TAB, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 40
    [A11yWin]::keybd_event($VK_TAB, 0, $KEYUP, [UIntPtr]::Zero)
    if ($shift) { [A11yWin]::keybd_event($VK_SHIFT, 0, $KEYUP, [UIntPtr]::Zero) }
    Start-Sleep -Milliseconds $settleMs
}

function Press-Esc([int]$settleMs = 500) {
    if (-not (Ensure-Foreground)) { $script:keysUnreliable = $true }
    $VK_ESC = 0x1B; $KEYUP = 2
    [A11yWin]::keybd_event($VK_ESC, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 40
    [A11yWin]::keybd_event($VK_ESC, 0, $KEYUP, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds $settleMs
}

<# 当前焦点元素的身份（可读字符串）。读不到就是 "(无)"。 #>
<#
 * 一个元素的**可比身份**：类型 + 名字 + 矩形。
 *
 * 为什么不能只用名字：结果面板里每一行的按钮 aria-label 都是同一句
 * （「打开这个结果文件」），用名字做身份会把不同行看成同一个元素 —— 那会把
 * “产品里按钮名字不够用”误判成“Tab 卡住了”（实跑踩到）。带上矩形就能把
 * 不同行区分开；与名字的差异本身记在报告的判据里。
 *
 * 矩形拿不到时退回 (kind, name, runtimeId)。
 #>
function El-Identity($el) {
    if (-not $el) { return '(none)' }
    $k = Kind-Of $el
    $n = [string]$el.Current.Name
    $r = $el.Current.BoundingRectangle
    if ([double]::IsInfinity($r.Left) -or [double]::IsNaN($r.Left)) {
        try { return ($k + '|' + $n + '|rid:' + ($el.GetRuntimeId() -join ',')) } catch { return ($k + '|' + $n + '|norect') }
    }
    return ($k + '|' + $n + '|' + [int]$r.Left + ',' + [int]$r.Top)
}

function Focus-Id() {
    $f = $AE::FocusedElement
    if (-not $f) { return '(读不到焦点)' }
    # 焦点跑到**别的程序**时，读数没用：记为污染，不当成 Tab 结果。
    #
    # 怎么判“还是我们的”：**往上走到 UIA 根，看能不能碰到我们的 root 元素**
    # （用 Equals 比，不是比句柄也不是比进程号）。
    # 这里踩过两个坑：
    #   * 比**窗口句柄**：Tauri 的 MainWindowHandle 和 UIA 最顶层元素的
    #     NativeWindowHandle **不是同一个数**（实测：前者 15992220、后者 5243034），比不中；
    #   * 比**进程号**：WebView2 的 DOM 跑在**另一个进程**里
    #     （`msedgewebview2.exe`，实测 pid 与 cante-gui.exe 不同），于是每个按钮都被
    #     误报成“焦点跑到别的窗口”。
    # 走到根再 Equals 这两种都不靠。
    try {
        $cur = $f
        $ours = $false
        for ($i = 0; $i -lt 40; $i++) {
            if ($cur -eq $script:appRoot) { $ours = $true; break }
            $par = [System.Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($cur)
            if (-not $par) { break }
            $cur = $par
        }
        if (-not $ours) {
            $script:fgLost = $true
            return ('(焦点跑到别的窗口了: ' + $f.Current.ControlType.ProgrammaticName + ')')
        }
    } catch {}
    $n = [string]$f.Current.Name
    if (-not $n) { $n = '(无名)' }
    return ((Kind-Of $f) + '「' + $n + '」')
}

<# 等某个名字的元素出现（UIA 树里）。 #>
function Wait-Name($root, [string]$name, [int]$timeoutSec = 20) {
    $deadline = (Get-Date).AddSeconds($timeoutSec)
    while ((Get-Date) -lt $deadline) {
        $cond = New-Object System.Windows.Automation.PropertyCondition($AE::NameProperty, $name)
        $el = $root.FindFirst($TS::Descendants, $cond)
        if ($el) { return $el }
        Start-Sleep -Milliseconds 400
    }
    return $null
}

<# 等某个名字的**前缀**匹配的元素出现（卡片的 aria-label 是「标题。例子」）。 #>
function Wait-NamePrefix($root, [string]$prefix, [int]$timeoutSec = 20) {
    $deadline = (Get-Date).AddSeconds($timeoutSec)
    while ((Get-Date) -lt $deadline) {
        foreach ($e in (All-Descendants $root)) {
            $n = [string]$e.Current.Name
            if ($n -and $n.StartsWith($prefix)) { return $e }
        }
        Start-Sleep -Milliseconds 400
    }
    return $null
}

<# 用 UIA 的 Invoke 按一下（**只有搭场景时用**；验 Tab 时一律用真键盘）。 #>
function Click-El($el) {
    try { $p = $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern); $p.Invoke(); return $true }
    catch { return $false }
}

# ---------------------------------------------------------------------------
# 判据：Tab 顺序
# ---------------------------------------------------------------------------

<#
 * 盲按 Tab，把每一步的**焦点元素完整事实**读回来。
 *
 * 这是本脚本最硬的一条证据：焦点是**真键盘**按出来的，每一步用
 * AutomationElement.FocusedElement 读回，量它**当时**的矩形。
 *
 * 为什么必须“当时量”而不是先扫一遍全树：确认页比窗口高，未滚动到的控件
 * （例如「我同意直接改原来的文件」那个复选框）在静态快照里 `IsOffscreen=True`、
 * 矩形落在可见区之外；而 Tab 走到它时浏览器会把它滚到眼前。
 * 先扫一遍再按“不在屏上就跳过”会把这种**键盘真到得了**的控件默默漏掉 ✗
 * （实跑踩过：那个 20px 的复选框就是这么被放过的）。
 *
 * 判据：
 *   * 每一步焦点都真的**动了**（不许卡在同一个元素上）；
 *   * 走满一圈之内**回到起点**（层内循环）；
 *   * 不许跳出到窗口外（读不到焦点）。
 #>
function Tab-Round($root, [int]$maxSteps, [double]$scale) {
    $seen = New-Object System.Collections.Generic.List[string]
    $visited = New-Object System.Collections.Generic.List[object]
    $startEl = $AE::FocusedElement
    $start = El-Identity $startEl
    $stuck = 0
    for ($i = 1; $i -le $maxSteps; $i++) {
        Press-Tab $false
        $fel = $AE::FocusedElement
        $now = El-Identity $fel
        if ($fel) { $visited.Add((Describe-El $fel $scale)) | Out-Null }
        if ($now -eq $start -and $i -gt 1) {
            Say ("    Tab 第 $i 步回到起点：" + (Focus-Id))
            return [pscustomobject]@{ steps = $i; looped = $true; visited = $seen; stuck = $stuck; start = $start; elements = $visited }
        }
        # 卡住 = 连着两次**同一个元素**（带上矩形判定）都没动。
        if ($seen.Count -gt 0 -and $seen[$seen.Count - 1] -eq $now) { $stuck++ }
        $seen.Add($now)
        Say ("    Tab $i -> " + (Focus-Id))
    }
    return [pscustomobject]@{ steps = $maxSteps; looped = $false; visited = $seen; stuck = $stuck; start = $start; elements = $visited }
}

<#
 * 对「Tab 真到得了的那些控件」下 44px 判据。
 *
 * 只对 **按钮类**（Button / Hyperlink / SplitButton / ListItem）要 ≥ 44：
 * 判据原话就是「能用键盘到达的**按钮**」，而且产品自己的 typography 闸门也只管 `button`。
 * CheckBox / RadioButton / Edit 单独作为**事实**报出来（不当作达标，也不当作违规）——
 * UIA 给的是那个**原生控件自己的框**（例如 20x20 的复选框），而它外面往往还包着一层
 * 更大的 <label>；那一层在 UIA 里**不单独成节点**（它的文字变成了控件的 Name），
 * 所以“真实可点区域到底多大”从 UIA 这一层**量不到** —— 报告里如实这么写。
 #>
function Judge-Visited($round, [string]$scenario, [string]$outFile) {
    $els = @($round.elements)
    $els | ConvertTo-Json -Depth 5 | Set-Content -Path $outFile -Encoding UTF8
    Say ''
    Say "=== Tab 真到得了的元素（$scenario）: 名字 / 类型 / 逻辑高 / 在屏上 ==="
    foreach ($d in $els) {
        $hText = $(if ($null -ne $d.heightLogical) { 'h=' + $d.heightLogical } else { 'h=(未量到)' })
        SayR ('  | ' + $(if ($d.name -and $d.name.Trim()) { $d.name } else { '(无名)' }) + ' / ' + $d.kind + ' / ' + $hText + ' / offscreen=' + $d.offscreen)
    }
    $BUTTON_KINDS = @('Button', 'Hyperlink', 'SplitButton', 'ListItem')
    $buttons = @($els | Where-Object { $BUTTON_KINDS -contains $_.kind })
    $short = @($buttons | Where-Object { $null -ne $_.heightLogical -and $_.heightLogical -lt 44 })
    $unmeasured = @($buttons | Where-Object { $null -eq $_.heightLogical })
    if ($short.Count -eq 0 -and $unmeasured.Count -eq 0) {
        Add-Verdict $scenario 'tab-reachable-buttons-44px' $true ''
        Say ("  ✓ Tab 到得了的按钮共 $($buttons.Count) 个，逻辑高都 >= 44。")
    } else {
        Add-Verdict $scenario 'tab-reachable-buttons-44px' $false ("$($short.Count) 个 < 44；$($unmeasured.Count) 个量不到")
        foreach ($d in $short) { SayR ('  ✗ ' + $d.kind + '「' + $d.name + '」 h=' + $d.heightLogical) }
        foreach ($d in $unmeasured) { SayR ('  ✗ ' + $d.kind + '「' + $d.name + '」 量不到矩形') }
    }
    # 非按钮类的可聚焦控件：只报事实。
    $others = @($els | Where-Object { -not ($BUTTON_KINDS -contains $_.kind) })
    foreach ($d in $others) {
        Say ('  （事实，不计入上条判据）' + $d.kind + '「' + $d.name + '」 h=' + $d.heightLogical + '逻辑')
        Say  '      —— UIA 量的是这个原生控件自己的框；它外面包的 <label> 在 UIA 里不单独成节点，'
        Say  '         所以“她真实可点的区域多大”从这一层量不到（记在报告的「没验到什么」里）。'
    }
}

# ---------------------------------------------------------------------------
# 启动应用 + 拿到窗口
# ---------------------------------------------------------------------------

Clear-StaleApp
Say ''
Say ("=== 启动应用（自己启动，不经 msedgedriver）===")
$proc = Start-Process -FilePath $exePath -PassThru
Say ("pid=" + $proc.Id)
Start-Sleep -Seconds $StartupSecs
$proc.Refresh()
if ($proc.HasExited) { Say ("环境问题：应用退出了（exit " + $proc.ExitCode + '）'); exit 2 }

$hwnd = $proc.MainWindowHandle
if ($hwnd -eq 0) { Start-Sleep -Seconds 5; $proc.Refresh(); $hwnd = $proc.MainWindowHandle }
if ($hwnd -eq 0) { Say '环境问题：拿不到主窗口句柄'; if (-not $KeepAppRunning) { Stop-Process -Id $proc.Id -Force }; exit 2 }

$root = $AE::FromHandle($hwnd)
if (-not $root) { Say '环境问题：UIA 读不到主窗口'; if (-not $KeepAppRunning) { Stop-Process -Id $proc.Id -Force }; exit 2 }
$script:appHwnd = $hwnd
$script:appPid = $proc.Id
$script:appRoot = $root
$script:fgLost = $false
$script:keysUnreliable = $false
[void][A11yWin]::SetForegroundWindow($hwnd)
Start-Sleep -Seconds 1

# 缩放：物理像素 -> 逻辑像素要除以 (DPI/96)。判据（44px）是逻辑像素。
$dpi = [A11yWin]::GetDpiForWindow($hwnd)
if (-not $dpi -or $dpi -eq 0) { $dpi = 96 }
$scale = [double]$dpi / 96.0
Say ("窗口句柄=" + $hwnd + " DPI=" + $dpi + " 缩放=" + $scale + "（物理像素 ÷ 缩放 = 逻辑像素）")

# 客户端区域（屏幕坐标），用来判"在不在窗口里"。
$client = New-Object A11yWin+RECT
[void][A11yWin]::GetClientRect($hwnd, [ref]$client)
$origin = New-Object A11yWin+POINT
[void][A11yWin]::ClientToScreen($hwnd, [ref]$origin)
$cl = $origin.X; $ct = $origin.Y; $cr = $origin.X + $client.Right; $cb = $origin.Y + $client.Bottom
Say ("窗口客户区（屏幕坐标）=[$cl,$ct,$cr,$cb]")

# ---------------------------------------------------------------------------
# 判据：可点元素有没有可念的名字 + 44px
# ---------------------------------------------------------------------------

$script:verdicts = New-Object System.Collections.Generic.List[object]
function Add-Verdict([string]$scenario, [string]$kind, [bool]$ok, [string]$why) {
    $script:verdicts.Add([pscustomobject]@{ Scenario = $scenario; Kind = $kind; Ok = $ok; Why = $why })
}
# 场景半途因环境原因停下时置位 —— 不能因为“没下过任何判据”就报 OK（那是假绿）。
$script:envBlocked = $false
function Add-EnvBlocked([string]$scenario, [string]$why) {
    $script:envBlocked = $true
    $script:verdicts.Add([pscustomobject]@{ Scenario = $scenario; Kind = 'reached-screen'; Ok = $false; Why = $why })
}

<#
 * 枚举当前 UIA 树里的**可聚焦**元素，逐个记事实，并下两条判据：
 *   ① 名字非空（可点击的东西必须能被念出来）；
 *   ② 键盘到得了的 Button/CheckBox/RadioButton/Link，逻辑高度 >= 44。
 * 另外单独统计"有名字但不可聚焦"的元素——它们是读屏要念的正文/标题。
 #>
function Dump-And-Judge($root, [string]$scenario, [string]$outFile) {
    $all = All-Descendants $root
    $elements = @()
    foreach ($e in $all) {
        $d = Describe-El $e $scale
        # 只记"有名字的"与"可聚焦的"：UIA 树里大量无名容器，记下来只会淹掉信号。
        if (($d.name -and $d.name.Trim()) -or $d.focusable) { $elements += $d }
    }
    $elements | ConvertTo-Json -Depth 5 | Set-Content -Path $outFile -Encoding UTF8

    Say ''
    Say "=== 元素清单（$scenario）: 名字 / 类型 / 物理矩形 / 逻辑高 / 可聚焦 / 在屏上 ==="
    foreach ($d in $elements) {
        $rectText = $(if ($d.rectPhys) { '[' + ($d.rectPhys -join ',') + ']' } else { '[非有限]' })
        $hText = $(if ($null -ne $d.heightLogical) { 'h=' + $d.heightLogical + '逻辑(' + $d.heightPhys + '物理)' } else { 'h=(未量到)' })
        SayR ('  | ' + $(if ($d.name -and $d.name.Trim()) { $d.name } else { '(无名)' }) +
            ' / ' + $d.kind +
            ' / ' + $rectText +
            ' / ' + $hText +
            ' / focusable=' + $d.focusable +
            ' / offscreen=' + $d.offscreen +
            $(if ($d.automationId) { ' / id=' + $d.automationId } else { '' }))
    }

    # ① 名字
    # 只对**真控件**下判据：Button / CheckBox / RadioButton / Hyperlink / Edit / ComboBox / ListItem / Slider。
    # 为什么不把 Pane / Document / Group / Window 算进去：WebView2 的**宿主 Pane**（浏览器那一层）
    # 在 UIA 里 `IsKeyboardFocusable=True` 但**没有名字、也量不到矩形**，而它是**容器不是控件**——
    # 读屏本来就不该念它。实测：盲按 Tab 一圈，焦点**从来没有**落到 Pane 上（§报告）。
    # 把这一类当成“无名控件”是误报；但它得**说出来**，不能患默默放过。
    $CONTROL_KINDS = @('Button', 'CheckBox', 'RadioButton', 'Hyperlink', 'Edit', 'ComboBox', 'ListItem', 'Slider', 'TabItem', 'MenuItem', 'SplitButton')
    $nameless = @($elements | Where-Object { $_.focusable -and ($CONTROL_KINDS -contains $_.kind) -and -not ($_.name -and $_.name.Trim()) })
    # 可聚焦、但**不是**控件类型、又没有名字的：单独记下来（宿主 Pane 这一类）。
    $namelessHost = @($elements | Where-Object { $_.focusable -and -not ($CONTROL_KINDS -contains $_.kind) -and -not ($_.name -and $_.name.Trim()) })
    if ($nameless.Count -eq 0) {
        Add-Verdict $scenario 'focusable-have-names' $true ''
        Say ''
        Say '  ✓ 每个可聚焦的**控件**都有可念的名字（Name 非空）。'
    } else {
        Add-Verdict $scenario 'focusable-have-names' $false ("有 $($nameless.Count) 个可聚焦控件没有名字")
        Say ''
        Say ("  ✗ 有 $($nameless.Count) 个可聚焦控件没有名字（读屏念不出来）：")
        foreach ($d in $nameless) { SayR ('     · ' + $d.kind + ' [' + $(if ($d.rectPhys) { ($d.rectPhys -join ',') } else { '非有限' }) + ']') }
    }
    if ($namelessHost.Count -gt 0) {
        Say ("  （另注：$($namelessHost.Count) 个可聚焦的**非控件**（容器/宿主）没有名字，不计入上条判据：")
        foreach ($d in $namelessHost) { Say ('     · ' + $d.kind + '（如 WebView2 的宿主 Pane）') }
        Say '    实测盲按 Tab 一圈，焦点从来没落到它们上 —— 读屏也不该念容器。）'
    }
    # ② 44px 不在这里判 —— 只对「Tab 真到得了的那些控件」判（见 Judge-Visited）。
    #    原因：确认页比窗口高，未滚动到的控件在静态快照里 IsOffscreen=True；
    #    先扫一遍再按“不在屏上就跳过”会把键盘真到得了的控件默默漏掉（实跑踩过）。
    return $elements
}

# ---------------------------------------------------------------------------
# 各场景
# ---------------------------------------------------------------------------

$nonFocusableNamed = 0
switch ($Scenario) {
    'home' {
        Say ''
        Say '=== 首页：先看元素清单与两条判据 ==='
        # 焦点先落在文档里（首页没有浮层）。按一次 Tab 让焦点进到第一个按钮，
        # 免得 Tab-Round 的起点是"读不到焦点"。
        Press-Tab $false
        Say ('  起始焦点：' + (Focus-Id))
        $elements = Dump-And-Judge $root 'home' (Join-Path $WorkDir 'elements-home.json')
        $nonFocusableNamed = @($elements | Where-Object { -not $_.focusable -and ($_.name -and $_.name.Trim()) }).Count
        Say ("  （另有 $nonFocusableNamed 个有名字但不可聚焦的元素 —— 读屏要念的正文/标题）")

        Say ''
        Say '=== 首页：Tab 顺序（盲按，读回焦点）==='
        $round = Tab-Round $root 60 $scale
        Add-Verdict 'home' 'tab-loops' ([bool]$round.looped) $(if ($round.looped) { '' } else { "按了 $($round.steps) 步没回到起点" })
        Add-Verdict 'home' 'tab-not-stuck' ($round.stuck -eq 0) $(if ($round.stuck -eq 0) { '' } else { "有 $($round.stuck) 次停在同一个元素上" })
        if ($script:fgLost) { Add-Verdict 'home' 'no-focus-steal' $false '盲按时焦点跑到别的窗口了（测试污染，结果不可信）' }
        Judge-Visited $round 'home' (Join-Path $WorkDir 'visited-home.json')
    }

    'confirm' {
        Say ''
        Say '=== 确认页：走到它 ==='
        # 用**文字卡**（needs:"text"）而不是文件卡：文件卡会卡在「先选一个」
        # （这个脚本故意不选真文件：验收只关心键盘行为，不想把原生对话框也拌进来）。
        # 文字卡第一屏就是「说一句话」，不选文件，所以能直接走到确认页，也不需要模型调用。
        $cardName = '把这段时间做的事写成一份总结'
        $card = Wait-NamePrefix $root $cardName 20
        if (-not $card) { Add-EnvBlocked 'confirm' ('首页上找不到文字卡「' + $cardName + '」')
        break }
        [void](Click-El $card)
        Start-Sleep -Seconds 2
        if (-not (Wait-Name $root '这个任务不用选文件，直接说你要写什么就行。' 15)) {
            # 文案可能变；退一步：只要看到 task-instruction 输入框也算到了。
            if (-not $root.FindFirst($TS::Descendants, (New-Object System.Windows.Automation.PropertyCondition($AE::AutomationIdProperty, 'task-instruction')))) {
                Add-EnvBlocked 'confirm' '没走到「写一句话」那一步'
                break
            }
        }
        $instr = $root.FindFirst($TS::Descendants, (New-Object System.Windows.Automation.PropertyCondition($AE::AutomationIdProperty, 'task-instruction')))
        if ($instr) {
            try { $instr.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue('把我这几个月的流水账写成一份工作总结，别写得太长') } catch {}
        }
        $gen = Wait-Name $root '生成计划' 15
        if (-not $gen) { Add-EnvBlocked 'confirm' '找不到「生成计划」'
        break }
        [void](Click-El $gen)
        Start-Sleep -Seconds 3
        if (-not (Wait-Name $root '它打算这样做' 20)) { Add-EnvBlocked 'confirm' '没走到确认页（找不到「它打算这样做」）'
        break }

        $elements = Dump-And-Judge $root 'confirm' (Join-Path $WorkDir 'elements-confirm.json')
        $nonFocusableNamed = @($elements | Where-Object { -not $_.focusable -and ($_.name -and $_.name.Trim()) }).Count

        Say ''
        Say '=== 确认页：Esc **必须不能**关掉它 ==='
        $before = Focus-Id
        Press-Esc
        Start-Sleep -Seconds 1
        $still = Wait-Name $root '它打算这样做' 5
        $closed = -not [bool]$still
        Add-Verdict 'confirm' 'esc-must-not-close' (-not $closed) $(if ($closed) { '按 Esc 之后确认页不见了 —— 这是 MUST-ANSWER，不该关' } else { '' })
        if ($closed) { Say '  ✗ 按 Esc 之后确认页关了（不该：这是动手前唯一的门，MUST-ANSWER）。' }
        else { Say ('  ✓ 按 Esc 之后确认页还在（MUST-ANSWER，符合设计）。焦点=' + (Focus-Id)) }

        Say ''
        Say '=== 确认页：Tab 在里面走一圈（不许进死循环）==='
        $round = Tab-Round $root 60 $scale
        Add-Verdict 'confirm' 'tab-loops' ([bool]$round.looped) $(if ($round.looped) { '' } else { "按了 $($round.steps) 步没回到起点" })
        Add-Verdict 'confirm' 'tab-not-stuck' ($round.stuck -eq 0) $(if ($round.stuck -eq 0) { '' } else { "有 $($round.stuck) 次停在同一个元素上" })
        if ($script:fgLost) { Add-Verdict 'confirm' 'no-focus-steal' $false '盲按时焦点跑到别的窗口了（测试污染，结果不可信）' }
        Judge-Visited $round 'confirm' (Join-Path $WorkDir 'visited-confirm.json')
    }

    'approval' {
        Say ''
        Say '=== 审批卡：需要真的开跑（这一屏只在做事的过程中出现）==='
        Say '  说明：审批卡要真的连上执行组件、由一个工具调用触发。它**不能**走 msedgedriver'
        Say '        （msedgedriver 启动应用时会盖掉 WEBVIEW2_*，UIA 就只看到壳）—— 所以这一场'
        Say '        自己启动应用、用 UIA 走到确认页并点「开始」，等审批卡出现。'
        Say '        它能不能出现取决于**服务方/执行组件那一侧**；不行就如实报没验成。'
        Say '  为什么用**文件卡**：文字卡（doc.worksummary）一次工具调用都不用就能写完，'
        Say '        实测跑完是 done、根本不出现审批卡 ✗。文件卡要读表、要写结果，才会弹审批。'
        # 文件卡：点卡 → 「选择文件」（原生对话框交给 accept-file-dialog.ps1）→ 下一步 → 写一句 → 生成计划。
        $card = Wait-NamePrefix $root '从大表里挑出想要的行' 20
        if (-not $card) { Add-EnvBlocked 'approval' '首页上找不到文件卡'; break }
        [void](Click-El $card)
        Start-Sleep -Seconds 2
        $pickBtn = Wait-Name $root '选择文件' 15
        if (-not $pickBtn) { Add-EnvBlocked 'approval' '找不到「选择文件」'; break }
        # 先挂上填原生对话框的助手（它自己会等窗口出现）。
        $helper = Join-Path $script:Here 'accept-file-dialog.ps1'
        $inputXlsx = $script:approvalInput
        if (-not $inputXlsx -or -not (Test-Path $inputXlsx)) { Add-EnvBlocked 'approval' ('没有可用的输入表：' + $inputXlsx); break }
        $helperProc = Start-Process powershell -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',$helper,'-Path',$inputXlsx,'-TimeoutSec','90') -PassThru -WindowStyle Hidden
        [void](Click-El $pickBtn)
        [void]$helperProc.WaitForExit(120000)
        Say ('  填原生对话框的助手退出码=' + $helperProc.ExitCode)
        Start-Sleep -Seconds 2
        $next = Wait-Name $root '下一步' 15
        if (-not $next) { Add-EnvBlocked 'approval' '找不到「下一步」'; break }
        [void](Click-El $next)
        Start-Sleep -Seconds 1
        $instr = $root.FindFirst($TS::Descendants, (New-Object System.Windows.Automation.PropertyCondition($AE::AutomationIdProperty, 'task-instruction')))
        if ($instr) { try { $instr.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue('把华东区的记录挑出来，另存成一张新表') } catch {} }
        $gen = Wait-Name $root '生成计划' 15
        if (-not $gen) { Add-EnvBlocked 'approval' '找不到「生成计划」'; break }
        [void](Click-El $gen)
        Start-Sleep -Seconds 3
        if (-not (Wait-Name $root '它打算这样做' 20)) { Add-EnvBlocked 'approval' '没走到确认页'; break }
        $start = Wait-Name $root '开始' 10
        if (-not $start) { Add-EnvBlocked 'approval' '确认页上没有「开始」'; break }
        [void](Click-El $start)
        Say '  已点「开始」，等审批卡（最多 180 秒）…'
        $approval = Wait-Name $root '要不要允许它继续？' 180
        if (-not $approval) {
            # 没等到：如实报**没验成**，并把当时屏幕上的字贴出来（帮助定位是环境还是产品）。
            Say '  （180 秒内没等到审批卡 —— 这一场**没验成**。当时屏幕上有名字的元素：）'
            $names = @()
            foreach ($e in (All-Descendants $root)) { $n = [string]$e.Current.Name; if ($n -and $n.Trim() -and $names -notcontains $n) { $names += $n } }
            SayLines (($names | Select-Object -First 25) -join ' | ')
            Add-EnvBlocked 'approval' '180 秒内没出现审批卡（多半是服务方/执行组件这一侧没跑起来）'
            break
        }
        $elements = Dump-And-Judge $root 'approval' (Join-Path $WorkDir 'elements-approval.json')

        Say ''
        Say '=== 审批卡：Esc **必须不能**关掉它 ==='
        Press-Esc
        Start-Sleep -Seconds 1
        $still = Wait-Name $root '要不要允许它继续？' 5
        $closed = -not [bool]$still
        Add-Verdict 'approval' 'esc-must-not-close' (-not $closed) $(if ($closed) { '按 Esc 之后审批卡不见了 —— MUST-ANSWER，不该关' } else { '' })
        if ($closed) { Say '  ✗ 按 Esc 之后审批卡关了（不该）。' } else { Say ('  ✓ 按 Esc 之后审批卡还在（MUST-ANSWER，符合设计）。焦点=' + (Focus-Id)) }

        Say ''
        Say '=== 审批卡：Tab 在里面走一圈 ==='
        $round = Tab-Round $root 40 $scale
        Add-Verdict 'approval' 'tab-loops' ([bool]$round.looped) $(if ($round.looped) { '' } else { "按了 $($round.steps) 步没回到起点" })
        Add-Verdict 'approval' 'tab-not-stuck' ($round.stuck -eq 0) $(if ($round.stuck -eq 0) { '' } else { "有 $($round.stuck) 次停在同一个元素上" })
        Judge-Visited $round 'approval' (Join-Path $WorkDir 'visited-approval.json')
    }

    'results' {
        Say ''
        Say '=== 「我做的结果」面板：Tab 在层里循环 + Esc 能关（这一层**应该**能关）==='
        $entry = $null
        foreach ($e in (All-Descendants $root)) {
            $n = [string]$e.Current.Name
            if ($n -and $n.StartsWith('打开我做的结果')) { $entry = $e; break }
        }
        if (-not $entry) { Add-EnvBlocked 'results' '首页上找不到「我做的结果」入口'
        break }
        [void](Click-El $entry)
        Start-Sleep -Seconds 2
        if (-not (Wait-Name $root '回到首页' 15)) { Add-EnvBlocked 'results' '面板没打开'
        break }
        $elements = Dump-And-Judge $root 'results' (Join-Path $WorkDir 'elements-results.json')
        $round = Tab-Round $root 220 $scale
        Add-Verdict 'results' 'tab-loops' ([bool]$round.looped) $(if ($round.looped) { '' } else { "按了 $($round.steps) 步没回到起点" })
        Add-Verdict 'results' 'tab-not-stuck' ($round.stuck -eq 0) $(if ($round.stuck -eq 0) { '' } else { "有 $($round.stuck) 次停在同一个元素上" })
        if ($script:fgLost) { Add-Verdict 'results' 'no-focus-steal' $false '盲按时焦点跑到别的窗口了（测试污染，结果不可信）' }
        Judge-Visited $round 'results' (Join-Path $WorkDir 'visited-results.json')

        Say ''
        Say '=== 对照组：这个面板**应该**能被 Esc 关掉（它给了 onEscape）==='
        Press-Esc
        Start-Sleep -Seconds 1
        $gone = -not [bool](Wait-Name $root '回到首页' 4)
        Add-Verdict 'results' 'esc-closes' $gone $(if ($gone) { '' } else { '按 Esc 之后面板还在（它给了 onEscape，应该能关）' })
        if ($gone) { Say '  ✓ 按 Esc 之后面板关掉了（与确认页/审批卡形成对照）。' }
        else { Say '  ✗ 按 Esc 之后面板还在。' }
    }
}

# ---------------------------------------------------------------------------
# 汇总
# ---------------------------------------------------------------------------
Say ''
Say '=== 判据汇总 ==='
foreach ($v in $script:verdicts) {
    Say ('  ' + $(if ($v.Ok) { '✓' } else { '✗' }) + ' [' + $v.Scenario + '] ' + $v.Kind + $(if ($v.Why) { ' —— ' + $v.Why } else { '' }))
}
$bad = @($script:verdicts | Where-Object { -not $_.Ok })
$script:Lines -join "`r`n" | Set-Content -Path (Join-Path $WorkDir ('report-' + $Scenario + '.txt')) -Encoding UTF8
Say ''
Say ("报告原文：" + (Redact (Join-Path $WorkDir ('report-' + $Scenario + '.txt'))))

if (-not $KeepAppRunning) {
    try { Stop-Process -Id $proc.Id -Force } catch {}
    Clear-StaleApp
}

# 顺序很重要：**环境问题优先**。半途因环境原因停下时，判据列表可能是空的（或半套），
# 那时报 OK 就是假绿（实跑踩过：找不到确认页却打了「OK」）。
if ($script:keysUnreliable) {
    Say '环境问题：盲按时拿不到前台，按键可能没送到应用 —— 这一轮的键盘读数不可信，不当产品结论。'
    exit 2
}
if ($script:envBlocked) {
    Say '环境问题：这一场没跑完（见上面每一处的「环境问题」与判据表里 reached-screen 那行）。'
    exit 2
}
if ($bad.Count -gt 0) { Say ("产品问题：" + $bad.Count + ' 条判据不符合。'); exit 3 }
Say ('a11y-uia: OK — ' + $Scenario + ' 这一场的判据都满足。')
exit 0
