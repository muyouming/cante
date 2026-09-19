# 「她的环境比我们想的乱」那一条的真机验收（UIA 取证，一条命令跑一个场景）。
#
# 这一条要在真 Windows 上回答四件事（原任务 1–4）：
#   wizard   —— **1280x800 这一块屏**下把**向导**走一遍：按钮会不会被裁？要不要滚动才点到？
#   screens  —— 这台机器有几个显示设备？只有一个就**如实写"没有第二种显示配置"**。
#   textscale—— 系统「使文本更大」（TextScaleFactor，**不是**显示缩放）：读当前值，
#                在 100%/125%（能改就再加 150%）下各跑一轮首页，看文字有没有被裁。
#   theme    —— 系统暗色/亮色主题切换：看首页与结果页的对比度，记关键控件的**实际颜色**。
#
# 为什么用 UIA 而不是截图：截图像素只能证明"画了东西"，证明不了"画的是哪句话、
# 按钮有多大、在不在视口里"。WebView2 把渲染出来的 DOM 暴露成 UIA 树，读回来才是可核对的证据。
# 这一套与 a11y-uia.ps1 / measure-scale-viewport.ps1 / accept-first-screen.ps1 是同一条路。
#
# 关于"被裁"的判据（本脚本怎么算的）：
#   * 横向裁切：元素的 BoundingRectangle 超出**客户区**右边界 → 记 `overflowRight`；
#   * 纵向裁切：向导那一场额外判"顶部被裁"（F1 那个坑：items-center + 内容比窗口高会让
#     顶部滚不回去）——判首屏**标题**的 top 是否 >= 客户区 top；
#   * 按钮可达：Tab 真走一遍（keybd_event），读回焦点，确认每个按钮都**到得了**，
#     且必要时滚动之后真的能点（真滚轮 + 真 invoke）。
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File gui\scripts\windows\robust\run-robust.ps1 -Scenario wizard
#   ... -Scenario screens
#   ... -Scenario textscale
#   ... -Scenario theme
#
# 退出码：0 = 判据满足；2 = 环境问题（应用/桌面不在、读不到窗口、设置改不了）；3 = 产品问题。
#
# 注意：本文件必须保存为 UTF-8 with BOM（Windows PowerShell 5.1 否则按 GBK 解析中文）。

param(
    [ValidateSet('wizard', 'screens', 'textscale', 'theme')][string]$Scenario = 'wizard',
    [string]$Exe = "",
    [string]$WorkDir = "",
    [int]$StartupSecs = 14,
    # 保留应用状态（不清档案）。向导那一场**必须**是首启，所以默认会清。
    [switch]$KeepState,
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
# 会话判断（照 run-accept-drive.ps1 / a11y-uia.ps1 那套，不另发明）
# ---------------------------------------------------------------------------
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
$sessionId = (Get-Process -Id $PID).SessionId
$hasDesktop = [bool](Get-Process explorer -ErrorAction SilentlyContinue)
Say ("会话：session=$sessionId elevated=$isAdmin 有桌面=$hasDesktop")
if ($isAdmin) { Say '环境问题：当前是提权会话，WebView2 会忽略 WEBVIEW2_*，UIA 读不到 DOM。用不提权的交互会话跑。'; exit 2 }
if (-not $hasDesktop) { Say '环境问题：这个会话没有交互桌面。'; exit 2 }

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Drawing
# Windows Forms 只为了读 Screen.AllScreens / SendKeys —— 放在顶层一次加载，
# 别放在 switch 分支里（wizard 那场在第 331 行就要用它，而那时分支里还没加载）。
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class RW {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int ht, bool repaint);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, int d, UIntPtr e);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
}
"@
$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]

$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--force-renderer-accessibility'

if (-not $WorkDir) { $WorkDir = Join-Path $env:TEMP ('cante-robust-' + $Scenario + '-' + (Get-Date -Format 'yyyyMMdd-HHmmss')) }
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
        Get-Process -Name $name -ErrorAction SilentlyContinue | ForEach-Object {
            try { Stop-Process -Id $_.Id -Force } catch {}
        }
    }
    # **WebView2 的渲染进程也要清**：实测踩过 —— 上一次跑被中断后残留的
    # `msedgewebview2.exe` 会占住应用档案（`%LOCALAPPDATA%\dev.cante.gui`），
    # 于是下一次启动**直接 exit -1**，看起来像“应用起不来”✗（不是产品问题）。
    # 只清**属于这个应用**的那些（命令行里带 dev.cante.gui），不动她正常的 Edge 渲染进程。
    Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and ($_.CommandLine -like '*dev.cante.gui*') } |
        ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force } catch {} }
    Start-Sleep -Seconds 2
}
function All-Desc($root) { return $root.FindAll($TS::Descendants, [System.Windows.Automation.Condition]::TrueCondition) }
function Kind-Of($el) {
    $t = $el.Current.ControlType.ProgrammaticName
    if ($t -and $t.Contains('.')) { return $t.Substring($t.LastIndexOf('.') + 1) }
    return $t
}
function Describe-El($el, [double]$scale) {
    $r = $el.Current.BoundingRectangle
    $fin = (-not [double]::IsInfinity($r.Left)) -and (-not [double]::IsNaN($r.Left)) -and (-not [double]::IsInfinity($r.Width))
    if (-not $fin) {
        return [pscustomobject]@{ name = [string]$el.Current.Name; kind = (Kind-Of $el); focusable = [bool]$el.Current.IsKeyboardFocusable
            offscreen = [bool]$el.Current.IsOffscreen; left = $null; top = $null; right = $null; bottom = $null
            wPhys = $null; hPhys = $null; wLogical = $null; hLogical = $null }
    }
    return [pscustomobject]@{
        name = [string]$el.Current.Name; kind = (Kind-Of $el)
        focusable = [bool]$el.Current.IsKeyboardFocusable; offscreen = [bool]$el.Current.IsOffscreen
        left = [int]$r.Left; top = [int]$r.Top; right = [int]$r.Right; bottom = [int]$r.Bottom
        wPhys = [math]::Round($r.Width, 1); hPhys = [math]::Round($r.Height, 1)
        wLogical = [math]::Round($r.Width / $scale, 1); hLogical = [math]::Round($r.Height / $scale, 1)
    }
}
function Urgb($el) {
    # UIA 给的颜色：WebView2 的 DOM 元素**实测都是 (0,0,0)**（它不把 CSS 颜色报上来），
    # 所以这一条只能当“UIA 有没有给”的如实记录，**不能**当对比度证据（对比度用像素采样，见 PixelStats）。
    try {
        $fg = $el.Current.ForegroundColor
        $bg = $el.Current.BackgroundColor
        return @([int]$fg.R, [int]$fg.G, [int]$fg.B, [int]$bg.R, [int]$bg.G, [int]$bg.B)
    } catch { return $null }
}

