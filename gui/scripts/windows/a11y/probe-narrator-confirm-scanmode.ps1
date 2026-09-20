# 确认页：Tab 只能念到 4 样东西（开始/复选框/先给我看一眼/取消），**计划正文没被念**。
# 这一份来回答一个关键问题：那是不是因为"Tab 走不到"？读屏还有**扫描模式**（scan mode）
# 可以整页顺序朗读。如果扫描模式能念到计划，那"不念"就只是 Tab 的局限，不是产品的缺。
#
# 做法：同一段 ETW 里**分两段** —— 先 Tab 走一圈，再切扫描模式（Caps Lock+Space）+ 方向键下，
# 看 SpokenText 里有没有出现「它打算这样做」/计划步骤。
param(
    [string]$Exe = 'C:\cante-wt\a11y\gui\src-tauri\target\debug\cante-gui.exe',
    [string]$WorkDir = 'C:\cante-a11y-narr',
    [int]$StartupSecs = 14,
    [int]$TabCount = 12,
    [int]$ScanPresses = 25,
    [int]$HoldSeconds = 6
)
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$log = Join-Path $WorkDir 'narrator-confirm-scanmode.txt'
Remove-Item $log -ErrorAction SilentlyContinue
function Say([string]$t) { Write-Output $t; Add-Content -Path $log -Value $t -Encoding UTF8 }
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
  const byte CAPS = 0x14, SPACE = 0x20, DOWN = 0x28, TAB = 0x09;
  static void K(byte vk, bool up) { keybd_event(vk, 0, up ? (uint)2 : 0, UIntPtr.Zero); }
  public static void Tab(int n) { for (int i=0;i<n;i++){ K(TAB,false); System.Threading.Thread.Sleep(70); K(TAB,true); System.Threading.Thread.Sleep(400);} }
  // Narrator 扫描模式开关默认是 Caps Lock + Space
  public static void ToggleScanMode() { K(CAPS,false); System.Threading.Thread.Sleep(60); K(SPACE,false); System.Threading.Thread.Sleep(60); K(SPACE,true); System.Threading.Thread.Sleep(60); K(CAPS,true); System.Threading.Thread.Sleep(800); }
  public static void Down(int n) { for (int i=0;i<n;i++){ K(DOWN,false); System.Threading.Thread.Sleep(70); K(DOWN,true); System.Threading.Thread.Sleep(500);} }
}
'@
$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
function Clear-Stale {
    Get-Process cante-gui -ErrorAction SilentlyContinue | ForEach-Object { try { Stop-Process -Id $_.Id -Force } catch {} }
    Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like '*dev.cante.gui*' } | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force } catch {} }
    Start-Sleep -Seconds 2
}
function FindC($r, [string]$n) { foreach ($e in $r.FindAll($TS::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) { if (([string]$e.Current.Name).Contains($n)) { return $e } } return $null }
function ClickN($r, [string]$n) { $e = FindC $r $n; if ($e) { try { $e.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke(); return $true } catch { return $false } } return $false }
function ClickScrolled($r, [string]$n, [IntPtr]$hwnd) {
    $e = FindC $r $n; if (-not $e) { return $false }
    try { $e.SetFocus() } catch {}
    try { $e.GetCurrentPattern([System.Windows.Automation.ScrollItemPattern]::Pattern).ScrollIntoView() } catch {}
    Start-Sleep -Milliseconds 300
    if (ClickN $r $n) { return $true }
    $cr = New-Object NS+R; [void][NS]::GetClientRect($hwnd, [ref]$cr)
    $o = New-Object NS+P; [void][NS]::ClientToScreen($hwnd, [ref]$o)
    [void][NS]::SetCursorPos(($o.X + [int]($cr.RR / 2)), ($o.Y + [int]($cr.B / 2)))
    for ($i = 1; $i -le 8; $i++) { [NS]::mouse_event(0x0800, 0, 0, -120, [UIntPtr]::Zero); Start-Sleep -Milliseconds 250; if (ClickN $r $n) { return $true } }
    return $false
}
Clear-Stale
if (-not (Test-Path $Exe)) { Say ('环境问题：找不到 ' + $Exe); exit 2 }
$p = Start-Process -FilePath $Exe -PassThru
Start-Sleep -Seconds $StartupSecs
$p.Refresh()
if ($p.HasExited) { Say ('环境问题：应用退出 exit=' + $p.ExitCode); exit 2 }
$hwnd = $p.MainWindowHandle
Say ('应用 pid=' + $p.Id + ' hwnd=' + $hwnd)
$root = $AE::FromHandle($hwnd)
[void][NS]::SetForegroundWindow($hwnd); Start-Sleep -Seconds 1
if (-not (FindC $root '需要我帮你做什么')) {
    $d = (Get-Date).AddSeconds(60)
    while ((Get-Date) -lt $d -and -not (FindC $root '需要我帮你做什么')) {
        $c = $false
        foreach ($l in @('开始检查','下一步','先看看界面','开始使用')) { if (ClickScrolled $root $l $hwnd) { Start-Sleep -Seconds 3; $c = $true; break } }
        if (-not $c) { Start-Sleep -Milliseconds 600 }
    }
}
$card = FindC $root '把这段时间做的事写成一份总结'
if (-not $card) { Say '环境问题：找不到文字卡'; Stop-Process -Id $p.Id -Force; exit 2 }
try { $card.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke() } catch {}
Start-Sleep -Seconds 3
$instr = $root.FindFirst($TS::Descendants, (New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::AutomationIdProperty, 'task-instruction')))
if ($instr) { try { $instr.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue('把这段时间做的事写成一份总结') } catch {} }
Start-Sleep -Seconds 1
if (-not (ClickScrolled $root '生成计划' $hwnd)) { Say '环境问题：找不到「生成计划」'; Stop-Process -Id $p.Id -Force; exit 2 }
Start-Sleep -Seconds 3
Say ('到确认页 = ' + [bool](FindC $root '它打算这样做'))
if (-not (FindC $root '它打算这样做')) { Stop-Process -Id $p.Id -Force; exit 2 }
if (@(Get-Process Narrator -ErrorAction SilentlyContinue).Count -eq 0) { Start-Process 'C:\Windows\System32\Narrator.exe' -ErrorAction SilentlyContinue | Out-Null; Start-Sleep -Seconds 6 }
Say ('Narrator 进程数 = ' + @(Get-Process Narrator -ErrorAction SilentlyContinue).Count)

