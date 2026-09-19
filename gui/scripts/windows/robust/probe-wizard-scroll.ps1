$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System; using System.Runtime.InteropServices;
public class PW {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, int d, UIntPtr e);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
}
"@
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--force-renderer-accessibility'
$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]

$profileDir = Join-Path $env:LOCALAPPDATA 'dev.cante.gui'
$historyDir = Join-Path $env:APPDATA 'dev.cante.gui'
Get-Process cante-gui -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 2
foreach ($d in @($profileDir, $historyDir)) { if (Test-Path $d) { Remove-Item $d -Recurse -Force -ErrorAction SilentlyContinue } }

$exe = 'C:\cante-wt\usage\gui\src-tauri\target\debug\cante-gui.exe'
$p = Start-Process -FilePath $exe -PassThru
Start-Sleep -Seconds 14
$p.Refresh()
$root = $AE::FromHandle($p.MainWindowHandle)
[void][PW]::SetForegroundWindow($p.MainWindowHandle)
Start-Sleep -Seconds 1
$cr = New-Object PW+RECT
[void][PW]::GetClientRect($p.MainWindowHandle, [ref]$cr)
$o = New-Object PW+POINT
[void][PW]::ClientToScreen($p.MainWindowHandle, [ref]$o)
$cl = $o.X; $ct = $o.Y; $cw = $cr.Right; $ch = $cr.Bottom
Write-Output ("client = [" + $cl + "," + $ct + "] " + $cw + "x" + $ch)

function Tap($name) {
    $c = New-Object System.Windows.Automation.PropertyCondition($AE::NameProperty, $name)
    $e = $root.FindFirst($TS::Descendants, $c)
    if ($e) { try { $e.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke(); return $true } catch { return $false } }
    return $false
}
function RectOf($name) {
    $c = New-Object System.Windows.Automation.PropertyCondition($AE::NameProperty, $name)
    $e = $root.FindFirst($TS::Descendants, $c)
    if (-not $e) { return $null }
    $r = $e.Current.BoundingRectangle
    $t = $e.Current.ControlType.ProgrammaticName; if ($t.Contains('.')) { $t = $t.Substring($t.LastIndexOf('.') + 1) }
    return [pscustomobject]@{ kind = $t; top = [int]$r.Top; bottom = [int]$r.Bottom; left = [int]$r.Left; right = [int]$r.Right; off = $e.Current.IsOffscreen }
}

# walk the wizard to the last step
[void](Tap '开始检查')
Start-Sleep -Seconds 4
if (Tap '下一步') { Start-Sleep -Seconds 2 }
elseif (Tap '先看看界面') { Start-Sleep -Seconds 2 }
Start-Sleep -Seconds 2

$b = RectOf '开始使用'
Write-Output ("BEFORE SCROLL: 开始使用 = " + ($b | ConvertTo-Json -Compress))
Write-Output ("  client bottom = " + ($ct + $ch) + "  -> insideClient = " + ($b.bottom -le ($ct + $ch)))

# scroll the wizard container: put the cursor over the middle of the wizard pane, send wheel-down
[void][PW]::SetCursorPos(($cl + [int]($cw / 2)), ($ct + [int]($ch / 2)))
Start-Sleep -Milliseconds 300
for ($i = 1; $i -le 8; $i++) {
    [PW]::mouse_event(0x0800, 0, 0, -120, [UIntPtr]::Zero)   # MOUSEEVENTF_WHEEL, -120 = one notch down
    Start-Sleep -Milliseconds 250
    $b2 = RectOf '开始使用'
    $inside = $b2 -and ($b2.bottom -le ($ct + $ch))
    Write-Output ("  wheel " + $i + ": top=" + $b2.top + " bottom=" + $b2.bottom + " insideClient=" + $inside)
    if ($inside) {
        Write-Output ("  -> 滚 " + $i + " 格之后进视口：真的 invoke 一下 -> " + (Tap '开始使用'))
        break
    }
}
Stop-Process -Id $p.Id -Force
