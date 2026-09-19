param(
    [string]$Exe = "C:\cante-scale\app\cante-gui-vm.exe",
    [Parameter(Mandatory = $true)][string]$OutDir,
    [int]$ClientWidth = 1024,
    [int]$ClientHeight = 608,
    [string]$Card = "从大表里挑出想要的行",
    [string]$Instruction = "把华东区的记录挑出来，另存成一张新表",
    [string]$InputFile = "C:\cante-scale\input\销售明细.xlsx",
    [string]$DialogHelper = "C:\cante-wt\docs\gui\scripts\windows\accept-file-dialog.ps1",
    [int]$ResultTimeoutSec = 600
)
# 滚动可达性：在 125% 等效视口下，结果页的关键按钮「滚动之后点得到吗」。
#
# 为什么必须真滚真点：UIA 树里能按名字找到元素 ≠ 它现在在视口里、≠ 点得到。
# 所以这里做三件事：① 记录滚动前每个按钮的 y/屏外标志；② 发真的滚轮事件；③ 对
# 滚动后落在窗口内、且不在屏外的那个按钮**真 invoke 一下**。
#
# PowerShell 踩坑（写在这里免得下次再踩）：AutomationElement 走 `return ,$x` 这种
# 「防解包」写法时，在 foreach 内联调用与赋值调用两种上下文里行为不一致（一处拿到
# 元素、另一处拿到名字字符串）。所以这里**不用返回值传元素**，改成把命中的元素放进
# $script:hit，函数只回 $true/$false。

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
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
public static class SX {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int ht, bool rp);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern void mouse_event(uint f, uint dx, uint dy, uint data, IntPtr extra);
  public static void WheelDown(int times) {
    for (int i = 0; i < times; i++) {
      mouse_event(0x0800, 0, 0, unchecked((uint)(-120)), IntPtr.Zero);
      System.Threading.Thread.Sleep(120);
    }
  }
}
'@

$script:Lines = New-Object System.Collections.Generic.List[string]
function Say([string]$t) { Write-Output $t; [void]$script:Lines.Add($t) }

function AllD($root) { return $root.FindAll($TS::Descendants, [System.Windows.Automation.Condition]::TrueCondition) }
function BodyText($root) {
    $o = New-Object System.Collections.Generic.List[string]
    foreach ($e in (AllD $root)) { $n = $e.Current.Name; if ($n -and $n.Trim() -and -not $o.Contains($n)) { [void]$o.Add($n) } }
    return ($o -join "`n")
}
function DumpElems($root) {
    $list = New-Object System.Collections.Generic.List[object]
    foreach ($e in (AllD $root)) {
        $b = $e.Current.BoundingRectangle
        if ($b.Width -gt 0) { [void]$list.Add([pscustomobject]@{ el = $e; name = $e.Current.Name; x = [int]$b.Left; y = [int]$b.Top; w = [int]$b.Width; h = [int]$b.Height; off = [bool]$e.Current.IsOffscreen }) }
    }
    return $list
}
# 命中就放进 $script:hit，只回布尔（不用返回值传 AutomationElement）
function FindByName($root, [string]$name, [int]$timeoutSec = 20) {
    $script:hit = $null
    $deadline = (Get-Date).AddSeconds($timeoutSec)
    while ((Get-Date) -lt $deadline) {
        foreach ($e in (AllD $root)) { if ($e.Current.Name -eq $name) { $script:hit = $e; return $true } }
        Start-Sleep -Milliseconds 400
    }
    return $false
}
function FindByNamePrefix($root, [string]$prefix, [int]$timeoutSec = 20) {
    $script:hit = $null
    $deadline = (Get-Date).AddSeconds($timeoutSec)
    while ((Get-Date) -lt $deadline) {
        foreach ($e in (AllD $root)) { $n = $e.Current.Name; if ($n -and $n.StartsWith($prefix)) { $script:hit = $e; return $true } }
        Start-Sleep -Milliseconds 400
    }
    return $false
}
function ClickHit() { $script:hit.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke() }
function WaitFor($root, [string]$needle, [int]$timeoutSec) {
    $deadline = (Get-Date).AddSeconds($timeoutSec)
    while ((Get-Date) -lt $deadline) { if ((BodyText $root) -match [regex]::Escape($needle)) { return $true }; Start-Sleep -Seconds 1 }
    return $false
}
function ClearGates($root) {
    $c = @{ approvals = 0; questions = 0; followups = 0 }
    $tx = BodyText $root
    foreach ($pair in @(@('要不要允许它继续？','允许这次','approvals'), @('它想问你几件事','按它的建议来','questions'), @('它有一件事想问你','你看着办','followups'))) {
        if ($tx -notmatch [regex]::Escape($pair[0])) { continue }
        if (-not (FindByName $root $pair[1] 2)) { continue }
        if ($script:hit.Current.IsOffscreen) { continue }
        ClickHit; $c[$pair[2]]++
        $d = (Get-Date).AddSeconds(20)
        while ((Get-Date) -lt $d) { Start-Sleep -Milliseconds 500; if ((BodyText $root) -notmatch [regex]::Escape($pair[0])) { break } }
    }
    return $c
}
function RectOfName($list, [string]$name) {
    foreach ($it in $list) { if ($it.name -eq $name) { return $it } }
    return $null
}

