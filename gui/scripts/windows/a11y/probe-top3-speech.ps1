$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$zh = $synth.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture.Name -like 'zh*' } | Select-Object -First 1
$synth.SelectVoice($zh.VoiceInfo.Name)
$outDir = 'C:\cante-narrator\tts-final'
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
# 这些字符串**逐字**取自真机的 UIA 树（narrate-*.txt / .json）
$cases = @(
    @{ tag = 'listitem-full';  text = '结果_挑出华东区-1.xlsx来自「从大表里挑出想要的行」：把华东区的记录挑出来，另存成一张新表做好的时间：今天 07:34这次没能核对它还在不在。可以打开所在文件夹自己看一眼。打开文件打开所在文件夹' },
    @{ tag = 'row-button';     text = '打开 结果_挑出华东区-1.xlsx' },
    @{ tag = 'row-folderbtn';  text = '打开 结果_挑出华东区-1.xlsx 所在的文件夹' },
    @{ tag = 'heading-twice';  text = '我做的结果 我做的结果' },
    @{ tag = 'step-listitem';  text = '1选文件—' }
)
foreach ($c in $cases) {
    $wav = Join-Path $outDir ($c.tag + '.wav')
    $synth.SetOutputToWaveFile($wav); $synth.Speak($c.text); $synth.SetOutputToNull()
    Write-Output ($c.tag.PadRight(16) + ' 字数=' + $c.text.Length.ToString().PadLeft(3) + '  念出来=' + (Sec $wav) + ' 秒')
}
$synth.Dispose()
