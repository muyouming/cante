param(
    [string]$WorkDir = ""
)
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
if (-not $WorkDir) { $WorkDir = Join-Path $env:TEMP 'narrator-probe' }
New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
$script:Lines = New-Object System.Collections.Generic.List[string]
function Say([string]$t) { Write-Host $t; [void]$script:Lines.Add($t) }
function Flush() {
    ($script:Lines -join "`r`n") |
        ForEach-Object { [System.IO.File]::WriteAllText((Join-Path $WorkDir 'probe-narrator.txt'), $_, (New-Object System.Text.UTF8Encoding($false))) }
}

Say '=== 1) Narrator 在不在、跑没跑 ==='
$exe = 'C:\Windows\System32\Narrator.exe'
Say ('exe 存在 = ' + (Test-Path $exe))
if (Test-Path $exe) {
    $vi = (Get-Item $exe).VersionInfo
    Say ('  版本 = ' + $vi.FileVersion)
    Say ('  产品 = ' + $vi.ProductName)
}
$np = @(Get-Process Narrator -ErrorAction SilentlyContinue)
Say ('Narrator 进程数 = ' + $np.Count)
foreach ($p in $np) { Say ('  pid=' + $p.Id + ' session=' + $p.SessionId + ' 启动于 ' + $p.StartTime) }

Say ''
Say '=== 2) 有没有音频输出设备（决定它到底能不能"说话"）==='
$sd = @(Get-CimInstance Win32_SoundDevice -ErrorAction SilentlyContinue)
Say ('Win32_SoundDevice 个数 = ' + $sd.Count)
foreach ($d in $sd) { Say ('  ' + $d.Name + ' / ' + $d.Status) }
$ep = @(Get-PnpDevice -Class AudioEndpoint -ErrorAction SilentlyContinue)
Say ('AudioEndpoint 设备数 = ' + $ep.Count)
foreach ($d in $ep) { Say ('  [' + $d.Status + '] ' + $d.FriendlyName) }
Say ('Audiosrv = ' + (Get-Service Audiosrv -ErrorAction SilentlyContinue).Status +
     ' ; AudioEndpointBuilder = ' + (Get-Service AudioEndpointBuilder -ErrorAction SilentlyContinue).Status)
# 渲染端点（能出声的东西）——用 COM 枚举，比 WMI 准
try {
    $en = New-Object -ComObject MMDeviceEnumerator 2>$null
    Say '  MMDeviceEnumerator 可用'
} catch {
    Say '  （没有 MMDeviceEnumerator COM，跳过）'
}

Say ''
Say '=== 3) 能不能把这个 Narrator 进程当"可驱动对象"用（它有没有窗口/命令行）==='
foreach ($p in $np) {
    $all = @{}
    Get-CimInstance Win32_Process | ForEach-Object { $all[[int]$_.ProcessId] = $_ }
    $proc = Get-CimInstance Win32_Process -Filter ("ProcessId=$($p.Id)") -ErrorAction SilentlyContinue
    Say ('  pid=' + $p.Id + ' cmd=[' + $(if ($proc) { $proc.CommandLine } else { '' }) + ']')
    Say ('  MainWindowHandle=' + $p.MainWindowHandle + ' 标题=[' + $p.MainWindowTitle + ']')
}

Say ''
Say '=== 4) 非提权会话能不能启动 Narrator（"用命令行让它说话")==='
$out = Join-Path $WorkDir 'narrator-launch.txt'
try {
    $pr = Start-Process -FilePath $exe -PassThru -ErrorAction Stop
    Say ('  启动成功 pid=' + $pr.Id)
    Start-Sleep -Seconds 4
    try { if (-not $pr.HasExited) { Say '  4 秒后仍在跑'; Stop-Process -Id $pr.Id -Force } else { Say ('  4 秒内退出了，exit=' + $pr.ExitCode) } } catch {}
} catch {
    Say ('  启动失败：' + $_.Exception.Message)
    Say '  → 这说明**非提权会话起不了 Narrator**（它的清单要求提权）。'
}

Say ''
Say '=== 5) Narrator 的说话文本会不会落进可读的日志/ETW ==='
$providerOk = $false
try {
    $prov = Get-WinEvent -ListProvider 'Microsoft-Windows-Narrator' -ErrorAction Stop
    Say ('  provider GUID = ' + $prov.Id + '，定义事件数 = ' + $prov.Events.Count)
    $providerOk = $true
} catch { Say ('  provider 查不到：' + $_.Exception.Message) }
try {
    $logs = Get-WinEvent -ListLog * -ErrorAction SilentlyContinue | Where-Object { $_.LogName -match 'Narrator' }
    if ($logs) { foreach ($l in $logs) { Say ('  日志 ' + $l.LogName + ' enabled=' + $l.IsEnabled + ' records=' + $l.RecordCount) } }
    else { Say '  **没有任何 Narrator 日志通道**（它只走 ETW 实时会话，不落盘）' }
} catch { Say ('  枚举日志失败：' + $_.Exception.Message) }
if ($providerOk) {
    $etl = Join-Path $WorkDir 'narrator.etl'
    if (Test-Path $etl) { Remove-Item $etl -Force }
    $r1 = (& logman create trace CanteNarratorProbe -p $prov.Id -o $etl -f bin 2>&1 | Out-String)
    Say ('  logman create: ' + ($r1 -replace '\s+', ' ').Trim())
    $r2 = (& logman start CanteNarratorProbe 2>&1 | Out-String)
    Say ('  logman start: ' + ($r2 -replace '\s+', ' ').Trim())
    Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public static class K2{ [DllImport("user32.dll")]public static extern void keybd_event(byte vk,byte sc,uint f,UIntPtr e);}'
    for ($i = 0; $i -lt 3; $i++) { [K2]::keybd_event(0x09, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 120; [K2]::keybd_event(0x09, 0, 2, [UIntPtr]::Zero); Start-Sleep -Milliseconds 400 }
    Start-Sleep -Seconds 8
    $r3 = (& logman stop CanteNarratorProbe 2>&1 | Out-String)
    Say ('  logman stop: ' + ($r3 -replace '\s+', ' ').Trim())
    & logman delete CanteNarratorProbe 2>&1 | Out-Null
    if (Test-Path $etl) {
        Say ('  ETL 大小 = ' + (Get-Item $etl).Length + ' 字节')
        $xml = Join-Path $WorkDir 'narrator.xml'
        $r4 = (& tracerpt $etl -of XML -o $xml -y 2>&1 | Out-String)
        Say ('  tracerpt: ' + (($r4 -replace '\s+', ' ').Trim()))
        if (Test-Path $xml) {
            $txt = Get-Content $xml -Raw -ErrorAction SilentlyContinue
            Say ('  XML 大小 = ' + (Get-Item $xml).Length + ' 字节')
            foreach ($kw in 'Speak', 'Speech', 'Utter', 'Phrase', 'Ssml', 'Text') {
                Say ('    ' + $kw + ' 出现 ' + ([regex]::Matches($txt, $kw, 'IgnoreCase')).Count + ' 次')
            }
        } else { Say '  没生成 XML' }
    } else { Say '  没有 ETL 文件生成' }
}
Say ''
Say '=== 完 ==='
Flush
