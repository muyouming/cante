# 抓 Narrator **念我们应用** 的那一段 ETW —— 这是"读屏实际念出来是什么"的一手证据。
#
# 上一版 probe-focus-follow.ps1 假定 cante-gui 已经在跑；这一版**自己启动应用**并走完向导到首页，
# 再抓 Narrator 的 ETW，最后在 XML 里找 `Pid=<cante-gui pid>` —— 找得到就说明
# **Narrator 确实在念我们应用的控件**，那段 `名字, 控件类型,` 就是它要念的话。
#
# 必须提权：logman 建 ETW 会话要提权；Narrator 也是提权的。
# 必须按 provider **名字**建会话（按 GUID 报 Element not found，实测）。
param(
    [string]$Exe = 'C:\cante-wt\a11y\gui\src-tauri\target\debug\cante-gui.exe',
    [string]$WorkDir = 'C:\cante-a11y-narr',
    [int]$StartupSecs = 14,
    [int]$TabCount = 14,
    [int]$HoldSeconds = 6
)
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
$log = Join-Path $WorkDir 'narrator-our-app.txt'
Remove-Item $log -ErrorAction SilentlyContinue
function Say([string]$t) { Add-Content -Path $log -Value $t -Encoding UTF8 }

Say ('elevated = ' + ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--force-renderer-accessibility'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class NK {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte sc, uint f, UIntPtr e);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out R r);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref P p);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, int d, UIntPtr e);
  [StructLayout(LayoutKind.Sequential)] public struct R { public int L,T,RR,B; }
  [StructLayout(LayoutKind.Sequential)] public struct P { public int X,Y; }
  public static void Tab(int n) { for (int i=0;i<n;i++){ keybd_event(0x09,0,0,UIntPtr.Zero); System.Threading.Thread.Sleep(80); keybd_event(0x09,0,2,UIntPtr.Zero); System.Threading.Thread.Sleep(450);} }
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

# 1) 启动应用到首页（走完向导，若出现）
Clear-Stale
if (-not (Test-Path $Exe)) { Say ('环境问题：找不到 ' + $Exe); exit 2 }
$p = Start-Process -FilePath $Exe -PassThru
Start-Sleep -Seconds $StartupSecs
$p.Refresh()
if ($p.HasExited) { Say ('环境问题：应用退出 exit=' + $p.ExitCode); exit 2 }
$hwnd = $p.MainWindowHandle
Say ('应用 pid=' + $p.Id + ' hwnd=' + $hwnd)
$root = $AE::FromHandle($hwnd)
[void][NK]::SetForegroundWindow($hwnd); Start-Sleep -Seconds 1
if (-not (FindC $root '需要我帮你做什么')) {
    Say '（首启向导：走一遍到首页）'
    foreach ($step in @('开始检查','下一步','先看看界面','开始使用')) {
        if (ClickN $root $step) { Say ('  点了「' + $step + '」'); Start-Sleep -Seconds 3 }
    }
    Start-Sleep -Seconds 2
}
$atHome = [bool](FindC $root '需要我帮你做什么')
Say ('到首页 = ' + $atHome)

# 2) 让 Narrator 是跑着的（它是单例；没跑就起一个）
$nar = @(Get-Process Narrator -ErrorAction SilentlyContinue)
if ($nar.Count -eq 0) {
    Say '（Narrator 没在跑，起一个）'
    Start-Process 'C:\Windows\System32\Narrator.exe' -ErrorAction SilentlyContinue | Out-Null
    Start-Sleep -Seconds 6
    $nar = @(Get-Process Narrator -ErrorAction SilentlyContinue)
}
Say ('Narrator 进程数 = ' + $nar.Count)

# 3) 抓 ETW，同时把焦点放回应用并盲按 Tab
$etl = Join-Path $WorkDir 'our-app.etl'
if (Test-Path $etl) { Remove-Item $etl -Force }
& logman delete CanteNarrOurApp 2>&1 | Out-Null
$r1 = (& logman create trace CanteNarrOurApp -p 'Microsoft-Windows-Narrator' -o $etl -f bin -ets 2>&1 | Out-String)
Say ('  etw create: ' + ($r1 -replace '\s+', ' ').Trim())
Start-Sleep -Seconds 2
[void][NK]::SetForegroundWindow($hwnd)
Start-Sleep -Milliseconds 800
# 真滚轮把页面推回顶部，Tab 从第一个可聚焦元素开始
$cr = New-Object NK+R; [void][NK]::GetClientRect($hwnd, [ref]$cr)
$o = New-Object NK+P; [void][NK]::ClientToScreen($hwnd, [ref]$o)
[void][NK]::SetCursorPos(($o.X + [int]($cr.RR / 2)), ($o.Y + [int]($cr.B / 2)))
for ($i = 0; $i -lt 12; $i++) { [NK]::mouse_event(0x0800, 0, 0, 120, [UIntPtr]::Zero); Start-Sleep -Milliseconds 60 }
Say ('  前台 = ' + [NK]::GetForegroundWindow() + '（应用是 ' + $hwnd + '）')
[NK]::Tab($TabCount)
Start-Sleep -Seconds $HoldSeconds
$r2 = (& logman stop CanteNarrOurApp -ets 2>&1 | Out-String)
Say ('  etw stop: ' + ($r2 -replace '\s+', ' ').Trim())

# 4) 解析：找 Narrator 念到 cante-gui 的证据
if (Test-Path $etl) {
    Say ('  ETL 大小 = ' + (Get-Item $etl).Length)
    $xml = Join-Path $WorkDir 'our-app.xml'
    & tracerpt $etl -of XML -o $xml -y 2>&1 | Out-Null
    if (Test-Path $xml) {
        $txt = Get-Content $xml -Raw
        $ev = ([regex]::Matches($txt, '<Event ')).Count
        Say ('  事件 = ' + $ev + '，XML 大小 = ' + (Get-Item $xml).Length)
        $hits = ([regex]::Matches($txt, ('Pid=' + $p.Id + ';'))).Count
        Say ('  提到「应用 pid=' + $p.Id + '」的次数 = ' + $hits)
        Say ('  （对照：提到 Narrator 自己 pid 的次数 = ' + ([regex]::Matches($txt, 'Pid=10844;')).Count + '）')
    }
}
# 收尾：把我们起的应用关掉（Narrator 是系统在跑的，不碰）
try { Stop-Process -Id $p.Id -Force } catch {}
Clear-Stale
Say '完'
