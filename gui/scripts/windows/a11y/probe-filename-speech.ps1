$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
# 量「文件名那一段」与「等长的普通中文」各要念多久 —— 用同一台机器的同一个中文语音，不猜。
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$zh = $synth.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture.Name -like 'zh*' } | Select-Object -First 1
$synth.SelectVoice($zh.VoiceInfo.Name)
$outDir = 'C:\cante-narrator\tts2'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

function Get-WavSeconds([string]$path) {
    $b = [System.IO.File]::ReadAllBytes($path)
    $i = 12; $ch = 1; $rate = 22050; $bits = 16; $data = 0
    while ($i -lt $b.Length - 8) {
        $id = [System.Text.Encoding]::ASCII.GetString($b, $i, 4)
        $sz = [BitConverter]::ToInt32($b, $i + 4)
        if ($id -eq 'fmt ') { $ch = [BitConverter]::ToInt16($b, $i + 10); $rate = [BitConverter]::ToInt32($b, $i + 12); $bits = [BitConverter]::ToInt16($b, $i + 22) }
        elseif ($id -eq 'data') { $data = $sz; break }
        $i += 8 + $sz
    }
    $bps = $rate * $ch * ($bits / 8)
    return [math]::Round($data / $bps, 1)
}

$cases = @(
    @{ tag = 'A-文件名段';      text = '结果_挑出华东区-1.xlsx' },
    @{ tag = 'B-等长普通中文';  text = '把这几张表合成一张新表' },
    @{ tag = 'C-数字文件名';    text = '结果_挑出华东区-12.xlsx' },
    @{ tag = 'D-带扩展名反复';  text = 'xlsx' },
    @{ tag = 'E-下划线';        text = '结果_挑出华东区' }
)
foreach ($c in $cases) {
    $wav = Join-Path $outDir ($c.tag + '.wav')
    $synth.SetOutputToWaveFile($wav); $synth.Speak($c.text); $synth.SetOutputToNull()
    $sec = Get-WavSeconds $wav
    # PowerShell 5.1 不允许把 `if` 当表达式拼在字符串里（实测报 CommandNotFoundException）——
    # 先用一个变量算好再拼。
    $rate = ''
    if ($sec -gt 0 -and $c.text.Length -gt 0) { $rate = ([math]::Round($c.text.Length / $sec, 1)).ToString() + ' 字/秒' }
    Write-Output ($c.tag.PadRight(16) + ' 字=' + $c.text.Length.ToString().PadLeft(3) + '  时长=' + $sec + ' 秒  ' + $rate + '  「' + $c.text + '」')
}
$synth.Dispose()
