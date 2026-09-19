$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--force-renderer-accessibility'
$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
$CVR = [System.Windows.Automation.TreeWalker]::ControlViewWalker

function Clear-Stale {
    Get-Process cante-gui -ErrorAction SilentlyContinue | Stop-Process -Force
    Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like '*dev.cante.gui*' } | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {} }
    Start-Sleep -Seconds 2
}
function All($r) { $r.FindAll($TS::Descendants, [System.Windows.Automation.Condition]::TrueCondition) }
function FindC($r, $n) { foreach ($e in (All $r)) { if (([string]$e.Current.Name).Contains($n)) { return $e } } return $null }
function Kind($e) { $t = $e.Current.ControlType.ProgrammaticName; if ($t.Contains('.')) { $t = $t.Substring($t.LastIndexOf('.') + 1) }; return $t }

Clear-Stale
$p = Start-Process 'C:\cante-wt\a11y\gui\src-tauri\target\debug\cante-gui.exe' -PassThru
Start-Sleep -Seconds 14
$p.Refresh()
$root = $AE::FromHandle($p.MainWindowHandle)

# advance wizard if needed
function ClickN($r, $n) { $e = FindC $r $n; if ($e) { try { $e.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke(); return $true } catch {} }; return $false }
if (-not (FindC $root '需要我帮你做什么')) {
    [void](ClickN $root '开始检查'); Start-Sleep -Seconds 3
    [void](ClickN $root '下一步'); Start-Sleep -Seconds 2
    [void](ClickN $root '先看看界面'); Start-Sleep -Seconds 2
    [void](ClickN $root '开始使用'); Start-Sleep -Seconds 2
}
"home reached: " + [bool](FindC $root '需要我帮你做什么')
$entry = FindC $root '打开我做的结果'
if ($entry) { try { $entry.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke() } catch { "entry invoke fail: $($_.Exception.Message)" } }
Start-Sleep -Seconds 3
"panel reached: " + [bool](FindC $root '回到首页')

# --- Q1: is there a List ancestor for the ListItems? ---
$li = $null
foreach ($e in (All $root)) { if ((Kind $e) -eq 'ListItem') { $li = $e; break } }
if ($li) {
    "--- ListItem ancestors (control view) ---"
    $cur = $li
    for ($i = 0; $i -lt 8; $i++) {
        $par = $CVR.GetParent($cur)
        if (-not $par) { "  (no more parents)"; break }
        "  $i : " + (Kind $par) + "  name='" + $par.Current.Name + "'"
        $cur = $par
    }
} else { "no ListItem found" }

# --- Q2: count List vs ListItem on the panel ---
$lists = 0; $items = 0
foreach ($e in (All $root)) { $k = Kind $e; if ($k -eq 'List') { $lists++ }; if ($k -eq 'ListItem') { $items++ } }
"List nodes = $lists ; ListItem nodes = $items"

# --- Q3: which headings exist on the panel? ---
"--- heading nodes (panel) ---"
foreach ($e in (All $root)) {
    $hl = $null
    try { $hl = $e.GetCurrentPropertyValue([System.Windows.Automation.AutomationElement]::HeadingLevelProperty) } catch {}
    $s = "$hl"
    if ($s -match '^Level([1-9])$') { "  L" + $Matches[1] + " : " + $e.Current.Name }
}
Stop-Process -Id $p.Id -Force
Clear-Stale