$p = Start-Process -FilePath $Exe -PassThru
Start-Sleep -Seconds 12
$h = $p.MainWindowHandle; $root = $AE::FromHandle($h)
$cr = New-Object 'SX+RECT'; [void][SX]::GetClientRect($h, [ref]$cr)
$wr = New-Object 'SX+RECT'; [void][SX]::GetWindowRect($h, [ref]$wr)
$cw = ($wr.Right - $wr.Left) - $cr.Right; $ch = ($wr.Bottom - $wr.Top) - $cr.Bottom
[void][SX]::MoveWindow($h, 0, 0, ($ClientWidth + $cw), ($ClientHeight + $ch), $true)
Start-Sleep -Seconds 3
$cr = New-Object 'SX+RECT'; [void][SX]::GetClientRect($h, [ref]$cr)
$wr = New-Object 'SX+RECT'; [void][SX]::GetWindowRect($h, [ref]$wr)
Say ("客户区 = " + $cr.Right + "x" + $cr.Bottom + "  窗口=[" + $wr.Left + "," + $wr.Top + ".." + $wr.Right + "," + $wr.Bottom + "]")

if (-not (WaitFor $root '需要我帮你做什么' 30)) { Say 'ENV:首页没出现'; Stop-Process -Id $p.Id -Force; exit 2 }
if (-not (FindByNamePrefix $root $Card 30)) { Say 'PRODUCT:没有卡片'; Stop-Process -Id $p.Id -Force; exit 3 }
ClickHit; Start-Sleep -Seconds 2
if (-not (WaitFor $root '选择文件' 30)) { Say 'PRODUCT:没有选文件'; Stop-Process -Id $p.Id -Force; exit 3 }
$helper = Start-Process -FilePath 'powershell' -PassThru -NoNewWindow -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',$DialogHelper,'-Path',$InputFile,'-TimeoutSec','90') -RedirectStandardOutput (Join-Path $OutDir 'dialog.log') -RedirectStandardError (Join-Path $OutDir 'dialog.err')
if (FindByName $root '选择文件' 20) { ClickHit }
$helper.WaitForExit(120000) | Out-Null
if (-not (WaitFor $root (Split-Path -Leaf $InputFile) 30)) { Say 'PRODUCT:文件没选上'; Stop-Process -Id $p.Id -Force; exit 3 }
if (FindByName $root '下一步' 20) { ClickHit; Start-Sleep -Seconds 2 }
if (-not (FindByName $root '生成计划' 30)) { Say 'PRODUCT:没有生成计划'; Stop-Process -Id $p.Id -Force; exit 3 }
# 先写需求（输入框按 AutomationId 找）
$box = $null
foreach ($e in (AllD $root)) { if ($e.Current.AutomationId -eq 'task-instruction') { $box = $e; break } }
if (-not $box) { Say 'PRODUCT:没有输入框'; Stop-Process -Id $p.Id -Force; exit 3 }
$box.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue($Instruction)
if (-not (FindByName $root '生成计划' 30)) { Say 'PRODUCT:没有生成计划'; Stop-Process -Id $p.Id -Force; exit 3 }
ClickHit
if (-not (WaitFor $root '它打算这样做' 60)) { Say 'PRODUCT:没有确认页'; Stop-Process -Id $p.Id -Force; exit 3 }
if (FindByName $root '开始' 20) { ClickHit }
$deadline = (Get-Date).AddSeconds($ResultTimeoutSec); $tot = @{ approvals = 0; questions = 0; followups = 0 }; $reached = $false
while ((Get-Date) -lt $deadline) {
    $g = ClearGates $root; $tot.approvals += $g.approvals; $tot.questions += $g.questions; $tot.followups += $g.followups
    $tx = BodyText $root
    if ($tx -match '做好了' -or $tx -match '这件事没有做完' -or $tx -match '这次没能做完') { $reached = $true; break }
    Start-Sleep -Seconds 1
}
Say ("替她点：审批 " + $tot.approvals + " 提问 " + $tot.questions + " 追问 " + $tot.followups)
if (-not $reached) { Say 'PRODUCT:没到结果页'; Stop-Process -Id $p.Id -Force; exit 3 }

