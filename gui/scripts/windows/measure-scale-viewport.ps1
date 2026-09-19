# 在指定**窗口尺寸**下量结果页的版面（UI Automation），用来回答缩放那一组问题：
#   ① 结果页文字有没有被裁掉/挤出视口？ ② 按钮还点得到吗？ ③ 底部输入区占多少？
#   ④ 关键元素的实际高度（UIA BoundingRectangle）。
#
# 为什么用「窗口尺寸」而不是真的改缩放：这台验收机的显示适配器**不支持**按 source 调缩放
# （DisplayConfig 的 GET/SET 都返回 rc=87，见 scale-probe.ps1 与报告 §2）。125% 在这台
# 1280x800 上会得到 1024x608 的**逻辑视口**，所以把窗口的客户区设成那个尺寸，就能量到
# 「同样的 CSS 视口下版面会怎样」——这条**不等于**真机 125% 缩放，报告里必须分开写。
#
# 它自己启动应用、用 UIA 走到结果页（UIA 驱动原生文件对话框不行，所以走**文件卡**并把
# 对话框交给 accept-file-dialog.ps1），然后把每个有名字元素的位置/尺寸记下来。
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File measure-scale-viewport.ps1 `
#     -Exe "<cante-gui.exe>" -OutDir "<目录>" -ClientWidth 1024 -ClientHeight 608 `
#     -InputFile "<输入.xlsx>" -DialogHelper "<accept-file-dialog.ps1>"
#
# 退出码：0 = 量到了；2 = 环境问题；3 = 没走到结果页。
#
# 注意：本文件必须保存为 UTF-8 with BOM（Windows PowerShell 5.1 否则按 GBK 解析中文）。

param(
    [string]$Exe = "$env:LOCALAPPDATA\Cante\cante-gui.exe",
    [Parameter(Mandatory = $true)][string]$OutDir,
    # 目标**客户区**（= CSS 视口）尺寸。0 表示不改（用应用自己的默认尺寸）。
    [int]$ClientWidth = 0,
    [int]$ClientHeight = 0,
    [string]$Card = "从大表里挑出想要的行",
    [string]$Instruction = "把华东区的记录挑出来，另存成一张新表",
    [string]$InputFile = "",
    [string]$DialogHelper = "",
    [int]$DialogTimeoutSec = 90,
    [int]$ResultTimeoutSec = 600,
    # 真机缩放比例（用来把物理像素与 CSS 像素区分开）。这台机器上是 1.0（100%）。
    [double]$Scale = 1.0,
    [switch]$KeepRunning
)

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--force-renderer-accessibility'
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
if (-not $DialogHelper) { $DialogHelper = Join-Path (Split-Path $MyInvocation.MyCommand.Path) 'accept-file-dialog.ps1' }

# 企业预置：让向导不拦路。无 BOM 写（PS5.1 的 -Encoding UTF8 会加 BOM，应用读不出来）。
$adminFile = Join-Path $OutDir 'admin.json'
if (-not (Test-Path $adminFile)) {
    $json = '{"default_provider":null,"default_model":null,"allow_network":true,"disabled_tasks":[]}'
    [System.IO.File]::WriteAllText($adminFile, $json, (New-Object System.Text.UTF8Encoding($false)))
}
$env:CANTE_ADMIN_CONFIG = $adminFile

$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class Win {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int ht, bool repaint);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
}
'@

$script:Lines = New-Object System.Collections.Generic.List[string]
function Say([string]$t) { Write-Output $t; [void]$script:Lines.Add($t) }

