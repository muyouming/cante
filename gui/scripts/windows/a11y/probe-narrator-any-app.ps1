# 抓 Narrator 念**装好的那份（#230 之前）**结果面板 —— 用来做「修复前 / 修复后」的对照，
# 而且是**用 Narrator 自己的嘴**（ETW SpokenText）。
#
# 装好的那份是 v0.2.3（= 292008d），比 #230 早；结果面板那两个按钮的名字是
# 旧写法「打开这个结果文件」/「打开这个结果文件所在的文件夹」（不带文件名）。
# 所以这一份抓出来应当是：**12 行念的是同一句话**。
param(
    [string]$Exe = "$env:LOCALAPPDATA\Cante\cante-gui.exe",
    [string]$WorkDir = 'C:\cante-a11y-narr',
    [int]$StartupSecs = 14,
    [int]$TabCount = 30,
    [int]$HoldSeconds = 8,
    [string]$Tag = 'installed'
)
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
$log = Join-Path $WorkDir ("narrator-$Tag.txt")
Remove-Item $log -ErrorAction SilentlyContinue
function Say([string]$t) { Add-Content -Path $log -Value $t -Encoding UTF8 }
Say ('elevated = ' + ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--force-renderer-accessibility'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class NS {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte sc, uint f, UIntPtr e);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out R r);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref P p);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, int d, UIntPtr e);
  [StructLayout(LayoutKind.Sequential)] public struct R { public int L,T,RR,B; }
  [StructLayout(LayoutKind.Sequential)] public struct P { public int X,Y; }
  public static void Tab(int n) { for (int i=0;i<n;i++){ keybd_event(0x09,0,0,UIntPtr.Zero); System.Threading.Thread.Sleep(80); keybd_event(0x09,0,2,UIntPtr.Zero); System.Threading.Thread.Sleep(420);} }
}
'@
$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
function FindC($r, [string]$n) { foreach ($e in $r.FindAll($TS::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) { if (([string]$e.Current.Name).Contains($n)) { return $e } } return $null }
function ClickN($r, [string]$n) { $e = FindC $r $n; if ($e) { try { $e.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke(); return $true } catch { return $false } } return $false }
if (-not (Test-Path $Exe)) { Say ('环境问题：找不到 ' + $Exe); exit 2 }
$p = Start-Process -FilePath $Exe -PassThru
Start-Sleep -Seconds $StartupSecs
$p.Refresh()
if ($p.HasExited) { Say ('环境问题：应用退出 exit=' + $p.ExitCode); exit 2 }
$hwnd = $p.MainWindowHandle
Say ('应用 = ' + $Exe)
Say ('应用 pid=' + $p.Id + ' hwnd=' + $hwnd)
$root = $AE::FromHandle($hwnd)
[void][NS]::SetForegroundWindow($hwnd); Start-Sleep -Seconds 1
if (-not (FindC $root '需要我帮你做什么')) {
    foreach ($step in @('开始检查','下一步','先看看界面','开始使用')) { if (ClickN $root $step) { Start-Sleep -Seconds 3 } }
    Start-Sleep -Seconds 2
}
Say ('到首页 = ' + [bool](FindC $root '需要我帮你做什么'))
if (-not (FindC $root '打开我做的结果')) { Say '环境问题：找不到「我做的结果」入口'; Stop-Process -Id $p.Id -Force; exit 2 }
[void](ClickN $root '打开我做的结果'); Start-Sleep -Seconds 3
Say ('到结果面板 = ' + [bool](FindC $root '回到首页'))
$nar = @(Get-Process Narrator -ErrorAction SilentlyContinue)
if ($nar.Count -eq 0) { Start-Process 'C:\Windows\System32\Narrator.exe' -ErrorAction SilentlyContinue | Out-Null; Start-Sleep -Seconds 6 }
Say ('Narrator 进程数 = ' + @(Get-Process Narrator -ErrorAction SilentlyContinue).Count)
$etl = Join-Path $WorkDir ("$Tag.etl")
if (Test-Path $etl) { Remove-Item $etl -Force }
& logman delete ("CanteNarr" + $Tag) 2>&1 | Out-Null
$r1 = (& logman create trace ("CanteNarr" + $Tag) -p 'Microsoft-Windows-Narrator' -o $etl -f bin -ets 2>&1 | Out-String)
Say ('  etw create: ' + ($r1 -replace '\s+', ' ').Trim())
Start-Sleep -Seconds 2
[void][NS]::SetForegroundWindow($hwnd); Start-Sleep -Milliseconds 800
$cr = New-Object NS+R; [void][NS]::GetClientRect($hwnd, [ref]$cr)
$o = New-Object NS+P; [void][NS]::ClientToScreen($hwnd, [ref]$o)
[void][NS]::SetCursorPos(($o.X + [int]($cr.RR / 2)), ($o.Y + [int]($cr.B / 2)))
for ($i = 0; $i -lt 12; $i++) { [NS]::mouse_event(0x0800, 0, 0, 120, [UIntPtr]::Zero); Start-Sleep -Milliseconds 60 }
[NS]::Tab($TabCount)
Start-Sleep -Seconds $HoldSeconds
$r2 = (& logman stop ("CanteNarr" + $Tag) -ets 2>&1 | Out-String)
Say ('  etw stop: ' + ($r2 -replace '\s+', ' ').Trim())
if (Test-Path $etl) {
    $xml = Join-Path $WorkDir ("$Tag.xml")
    & tracerpt $etl -of XML -o $xml -y 2>&1 | Out-Null
    Say ('  ETL = ' + (Get-Item $etl).Length + '，XML = ' + (Get-Item $xml).Length)
}
try { Stop-Process -Id $p.Id -Force } catch {}
Say '完'