BodyText $root | Set-Content -Path (Join-Path $OutDir 'before-scroll.txt') -Encoding UTF8
$targets = @('打开文件', '打开所在文件夹', '复制成微信能贴的文字', '再跑一次', '知道了')
Say ''
Say '=== 滚动前 ==='
$before = DumpElems $root
foreach ($t in $targets) {
    $r0 = RectOfName $before $t
    Say ("  " + $t.PadRight(16) + $(if ($r0) { "y=" + $r0.y + " h=" + $r0.h + " 屏外=" + $r0.off } else { "（不在 UIA 树里）" }))
}

# 真滚：指针放窗口中间，向下滚 25 格
[void][SX]::SetForegroundWindow($h)
[void][SX]::SetCursorPos([int](($wr.Left + $wr.Right) / 2), [int](($wr.Top + $wr.Bottom) / 2))
[SX]::WheelDown(25)
Start-Sleep -Seconds 2
BodyText $root | Set-Content -Path (Join-Path $OutDir 'after-scroll.txt') -Encoding UTF8

$WinH = $wr.Bottom - $wr.Top
Say ''
Say '=== 滚动后（在窗口内 = 矩形整个落在窗口里）==='
$after = DumpElems $root
foreach ($t in $targets) {
    $r1 = RectOfName $after $t
    if ($r1) {
        $inWin = ($r1.y -ge $wr.Top -and ($r1.y + $r1.h) -le $wr.Bottom -and $r1.x -ge $wr.Left -and ($r1.x + $r1.w) -le $wr.Right)
        Say ("  " + $t.PadRight(16) + "y=" + $r1.y + " h=" + $r1.h + " 屏外=" + $r1.off + " 在窗口内=" + $inWin)
    } else {
        Say ("  " + $t.PadRight(16) + "（滚动后不在 UIA 树里 —— 说明它被卸载了）")
    }
}

# 真点一个「滚动后落在窗口内且不在屏外」的按钮
$clickable = $null
foreach ($t in $targets) {
    $r1 = RectOfName $after $t
    if ($r1 -and -not $r1.off -and ($r1.y -ge $wr.Top) -and (($r1.y + $r1.h) -le $wr.Bottom)) { $clickable = $t; break }
}
Say ''
if ($clickable) {
    if (FindByName $root $clickable 5) {
        $ok = $false
        try { ClickHit; $ok = $true } catch { Say ("  点击抛异常：" + $_.Exception.Message) }
        Start-Sleep -Seconds 2
        $tail = (BodyText $root); if ($tail.Length -gt 80) { $tail = $tail.Substring(0, 80) }
        Say ("  真点了「" + $clickable + "」→ invoke " + $(if ($ok) { "成功" } else { "失败" }) + "（点完屏幕开头：" + ($tail -replace "`n", " / ") + "…）")
    } else { Say ("  找不到「" + $clickable + "」元素，没能点") }
} else {
    Say '  （滚动后仍没有按钮落在窗口内 —— 这条要如实写进报告）'
}

($script:Lines -join "`r`n") | Set-Content -Path (Join-Path $OutDir 'scroll-report.txt') -Encoding UTF8
Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
Say ''
Say ("scroll-reach: 完成（客户区 " + $ClientWidth + "x" + $ClientHeight + "）")
exit 0
