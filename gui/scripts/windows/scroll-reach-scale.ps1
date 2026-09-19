# 增量滚动：每滚一格记一次目标按钮的位置，找出它**什么时候进入视口、那时点得到吗**。
# 报告里要的是「滚 N 格之后它到屏幕上了、能点」，不是笼统一句"要滚动"。
param(
    [string]$Exe = "",
    [Parameter(Mandatory = $true)][string]$OutDir,
    [int]$ClientWidth = 1024,
    [int]$ClientHeight = 608,
    [string]$Target = "打开文件",
    [string]$Card = "从大表里挑出想要的行",
    [string]$Instruction = "把华东区的记录挑出来，另存成一张新表",
    [string]$InputFile = "",
    [string]$DialogHelper = "",
    [int]$MaxWheel = 40
)
# 滚动可达性：逐格发真滚轮事件，找出目标按钮**第几格进视口**，并在那时**真 invoke 一下**。
#
# 为什么不能只看 UIA 树：元素能被按名字找到 ≠ 它在视口里、≠ 点得到（可能是屏外的）。
# 用法（应用与输入表都给上）：
#   powershell -File scroll-reach-scale.ps1 -OutDir <目录> -InputFile <输入.xlsx> [-Target 打开文件]
#
# 退出码：0 = 完成；2 = 环境问题；3 = 没走到结果页。
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
# 默认值：应用走注册表里的安装位置（不写死任何本机路径）；对话框助手就在本脚本旁边。
if (-not $Exe) {
    $entry = Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' -ErrorAction SilentlyContinue |
        Where-Object { $_.GetValue('DisplayName') -like '*Cante*' } | Select-Object -First 1
    if ($entry) { $Exe = Join-Path ($entry.GetValue('InstallLocation').Trim('"')) 'cante-gui.exe' }
    if (-not $Exe -or -not (Test-Path $Exe)) { $Exe = Join-Path $env:LOCALAPPDATA 'Cante\cante-gui.exe' }
}
if (-not $DialogHelper) { $DialogHelper = Join-Path (Split-Path $MyInvocation.MyCommand.Path) 'accept-file-dialog.ps1' }
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--force-renderer-accessibility'
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$admin = Join-Path $OutDir 'admin.json'
if (-not (Test-Path $admin)) {
    [System.IO.File]::WriteAllText($admin, '{"default_provider":null,"default_model":null,"allow_network":true,"disabled_tasks":[]}', (New-Object System.Text.UTF8Encoding($false)))
}
$env:CANTE_ADMIN_CONFIG = $admin
$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class SI {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int ht, bool rp);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern void mouse_event(uint f, uint dx, uint dy, uint data, IntPtr e);
  public static void WheelDown() { mouse_event(0x0800, 0, 0, unchecked((uint)(-120)), IntPtr.Zero); }
}
'@

$script:hit = $null
$script:Lines = New-Object System.Collections.Generic.List[string]
function Say([string]$t) { Write-Output $t; [void]$script:Lines.Add($t) }
function AllD($root) { return $root.FindAll($TS::Descendants, [System.Windows.Automation.Condition]::TrueCondition) }
function BodyText($root) {
    $o = New-Object System.Collections.Generic.List[string]
    foreach ($e in (AllD $root)) { $n = $e.Current.Name; if ($n -and $n.Trim() -and -not $o.Contains($n)) { [void]$o.Add($n) } }
    return ($o -join "`n")
}
function FindName($root, [string]$name, [int]$t = 20) {
    $script:hit = $null
    $d = (Get-Date).AddSeconds($t)
    while ((Get-Date) -lt $d) {
        foreach ($e in (AllD $root)) { if ($e.Current.Name -eq $name) { $script:hit = $e; return $true } }
        Start-Sleep -Milliseconds 400
    }
    return $false
}
function FindPrefix($root, [string]$p, [int]$t = 20) {
    $script:hit = $null
    $d = (Get-Date).AddSeconds($t)
    while ((Get-Date) -lt $d) {
        foreach ($e in (AllD $root)) { $n = $e.Current.Name; if ($n -and $n.StartsWith($p)) { $script:hit = $e; return $true } }
        Start-Sleep -Milliseconds 400
    }
    return $false
}
function ClickHit() { $script:hit.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke() }
function WaitFor($root, [string]$n, [int]$t) {
    $d = (Get-Date).AddSeconds($t)
    while ((Get-Date) -lt $d) { if ((BodyText $root) -match [regex]::Escape($n)) { return $true }; Start-Sleep -Seconds 1 }
    return $false
}
function Gates($root) {
    $c = @{ approvals = 0; questions = 0; followups = 0 }
    $tx = BodyText $root
    foreach ($p in @(@('要不要允许它继续？','允许这次','approvals'), @('它想问你几件事','按它的建议来','questions'), @('它有一件事想问你','你看着办','followups'))) {
        if ($tx -notmatch [regex]::Escape($p[0])) { continue }
        if (-not (FindName $root $p[1] 2)) { continue }
        if ($script:hit.Current.IsOffscreen) { continue }
        ClickHit; $c[$p[2]]++
        $d = (Get-Date).AddSeconds(20)
        while ((Get-Date) -lt $d) { Start-Sleep -Milliseconds 500; if ((BodyText $root) -notmatch [regex]::Escape($p[0])) { break } }
    }
    return $c
}

