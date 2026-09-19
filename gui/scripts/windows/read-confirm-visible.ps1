param(
  [string]$Exe = "",
  [string]$LedgerFile = "",
  [string]$Instruction = "",
  [string]$Card = "",
  [string]$OutJson = "",
  # 企业预置（让向导不拦路、卡片直接上首页）。不给就自己写一份到 OutJson 旁边。
  [string]$AdminConfig = "",
  [int]$ResultTimeoutSec = 600
)

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

# 让 WebView2 把渲染出来的 DOM 暴露成 UI Automation 树。**只能在应用自己启动时给**：
# msedgedriver 启动应用时会用自己的值覆盖 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
# （实测：走 WebDriver 启动时 msedgewebview2.exe 的命令行里没有 force-renderer-accessibility），
# 所以走 WebDriver 那条路 UIA 读不到 DOM。这个脚本自己启动应用，才能读到。
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--force-renderer-accessibility'

# 有企业预置时向导会被跳过，卡片直接上首页 —— 手动启动应用时要自己设，否则看到的是向导。
if (-not $AdminConfig) {
  $AdminConfig = Join-Path ([System.IO.Path]::GetDirectoryName($OutJson)) 'admin.json'
}
if (-not (Test-Path $AdminConfig)) {
  # 不带 BOM：PowerShell 5.1 的 Set-Content -Encoding UTF8 会加 BOM，而这份 JSON
  # 带 BOM 时应用读不出来（向导会出来拦路）。用 .NET 写无 BOM 的 UTF-8。
  $json = '{"default_provider":null,"default_model":null,"allow_network":true,"disabled_tasks":[]}'
  [System.IO.File]::WriteAllText($AdminConfig, $json, (New-Object System.Text.UTF8Encoding($false)))
}
$env:CANTE_ADMIN_CONFIG = $AdminConfig

$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
$CT = [System.Windows.Automation.ControlType]

function Say([string]$t) { Write-Output $t }

function All-Descendants($root) {
  return $root.FindAll($TS::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
}

function Find-ByName($root, [string]$name, [int]$timeoutSec = 30) {
  $deadline = (Get-Date).AddSeconds($timeoutSec)
  while ((Get-Date) -lt $deadline) {
    $cond = New-Object System.Windows.Automation.PropertyCondition($AE::NameProperty, $name)
    $el = $root.FindFirst($TS::Descendants, $cond)
    if ($el) { return $el }
    Start-Sleep -Milliseconds 400
  }
  return $null
}

function Find-ByNamePrefix($root, [string]$prefix, [int]$timeoutSec = 30) {
  $deadline = (Get-Date).AddSeconds($timeoutSec)
  while ((Get-Date) -lt $deadline) {
    foreach ($el in (All-Descendants $root)) {
      $n = $el.Current.Name
      if ($n -and $n.StartsWith($prefix)) { return $el }
    }
    Start-Sleep -Milliseconds 400
  }
  return $null
}

function Click-El($el) {
  $p = $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
  $p.Invoke()
}

function Dump-Buttons($root) {
  $cond = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $CT::Button)
  $out = @()
  foreach ($b in $root.FindAll($TS::Descendants, $cond)) { $out += $b.Current.Name }
  return $out
}

function Dump-Text($root) {
  # 不按 ControlType 过滤：确认页的文字（标题、正文、按钮上的字）在 UIA 里
  # 不全都是 Text（有的包在 Group/Button 里）。收集**所有有名字的元素**，去重，
  # 这样“把读到的原文贴进报告”才不是漏的。
  $out = @()
  foreach ($t in (All-Descendants $root)) {
    $n = $t.Current.Name
    if ($n -and $n.Trim() -and ($out -notcontains $n)) { $out += $n }
  }
  return $out
}

# 窗口客户区（屏幕坐标），用来判"在不在屏上"。
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class CfmWin32 {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
}
"@

$proc = Start-Process -FilePath $Exe -PassThru
Start-Sleep -Seconds 12
$proc.Refresh()
if ($proc.HasExited) { Say "应用已退出（exit $($proc.ExitCode)）"; exit 2 }
$root = $AE::FromHandle($proc.MainWindowHandle)
if ($null -eq $root) { Say "读不到主窗口"; Stop-Process -Id $proc.Id -Force; exit 2 }
Say ("应用 pid=$($proc.Id) 句柄=$($proc.MainWindowHandle)")

$client = New-Object CfmWin32+RECT
[void][CfmWin32]::GetClientRect($proc.MainWindowHandle, [ref]$client)
$origin = New-Object CfmWin32+POINT
[void][CfmWin32]::ClientToScreen($proc.MainWindowHandle, [ref]$origin)
$cl = $origin.X; $ct = $origin.Y; $cr = $origin.X + $client.Right; $cb = $origin.Y + $client.Bottom
Say ("窗口客户区（屏幕坐标）=[$cl,$ct,$cr,$cb]")

