# 核对一个事实（不猜）：UIA 的 RawView vs ControlView 到底差多少、
# 以及"同一句标题数到两次"是不是布局节点造成的。
# 用法：powershell -File probe-view-counts.ps1
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--force-renderer-accessibility'
$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
$RAW = [System.Windows.Automation.TreeWalker]::RawViewWalker
$CV = [System.Windows.Automation.TreeWalker]::ControlViewWalker

Get-Process cante-gui -ErrorAction SilentlyContinue | ForEach-Object { try { Stop-Process -Id $_.Id -Force } catch {} }
Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like '*dev.cante.gui*' } | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force } catch {} }
Start-Sleep -Seconds 2
Remove-Item (Join-Path $env:LOCALAPPDATA 'dev.cante.gui') -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path $env:APPDATA 'dev.cante.gui') -Recurse -Force -ErrorAction SilentlyContinue

$exe = 'C:\cante-wt\a11y\gui\src-tauri\target\debug\cante-gui.exe'
$p = Start-Process $exe -PassThru
Start-Sleep -Seconds 14
$p.Refresh()
$root = $AE::FromHandle($p.MainWindowHandle)
function FindC($r, [string]$n) { foreach ($e in $r.FindAll($TS::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) { if (([string]$e.Current.Name).Contains($n)) { return $e } } return $null }
function ClickN($r, [string]$n) { $e = FindC $r $n; if ($e) { try { $e.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke(); return $true } catch { return $false } }; return $false }
# 走到首页
$d = (Get-Date).AddSeconds(60)
while ((Get-Date) -lt $d -and -not (FindC $root '需要我帮你做什么')) {
    $c = $false; foreach ($l in @('开始检查','下一步','先看看界面','开始使用')) { if (ClickN $root $l) { Start-Sleep -Seconds 3; $c = $true; break } }
    if (-not $c) { Start-Sleep -Milliseconds 600 }
}
Write-Output ('到首页 = ' + [bool](FindC $root '需要我帮你做什么'))

function Count-Walk($walker, [string]$label) {
    $script:n = 0; $script:nonCtrl = 0; $script:names = @{}
    function W($el) {
        if (-not $el) { return }
        $script:n++
        $ic = $true
        try { $ic = [bool]$el.GetCurrentPropertyValue([System.Windows.Automation.AutomationElement]::IsControlElementProperty) } catch {}
        if (-not $ic) { $script:nonCtrl++ }
        $nm = [string]$el.Current.Name
        if ($nm -and $nm.Trim() -and -not $ic) { if ($script:names.ContainsKey($nm)) { $script:names[$nm] = $script:names[$nm] + 1 } else { $script:names[$nm] = 1 } }
        $ch = $walker.GetFirstChild($el); $g = 0
        while ($ch -and $g -lt 5000) { W $ch; $ch = $walker.GetNextSibling($ch); $g++ }
    }
    W $root
    Write-Output ("$label : 节点总数 = " + $script:n + "，其中 IsControlElement=False = " + $script:nonCtrl)
    $dup = $script:names.GetEnumerator() | Where-Object { $_.Value -gt 1 } | Select-Object -First 5
    if ($dup) { Write-Output '  （无名以外的布局节点里，名字出现 >1 次的：）'; $dup | ForEach-Object { Write-Output ('    ' + $_.Key + ' × ' + $_.Value) } }
}
Count-Walk $RAW 'RawView'
Count-Walk $CV 'ControlView'
Stop-Process -Id $p.Id -Force
