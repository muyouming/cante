# 抓一段 Narrator 的 ETW，验证：**它会不会念我们的应用**（cante-gui 的元素）。
# 这是"读屏会怎么说"的关键一步 —— 如果 Narrator 会跟着焦点念 cante-gui 的控件，
# 那我们就能从它自己的事件里读出**它真正要念的那句话**，不用猜。
#
# 用 provider **名字** 建会话（GUID 会报 Element not found；名字可以，实测）。
# 必须 -ets（直接进实时会话），且要提权（logman 建会话需要）。
param(
    [string]$WorkDir = "C:\cante-a11y-narr",
    [int]$Seconds = 25
)
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
$log = Join-Path $WorkDir 'focus-follow.txt'
Remove-Item $log -ErrorAction SilentlyContinue
function Say([string]$t) { Add-Content -Path $log -Value $t -Encoding UTF8 }

Say ('elevated = ' + ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))

# 关掉"讲述人更新"对话框（它会抢焦点，污染 Captured 内容）
Get-Process ShellHost -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowTitle -like '*讲述人*' } |
    ForEach-Object { try { $_.CloseMainWindow() | Out-Null; Say ('  关掉讲述人更新对话框 pid=' + $_.Id) } catch {} }
Start-Sleep -Seconds 1

$etl = Join-Path $WorkDir 'focus-follow.etl'
if (Test-Path $etl) { Remove-Item $etl -Force }
& logman delete CanteNarrFocus 2>&1 | Out-Null
$r = (& logman create trace CanteNarrFocus -p 'Microsoft-Windows-Narrator' -o $etl -f bin -ets 2>&1 | Out-String)
Say ('  create: ' + ($r -replace '\s+', ' ').Trim())
Start-Sleep -Seconds 2

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class FKW {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte sc, uint f, UIntPtr e);
  public static void Tab(int n) { for (int i=0;i<n;i++){ keybd_event(0x09,0,0,UIntPtr.Zero); System.Threading.Thread.Sleep(60); keybd_event(0x09,0,2,UIntPtr.Zero); System.Threading.Thread.Sleep(400);} }
}
'@

# 找到 cante-gui 窗口并拉到前台，然后盲按 Tab，让 Narrator 跟着念
$cg = Get-Process cante-gui -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $cg) { Say '  ✗ 没有 cante-gui 窗口在跑 —— 先用 narrate-script.ps1 或手动启动应用'; }
else {
    Say ('  cante-gui pid=' + $cg.Id + ' hwnd=' + $cg.MainWindowHandle)
    [void][FKW]::SetForegroundWindow($cg.MainWindowHandle)
    Start-Sleep -Seconds 1
    Say ('  前台现在是 = ' + [FKW]::GetForegroundWindow() + '（应为 ' + $cg.MainWindowHandle + '）')
    [FKW]::Tab(10)
}
Start-Sleep -Seconds 3

$rs = (& logman stop CanteNarrFocus -ets 2>&1 | Out-String)
Say ('  stop: ' + ($rs -replace '\s+', ' ').Trim())
if (Test-Path $etl) {
    Say ('  ETL 大小 = ' + (Get-Item $etl).Length + ' 字节')
    $xml = Join-Path $WorkDir 'focus-follow.xml'
    & tracerpt $etl -of XML -o $xml -y 2>&1 | Out-Null
    if (Test-Path $xml) {
        $txt = Get-Content $xml -Raw
        $ev = ([regex]::Matches($txt, '<Event ')).Count
        Say ('  XML 大小 = ' + (Get-Item $xml).Length + '，事件 = ' + $ev)
        # Narrator 念某元素时会在 OnNarratorContextUpdated 里带 Pid=<cante-gui pid>
        $pidHits = ([regex]::Matches($txt, ('Pid=' + $cg.Id + ';'))).Count
        Say ('  提到 cante-gui pid=' + $cg.Id + ' 的次数 = ' + $pidHits)
        if ($pidHits -gt 0) { Say '  ✓ Narrator **会**跟着我们应用的焦点走（这条证据成立）' }
        else { Say '  ✗ 这段里没看到 Narrator 念我们的应用（可能焦点没进去）' }
    } else { Say '  没生成 XML' }
} else { Say '  没有 ETL（会话没起来）' }
Say '完'
