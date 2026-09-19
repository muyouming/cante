$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$zh = $synth.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture.Name -like 'zh*' } | Select-Object -First 1
$synth.SelectVoice($zh.VoiceInfo.Name)
$out = 'C:\cante-a11y-narr\tts'
New-Item -ItemType Directory -Force -Path $out | Out-Null
function Sec([string]$p) {
    $b = [System.IO.File]::ReadAllBytes($p); $i = 12; $ch = 1; $r = 22050; $bits = 16; $d = 0
    while ($i -lt $b.Length - 8) {
        $id = [System.Text.Encoding]::ASCII.GetString($b, $i, 4); $sz = [BitConverter]::ToInt32($b, $i + 4)
        if ($id -eq 'fmt ') { $ch = [BitConverter]::ToInt16($b, $i + 10); $r = [BitConverter]::ToInt32($b, $i + 12); $bits = [BitConverter]::ToInt16($b, $i + 22) }
        elseif ($id -eq 'data') { $d = $sz; break }
        $i += 8 + $sz
    }
    return [math]::Round($d / ($r * $ch * ($bits / 8)), 1)
}
# 这些句子**逐字**取自 ETW 抓到的 Narrator 实际 SpokenText（results.xml）
$cases = @(
    @{ t = '1'; d = '结果行按钮（短）'; s = '打开 结果_挑出华东区-1.xlsx' },
    @{ t = '2'; d = '结果行按钮（长）'; s = '打开 结果_挑出华东区-1.xlsx 所在的文件夹' },
    @{ t = '3'; d = '首页入口按钮'; s = '打开我做的结果' },
    @{ t = '4'; d = '最长的任务卡按钮'; s = '把几张表合成一张（自动去掉重复行）。把这三个月的销售表合成一张，重复的记录只留一条' },
    @{ t = '5'; d = '标题那句（去 SSML）'; s = '退出列表, 标题级别 2 我做的结果 你做过的东西都在这里，最近的在最上面。' },
    @{ t = '6'; d = '卡片的解释按钮'; s = '「汇总」是什么意思' },
    @{ t = '7'; d = '对照：纯中文同样长度'; s = '打开第一份华东区的表格文件' }
)
foreach ($c in $cases) {
    $wav = Join-Path $out ($c.t + '.wav')
    $synth.SetOutputToWaveFile($wav); $synth.Speak($c.s); $synth.SetOutputToNull()
    Write-Output ($c.t + '. ' + $c.d.PadRight(20) + ' 字数=' + $c.s.Length.ToString().PadLeft(3) + '  念=' + (Sec $wav) + ' 秒')
}
$synth.Dispose()
