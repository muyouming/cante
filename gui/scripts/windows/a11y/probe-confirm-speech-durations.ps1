$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$zh = $s.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture.Name -like 'zh*' } | Select-Object -First 1
$s.SelectVoice($zh.VoiceInfo.Name)
$out = 'C:\cante-a11y-narr\tts-confirm'
New-Item -ItemType Directory -Force -Path $out | Out-Null
function Sec([string]$p) {
    $b = [System.IO.File]::ReadAllBytes($p); $i = 12; $ch = 1; $r = 22050; $bi = 16; $d = 0
    while ($i -lt $b.Length - 8) {
        $id = [System.Text.Encoding]::ASCII.GetString($b, $i, 4); $sz = [BitConverter]::ToInt32($b, $i + 4)
        if ($id -eq 'fmt ') { $ch = [BitConverter]::ToInt16($b, $i + 10); $r = [BitConverter]::ToInt32($b, $i + 12); $bi = [BitConverter]::ToInt16($b, $i + 22) }
        elseif ($id -eq 'data') { $d = $sz; break }
        $i += 8 + $sz
    }
    return [math]::Round($d / ($r * $ch * ($bi / 8)), 1)
}
# 这些句子逐字取自 confirm.xml 的 SpokenText（Narrator 自己说的）
$cases = @(
    @{ n = '1'; s = '开始' },
    @{ n = '2'; s = '先给我看一眼' },
    @{ n = '3'; s = '取消' },
    @{ n = '4'; s = '我同意直接改原来的文件（不推荐） 默认是不勾选的：结果会另存为新文件，原件一个字都不会变。' }
)
foreach ($c in $cases) {
    $w = Join-Path $out ($c.n + '.wav')
    $s.SetOutputToWaveFile($w); $s.Speak($c.s); $s.SetOutputToNull()
    $head = $c.s.Substring(0, [Math]::Min(30, $c.s.Length))
    Write-Output ($c.n + '. 字数=' + $c.s.Length.ToString().PadLeft(3) + '  念=' + (Sec $w) + ' 秒   「' + $head + '」')
}
$s.Dispose()
