$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System; using System.Runtime.InteropServices;
public class PW3 {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L,T,R,B; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X,Y; }
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, int d, UIntPtr e);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
}
"@
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--force-renderer-accessibility'
$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
function All($r) { $r.FindAll($TS::Descendants, [System.Windows.Automation.Condition]::TrueCondition) }
function Find($r, $n) { foreach ($e in (All $r)) { if (([string]$e.Current.Name).Contains($n)) { return $e } } return $null }

# Set text scale to 150, launch, and inspect whether the greeting is scrolled or clipped.
$key = 'HKCU:\Software\Microsoft\Accessibility'
Set-ItemProperty -Path $key -Name TextScaleFactor -Value 150 -Type DWord

$exe = 'C:\cante-wt\usage\gui\src-tauri\target\debug\cante-gui.exe'
Get-Process cante-gui -ErrorAction SilentlyContinue | Stop-Process -Force
Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" -ErrorAction SilentlyContinue | Where-Object { /c/cante-wt/usage.CommandLine -like '*dev.cante.gui*' } | ForEach-Object { Stop-Process -Id /c/cante-wt/usage.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 3
$p = Start-Process $exe -PassThru
Start-Sleep -Seconds 14
$p.Refresh()
$hwnd = $p.MainWindowHandle
$root = $AE::FromHandle($hwnd)
[void][PW3]::SetForegroundWindow($hwnd)
Start-Sleep -Seconds 1

$cr = New-Object PW3+RECT; [void][PW3]::GetClientRect($hwnd, [ref]$cr)
$o = New-Object PW3+POINT; [void][PW3]::ClientToScreen($hwnd, [ref]$o)
Write-Output ("client = [" + $o.X + "," + $o.Y + "] " + $cr.R + "x" + $cr.B)
foreach ($n in @('需要我帮你', '点一张卡片', '历史', '直接说一句话')) {
    $e = Find $root $n
    if (-not $e) { Write-Output ("  $n : NOT FOUND"); continue }
    $r = $e.Current.BoundingRectangle
    Write-Output ("  $n : top=" + [int]$r.Top + " bottom=" + [int]$r.Bottom + " left=" + [int]$r.Left + " right=" + [int]$r.Right + " offscreen=" + $e.Current.IsOffscreen)
}
# scroll to the very top (wheel up) and re-measure
[void][PW3]::SetCursorPos(($o.X + [int]($cr.R / 2)), ($o.Y + [int]($cr.B / 2)))
for ($i = 1; $i -le 10; $i++) { [PW3]::mouse_event(0x0800, 0, 0, 120, [UIntPtr]::Zero); Start-Sleep -Milliseconds 120 }
Start-Sleep -Milliseconds 400
Write-Output "after scrolling to top:"
foreach ($n in @('需要我帮你', '点一张卡片', '历史')) {
    $e = Find $root $n
    if (-not $e) { Write-Output ("  $n : NOT FOUND"); continue }
    $r = $e.Current.BoundingRectangle
    Write-Output ("  $n : top=" + [int]$r.Top + " bottom=" + [int]$r.Bottom + " offscreen=" + $e.Current.IsOffscreen)
}
Stop-Process -Id $p.Id -Force
Remove-ItemProperty -Path $key -Name TextScaleFactor -ErrorAction SilentlyContinue
Write-Output ("restored TextScaleFactor=[" + (Get-ItemProperty $key -Name TextScaleFactor -ErrorAction SilentlyContinue).TextScaleFactor + "]")
