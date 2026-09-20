$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$zh = $synth.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture.Name -like 'zh*' } | Select-Object -First 1
$synth.SelectVoice($zh.VoiceInfo.Name)
$outDir = 'C:\cante-narrator\tts3'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
function Sec([string]$path) {
    $b = [System.IO.File]::ReadAllBytes($path); $i = 12; $ch = 1; $rate = 22050; $bits = 16; $data = 0
    while ($i -lt $b.Length - 8) {
        $id = [System.Text.Encoding]::ASCII.GetString($b, $i, 4); $sz = [BitConverter]::ToInt32($b, $i + 4)
        if ($id -eq 'fmt ') { $ch = [BitConverter]::ToInt16($b, $i + 10); $rate = [BitConverter]::ToInt32($b, $i + 12); $bits = [BitConverter]::ToInt16($b, $i + 22) }
        elseif ($id -eq 'data') { $data = $sz; break }
        $i += 8 + $sz
    }
    return [math]::Round($data / ($rate * $ch * ($bits / 8)), 1)
}
$cases = @(
    @{ t = '_';                d = '单独一个下划线' },
    @{ t = '.xlsx';            d = '扩展名' },
    @{ t = '-1';               d = '连字符加数字' },
    @{ t = '结果_';            d = '名字加下划线' },
    @{ t = '挑出华东区';       d = '普通中文 5 字' },
    @{ t = '结果 挑出华东区 1'; d = '下划线换成空格' },
    @{ t = '结果挑出华东区1';   d = '不留分隔' }
)
foreach ($c in $cases) {
    $wav = Join-Path $outDir ((($c.t -replace '[\\/:*?"<>|]', '_')) + '.wav')
    $synth.SetOutputToWaveFile($wav); $synth.Speak($c.t); $synth.SetOutputToNull()
    Write-Output (('"' + $c.t + '"').PadRight(20) + ' 字数=' + $c.t.Length.ToString().PadLeft(2) + '  时长=' + (Sec $wav) + ' 秒   (' + $c.d + ')')
}
$synth.Dispose()
