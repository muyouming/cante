$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
# WAV 时长：读 RIFF/WAVE 头里的 fmt(采样率/位深/声道) 与 data 大小算 —— 不猜。
function Get-WavInfo([string]$path) {
    $b = [System.IO.File]::ReadAllBytes($path)
    if ($b.Length -lt 44) { return $null }
    # find "fmt " chunk
    $i = 12
    $channels = 1; $rate = 16000; $bits = 16; $dataSize = 0
    while ($i -lt $b.Length - 8) {
        $id = [System.Text.Encoding]::ASCII.GetString($b, $i, 4)
        $sz = [BitConverter]::ToInt32($b, $i + 4)
        if ($id -eq 'fmt ') {
            $channels = [BitConverter]::ToInt16($b, $i + 10)
            $rate = [BitConverter]::ToInt32($b, $i + 12)
            $bits = [BitConverter]::ToInt16($b, $i + 22)
        } elseif ($id -eq 'data') {
            $dataSize = $sz
            break
        }
        $i += 8 + $sz
    }
    $bytesPerSec = $rate * $channels * ($bits / 8)
    $secs = if ($bytesPerSec -gt 0) { [math]::Round($dataSize / $bytesPerSec, 1) } else { 0 }
    return [pscustomobject]@{ file = (Split-Path -Leaf $path); rate = $rate; channels = $channels; bits = $bits; dataBytes = $dataSize; seconds = $secs }
}
Get-ChildItem 'C:\cante-narrator\tts\*.wav' | Sort-Object Name | ForEach-Object {
    $w = Get-WavInfo $_.FullName
    ($w.file.PadRight(24) + ' ' + $w.rate + 'Hz ' + $w.channels + 'ch ' + $w.bits + 'bit  时长≈ ' + $w.seconds + ' 秒')
}