# 从**截图像素**里量对比度：在一个元素的矩形内采样，取其**最低/最高亮度**的两个颜色，
# 算 WCAG 对比度（(L1+0.05)/(L2+0.05)）。这是近似（字体反锯齿/渐变会让极值偏极端），
# 但它基于“屏幕上真的画出来的颜色”，比向 UIA 要颜色可靠得多（UIA 对 WebView2 全报 0）。
function PixelStats([string]$png, [int]$l, [int]$t, [int]$r, [int]$b) {
    try {
        $bmp = [System.Drawing.Bitmap]::FromFile($png)
        $minL = 2.0; $maxL = -1.0; $minC = $null; $maxC = $null; $n = 0
        for ($y = [Math]::Max(0, $t); $y -lt [Math]::Min($bmp.Height, $b); $y++) {
            for ($x = [Math]::Max(0, $l); $x -lt [Math]::Min($bmp.Width, $r); $x++) {
                $c = $bmp.GetPixel($x, $y)
                # WCAG 相对亮度
                $lum = 0.2126 * [Math]::Pow($c.R / 255.0, 2.2) + 0.7152 * [Math]::Pow($c.G / 255.0, 2.2) + 0.0722 * [Math]::Pow($c.B / 255.0, 2.2)
                $n++
                if ($lum -lt $minL) { $minL = $lum; $minC = "$($c.R),$($c.G),$($c.B)" }
                if ($lum -gt $maxL) { $maxL = $lum; $maxC = "$($c.R),$($c.G),$($c.B)" }
            }
        }
        $bmp.Dispose()
        $ratio = if ($maxL -ge 0 -and $minL -le 2) { [Math]::Round(($maxL + 0.05) / ($minL + 0.05), 2) } else { $null }
        return [pscustomobject]@{ samples = $n; darkest = $minC; lightest = $maxC; contrastRatio = $ratio }
    } catch { return $null }
}
function Wait-Name($root, [string]$name, [int]$timeoutSec = 20) {
    $d = (Get-Date).AddSeconds($timeoutSec)
    while ((Get-Date) -lt $d) {
        $c = New-Object System.Windows.Automation.PropertyCondition($AE::NameProperty, $name)
        $e = $root.FindFirst($TS::Descendants, $c)
        if ($e) { return $e }
        Start-Sleep -Milliseconds 400
    }
    return $null
}
function Wait-Prefix($root, [string]$prefix, [int]$timeoutSec = 20) {
    $d = (Get-Date).AddSeconds($timeoutSec)
    while ((Get-Date) -lt $d) {
        foreach ($e in (All-Desc $root)) {
            $n = [string]$e.Current.Name
            if ($n -and $n.StartsWith($prefix)) { return $e }
        }
        Start-Sleep -Milliseconds 400
    }
    return $null
}
# 等**包含**某段文字的元素出现。首屏标题渲染成「你好，需要我帮你做什么？」—— 用等值匹配找不到它，
# 会把“首页没渲染出来”误报成失败（实跑踩到）。凡是要找 UI 中文的地方，一律用包含匹配。
function Wait-Contains($root, [string]$needle, [int]$timeoutSec = 20) {
    $d = (Get-Date).AddSeconds($timeoutSec)
    while ((Get-Date) -lt $d) {
        foreach ($e in (All-Desc $root)) {
            $n = [string]$e.Current.Name
            if ($n -and $n.Contains($needle)) { return $e }
        }
        Start-Sleep -Milliseconds 400
    }
    return $null
}

