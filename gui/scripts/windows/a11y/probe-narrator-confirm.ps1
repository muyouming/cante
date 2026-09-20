# 抓 Narrator 念**确认页**的 ETW —— 补上 -22.md 缺的第三屏（首页/结果面板已抓）。
#
# 为什么必须抓 ETW 而不是按 UIA 树算：`narrate-script.ps1` 是按 UIA 树推的，
# 而它在结果面板上**证明过高估**（把不可 Tab 的 100 字 ListItem 也算成"会念"）。
# 确认页要有同等级证据，就得让 Narrator 自己说。
#
# 怎么到确认页：点一张**文字卡**（needs:"text"）→ 贴一段字 → 生成计划。
# **不需要模型**（生成计划是本地暂存一条 preview），所以比结果页好到达。
#
# 必须提权：logman 建 ETW 会话要提权。
param(
    [string]$Exe = 'C:\cante-wt\a11y\gui\src-tauri\target\debug\cante-gui.exe',
    [string]$WorkDir = 'C:\cante-a11y-narr',
    [int]$StartupSecs = 14,
    [int]$TabCount = 30,
    [int]$HoldSeconds = 8,
    [string]$Tag = 'confirm'
)
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
$log = Join-Path $WorkDir ("narrator-$Tag.txt")
Remove-Item $log -ErrorAction SilentlyContinue
function Say([string]$t) { Write-Output $t; Add-Content -Path $log -Value $t -Encoding UTF8 }
Say ('elevated = ' + ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--force-renderer-accessibility'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class NC {
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
# 点一个按钮，先滚进视口（「开始使用」在 1280x800 上底部在折叠之下，UIA 不支持 Invoke）
function ClickScrolled($r, [string]$n, [IntPtr]$hwnd) {
    $e = FindC $r $n
    if (-not $e) { return $false }
    try { $e.SetFocus() } catch {}
    try { $e.GetCurrentPattern([System.Windows.Automation.ScrollItemPattern]::Pattern).ScrollIntoView() } catch {}
    Start-Sleep -Milliseconds 300
    if (ClickN $r $n) { return $true }
    $cr = New-Object NC+R; [void][NC]::GetClientRect($hwnd, [ref]$cr)
    $o = New-Object NC+P; [void][NC]::ClientToScreen($hwnd, [ref]$o)
    [void][NC]::SetCursorPos(($o.X + [int]($cr.RR / 2)), ($o.Y + [int]($cr.B / 2)))
    for ($i = 1; $i -le 8; $i++) { [NC]::mouse_event(0x0800, 0, 0, -120, [UIntPtr]::Zero); Start-Sleep -Milliseconds 250; if (ClickN $r $n) { return $true } }
    return $false
}
function AdvanceWizard($r, [IntPtr]$hwnd, [int]$timeoutSec = 60) {
    $d = (Get-Date).AddSeconds($timeoutSec)
    while ((Get-Date) -lt $d) {
        if (FindC $r '需要我帮你做什么') { return $true }
        $clicked = $false
        foreach ($label in @('开始检查', '下一步', '先看看界面', '开始使用')) {
            if (ClickScrolled $r $label $hwnd) { Say ('  （向导：点「' + $label + '」）'); Start-Sleep -Seconds 3; $clicked = $true; break }
        }
        if (-not $clicked) { Start-Sleep -Milliseconds 600 }
    }
    return $false
}

Clear-Stale
if (-not (Test-Path $Exe)) { Say ('环境问题：找不到 ' + $Exe); exit 2 }
$p = Start-Process -FilePath $Exe -PassThru
Start-Sleep -Seconds $StartupSecs
$p.Refresh()
if ($p.HasExited) { Say ('环境问题：应用退出 exit=' + $p.ExitCode); exit 2 }
$hwnd = $p.MainWindowHandle
Say ('应用 = ' + $Exe)
Say ('应用 pid=' + $p.Id + ' hwnd=' + $hwnd)
$root = $AE::FromHandle($hwnd)
[void][NC]::SetForegroundWindow($hwnd); Start-Sleep -Seconds 1
if (-not (FindC $root '需要我帮你做什么')) { [void](AdvanceWizard $root $hwnd 60) }
Say ('到首页 = ' + [bool](FindC $root '需要我帮你做什么'))

# 点文字卡（needs:"text"）：不选文件、不弹原生对话框、不需要模型
$card = FindC $root '把这段时间做的事写成一份总结'
if (-not $card) { Say '环境问题：首页上找不到文字卡'; Stop-Process -Id $p.Id -Force; exit 2 }
try { $card.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke() } catch {}
Start-Sleep -Seconds 3
$instr = $root.FindFirst($TS::Descendants, (New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::AutomationIdProperty, 'task-instruction')))
if ($instr) {
    try { $instr.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue('把这段时间做的事写成一份总结') } catch {}
}
Start-Sleep -Seconds 1
if (-not (ClickScrolled $root '生成计划' $hwnd)) { Say '环境问题：找不到「生成计划」'; Stop-Process -Id $p.Id -Force; exit 2 }
Start-Sleep -Seconds 3
$onConfirm = [bool](FindC $root '它打算这样做')
Say ('到确认页 = ' + $onConfirm)
if (-not $onConfirm) {
    Say '（确认页没到，屏幕上现有名字：）'
    $nm = @(); foreach ($e in $root.FindAll($TS::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) { $n = [string]$e.Current.Name; if ($n -and $n.Trim() -and $nm -notcontains $n) { $nm += $n } }
    Say (($nm | Select-Object -First 20) -join ' | ')
    Stop-Process -Id $p.Id -Force; exit 2
}

# Narrator 必须是跑着的（单例）
if (@(Get-Process Narrator -ErrorAction SilentlyContinue).Count -eq 0) {
    Start-Process 'C:\Windows\System32\Narrator.exe' -ErrorAction SilentlyContinue | Out-Null
    Start-Sleep -Seconds 6
}
Say ('Narrator 进程数 = ' + @(Get-Process Narrator -ErrorAction SilentlyContinue).Count)

# 抓 ETW，同时把焦点放回应用、盲按 Tab 走确认页
$etl = Join-Path $WorkDir ("$Tag.etl")
if (Test-Path $etl) { Remove-Item $etl -Force }
& logman delete ("CanteNarr" + $Tag) 2>&1 | Out-Null
$r1 = (& logman create trace ("CanteNarr" + $Tag) -p 'Microsoft-Windows-Narrator' -o $etl -f bin -ets 2>&1 | Out-String)
Say ('  etw create: ' + ($r1 -replace '\s+', ' ').Trim())
Start-Sleep -Seconds 2
[void][NC]::SetForegroundWindow($hwnd)
Start-Sleep -Milliseconds 800
$cr = New-Object NC+R; [void][NC]::GetClientRect($hwnd, [ref]$cr)
$o = New-Object NC+P; [void][NC]::ClientToScreen($hwnd, [ref]$o)
[void][NC]::SetCursorPos(($o.X + [int]($cr.RR / 2)), ($o.Y + [int]($cr.B / 2)))
for ($i = 0; $i -lt 12; $i++) { [NC]::mouse_event(0x0800, 0, 0, 120, [UIntPtr]::Zero); Start-Sleep -Milliseconds 60 }
Say ('  前台 = ' + [NC]::GetForegroundWindow() + '（应用是 ' + $hwnd + '）')
[NC]::Tab($TabCount)
Start-Sleep -Seconds $HoldSeconds
$r2 = (& logman stop ("CanteNarr" + $Tag) -ets 2>&1 | Out-String)
Say ('  etw stop: ' + ($r2 -replace '\s+', ' ').Trim())
if (Test-Path $etl) {
    $xml = Join-Path $WorkDir ("$Tag.xml")
    & tracerpt $etl -of XML -o $xml -y 2>&1 | Out-Null
    if (Test-Path $xml) {
        $txt = Get-Content $xml -Raw
        Say ('  事件 = ' + ([regex]::Matches($txt, '<Event ')).Count + '，XML = ' + (Get-Item $xml).Length)
    }
}
try { Stop-Process -Id $p.Id -Force } catch {}
Clear-Stale
Say '完'