function All-Descendants($root) { return $root.FindAll($TS::Descendants, [System.Windows.Automation.Condition]::TrueCondition) }
function Dump-Text($root) {
    $out = @()
    foreach ($t in (All-Descendants $root)) { $n = $t.Current.Name; if ($n -and $n.Trim() -and ($out -notcontains $n)) { $out += $n } }
    return $out
}
function Body-Text($root) { return ((Dump-Text $root) -join "`n") }
function Find-ByName($root, [string]$name, [int]$timeoutSec = 20) {
    $deadline = (Get-Date).AddSeconds($timeoutSec)
    while ((Get-Date) -lt $deadline) {
        $el = $root.FindFirst($TS::Descendants, (New-Object System.Windows.Automation.PropertyCondition($AE::NameProperty, $name)))
        if ($el) { return $el }
        Start-Sleep -Milliseconds 400
    }
    return $null
}
function Find-ByNamePrefix($root, [string]$prefix, [int]$timeoutSec = 20) {
    $deadline = (Get-Date).AddSeconds($timeoutSec)
    while ((Get-Date) -lt $deadline) {
        foreach ($el in (All-Descendants $root)) { $n = $el.Current.Name; if ($n -and $n.StartsWith($prefix)) { return $el } }
        Start-Sleep -Milliseconds 400
    }
    return $null
}
function Click-El($el) { $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke() }
function Wait-For($root, [string]$needle, [int]$timeoutSec) {
    $deadline = (Get-Date).AddSeconds($timeoutSec)
    while ((Get-Date) -lt $deadline) {
        if ((Body-Text $root) -match [regex]::Escape($needle)) { return $true }
        Start-Sleep -Seconds 1
    }
    return $false
}
function Clear-Gates($root) {
    $counts = @{ approvals = 0; questions = 0; followups = 0 }
    $text = Body-Text $root
    foreach ($pair in @(@('要不要允许它继续？','允许这次','approvals'), @('它想问你几件事','按它的建议来','questions'), @('它有一件事想问你','你看着办','followups'))) {
        if ($text -notmatch [regex]::Escape($pair[0])) { continue }
        $el = Find-ByName $root $pair[1] 2
        if (-not $el -or $el.Current.IsOffscreen) { continue }
        Click-El $el; $counts[$pair[2]]++
        $deadline = (Get-Date).AddSeconds(20)
        while ((Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500; if ((Body-Text $root) -notmatch [regex]::Escape($pair[0])) { break } }
    }
    return $counts
}

# 客户区（CSS 视口）的屏幕坐标
function Get-ClientBox($h) {
    $cr = New-Object 'Win+RECT'; [void][Win]::GetClientRect($h, [ref]$cr)
    $wr = New-Object 'Win+RECT'; [void][Win]::GetWindowRect($h, [ref]$wr)
    $borderX = (($wr.Right - $wr.Left) - $cr.Right) / 2
    $chromeY = (($wr.Bottom - $wr.Top) - $cr.Bottom) - $borderX
    return [pscustomobject]@{ Left = $wr.Left + $borderX; Top = $wr.Top + $chromeY; Width = $cr.Right; Height = $cr.Bottom }
}

$proc = Start-Process -FilePath (Resolve-Path $Exe).Path -PassThru
Start-Sleep -Seconds 12
$proc.Refresh()
if ($proc.HasExited) { Say ("应用已退出（exit " + $proc.ExitCode + "）"); Say 'ENV:应用起不来'; exit 2 }
$h = $proc.MainWindowHandle
if ($h -eq 0) { Say 'ENV:没有主窗口'; exit 2 }
$root = $AE::FromHandle($h)

Say ("应用 pid=" + $proc.Id + " hwnd=" + $h)
Say ("GetDpiForWindow = " + [Win]::GetDpiForWindow($h) + "（96 = 100%）")

# --- 设窗口客户区到目标尺寸 ---
if ($ClientWidth -gt 0 -and $ClientHeight -gt 0) {
    $box = Get-ClientBox $h
    Say ("改尺寸前：客户区 " + $box.Width + "x" + $box.Height)
    $wr = New-Object 'Win+RECT'; [void][Win]::GetWindowRect($h, [ref]$wr)
    $chromeW = ($wr.Right - $wr.Left) - $box.Width
    $chromeH = ($wr.Bottom - $wr.Top) - $box.Height
    [void][Win]::MoveWindow($h, 0, 0, ($ClientWidth + $chromeW), ($ClientHeight + $chromeH), $true)
    Start-Sleep -Seconds 2
    $box = Get-ClientBox $h
    Say ("改尺寸后：客户区 " + $box.Width + "x" + $box.Height + "（目标 " + $ClientWidth + "x" + $ClientHeight + "；窗框 " + $chromeW + "x" + $chromeH + "）")
} else {
    $box = Get-ClientBox $h
    Say ("客户区（未改）：" + $box.Width + "x" + $box.Height)
}
$viewport = [pscustomobject]@{ width = $box.Width; height = $box.Height; left = $box.Left; top = $box.Top }

$result = [ordered]@{
    ok = $false; exe = $Exe; scale = $Scale
    targetClient = @($ClientWidth, $ClientHeight)
    viewport = $viewport
    gates = @{ approvals = 0; questions = 0; followups = 0 }
    elements = @()
}

# --- 走一张文件卡到结果页 ---
if (-not (Wait-For $root '需要我帮你做什么' 30)) { Say '首页没出现'; if (-not $KeepRunning) { Stop-Process -Id $proc.Id -Force }; Say 'ENV:首页没出现'; exit 2 }
$cardEl = Find-ByNamePrefix $root $Card 30
if (-not $cardEl) { Say '找不到卡片'; if (-not $KeepRunning) { Stop-Process -Id $proc.Id -Force }; Say 'PRODUCT:没有卡片'; exit 3 }
Click-El $cardEl; Start-Sleep -Seconds 2

if ($InputFile) {
    if (-not (Wait-For $root '选择文件' 30)) { Say '选文件这步没出现'; if (-not $KeepRunning) { Stop-Process -Id $proc.Id -Force }; Say 'PRODUCT:没有选文件'; exit 3 }
    $helper = Start-Process -FilePath 'powershell' -PassThru -NoNewWindow `
        -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',$DialogHelper,'-Path',$InputFile,'-TimeoutSec',[string]$DialogTimeoutSec) `
        -RedirectStandardOutput (Join-Path $OutDir 'dialog.log') -RedirectStandardError (Join-Path $OutDir 'dialog.err')
    $chooseEl = Find-ByName $root '选择文件' 20
    if ($chooseEl) { Click-El $chooseEl }
    $helper.WaitForExit(($DialogTimeoutSec + 30) * 1000) | Out-Null
    $basename = Split-Path -Leaf $InputFile
    if (-not (Wait-For $root $basename 30)) { Say '文件没选上'; if (-not $KeepRunning) { Stop-Process -Id $proc.Id -Force }; Say 'PRODUCT:文件没选上'; exit 3 }
    $nextEl = Find-ByName $root '下一步' 20
    if ($nextEl) { Click-El $nextEl; Start-Sleep -Seconds 2 }
}
$instrEl = $root.FindFirst($TS::Descendants, (New-Object System.Windows.Automation.PropertyCondition($AE::AutomationIdProperty, 'task-instruction')))
if (-not $instrEl) { Say '找不到输入框'; if (-not $KeepRunning) { Stop-Process -Id $proc.Id -Force }; Say 'PRODUCT:没有输入框'; exit 3 }
$instrEl.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue($Instruction)
$gpEl = Find-ByName $root '生成计划' 30
if ($gpEl) { Click-El $gpEl }
if (-not (Wait-For $root '它打算这样做' 60)) { Say '确认页没出现'; if (-not $KeepRunning) { Stop-Process -Id $proc.Id -Force }; Say 'PRODUCT:没有确认页'; exit 3 }
$startEl = Find-ByName $root '开始' 20
if ($startEl) { Click-El $startEl }

$deadline = (Get-Date).AddSeconds($ResultTimeoutSec)
$totals = @{ approvals = 0; questions = 0; followups = 0 }
$reached = $false
while ((Get-Date) -lt $deadline) {
    $c = Clear-Gates $root
    $totals.approvals += $c.approvals; $totals.questions += $c.questions; $totals.followups += $c.followups
    $txt = Body-Text $root
    if ($txt -match '做好了' -or $txt -match '这件事没有做完' -or $txt -match '这次没能做完') { $reached = $true; break }
    Start-Sleep -Seconds 1
}
$result.gates = $totals
$resultText = Body-Text $root
$resultText | Set-Content -Path (Join-Path $OutDir 'result-page.txt') -Encoding UTF8
Say ("替她点：审批 " + $totals.approvals + " 次、提问 " + $totals.questions + " 次、追问 " + $totals.followups + " 次")

if (-not $reached) { if (-not $KeepRunning) { Stop-Process -Id $proc.Id -Force }; Say 'PRODUCT:没到结果页'; exit 3 }

# --- 量每个有名字元素：矩形、是否屏外、是否落在客户区内 ---
# 滚动会让"在视口外"变得模糊，所以只报事实：逻辑坐标 + offscreen 标志 + 是否在客户区矩形内。
Say ''
Say ("=== 结果页元素（客户区 " + $viewport.width + "x" + $viewport.height + "，缩放 " + $Scale + "）===")
Say ("  " + "名称".PadRight(38) + " 逻辑x,y  w x h   物理h  屏外  在视口内")
$els = @()
foreach ($e in (All-Descendants $root)) {
    $n = $e.Current.Name
    if (-not $n -or -not $n.Trim()) { continue }
    $r = $e.Current.BoundingRectangle
    $w = [int]$r.Width; $hh = [int]$r.Height
    $physH = [int][Math]::Round($hh * $Scale)
    $inside = ($r.Width -gt 0 -and $r.Height -gt 0 -and $r.Left -ge $box.Left -and $r.Right -le ($box.Left + $box.Width) -and $r.Top -ge $box.Top -and $r.Bottom -le ($box.Top + $box.Height))
    $els += [pscustomobject]@{
        name = $n; x = [int]$r.Left; y = [int]$r.Top; w = $w; h = $hh
        physical_h = $physH; offscreen = [bool]$e.Current.IsOffscreen; insideViewport = [bool]$inside
        controlType = $e.Current.ControlType.ProgrammaticName
    }
    $label = if ($n.Length -gt 36) { $n.Substring(0,36) } else { $n }
    Say ("  " + $label.PadRight(38) + ("{0,6},{1,-5}" -f [int]$r.Left, [int]$r.Top) + ("{0,5}x{1,-5}" -f $w, $hh) + ("{0,6}" -f $physH) + ("{0,7}" -f $e.Current.IsOffscreen) + ("{0,8}" -f $inside))
}
$result.elements = $els

# --- 关键文案「有没有真的渲染出来」：逐条找，记命中与否 ---
$mustFind = @(
    '做好了',
    '结果_挑出华东区.xlsx',
    '打开文件',
    '打开所在文件夹',
    '想打印出来：先点「打开文件」把它打开，再按 Ctrl+P 就能打印。',
    '以后也能在首页的「我做的结果」里找到它。'
)
Say ''
Say '=== 关键文案是否都在屏上（UIA 树里能按名字找到）==='
$found = @()
foreach ($needle in $mustFind) {
    $el = Find-ByName $root $needle 3
    $hit = [bool]$el
    $found += [pscustomobject]@{ needle = $needle; found = $hit }
    $extra = ''
    if ($el) {
        $r = $el.Current.BoundingRectangle
        $extra = '  矩形=' + [int]$r.Left + ',' + [int]$r.Top + ' ' + [int]$r.Width + 'x' + [int]$r.Height + ' 在视口内=' + ($r.Left -ge $box.Left -and $r.Right -le ($box.Left + $box.Width) -and $r.Top -ge $box.Top -and $r.Bottom -le ($box.Top + $box.Height))
    }
    Say (($(if ($hit) { '✓' } else { '✗' })) + ' ' + $needle + $extra)
}
$result.mustFind = $found

$result.ok = $true
if (-not $KeepRunning) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
$result | ConvertTo-Json -Depth 8 | Set-Content -Path (Join-Path $OutDir 'measure.json') -Encoding UTF8
($script:Lines -join "`r`n") | Set-Content -Path (Join-Path $OutDir 'measure-report.txt') -Encoding UTF8
Say ''
Say ('measure-scale-viewport: OK — 客户区 ' + $viewport.width + 'x' + $viewport.height + ' 下量完了。')
exit 0