$etl = Join-Path $WorkDir 'confirm-scanmode.etl'
if (Test-Path $etl) { Remove-Item $etl -Force }
& logman delete CanteNarrConfirmScan 2>&1 | Out-Null
$r1 = (& logman create trace CanteNarrConfirmScan -p 'Microsoft-Windows-Narrator' -o $etl -f bin -ets 2>&1 | Out-String)
Say ('  etw create: ' + ($r1 -replace '\s+', ' ').Trim())
Start-Sleep -Seconds 2
[void][NS]::SetForegroundWindow($hwnd); Start-Sleep -Milliseconds 800
$cr = New-Object NS+R; [void][NS]::GetClientRect($hwnd, [ref]$cr)
$o = New-Object NS+P; [void][NS]::ClientToScreen($hwnd, [ref]$o)
[void][NS]::SetCursorPos(($o.X + [int]($cr.RR / 2)), ($o.Y + [int]($cr.B / 2)))
for ($i = 0; $i -lt 12; $i++) { [NS]::mouse_event(0x0800, 0, 0, 120, [UIntPtr]::Zero); Start-Sleep -Milliseconds 60 }
Say '  --- 阶段 A：切扫描模式之前（Tab 一圈）---'
[NS]::Tab($TabCount)
Start-Sleep -Seconds 2
Say '  --- 阶段 B：切扫描模式（Caps Lock+Space）+ 方向键下 ---'
[NS]::ToggleScanMode()
Start-Sleep -Seconds 1
[NS]::Down($ScanPresses)
Start-Sleep -Seconds $HoldSeconds
$r2 = (& logman stop CanteNarrConfirmScan -ets 2>&1 | Out-String)
Say ('  etw stop: ' + ($r2 -replace '\s+', ' ').Trim())
if (Test-Path $etl) {
    $xml = Join-Path $WorkDir 'confirm-scanmode.xml'
    & tracerpt $etl -of XML -o $xml -y 2>&1 | Out-Null
    Say ('  事件 = ' + ([regex]::Matches((Get-Content $xml -Raw), '<Event ')).Count + '，XML = ' + (Get-Item $xml).Length)
}
try { Stop-Process -Id $p.Id -Force } catch {}
Clear-Stale
Say '完'