Say ''
Say '=== 第 1 步：点卡片 ==='
$cardEl = Find-ByNamePrefix $root $Card 30
if (-not $cardEl) { Say "找不到卡片：$Card"; Stop-Process -Id $proc.Id -Force; exit 3 }
Say ("卡片按钮 Name=" + $cardEl.Current.Name)
Click-El $cardEl
Start-Sleep -Seconds 2
Say ("点卡片后按钮：" + ((Dump-Buttons $root) -join ' / '))

Say ''
Say '=== 第 2 步：把流水账写进输入框 ==='
$instrEl = $root.FindFirst($TS::Descendants, (New-Object System.Windows.Automation.PropertyCondition($AE::AutomationIdProperty, 'task-instruction')))
if (-not $instrEl) {
  Say "找不到 #task-instruction；当前按钮：" + ((Dump-Buttons $root) -join ' / ')
  Stop-Process -Id $proc.Id -Force; exit 3
}
$ledger = Get-Content $LedgerFile -Raw -Encoding UTF8
$vp = $instrEl.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
$vp.SetValue($Instruction + "`r`n`r`n" + $ledger)
Say "已写入输入框（含来料）"

$gpEl = Find-ByName $root "生成计划" 30
if (-not $gpEl) { Say "找不到「生成计划」"; Stop-Process -Id $proc.Id -Force; exit 3 }
Click-El $gpEl
Say "已点「生成计划」"

Say ''
Say '=== 第 3 步：确认页的可见性读数 ==='
Start-Sleep -Seconds 4
$needle = "先给我看一眼（只看不动）"
$el = Find-ByName $root $needle 30
# 先把两个数组算出来再拼 JSON：在哈希字面量里直接调函数，PS 5.1 有时会把返回的
# 数组序列化成 {}（实测），分开写就没有这个间题。
$allButtons = @(Dump-Buttons $root)
$allTexts = @(Dump-Text $root)
# 每个有名字的元素的 offscreen + 矩形。用途有两个：报告里能看出这个判定**有信号**
# （不是恒为 false），以及能对着看“哪一条落在滚动区里、外面看不见”。
$elements = @()
foreach ($e in (All-Descendants $root)) {
  $n = $e.Current.Name
  if (-not $n -or -not $n.Trim()) { continue }
  $er = $e.Current.BoundingRectangle
  $elements += [pscustomobject]@{
    name = $n
    offscreen = [bool]$e.Current.IsOffscreen
    rect = @([int]$er.Left, [int]$er.Top, [int]$er.Right, [int]$er.Bottom)
  }
}
$snapshot = [ordered]@{ ok = $false; needle = $needle }
if ($el) {
  $r = $el.Current.BoundingRectangle
  $off = $el.Current.IsOffscreen
  $hasRect = ($r.Width -gt 0 -and $r.Height -gt 0)
  $inside = $hasRect -and $r.Left -ge $cl -and $r.Right -le $cr -and $r.Top -ge $ct -and $r.Bottom -le $cb
  $snapshot.ok = ((-not $off) -and $inside)
  $snapshot.offscreen = [bool]$off
  $snapshot.rect = @([int]$r.Left, [int]$r.Top, [int]$r.Right, [int]$r.Bottom)
  $snapshot.client = @($cl, $ct, $cr, $cb)
  $snapshot.inside = [bool]$inside
  $snapshot.buttons = $allButtons
  $snapshot.texts = $allTexts
  $snapshot.elements = $elements
  Say ("命中：Name=「" + $el.Current.Name + "」 offscreen=" + $off + " 矩形=[" + [int]$r.Left + "," + [int]$r.Top + "," + [int]$r.Right + "," + [int]$r.Bottom + "] 在客户区内=" + $inside)
} else {
  Say "确认页没找到「$needle」"
  $snapshot.buttons = $allButtons
  $snapshot.texts = $allTexts
  $snapshot.elements = $elements
}
$snapshot | ConvertTo-Json -Depth 6 | Set-Content -Path $OutJson -Encoding UTF8

Say ''
Say '=== 确认页所有文字（UIA 原样读回）==='
foreach ($t in $allTexts) { Say ('  | ' + $t) }

Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
Say ''
if ($snapshot.ok) {
  Say ('read-confirm-visible: OK — 「' + $needle + '」在屏上（offscreen 为假、矩形落在窗口客户区内）。')
  exit 0
} else {
  Say ('read-confirm-visible: FAIL — 「' + $needle + '」不在屏上（或根本不在 UIA 树里）。')
  exit 3
}

