$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$WorkDir = 'C:\cante-a11y-narr'
New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
$log = Join-Path $WorkDir 'audio-and-etw.txt'
Remove-Item $log -ErrorAction SilentlyContinue
function Say([string]$t) { Add-Content -Path $log -Value $t -Encoding UTF8 }

Say ('elevated = ' + ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))

Say ''
Say '=== A) 音频渲染端点：用 MMDeviceEnumerator 直接问（比 WMI 准）==='
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class MM {
  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorComObject { }
  [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceEnumerator {
    int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
    int GetDefaultAudioEndpoint(int dataFlow, int role, out IntPtr device);
    int GetDevice(string id, out IntPtr device);
    int RegisterEndpointNotificationCallback(IntPtr client);
    int UnregisterEndpointNotificationCallback(IntPtr client);
  }
  public static string Check() {
    try {
      var en = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());
      IntPtr dev;
      int hr = en.GetDefaultAudioEndpoint(0, 0, out dev);   // eRender, eConsole
      return "GetDefaultAudioEndpoint(eRender) hr=0x" + hr.ToString("X8") + (hr == 0 ? "  → 有默认播放设备" : "  → 没有默认播放设备");
    } catch (Exception ex) { return "COM 失败: " + ex.Message; }
  }
}
'@
Say ('  ' + [MM]::Check())

Say ''
Say '=== B) 音频相关服务/驱动 ==='
foreach ($s in 'Audiosrv','AudioEndpointBuilder','DeviceInstall') {
    $svc = Get-Service $s -ErrorAction SilentlyContinue
    if ($svc) { Say ('  ' + $s + ' = ' + $svc.Status) }
}
$drv = @(Get-CimInstance Win32_PnPSignedDriver -ErrorAction SilentlyContinue | Where-Object { $_.DeviceClass -in 'MEDIA','AUDIO' })
Say ('  PnP 驱动里 MEDIA/AUDIO 类 = ' + $drv.Count)
foreach ($d in $drv) { Say ('    ' + $d.DeviceName) }

Say ''
Say '=== C) ETW：用 provider **名字**建会话（GUID 报 Element not found 时试试名字）==='
& logman delete CanteNarratorProbe 2>&1 | Out-Null
$etl = Join-Path $WorkDir 'narrator2.etl'
if (Test-Path $etl) { Remove-Item $etl -Force }
$r1 = (& logman create trace CanteNarratorProbe -p 'Microsoft-Windows-Narrator' -o $etl -f bin -ets 2>&1 | Out-String)
Say ('  create(-ets, by name): ' + ($r1 -replace '\s+', ' ').Trim())
Start-Sleep -Seconds 2
Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public static class EK2{ [DllImport("user32.dll")]public static extern void keybd_event(byte vk,byte sc,uint f,UIntPtr e);}'
for ($i = 0; $i -lt 6; $i++) {
    [EK2]::keybd_event(0x09, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 100
    [EK2]::keybd_event(0x09, 0, 2, [UIntPtr]::Zero); Start-Sleep -Milliseconds 400
}
Start-Sleep -Seconds 4
$r3 = (& logman stop CanteNarratorProbe -ets 2>&1 | Out-String)
Say ('  stop(-ets): ' + ($r3 -replace '\s+', ' ').Trim())
if (Test-Path $etl) {
    Say ('  ETL 大小 = ' + (Get-Item $etl).Length + ' 字节')
    $xml = Join-Path $WorkDir 'narrator2.xml'
    & tracerpt $etl -of XML -o $xml -y 2>&1 | Out-Null
    if (Test-Path $xml) {
        $txt = Get-Content $xml -Raw -ErrorAction SilentlyContinue
        Say ('  XML 大小 = ' + (Get-Item $xml).Length + '，事件条数 = ' + ([regex]::Matches($txt, '<Event ')).Count)
        foreach ($kw in 'Speak','Utter','Phrase','Ssml') { Say ('    ' + $kw + ' = ' + ([regex]::Matches($txt, $kw, 'IgnoreCase')).Count) }
        $n = 0
        foreach ($m in [regex]::Matches($txt, '<Data[^>]*>([^<]{2,160})</Data>')) {
            $v = $m.Groups[1].Value.Trim(); if ($v) { Say ('    · ' + $v); if (++$n -ge 10) { break } }
        }
        if ($n -eq 0) { Say '    （没有可读 <Data>）' }
    } else { Say '  没生成 XML' }
} else { Say '  没有 ETL（会话没起来）' }
Say '完'
