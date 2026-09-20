# 提权跑一次：① 看 Narrator 提权后会不会活着；② 抓一段它的 ETW，看"它要念的那句话"能不能读出来。
# 为什么必须提权：Narrator.exe 的清单要求提权（非提权启动 4 秒内 exit=-1，见 probe-narrator.ps1 §4）；
# logman 建会话也报 "Element not found"（同样的权限原因）。
param([string]$WorkDir = "C:\cante-a11y-narr")
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
$log = Join-Path $WorkDir 'elevated-probe.txt'
function Say([string]$t) { Add-Content -Path $log -Value $t -Encoding UTF8 }
Remove-Item $log -ErrorAction SilentlyContinue

Say ('elevated = ' + ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))

Say ''
Say '=== A) 提权启动 Narrator，看它活不活 ==='
$before = @(Get-Process Narrator -ErrorAction SilentlyContinue).Count
Say ('启动前 Narrator 进程数 = ' + $before)
$p = Start-Process -FilePath 'C:\Windows\System32\Narrator.exe' -PassThru -ErrorAction SilentlyContinue
if ($p) {
    Say ('  起了一个 pid=' + $p.Id)
    Start-Sleep -Seconds 6
    try {
        $p.Refresh()
        if ($p.HasExited) { Say ('  6 秒内退出了，exit=' + $p.ExitCode) }
        else {
            Say ('  6 秒后仍在跑 — 提权能让它活着')
            Say ('    MainWindowHandle=' + $p.MainWindowHandle + ' 标题=[' + $p.MainWindowTitle + ']')
        }
    } catch { Say ('  查状态失败：' + $_.Exception.Message) }
} else { Say '  起不来' }

Say ''
Say '=== B) 提权抓 Narrator 的 ETW（看说话文本能不能读出来）==='
$guid = '835b79e2-e76a-44c4-9885-26ad122d3b4d'
$etl = Join-Path $WorkDir 'narrator.etl'
if (Test-Path $etl) { Remove-Item $etl -Force }
& logman delete CanteNarratorProbe 2>&1 | Out-Null
$r1 = (& logman create trace CanteNarratorProbe -p $guid -o $etl -f bin 2>&1 | Out-String)
Say ('  create: ' + ($r1 -replace '\s+', ' ').Trim())
$r2 = (& logman start CanteNarratorProbe 2>&1 | Out-String)
Say ('  start:  ' + ($r2 -replace '\s+', ' ').Trim())

# 让 Narrator 读点东西：把前台切到应用（若在跑），盲按几次 Tab
Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public static class EK{ [DllImport("user32.dll")]public static extern void keybd_event(byte vk,byte sc,uint f,UIntPtr e); [DllImport("user32.dll")]public static extern IntPtr GetForegroundWindow();}'
Say ('  前台窗口 = ' + [EK]::GetForegroundWindow())
for ($i = 0; $i -lt 6; $i++) {
    [EK]::keybd_event(0x09, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 100
    [EK]::keybd_event(0x09, 0, 2, [UIntPtr]::Zero); Start-Sleep -Milliseconds 500
}
Start-Sleep -Seconds 5
$r3 = (& logman stop CanteNarratorProbe 2>&1 | Out-String)
Say ('  stop:   ' + ($r3 -replace '\s+', ' ').Trim())
& logman delete CanteNarratorProbe 2>&1 | Out-Null

if (Test-Path $etl) {
    Say ('  ETL 大小 = ' + (Get-Item $etl).Length + ' 字节')
    $xml = Join-Path $WorkDir 'narrator.xml'
    $r4 = (& tracerpt $etl -of XML -o $xml -y 2>&1 | Out-String)
    Say ('  tracerpt: ' + (($r4 -replace '\s+', ' ').Trim()))
    if (Test-Path $xml) {
        $txt = Get-Content $xml -Raw -ErrorAction SilentlyContinue
        Say ('  XML 大小 = ' + (Get-Item $xml).Length + ' 字节')
        $ev = ([regex]::Matches($txt, '<Event ')).Count
        Say ('  事件条数 = ' + $ev)
        foreach ($kw in 'Speak', 'Speech', 'Utter', 'Phrase', 'Ssml', 'Narrator') {
            Say ('    ' + $kw + ' 出现 ' + ([regex]::Matches($txt, $kw, 'IgnoreCase')).Count + ' 次')
        }
        # 把前几条事件的 UserData/Data 打出来看有没有可读文本
        $data = [regex]::Matches($txt, '<Data[^>]*>([^<]{2,120})</Data>')
        Say ('  可读 <Data> 片段（前 12 条）：')
        $shown = 0
        foreach ($m in $data) {
            $v = $m.Groups[1].Value.Trim()
            if ($v) { Say ('    · ' + $v); $shown++; if ($shown -ge 12) { break } }
        }
        if ($shown -eq 0) { Say '    （没有可读文本片段）' }
    } else { Say '  没生成 XML' }
} else { Say '  没有 ETL 文件（会话没起来）' }

Say ''
Say '=== C) 收尾：把我们起的 Narrator 收掉（原来那个 2452 不碰）==='
foreach ($q in @(Get-Process Narrator -ErrorAction SilentlyContinue)) {
    if ($q.Id -ne 2452) { try { Stop-Process -Id $q.Id -Force; Say ('  收掉 pid=' + $q.Id) } catch { Say ('  收不掉 pid=' + $q.Id) } }
}
Say '完'