function Click-El($el) {
    try { $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke(); return $true } catch { return $false }
}
function Save-Shot([IntPtr]$hwnd, [string]$path) {
    # PrintWindow 截图（PW_RENDERFULLCONTENT=2）：留档，供人眼看。拿不到画面时如实说。
    try {
        Add-Type @"
using System; using System.Runtime.InteropServices;
public class Shot { [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R.RECT r);
 [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint f); }
public class R { [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; } }
"@ -ErrorAction SilentlyContinue
        $rect = New-Object R+RECT
        [void][Shot]::GetWindowRect($hwnd, [ref]$rect)
        $w = $rect.Right - $rect.Left; $h = $rect.Bottom - $rect.Top
        if ($w -le 0 -or $h -le 0) { return $false }
        $bmp = New-Object System.Drawing.Bitmap $w, $h
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $dc = $g.GetHdc()
        $ok = [Shot]::PrintWindow($hwnd, $dc, 2)
        $g.ReleaseHdc($dc); $g.Dispose()
        $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
        # 非黑像素比例：全黑的图不能当证据（SSH/无桌面时常见）
        $nonBlack = 0; $tot = 0
        for ($y = 0; $y -lt $h; $y += 6) { for ($x = 0; $x -lt $w; $x += 6) { $tot++; $c = $bmp.GetPixel($x, $y); if ($c.R -gt 8 -or $c.G -gt 8 -or $c.B -gt 8) { $nonBlack++ } } }
        $bmp.Dispose()
        $script:lastShotNonBlack = if ($tot -gt 0) { [math]::Round(100.0 * $nonBlack / $tot, 2) } else { 0 }
        return $ok
    } catch { return $false }
}

$script:verdicts = New-Object System.Collections.Generic.List[object]
function Add-Verdict([string]$sc, [string]$kind, [bool]$ok, [string]$why) {
    $script:verdicts.Add([pscustomobject]@{ Scenario = $sc; Kind = $kind; Ok = $ok; Why = $why })
}
$script:envBlocked = $false
function Add-EnvBlocked([string]$sc, [string]$why) {
    $script:envBlocked = $true
    $script:verdicts.Add([pscustomobject]@{ Scenario = $sc; Kind = 'reached-screen'; Ok = $false; Why = $why })
}
# 「这一条**验不了**」——不是产品问题，是这台机器/这个环境给不出那种配置
# （例如「只有一个显示设备」→ 多屏这条无法验）。它要与「产品不符合」分开：
# 报成产品问题会让人去「修」一个不存在的问题 ✗（任务里点名要求区分这两者）。
$script:unverifiable = $false
function Add-Unverifiable([string]$sc, [string]$kind, [string]$why) {
    $script:unverifiable = $true
    $script:verdicts.Add([pscustomobject]@{ Scenario = $sc; Kind = $kind; Ok = $false; Why = $why })
}

$exePath = Resolve-AppExe $Exe
if (-not $exePath) { Say '环境问题：找不到 cante-gui.exe'; exit 2 }
SayR ("应用：" + $exePath)
SayR ("工作目录：" + $WorkDir)

$script:appHwnd = [IntPtr]::Zero
$script:appRoot = $null
$script:clientRect = $null
$script:scale = 1.0

# 启动应用 + 拿 root / 客户区 / DPI。$clear 时先清档案（向导要首启）。
function Start-App([bool]$clear) {
    # 最多两次：实测踩到过 —— 上一次跑被中断后残留的 WebView2 渲染进程占着应用档案，
    # 下一次启动会直接退出（exit -1），看起来像“应用起不来”✗（不是产品问题）。
    # 清完残留重试一次就好；两次都不行才当真失败。
    for ($attempt = 1; $attempt -le 2; $attempt++) {
        Clear-Stale
        if ($attempt -gt 1) { Start-Sleep -Seconds 3 }
        if ($clear -and -not $KeepState) {
            foreach ($d in @($profileDir, $historyDir)) {
                if (Test-Path $d) { Remove-Item $d -Recurse -Force -ErrorAction SilentlyContinue }
            }
        }
        $p = Start-Process -FilePath $exePath -PassThru
        Start-Sleep -Seconds $StartupSecs
        $p.Refresh()
        if ($p.HasExited) {
            Say ("    （启动尝试 " + $attempt + "：应用退出了，exit=" + $p.ExitCode + " —— 再清一次残留、重试）")
            continue
        }
        $hwnd = $p.MainWindowHandle
        if ($hwnd -eq 0) { Start-Sleep -Seconds 5; $p.Refresh(); $hwnd = $p.MainWindowHandle }
        if ($hwnd -eq 0) { Say ("    （启动尝试 " + $attempt + "：拿不到窗口句柄）"); try { Stop-Process -Id $p.Id -Force } catch {}; continue }
        $root = $AE::FromHandle($hwnd)
        if (-not $root) { try { Stop-Process -Id $p.Id -Force } catch {}; continue }
        $script:appHwnd = $hwnd
        $script:appRoot = $root
        $dpi = [RW]::GetDpiForWindow($hwnd); if (-not $dpi) { $dpi = 96 }
        $script:scale = [double]$dpi / 96.0
        $cr = New-Object RW+RECT
        [void][RW]::GetClientRect($hwnd, [ref]$cr)
        $o = New-Object RW+POINT
        [void][RW]::ClientToScreen($hwnd, [ref]$o)
        $script:clientRect = @($o.X, $o.Y, ($o.X + $cr.Right), ($o.Y + $cr.Bottom))
        [void][RW]::SetForegroundWindow($hwnd)
        Start-Sleep -Seconds 1
        return $p
    }
    return $null
}

# 列出当前有名字/可聚焦的元素，并判"横向溢出客户区"与"是否在客户区内"。
# 把页面滚到**顶部**再量：页面本来就可滚动（首页比窗口高），而滚动位置会跨启动保留
# （WebView2 档案里存着）。不先归位的话，标题可能量到 top=-171（在视口上方）—— 那是
# “页面被滚下去了”，**不是文字被裁** ✗（实跑踩到，测出未验证的假红）。
function Scroll-ToTop {
    [void][RW]::SetForegroundWindow($script:appHwnd)
    $cx = $script:clientRect[0] + [int](($script:clientRect[2] - $script:clientRect[0]) / 2)
    $cy = $script:clientRect[1] + [int](($script:clientRect[3] - $script:clientRect[1]) / 2)
    [void][RW]::SetCursorPos($cx, $cy)
    Start-Sleep -Milliseconds 200
    for ($i = 1; $i -le 12; $i++) { [RW]::mouse_event(0x0800, 0, 0, 120, [UIntPtr]::Zero); Start-Sleep -Milliseconds 90 }
    Start-Sleep -Milliseconds 300
}

