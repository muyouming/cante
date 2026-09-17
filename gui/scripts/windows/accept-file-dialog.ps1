# 填掉应用弹出的原生「打开文件」对话框（WebDriver 进不去的地方）。
#
# 为什么需要它：简单模式第一步的「选择文件」走的是 Tauri 的原生对话框（Windows 上是
# IFileOpenDialog，一个 #32770 窗口）。WebDriver 只能驱动 WebView2 里的内容，对原生窗口
# 无能为力 —— `gui/e2e-windows/smoke.mjs` 就是因此停在确认页的。这里用 UI Automation
# 从外面把路径填进去、点「打开」，让「装好的应用干成一件活」这条路真的能被自动化。
#
# 这条对话框的控件在 UIA 里**不是** Button/Edit，而是带固定 AutomationId 的 Pane：
#   - 文件名输入框：AutomationId 1148，class 依次是 ComboBoxEx32 / ComboBox / Edit
#   - 文件名下拉：  AutomationId 1136
#   - 「打开」按钮：AutomationId 1，class Button
#   - 「取消」按钮：AutomationId 2
# 所以下面全部按 AutomationId + ClassName 找，不按 ControlType。ValuePattern 在这条
# 输入框上不可用（实测），因此退到 WM_SETTEXT / BM_CLICK（跨进程对标准控件有效）。
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File accept-file-dialog.ps1 \
#     -Path "C:\...\销售明细.xlsx" [-TimeoutSec 60] [-ExpectAppPid 1234] [-Dump]
#
# 退出码：0 = 填好并点了打开；2 = 超时没等到对话框；3 = 等到了但没能填/点。
#
# 注意：本文件必须保存为 UTF-8 with BOM（Windows PowerShell 5.1 否则按 GBK 解析中文）。

param(
    [Parameter(Mandatory = $true)][string]$Path,
    [int]$TimeoutSec = 60,
    [int]$ExpectAppPid = 0,
    [switch]$Dump
)

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class AcceptWin32 {
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern IntPtr SendMessage(IntPtr hWnd, uint msg, IntPtr wParam, string lParam);
    [DllImport("user32.dll")]
    public static extern IntPtr SendMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);
    public static readonly uint WM_SETTEXT = 0x000C;
    public static readonly uint BM_CLICK = 0x00F5;
}
'@

$auto = [System.Windows.Automation.AutomationElement]
$TrueCond = [System.Windows.Automation.Condition]::TrueCondition

function Say($text) { Write-Output $text }

function Get-AppPids {
    if ($ExpectAppPid -gt 0) { return @($ExpectAppPid) }
    return @((Get-Process -Name 'cante-gui' -ErrorAction SilentlyContinue).Id)
}

function Find-Dialog {
    $appPids = Get-AppPids
    $winCond = New-Object System.Windows.Automation.PropertyCondition($auto::ControlTypeProperty, [System.Windows.Automation.ControlType]::Window)
    $windows = $auto::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $winCond)
    foreach ($w in $windows) {
        if ($w.Current.ClassName -ne '#32770') { continue }
        if ($appPids.Count -gt 0 -and ($appPids -notcontains $w.Current.ProcessId)) { continue }
        # 「有 AutomationId 1148 的输入框」是「这是文件对话框」的可靠标志。
        $cond = New-Object System.Windows.Automation.PropertyCondition($auto::AutomationIdProperty, '1148')
        if ($w.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond).Count -gt 0) { return $w }
    }
    return $null
}

function Find-ByAid($root, $aid, $className) {
    $cond = New-Object System.Windows.Automation.PropertyCondition($auto::AutomationIdProperty, $aid)
    $found = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
    foreach ($el in $found) {
        if (-not $className -or $el.Current.ClassName -eq $className) { return $el }
    }
    return $null
}

function Set-Text($element, $text) {
    try {
        $vp = $element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
        $vp.SetValue($text)
        return 'ValuePattern'
    } catch { }
    try {
        $legacy = $element.GetCurrentPattern([System.Windows.Automation.LegacyIAccessiblePattern]::Pattern)
        $legacy.SetValue($text)
        return 'LegacyIAccessible'
    } catch { }
    $hwnd = [IntPtr]$element.Current.NativeWindowHandle
    if ($hwnd -ne [IntPtr]::Zero) {
        [void][AcceptWin32]::SendMessage($hwnd, [AcceptWin32]::WM_SETTEXT, [IntPtr]::Zero, $text)
        return ('WM_SETTEXT(hwnd=' + $hwnd + ')')
    }
    return $null
}

function Click($element) {
    try {
        $inv = $element.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
        $inv.Invoke()
        return 'Invoke'
    } catch { }
    $hwnd = [IntPtr]$element.Current.NativeWindowHandle
    if ($hwnd -ne [IntPtr]::Zero) {
        [void][AcceptWin32]::SendMessage($hwnd, [AcceptWin32]::BM_CLICK, [IntPtr]::Zero, [IntPtr]::Zero)
        return ('BM_CLICK(hwnd=' + $hwnd + ')')
    }
    return $null
}

$deadline = (Get-Date).AddSeconds($TimeoutSec)
$dialog = $null
while ((Get-Date) -lt $deadline) {
    $dialog = Find-Dialog
    if ($dialog) { break }
    Start-Sleep -Milliseconds 300
}

if (-not $dialog) {
    Say "accept-file-dialog: ${TimeoutSec}s 内没等到「打开文件」对话框（找 #32770 且带 AutomationId 1148 的窗口）。"
    exit 2
}

Say ("accept-file-dialog: 对话框 name='" + $dialog.Current.Name + "' pid=" + $dialog.Current.ProcessId)

if ($Dump) {
    $all = $dialog.FindAll([System.Windows.Automation.TreeScope]::Descendants, $TrueCond)
    $n = 0
    foreach ($el in $all) {
        if ($n -ge 60) { break }
        $n++
        $ct = $el.Current.ControlType.ProgrammaticName -replace '^ControlType\.', ''
        $aid = $el.Current.AutomationId
        if ($aid -or $ct -in @('Edit', 'Button', 'ComboBox')) {
            Say ("  {0,-10} name='{1}' aid='{2}' class='{3}' hwnd={4}" -f $ct, $el.Current.Name, $aid, $el.Current.ClassName, $el.Current.NativeWindowHandle)
        }
    }
}

$edit = Find-ByAid $dialog '1148' 'Edit'
if (-not $edit) { $edit = Find-ByAid $dialog '1148' 'ComboBox' }
if (-not $edit) { $edit = Find-ByAid $dialog '1148' $null }
if (-not $edit) {
    Say 'accept-file-dialog: 没找到文件名输入框（AutomationId 1148）。'
    exit 3
}

$used = Set-Text $edit $Path
if (-not $used) {
    Say 'accept-file-dialog: 文件名输入框既不接受设值，也没有窗口句柄。'
    exit 3
}
Say ("accept-file-dialog: 路径已写入（$used），class='" + $edit.Current.ClassName + "'")

$open = Find-ByAid $dialog '1' 'Button'
if (-not $open) { $open = Find-ByAid $dialog '1' $null }
if (-not $open) {
    Say 'accept-file-dialog: 没找到「打开」按钮（AutomationId 1）。'
    exit 3
}

$clicked = Click $open
if (-not $clicked) {
    Say 'accept-file-dialog: 「打开」按钮既没有 Invoke，也没有窗口句柄。'
    exit 3
}
Say ("accept-file-dialog: 已点「打开」（$clicked）")
exit 0
