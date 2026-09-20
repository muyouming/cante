$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System; using System.Runtime.InteropServices;
public class DBG {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out R r);
  [StructLayout(LayoutKind.Sequential)] public struct R { public int L,T,RR,B; }
}
"@
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--force-renderer-accessibility'
$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]

Get-Process cante-gui -ErrorAction SilentlyContinue | Stop-Process -Force
Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like '*dev.cante.gui*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 2
Remove-Item (Join-Path $env:LOCALAPPDATA 'dev.cante.gui') -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path $env:APPDATA 'dev.cante.gui') -Recurse -Force -ErrorAction SilentlyContinue

$p = Start-Process 'C:\cante-wt\a11y\gui\src-tauri\target\debug\cante-gui.exe' -PassThru
Start-Sleep -Seconds 14
$p.Refresh()
$root = $AE::FromHandle($p.MainWindowHandle)
[void][DBG]::SetForegroundWindow($p.MainWindowHandle)
Start-Sleep -Seconds 1
function Names($r){ $o=@(); foreach($e in $r.FindAll($TS::Descendants,[System.Windows.Automation.Condition]::TrueCondition)){ $n=[string]$e.Current.Name; if($n -and $n.Trim()){ $o+=$n } }; return $o }
Write-Output "--- screen 1 (right after start) ---"
(Names $root | Select-Object -First 15) -join ' | '

# click 开始检查, wait, dump
function FindName($r,$n){ foreach($e in $r.FindAll($TS::Descendants,[System.Windows.Automation.Condition]::TrueCondition)){ if(([string]$e.Current.Name).Contains($n)){ return $e } } return $null }
$b = FindName $root '开始检查'
Write-Output ("found 开始检查: " + [bool]$b)
if($b){ try{ $b.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke() }catch{ Write-Output ('invoke fail: ' + $_.Exception.Message) } }
Start-Sleep -Seconds 6
Write-Output "--- screen 2 (after 开始检查) ---"
(Names $root | Select-Object -First 20) -join ' | '

$n1 = FindName $root '下一步'
$n2 = FindName $root '先看看界面'
Write-Output ("下一步=" + [bool]$n1 + "  先看看界面=" + [bool]$n2)
$target = if($n2){ $n2 } elseif($n1){ $n1 } else { $null }
if($target){ Write-Output ('clicking: ' + $target.Current.Name); try{ $target.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke() }catch{ Write-Output ('invoke fail: ' + $_.Exception.Message) } }
Start-Sleep -Seconds 4
Write-Output "--- screen 3 ---"
(Names $root | Select-Object -First 20) -join ' | '

$n3 = FindName $root '开始使用'
Write-Output ("开始使用=" + [bool]$n3)
if($n3){ try{ $n3.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke() }catch{ Write-Output ('invoke fail: ' + $_.Exception.Message) } }
Start-Sleep -Seconds 4
Write-Output "--- screen 4 (should be home) ---"
(Names $root | Select-Object -First 20) -join ' | '
Stop-Process -Id $p.Id -Force