function Dump-Elements([string]$tag, [string]$outFile) {
    # **量之前先重新取一次客户区**：窗口可能在启动之后被移过（实测踩到：
    # 窗口状态插件会恢复上次的位置，于是启动时取的 clientRect 过期了，
    # 元素的屏幕坐标看起来“在客户区之外”如 top=-477 ✗ —— 那是**坐标基准过期**，不是产品问题）。
    $cr = New-Object RW+RECT
    [void][RW]::GetClientRect($script:appHwnd, [ref]$cr)
    $o = New-Object RW+POINT
    [void][RW]::ClientToScreen($script:appHwnd, [ref]$o)
    $script:clientRect = @($o.X, $o.Y, ($o.X + $cr.Right), ($o.Y + $cr.Bottom))
    $els = @()
    foreach ($e in (All-Desc $script:appRoot)) {
        $d = Describe-El $e $script:scale
        if (($d.name -and $d.name.Trim()) -or $d.focusable) { $els += $d }
    }
    # 横向溢出：右边界超过客户区右边界，且不是全屏容器（宽度接近整窗的容器不算"内容被裁"）
    $clientW = $script:clientRect[2] - $script:clientRect[0]
    foreach ($d in $els) {
        $d | Add-Member -NotePropertyName overflowRight -NotePropertyValue $false -Force
        $d | Add-Member -NotePropertyName insideClient -NotePropertyValue $false -Force
        if ($null -ne $d.right) {
            $d.overflowRight = ($d.right -gt ($script:clientRect[2] + 1))
            $d.insideClient = ($d.left -ge ($script:clientRect[0] - 1)) -and ($d.right -le ($script:clientRect[2] + 1)) -and
                              ($d.top -ge ($script:clientRect[1] - 1)) -and ($d.bottom -le ($script:clientRect[3] + 1))
        }
    }
    $els | ConvertTo-Json -Depth 5 | Set-Content -Path $outFile -Encoding UTF8
    return $els
}

# ---------------------------------------------------------------------------
# 场景
# ---------------------------------------------------------------------------

