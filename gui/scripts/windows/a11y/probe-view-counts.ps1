# 核对一个事实（不猜）：UIA 的 RawView vs ControlView 到底差多少、
# 以及"同一句标题数到两次"是不是布局节点造成的。
# 用法：powershell -File probe-view-counts.ps1
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class VC {
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out R r);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref P p);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, int d, UIntPtr e);
  [StructLayout(LayoutKind.Sequential)] public struct R { public int L,T,RR,B; }
  [StructLayout(LayoutKind.Sequential)] public struct P { public int X,Y; }
}
'@
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--force-renderer-accessibility'
$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
$RAW = [System.Windows.Automation.TreeWalker]::RawViewWalker
$CV = [System.Windows.Automation.TreeWalker]::ControlViewWalker

Get-Process cante-gui -ErrorAction SilentlyContinue | ForEach-Object { try { Stop-Process -Id $_.Id -Force } catch {} }
Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like '*dev.cante.gui*' } | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force } catch {} }
Start-Sleep -Seconds 2
Remove-Item (Join-Path $env:LOCALAPPDATA 'dev.cante.gui') -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path $env:APPDATA 'dev.cante.gui') -Recurse -Force -ErrorAction SilentlyContinue

$exe = 'C:\cante-wt\a11y\gui\src-tauri\target\debug\cante-gui.exe'
$p = Start-Process $exe -PassThru
Start-Sleep -Seconds 14
$p.Refresh()
$root = $AE::FromHandle($p.MainWindowHandle)
function FindC($r, [string]$n) { foreach ($e in $r.FindAll($TS::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) { if (([string]$e.Current.Name).Contains($n)) { return $e } } return $null }
function ClickN($r, [string]$n) { $e = FindC $r $n; if ($e) { try { $e.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke(); return $true } catch { return $false } }; return $false }
# 点一个按钮，**先把它滚进视口**再点。
# 为何不能只用 ClickN：向导最后一步的「开始使用」在 1280x800 上底部在折叠之下，
# 那时 UIA 对它**不支持 Invoke 模式**，于是向导推进会卡住 —— 上次就是因此
# 没走到首页（`到首页 = False`），两个视图计数也就没法比。修法同 narrate-script.ps1。
function ClickScrolled($r, [string]$n, [IntPtr]$hwnd) {
    $e = FindC $r $n; if (-not $e) { return $false }
    try { $e.SetFocus() } catch {}
    try { $e.GetCurrentPattern([System.Windows.Automation.ScrollItemPattern]::Pattern).ScrollIntoView() } catch {}
    Start-Sleep -Milliseconds 300
    if (ClickN $r $n) { return $true }
    $cr = New-Object VC+R; [void][VC]::GetClientRect($hwnd, [ref]$cr)
    $o = New-Object VC+P; [void][VC]::ClientToScreen($hwnd, [ref]$o)
    [void][VC]::SetCursorPos(($o.X + [int]($cr.RR / 2)), ($o.Y + [int]($cr.B / 2)))
    for ($i = 1; $i -le 8; $i++) { [VC]::mouse_event(0x0800, 0, 0, -120, [UIntPtr]::Zero); Start-Sleep -Milliseconds 250; if (ClickN $r $n) { return $true } }
    return $false
}
# 走到首页（向导若出现就点过去；每一步都滚进视口再点）
$d = (Get-Date).AddSeconds(60)
while ((Get-Date) -lt $d -and -not (FindC $root '需要我帮你做什么')) {
    $c = $false
    foreach ($l in @('开始检查','下一步','先看看界面','开始使用')) {
        if (ClickScrolled $root $l $p.MainWindowHandle) { Start-Sleep -Seconds 3; $c = $true; break }
    }
    if (-not $c) { Start-Sleep -Milliseconds 600 }
}
Write-Output ('到首页 = ' + [bool](FindC $root '需要我帮你做什么'))

function Count-Walk($walker, [string]$label) {
    $script:n = 0; $script:nonCtrl = 0; $script:names = @{}
    function W($el) {
        if (-not $el) { return }
        $script:n++
        $ic = $true
        try { $ic = [bool]$el.GetCurrentPropertyValue([System.Windows.Automation.AutomationElement]::IsControlElementProperty) } catch {}
        if (-not $ic) { $script:nonCtrl++ }
        $nm = [string]$el.Current.Name
        if ($nm -and $nm.Trim() -and -not $ic) { if ($script:names.ContainsKey($nm)) { $script:names[$nm] = $script:names[$nm] + 1 } else { $script:names[$nm] = 1 } }
        $ch = $walker.GetFirstChild($el); $g = 0
        while ($ch -and $g -lt 5000) { W $ch; $ch = $walker.GetNextSibling($ch); $g++ }
    }
    W $root
    Write-Output ("$label : 节点总数 = " + $script:n + "，其中 IsControlElement=False = " + $script:nonCtrl)
    $dup = $script:names.GetEnumerator() | Where-Object { $_.Value -gt 1 } | Select-Object -First 5
    if ($dup) { Write-Output '  （无名以外的布局节点里，名字出现 >1 次的：）'; $dup | ForEach-Object { Write-Output ('    ' + $_.Key + ' × ' + $_.Value) } }
}
Count-Walk $RAW 'RawView'
Count-Walk $CV 'ControlView'
Stop-Process -Id $p.Id -Force
