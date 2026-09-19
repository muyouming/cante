# 抓 Narrator **念结果面板** 的那一段 ETW —— 直接验 #230（每行按钮名字带上文件名）在**读屏嘴里**
# 是什么样。这是"读屏实际念出来是什么"的一手证据，**不是我算出来的**。
#
# 为什么能成：Narrator 是**单例**，但它**会通过 ETW 把它要念的句子吐出来**（provider
# `Microsoft-Windows-Narrator`，字段 `SpokenText`）。上一版 probe-narrator-our-app.ps1 抓的是
# **首页**；这一份抓**我做的结果面板**（那是 #230 改的地方）。
#
# 必须提权：logman 建 ETW 会话要提权。
param(
    [string]$Exe = 'C:\cante-wt\a11y\gui\src-tauri\target\debug\cante-gui.exe',
    [string]$WorkDir = 'C:\cante-a11y-narr',
    [int]$StartupSecs = 14,
    [int]$TabCount = 40,
    [int]$HoldSeconds = 8
)
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
$log = Join-Path $WorkDir 'narrator-results.txt'
Remove-Item $log -ErrorAction SilentlyContinue
function Say([string]$t) { Add-Content -Path $log -Value $t -Encoding UTF8 }

Say ('elevated = ' + ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--force-renderer-accessibility'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class NR {
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

function Clear-Stale {
    Get-Process cante-gui -ErrorAction SilentlyContinue | ForEach-Object { try { Stop-Process -Id $_.Id -Force } catch {} }
    Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like '*dev.cante.gui*' } |
        ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force } catch {} }
    Start-Sleep -Seconds 2
}
function FindC($r, [string]$n) {
    foreach ($e in $r.FindAll($TS::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) {
        if (([string]$e.Current.Name).Contains($n)) { return $e }
    }
    return $null
}
function ClickN($r, [string]$n) {
    $e = FindC $r $n
    if ($e) { try { $e.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke(); return $true } catch { return $false } }
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
[void][NR]::SetForegroundWindow($hwnd); Start-Sleep -Seconds 1

# 走到首页（向导若出现）
if (-not (FindC $root '需要我帮你做什么')) {
    Say '（首启向导：走一遍到首页）'
    foreach ($step in @('开始检查','下一步','先看看界面','开始使用')) {
        if (ClickN $root $step) { Say ('  点了「' + $step + '」'); Start-Sleep -Seconds 3 }
    }
    Start-Sleep -Seconds 2
}
Say ('到首页 = ' + [bool](FindC $root '需要我帮你做什么'))

# 打开「我做的结果」面板
$entry = FindC $root '打开我做的结果'
if (-not $entry) { Say '环境问题：首页上找不到「我做的结果」入口（夹具铺了吗？）'; Stop-Process -Id $p.Id -Force; exit 2 }
[void](ClickN $root '打开我做的结果')
Start-Sleep -Seconds 3
$onPanel = [bool](FindC $root '回到首页')
Say ('到结果面板 = ' + $onPanel)
if (-not $onPanel) { Say '环境问题：面板没打开'; Stop-Process -Id $p.Id -Force; exit 2 }

# Narrator 必须是跑着的（单例）
$nar = @(Get-Process Narrator -ErrorAction SilentlyContinue)
if ($nar.Count -eq 0) {
    Say '（Narrator 没在跑，起一个）'
    Start-Process 'C:\Windows\System32\Narrator.exe' -ErrorAction SilentlyContinue | Out-Null
    Start-Sleep -Seconds 6
    $nar = @(Get-Process Narrator -ErrorAction SilentlyContinue)
}
Say ('Narrator 进程数 = ' + $nar.Count)

# 抓 ETW，同时把焦点放回应用、盲按 Tab 走遍面板
$etl = Join-Path $WorkDir 'results.etl'
if (Test-Path $etl) { Remove-Item $etl -Force }
& logman delete CanteNarrResults 2>&1 | Out-Null
$r1 = (& logman create trace CanteNarrResults -p 'Microsoft-Windows-Narrator' -o $etl -f bin -ets 2>&1 | Out-String)
Say ('  etw create: ' + ($r1 -replace '\s+', ' ').Trim())
Start-Sleep -Seconds 2
[void][NR]::SetForegroundWindow($hwnd)
Start-Sleep -Milliseconds 800
$cr = New-Object NR+R; [void][NR]::GetClientRect($hwnd, [ref]$cr)
$o = New-Object NR+P; [void][NR]::ClientToScreen($hwnd, [ref]$o)
[void][NR]::SetCursorPos(($o.X + [int]($cr.RR / 2)), ($o.Y + [int]($cr.B / 2)))
for ($i = 0; $i -lt 12; $i++) { [NR]::mouse_event(0x0800, 0, 0, 120, [UIntPtr]::Zero); Start-Sleep -Milliseconds 60 }
Say ('  前台 = ' + [NR]::GetForegroundWindow() + '（应用是 ' + $hwnd + '）')
[NR]::Tab($TabCount)
Start-Sleep -Seconds $HoldSeconds
$r2 = (& logman stop CanteNarrResults -ets 2>&1 | Out-String)
Say ('  etw stop: ' + ($r2 -replace '\s+', ' ').Trim())

if (Test-Path $etl) {
    Say ('  ETL 大小 = ' + (Get-Item $etl).Length)
    $xml = Join-Path $WorkDir 'results.xml'
    & tracerpt $etl -of XML -o $xml -y 2>&1 | Out-Null
    if (Test-Path $xml) {
        $txt = Get-Content $xml -Raw
        Say ('  事件 = ' + ([regex]::Matches($txt, '<Event ')).Count + '，XML 大小 = ' + (Get-Item $xml).Length)
        $hits = ([regex]::Matches($txt, ('Pid=' + $p.Id + ';'))).Count
        Say ('  提到「应用 pid=' + $p.Id + '」的次数 = ' + $hits)
    }
}
try { Stop-Process -Id $p.Id -Force } catch {}
Clear-Stale
Say '完'