switch ($Scenario) {

    'screens' {
        Say ''
        Say '=== 显示设备（有几个？只有一种就如实写"没有第二种显示配置"）==='
        $screens = [System.Windows.Forms.Screen]::AllScreens
        Say ("AllScreens.Count = " + $screens.Count)
        foreach ($s in $screens) {
            Say ("  设备=" + $s.DeviceName + " 主屏=" + $s.Primary + " 显示区域=" + $s.Bounds.Width + "x" + $s.Bounds.Height +
                 " 工作区=" + $s.WorkingArea.Width + "x" + $s.WorkingArea.Height)
        }
        $mon = @(Get-CimInstance Win32_DesktopMonitor -ErrorAction SilentlyContinue)
        Say ("Win32_DesktopMonitor 条数 = " + $mon.Count)
        foreach ($m in $mon) { Say ("  " + $m.DeviceID + " / " + $m.Name + " / Status=" + $m.Status) }
        $video = @(Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue)
        Say ("显示适配器 = " + $video.Count + " 个")
        foreach ($v in $video) { Say ("  " + $v.Name + " 驱动=" + $v.DriverVersion + " 分辨率=" + $v.CurrentHorizontalResolution + "x" + $v.CurrentVerticalResolution) }

        if ($screens.Count -le 1) {
            Add-Unverifiable 'screens' 'second-display-config' '这台机器只有一个显示设备 —— 多屏/换屏这条**验不了**（如实写）'
        } else {
            Add-Verdict 'screens' 'second-display-config' $true ''
        }
        # 工作区与任务栏也记下来（「版面够不够」跟它有关）
        $wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
        $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
        Say ("任务栏占的高度 = " + ($b.Height - $wa.Height) + "px")
    }

    'wizard' {
        Say ''
        Say '=== 向导：1280x800 首启走一遍，看有没有被裁 / 要滚动才能点到 ==='
        $p = Start-App $true
        if (-not $p) { Add-EnvBlocked 'wizard' '应用起不来或拿不到窗口'; break }
        Say ("窗口客户区=[$($script:clientRect -join ',')]  缩放=$($script:scale)（DPI=" + [RW]::GetDpiForWindow($script:appHwnd) + ")")
        Say ("主屏=" + [System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Width + "x" + [System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Height)

        # 第 1 步（欢迎）：标题与主按钮都得在客户区里。
        if (-not (Wait-Name $script:appRoot '开始检查' 20)) { Add-EnvBlocked 'wizard' '第一屏没出现「开始检查」（向导没起来？）'; break }
        $els = Dump-Elements 'wizard-step1' (Join-Path $WorkDir 'wizard-step1.json')
        Say ''
        Say '--- 第 1 步（欢迎）关键元素 ---'
        foreach ($n in @('欢迎使用 Cante', '开始检查', '1', '历史')) {
            $d = $els | Where-Object { $_.name -eq $n } | Select-Object -First 1
            if ($d) {
                Say ('  | ' + $d.kind + '「' + $d.name + '」top=' + $d.top + ' 高=' + $d.hLogical + '逻辑 在客户区内=' + $d.insideClient + ' 横向溢出=' + $d.overflowRight)
            }
        }
        $overflow = @($els | Where-Object { $_.overflowRight -and $_.hLogical -gt 0 })
        $title = $els | Where-Object { $_.name -eq '欢迎使用 Cante' } | Select-Object -First 1
        # F1 那个坑：内容比窗口高时顶部被裁、滚不回去。首屏标题的 top 必须在客户区内。
        $titleNotClipped = ($null -ne $title) -and ($title.top -ge ($script:clientRect[1] - 1))
        Add-Verdict 'wizard' 'welcome-title-not-clipped' $titleNotClipped $(if ($titleNotClipped) { '' } else { '首屏标题的 top 在客户区之上（顶部被裁）' })
        Say ''
        Say ('  横向溢出客户区的元素数 = ' + $overflow.Count)
        foreach ($d in ($overflow | Select-Object -First 6)) { Say ('     · ' + $d.kind + '「' + $d.name + '」right=' + $d.right + ' > 客户区右=' + $script:clientRect[2]) }

        # Tab 真走一遍：每个按钮都到得了吗（到不了 = 只能滚动/鼠标才够得着）
        $script:reachable = New-Object System.Collections.Generic.List[string]
        [System.Windows.Forms.SendKeys]::SendWait('')  # 触发输入队列就绪
        [void][RW]::SetForegroundWindow($script:appHwnd)
        # 先让焦点进到页面（按一次 Tab）
        $VK_TAB = 0x09
        [RW]::keybd_event($VK_TAB, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 60
        [RW]::keybd_event($VK_TAB, 0, 2, [UIntPtr]::Zero); Start-Sleep -Milliseconds 350
        for ($i = 1; $i -le 12; $i++) {
            $f = $AE::FocusedElement
            if ($f) {
                $n = [string]$f.Current.Name
                if ($n) { $script:reachable.Add($n) }
            }
            if ($AE::FocusedElement -and ([string]$AE::FocusedElement.Current.Name) -eq '开始检查') { break }
            [RW]::keybd_event($VK_TAB, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 60
            [RW]::keybd_event($VK_TAB, 0, 2, [UIntPtr]::Zero); Start-Sleep -Milliseconds 350
        }
        Say ''
        Say ('  Tab 走过的元素：' + (($script:reachable | Select-Object -Unique) -join ' → '))
        $sawStart = @($script:reachable | Where-Object { $_ -eq '开始检查' }).Count -gt 0
        Add-Verdict 'wizard' 'welcome-button-keyboard-reachable' $sawStart $(if ($sawStart) { '' } else { 'Tab 走不到「开始检查」' })

        # 点「开始检查」→ 等到 ready 或 notReady 的按钮；再点能到「下一步/先看看界面」
        $btn = Wait-Name $script:appRoot '开始检查' 10
        [void](Click-El $btn)
        Say ''
        Say '  已点「开始检查」，等检查结果…'
        $next = $null
        for ($i = 1; $i -le 30; $i++) {
            $next = Wait-Name $script:appRoot '下一步' 2
            if (-not $next) { $next = Wait-Name $script:appRoot '先看看界面' 2 }
            if ($next) { break }
        }
        if (-not $next) { Add-EnvBlocked 'wizard' '检查这一步没给出任何可点的按钮'; break }
        $els2 = Dump-Elements 'wizard-step2' (Join-Path $WorkDir 'wizard-step2.json')
        Say ('  第 2 步按钮：' + ([string]$next.Current.Name))
        $d2 = $els2 | Where-Object { $_.name -eq ([string]$next.Current.Name) } | Select-Object -First 1
        if ($d2) { Say ('  | ' + $d2.kind + '「' + $d2.name + '」top=' + $d2.top + ' 高=' + $d2.hLogical + ' 在客户区内=' + $d2.insideClient) }

        [void](Click-El $next)
        Start-Sleep -Seconds 1
        # 第 3 步（开始使用 / 三条承诺）：主按钮「开始使用」
        $done = Wait-Name $script:appRoot '开始使用' 15
        if ($done) {
            $els3 = Dump-Elements 'wizard-step3' (Join-Path $WorkDir 'wizard-step3.json')
            Say ''
            Say '--- 第 3 步（开始使用）关键元素 ---'
            foreach ($n in @('开始之前，先记住三件事', '开始使用')) {
                $d = $els3 | Where-Object { $_.name -eq $n } | Select-Object -First 1
                if ($d) { Say ('  | ' + $d.kind + '「' + $d.name + '」top=' + $d.top + ' 高=' + $d.hLogical + ' 在客户区内=' + $d.insideClient + ' 横向溢出=' + $d.overflowRight) }
            }
            $t3 = $els3 | Where-Object { $_.name -eq '开始之前，先记住三件事' } | Select-Object -First 1
            $ok3 = ($null -ne $t3) -and ($t3.top -ge ($script:clientRect[1] - 1))
            Add-Verdict 'wizard' 'laststep-title-not-clipped' $ok3 $(if ($ok3) { '' } else { '最后一步标题的 top 在客户区之上（顶部被裁）' })
            # 滚轮可达性：把关键按钮“落到视口里”当成可操作（源头上说的“要滚动才能点到”）。
        # 两种都要报：① 一开始就在视口里；②一开始在折叠之下、但滚 N 格后进视口且真 invoke 成功。
        $b3 = $els3 | Where-Object { $_.name -eq '开始使用' } | Select-Object -First 1
        if ($b3) {
            $clientBottom = $script:clientRect[3]
            $visiblePx = if ($null -ne $b3.bottom) { [Math]::Max(0, [Math]::Min($b3.bottom, $clientBottom) - $b3.top) } else { 0 }
            Say ('  「开始使用」top=' + $b3.top + ' 底=' + $b3.bottom + ' 客户区底=' + $clientBottom +
                 ' → 可见高=' + $visiblePx + ' / 共 ' + $b3.hLogical + '逻辑；整块在视口内=' + $b3.insideClient)
            if ($b3.insideClient) {
                Add-Verdict 'wizard' 'laststep-button-reachable' $true ''
                Say '  ✓ 一开始就整块在视口里。'
            } else {
                # 滚轮把它拉进来，到位后**真 invoke 一下**（“看得见 ≠ 点得到”）。
                [void][RW]::SetCursorPos(($script:clientRect[0] + [int](($script:clientRect[2] - $script:clientRect[0]) / 2)),
                                          ($script:clientRect[1] + [int](($script:clientRect[3] - $script:clientRect[1]) / 2)))
                $notches = 0; $reached = $false
                for ($i = 1; $i -le 8; $i++) {
                    [RW]::mouse_event(0x0800, 0, 0, -120, [UIntPtr]::Zero)
                    Start-Sleep -Milliseconds 250
                    # 重新量一次真实矩形（滚动改变了位置）
                    $cond = New-Object System.Windows.Automation.PropertyCondition($AE::NameProperty, '开始使用')
                    $elNow = $script:appRoot.FindFirst($TS::Descendants, $cond)
                    $notches = $i
                    if ($elNow) {
                        $rr = $elNow.Current.BoundingRectangle
                        if ($rr.Bottom -le ($script:clientRect[3] + 1)) { $reached = $true; break }
                    }
                }
                Say ('  滚 ' + $notches + ' 格后进视口=' + $reached)
                $clicked = $false
                if ($reached) {
                    $cond = New-Object System.Windows.Automation.PropertyCondition($AE::NameProperty, '开始使用')
                    $elNow = $script:appRoot.FindFirst($TS::Descendants, $cond)
                    $clicked = if ($elNow) { Click-El $elNow } else { $false }
                    Say ('  真 invoke「开始使用」= ' + $clicked)
                }
                # 可达 ≠ 一开始就在屏上：两者都报出来，判据看“能不能到她手上”（滚轮 + 真点）。
                Add-Verdict 'wizard' 'laststep-button-reachable' ($reached -and $clicked) `
                    $(if ($reached -and $clicked) { '' } else { "滚 $notches 格后仍不可达/点不到" })
            }
        } else {
            Add-Verdict 'wizard' 'laststep-button-reachable' $false '找不到「开始使用」'
        }
        } else {
            Say '  （没走到「开始使用」那一步 —— 如实记为没验到）'
            Add-Verdict 'wizard' 'laststep-reached' $false '没走到最后一步'
        }
        $shot = Join-Path $WorkDir 'wizard.png'
        [void](Save-Shot $script:appHwnd $shot)
        Say ('  截图：' + (Redact $shot) + '  非黑像素比例=' + $script:lastShotNonBlack + '%')
        if (-not $KeepAppRunning) { try { Stop-Process -Id $p.Id -Force } catch {} }
    }

    'textscale' {
        Say ''
        Say '=== 系统「使文本更大」：读当前值，能改就在 100%/125%/150% 各跑一轮首页 ==='
        $key = 'HKCU:\Software\Microsoft\Accessibility'
        New-Item -Path $key -Force | Out-Null
        $script:greetH = @{}
        $script:bodyW = @{}
        $orig = (Get-ItemProperty $key -Name TextScaleFactor -ErrorAction SilentlyContinue).TextScaleFactor
        Say ("原始 TextScaleFactor = [" + $orig + "]（没设过 = 系统默认 100%）")
        $script:textScaleOrig = $orig

        # 先确认这是「使文本更大」那一项，不是显示缩放（两者不同；显示缩放这台机器改不了，见 -18）
        Say '  说明：这是 Windows「使文本更大」（TextScaleFactor），**不是**显示缩放（DPI）。'
        Say '        -18 那份报告验过：这台机器的显示缩放改不了（适配器不支持 rc=87）。'

        foreach ($pct in @(100, 125, 150)) {
            Set-ItemProperty -Path $key -Name TextScaleFactor -Value $pct -Type DWord
            Say ''
            Say ("--- TextScaleFactor = " + $pct + " ---")
            $p = Start-App $false
            if (-not $p) { Add-EnvBlocked 'textscale' ("$pct% 时应用起不来"); continue }
            Start-Sleep -Seconds 1
            # 首页：等一个稳定文案
            if (-not (Wait-Contains $script:appRoot '需要我帮你做什么' 25)) {
                # 可能停在向导：点过去
                $b = Wait-Name $script:appRoot '开始检查' 8
                if ($b) { [void](Click-El $b); Start-Sleep -Seconds 3
                    $n2 = Wait-Name $script:appRoot '先看看界面' 8; if ($n2) { [void](Click-El $n2); Start-Sleep -Seconds 2 }
                    $n3 = Wait-Name $script:appRoot '开始使用' 8; if ($n3) { [void](Click-El $n3); Start-Sleep -Seconds 2 } }
            }
            Scroll-ToTop
            $els = Dump-Elements ("home-scale-$pct") (Join-Path $WorkDir ("home-$pct.json"))
            # 用**包含**匹配，不用等值：首屏标题渲染成「你好，需要我帮你做什么？」（带称呼与问号）。
            # 等值匹配会找不到，把“文字没被裁”误报成失败（实跑踩到）。
            $greet = $els | Where-Object { $_.name -and $_.name.Contains('需要我帮你做什么') } | Select-Object -First 1
            $body = $els | Where-Object { $_.name -like '点一张卡片*' } | Select-Object -First 1
            # 关键：有没有文字被**横向**挤出客户区
            $overflow = @($els | Where-Object { $_.overflowRight -and $_.hLogical -gt 0 })
            $clippedText = @($overflow | Where-Object { $_.kind -eq 'Text' -or $_.kind -eq 'Button' })
            Say ("  命名元素=" + $els.Count + "  横向溢出=" + $overflow.Count + "（其中文字/按钮=" + $clippedText.Count + "）")
            if ($greet) { Say ('  标题「你好，需要我帮你做什么？」高=' + $greet.hLogical + '逻辑 宽=' + $greet.wLogical + ' 客户区内=' + $greet.insideClient) }
            if ($body) { Say ('  正文「点一张卡片…」高=' + $body.hLogical + '逻辑 宽=' + $body.wLogical + ' 客户区内=' + $body.insideClient) }
            # “设置真的生效了吗”的证据：同一段文字的高度/宽度随比例长（不是靠窗口尺寸推的）
            if ($greet) { $script:greetH[$pct] = $greet.hLogical }
            if ($body) { $script:bodyW[$pct] = $body.wLogical }
            foreach ($d in ($clippedText | Select-Object -First 5)) { Say ('     · 溢出：' + $d.kind + '「' + $d.name.Substring(0,[Math]::Min(24,$d.name.Length)) + '」right=' + $d.right) }
            $ok = ($clippedText.Count -eq 0) -and ($null -ne $greet) -and $greet.overflowRight -eq $false
            Add-Verdict 'textscale' ("no-horizontal-clip@" + $pct + "%") $ok $(if ($ok) { '' } else { "有 $($clippedText.Count) 处文字/按钮横向溢出；或标题没渲染出来" })
            # 纵向单独记事实（页面本来就可滚动，纵向位置不是“被裁”的判据；已先滚到顶）。
            if ($greet) { Say ('  （纵向：标题 top=' + $greet.top + ' 客户区 top=' + $script:clientRect[1] + ' —— 已先滚到顶，纵向只作事实记录）') }
            $shot = Join-Path $WorkDir ("home-" + $pct + ".png")
            [void](Save-Shot $script:appHwnd $shot)
            Say ('  截图：' + (Redact $shot) + '  非黑像素比例=' + $script:lastShotNonBlack + '%')
            try { Stop-Process -Id $p.Id -Force } catch {}
            Start-Sleep -Seconds 2
        }

        # 还原（**必须**）
        if ($null -eq $orig -or $orig -eq '') { Remove-ItemProperty -Path $key -Name TextScaleFactor -ErrorAction SilentlyContinue }
        else { Set-ItemProperty -Path $key -Name TextScaleFactor -Value ([int]$orig) -Type DWord }
        $back = (Get-ItemProperty $key -Name TextScaleFactor -ErrorAction SilentlyContinue).TextScaleFactor
        Say ''
        Say '=== 设置真的生效了吗（同一段文字的尺寸随比例长）==='
        foreach ($pct in @(100, 125, 150)) {
            Say ("  TextScaleFactor=" + $pct + "%：标题高=" + $script:greetH[$pct] + "逻辑  正文宽=" + $script:bodyW[$pct])
        }
        $grew = ($script:greetH[125] -gt $script:greetH[100]) -and ($script:greetH[150] -gt $script:greetH[125])
        Add-Verdict 'textscale' 'setting-took-effect' $grew $(if ($grew) { '' } else { '文字尺寸没随 TextScaleFactor 长 —— 设置可能没生效' })
        Say ("还原后 TextScaleFactor = [" + $back + "]（应等于原始值 [" + $orig + "]）")
        $restored = (("$back" -eq "$orig") -or (($null -eq $orig -or $orig -eq '') -and ($null -eq $back -or $back -eq '')))
        Add-Verdict 'textscale' 'setting-restored' $restored $(if ($restored) { '' } else { 'TextScaleFactor 没还原回去' })
    }

    'theme' {
        Say ''
        Say '=== 系统主题：切到另一种，看首页的对比度，再还原 ==='
        $key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize'
        $origApps = (Get-ItemProperty $key -Name AppsUseLightTheme -ErrorAction SilentlyContinue).AppsUseLightTheme
        $origSys = (Get-ItemProperty $key -Name SystemUsesLightTheme -ErrorAction SilentlyContinue).SystemUsesLightTheme
        Say ("原始：AppsUseLightTheme=[" + $origApps + "]  SystemUsesLightTheme=[" + $origSys + "]")
        Say '  （1 = 亮色，0 = 暗色。）'
        Say '  一个先要说清的事实：**这个界面自带一套深色底**（bg-[#0b0f14]），它不看系统主题。'
        Say '  所以"系统亮色 / 应用深色"本来就是产品现在的样子 —— 这一条验的是**换了系统主题之后还看不看得清**。'
        @{ apps = $origApps; sys = $origSys } | ConvertTo-Json | Set-Content -Path (Join-Path $WorkDir 'theme-original.json') -Encoding UTF8

        foreach ($t in @(@{ tag = 'dark'; v = 0 }, @{ tag = 'light'; v = 1 })) {
            Set-ItemProperty -Path $key -Name AppsUseLightTheme -Value $t.v -Type DWord
            Set-ItemProperty -Path $key -Name SystemUsesLightTheme -Value $t.v -Type DWord
            Say ''
            Say ("--- 系统主题 = " + $t.tag + "（AppsUseLightTheme=" + $t.v + "）---")
            $p = Start-App $false
            if (-not $p) { Add-EnvBlocked 'theme' ($t.tag + ' 时应用起不来'); continue }
            if (-not (Wait-Contains $script:appRoot '需要我帮你做什么' 25)) {
                $b = Wait-Name $script:appRoot '开始检查' 8
                if ($b) { [void](Click-El $b); Start-Sleep -Seconds 3
                    $n2 = Wait-Name $script:appRoot '先看看界面' 8; if ($n2) { [void](Click-El $n2); Start-Sleep -Seconds 2 }
                    $n3 = Wait-Name $script:appRoot '开始使用' 8; if ($n3) { [void](Click-El $n3); Start-Sleep -Seconds 2 } }
            } else {
                # Wait-Name 用等值匹配找不到「你好，需要我帮你做什么？」，所以上面用包含判断兜一下
                $g = Wait-Prefix $script:appRoot '你好' 10
                if (-not $g) { $g = Wait-Prefix $script:appRoot '需要我帮你' 10 }
            }
            Scroll-ToTop
            $els = Dump-Elements ("home-theme-" + $t.tag) (Join-Path $WorkDir ("home-theme-" + $t.tag + ".json"))
            $shot = Join-Path $WorkDir ("home-theme-" + $t.tag + ".png")
            [void](Save-Shot $script:appHwnd $shot)
            $wr = New-Object R+RECT
            [void][Shot]::GetWindowRect($script:appHwnd, [ref]$wr)
            Say ('  截图：' + (Redact $shot) + '  非黑像素比例=' + $script:lastShotNonBlack + '%')
            Say '--- 关键控件：几何 + 像素采样对比度（截图坐标 = 屏幕坐标 - 窗口左上） ---'
            $rows = @()
            foreach ($n in @('需要我帮你做什么', '点一张卡片', '历史', '隐私', '开始处理', '打开我做的结果')) {
                $d = $els | Where-Object { $_.name -and $_.name.Contains($n) } | Select-Object -First 1
                if (-not $d) { Say ('  （找不到：' + $n + '）'); continue }
                $ps = $null
                if ($null -ne $d.left) {
                    $ps = PixelStats $shot ($d.left - $wr.Left) ($d.top - $wr.Top) ($d.right - $wr.Left) ($d.bottom - $wr.Top)
                }
                $cText = if ($ps) { '对比度≈' + $ps.contrastRatio + '（暗=' + $ps.darkest + ' 亮=' + $ps.lightest + '，采样 ' + $ps.samples + '）' } else { '(采样失败)' }
                Say ('  | ' + $d.kind + '「' + $n + '」高=' + $d.hLogical + '  ' + $cText)
                $rows += [pscustomobject]@{ name = $n; kind = $d.kind; contrast = $cText; hLogical = $d.hLogical }
            }
            $rows | ConvertTo-Json -Depth 4 | Set-Content -Path (Join-Path $WorkDir ("colors-theme-" + $t.tag + ".json")) -Encoding UTF8
            # 判据：关键文案**渲染出来了且没有横向溢出**（与主题无关）。纵向见上面已先滚到顶。
            # 对比度数值作为事实记下；不设阈值判红 —— 近似的像素极值不适合当 WCAG 门槛（报告里说明）。
            $greet = $els | Where-Object { $_.name -and $_.name.Contains('需要我帮你做什么') } | Select-Object -First 1
            $ok = ($null -ne $greet) -and ($greet.overflowRight -eq $false)
            Add-Verdict 'theme' ("home-rendered@" + $t.tag) $ok $(if ($ok) { '' } else { '首页关键文案没渲染出来或横向溢出' })
            try { Stop-Process -Id $p.Id -Force } catch {}
            Start-Sleep -Seconds 2
        }

        # 还原（**必须**）
        Set-ItemProperty -Path $key -Name AppsUseLightTheme -Value $origApps -Type DWord
        Set-ItemProperty -Path $key -Name SystemUsesLightTheme -Value $origSys -Type DWord
        $backA = (Get-ItemProperty $key -Name AppsUseLightTheme).AppsUseLightTheme
        $backS = (Get-ItemProperty $key -Name SystemUsesLightTheme).SystemUsesLightTheme
        Say ''
        Say ("还原后：AppsUseLightTheme=[" + $backA + "] SystemUsesLightTheme=[" + $backS + "]（应为 [" + $origApps + "]/[" + $origSys + "]）")
        $restored = ("$backA" -eq "$origApps") -and ("$backS" -eq "$origSys")
        Add-Verdict 'theme' 'theme-restored' $restored $(if ($restored) { '' } else { '系统主题没还原回去' })
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
SayR ("报告原文：" + (Join-Path $WorkDir ('report-' + $Scenario + '.txt')))

Clear-Stale

# 环境问题优先：半途因环境停下时判据可能是空的，报 OK 就是假绿。
if ($script:envBlocked) {
    Say '环境问题：这一场没跑完（见上面每一处的说明与判据表里 reached-screen 那行）。'
    exit 2
}
# 「验不了」单独一档（不是产品问题）：任务要求把「没验成」与「不符合」分开写 ✗✓。
if ($script:unverifiable) {
    Say '这一条**验不了**（不是产品问题）：见上面判据表里标了「验不了」的那几行 —— 原因是这台机器给不出那种环境。'
    exit 2
}
if ($bad.Count -gt 0) { Say ("产品问题：" + $bad.Count + ' 条判据不符合。'); exit 3 }
Say ('run-robust: OK — ' + $Scenario + ' 这一场的判据都满足。')
exit 0