$p = Start-Process -FilePath $Exe -PassThru
Start-Sleep -Seconds 12
$h = $p.MainWindowHandle; $root = $AE::FromHandle($h)
$cr = New-Object 'SI+RECT'; [void][SI]::GetClientRect($h, [ref]$cr)
$wr = New-Object 'SI+RECT'; [void][SI]::GetWindowRect($h, [ref]$wr)
$cw = ($wr.Right - $wr.Left) - $cr.Right; $ch = ($wr.Bottom - $wr.Top) - $cr.Bottom
[void][SI]::MoveWindow($h, 0, 0, ($ClientWidth + $cw), ($ClientHeight + $ch), $true)
Start-Sleep -Seconds 3
$cr = New-Object 'SI+RECT'; [void][SI]::GetClientRect($h, [ref]$cr)
$wr = New-Object 'SI+RECT'; [void][SI]::GetWindowRect($h, [ref]$wr)
Say ("客户区 = " + $cr.Right + "x" + $cr.Bottom)

if (-not (WaitFor $root '需要我帮你做什么' 30)) { Say 'ENV:首页没出现'; Stop-Process -Id $p.Id -Force; exit 2 }
if (-not (FindPrefix $root $Card 30)) { Say 'PRODUCT:没有卡片'; Stop-Process -Id $p.Id -Force; exit 3 }
ClickHit; Start-Sleep -Seconds 2
if (-not (WaitFor $root '选择文件' 30)) { Say 'PRODUCT:没有选文件'; Stop-Process -Id $p.Id -Force; exit 3 }
$hl = Start-Process -FilePath 'powershell' -PassThru -NoNewWindow -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',$DialogHelper,'-Path',$InputFile,'-TimeoutSec','90') -RedirectStandardOutput (Join-Path $OutDir 'dialog.log') -RedirectStandardError (Join-Path $OutDir 'dialog.err')
if (FindName $root '选择文件' 20) { ClickHit }
$hl.WaitForExit(120000) | Out-Null
if (-not (WaitFor $root (Split-Path -Leaf $InputFile) 30)) { Say 'PRODUCT:文件没选上'; Stop-Process -Id $p.Id -Force; exit 3 }
if (FindName $root '下一步' 20) { ClickHit; Start-Sleep -Seconds 2 }
$box = $null
foreach ($e in (AllD $root)) { if ($e.Current.AutomationId -eq 'task-instruction') { $box = $e; break } }
if (-not $box) { Say 'PRODUCT:没有输入框'; Stop-Process -Id $p.Id -Force; exit 3 }
$box.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue($Instruction)
if (FindName $root '生成计划' 30) { ClickHit }
if (-not (WaitFor $root '它打算这样做' 60)) { Say 'PRODUCT:没有确认页'; Stop-Process -Id $p.Id -Force; exit 3 }
if (FindName $root '开始' 20) { ClickHit }
$dl = (Get-Date).AddSeconds(600); $reached = $false
while ((Get-Date) -lt $dl) { [void](Gates $root); $tx = BodyText $root; if ($tx -match '做好了' -or $tx -match '这次没能做完') { $reached = $true; break }; Start-Sleep -Seconds 1 }
if (-not $reached) { Say 'PRODUCT:没到结果页'; Stop-Process -Id $p.Id -Force; exit 3 }

[void][SI]::SetForegroundWindow($h)
[void][SI]::SetCursorPos([int](($wr.Left + $wr.Right) / 2), [int](($wr.Top + $wr.Bottom) / 2))
Say ''
Say ("=== 逐格下滚，看「" + $Target + "」什么时候进视口（客户区 " + $cr.Right + "x" + $cr.Bottom + "）===")
$winTop = $wr.Top; $winBot = $wr.Bottom; $winL = $wr.Left; $winR = $wr.Right
$foundAt = -1; $clicked = $false
for ($step = 0; $step -le $MaxWheel; $step++) {
    $rec = $null
    foreach ($e in (AllD $root)) { if ($e.Current.Name -eq $Target) { $b = $e.Current.BoundingRectangle; $rec = [pscustomobject]@{ y = [int]$b.Top; h = [int]$b.Height; x = [int]$b.Left; w = [int]$b.Width; off = [bool]$e.Current.IsOffscreen }; break } }
    if ($rec) {
        $inWin = ($rec.y -ge $winTop -and ($rec.y + $rec.h) -le $winBot -and $rec.x -ge $winL -and ($rec.x + $rec.w) -le $winR)
        if ($step -eq 0 -or $inWin -or ($step % 5 -eq 0)) { Say ("  滚 " + $step + " 格：y=" + $rec.y + " h=" + $rec.h + " 屏外=" + $rec.off + " 在窗口内=" + $inWin) }
        if ($inWin -and -not $rec.off -and $foundAt -lt 0) {
            $foundAt = $step
            if (FindName $root $Target 5) {
                try { ClickHit; $clicked = $true } catch { Say ("  点击抛异常：" + $_.Exception.Message) }
                Start-Sleep -Seconds 2
            }
            Say ("  → 滚 " + $step + " 格后它在视口里：invoke " + $(if ($clicked) { '成功' } else { '失败' }))
            break
        }
    } elseif ($step -eq 0) { Say ("  （滚 0 格时「" + $Target + "」不在 UIA 树里）") }
    [SI]::WheelDown(); Start-Sleep -Milliseconds 150
}
if ($foundAt -lt 0) { Say ("  " + $MaxWheel + " 格内它一直没进视口 —— 如实写进报告") }
BodyText $root | Set-Content -Path (Join-Path $OutDir 'result-after-scroll.txt') -Encoding UTF8
($script:Lines -join "`r`n") | Set-Content -Path (Join-Path $OutDir 'scroll-incremental.txt') -Encoding UTF8
Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
Say ''
Say 'scroll-incremental: 完成'
exit 0
