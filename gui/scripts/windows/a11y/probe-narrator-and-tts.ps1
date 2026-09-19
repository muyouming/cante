$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# 这份探针回答两件事，都不猜：
#   Q1「Narrator 能不能被驱动」—— 试办法、看结果、如实说。
#   Q2「我们算出来的那些念法，这台机器上的**中文语音**真的能不能念」——
#      用系统自带的合成器把每句念成 WAV，看有没有声音、多长。

Write-Output '=== Q1：Narrator 在这台机器上的实况 ==='
$narr = 'C:\Windows\System32\Narrator.exe'
Write-Output ("Narrator.exe 存在 = " + (Test-Path $narr))
if (Test-Path $narr) {
    $vi = (Get-Item $narr).VersionInfo
    Write-Output ("  版本 = " + $vi.FileVersion)
}
# 1) 有没有命令行开关？（官方只支持 /? 之类，实测看有没有输出）
Write-Output '--- 试 Narrator.exe /? （3 秒超时）---'
$job = Start-Job { & 'C:\Windows\System32\Narrator.exe' /? 2>&1 }
if (Wait-Job $job -Timeout 8) { Receive-Job $job | Select-Object -First 5 } else { Stop-Job $job; Write-Output '  （超时：没有命令行输出 → 不是个可脚本驱动的 CLI）' }
Remove-Job $job -Force -ErrorAction SilentlyContinue

# 2) 启动它，看进程/窗口/UIA 有没有可供脚本操作的面
Write-Output '--- 启动 Narrator，看它露出什么可操作面 ---'
Get-Process Narrator -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1
$p = Start-Process $narr -PassThru -ErrorAction SilentlyContinue
Start-Sleep -Seconds 6
if ($p) {
    $p.Refresh()
    Write-Output ("  进程 pid=" + $p.Id + " hasExited=" + $p.HasExited)
    if (-not $p.HasExited) {
        Write-Output ("  MainWindowHandle=" + $p.MainWindowHandle + "  MainWindowTitle='" + $p.MainWindowTitle + "'")
        Add-Type -AssemblyName UIAutomationClient
        Add-Type -AssemblyName UIAutomationTypes
        if ($p.MainWindowHandle -ne 0) {
            $root = [System.Windows.Automation.AutomationElement]::FromHandle($p.MainWindowHandle)
            $n = @()
            foreach ($e in $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) {
                $nm = [string]$e.Current.Name
                if ($nm -and $nm.Trim()) { $n += $nm }
            }
            Write-Output ("  Narrator 窗口里可读节点 = " + $n.Count)
            ($n | Select-Object -First 8) | ForEach-Object { Write-Output ('    | ' + $_) }
        } else {
            Write-Output '  没有主窗口句柄（Narrator 是 UWP/无窗口宿主）→ 脚本没有可驱动的面'
        }
        Get-Process Narrator -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    }
}
Write-Output ''

Write-Output '=== Q2：算出来的念法，这台机器的中文语音能不能念出来 ==='
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$zh = $synth.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture.Name -like 'zh*' } | Select-Object -First 1
if (-not $zh) {
    Write-Output '  ✗ 没有中文语音 → 念不了（如实写）'
    exit 2
}
Write-Output ("  用这个中文语音：" + $zh.VoiceInfo.Name + " (" + $zh.VoiceInfo.Culture + ")")
$synth.SelectVoice($zh.VoiceInfo.Name)
$outDir = 'C:\cante-narrator\tts'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

# 这几句就是 narrate-script 对首页/确认页/结果面板算出来的"读屏会念的"
$samples = @(
    @{ tag = 'home-title'; text = '标题（第1级）：你好，需要我帮你做什么？，文字' },
    @{ tag = 'home-rowbutton'; text = '打开我做的结果，按钮' },
    @{ tag = 'panel-resultbutton'; text = '打开 结果_挑出华东区-1.xlsx，按钮' },
    @{ tag = 'panel-folderbutton'; text = '打开 结果_挑出华东区-1.xlsx 所在的文件夹，按钮' },
    @{ tag = 'panel-listitem'; text = '结果_挑出华东区-1.xlsx来自「从大表里挑出想要的行」：把华东区的记录挑出来，另存成一张新表做好的时间：今天 07:27这次没能核对它还在不在。可以打开所在文件夹自己看一眼。打开文件打开所在文件夹，列表项' }
)
foreach ($s in $samples) {
    $wav = Join-Path $outDir ($s.tag + '.wav')
    $synth.SetOutputToWaveFile($wav)
    $synth.Speak($s.text)
    $synth.SetOutputToNull()
    if (Test-Path $wav) {
        $bytes = (Get-Item $wav).Length
        # 时长用 WAV 头里的 data 段估算（16kHz 16bit mono = 32 字节/ms 量级），更稳的是读 Duration
        $dur = 'n/a'
        try {
            $player = New-Object System.Media.SoundPlayer $wav
            $player.Load()
        } catch {}
        Write-Output ("  " + $s.tag + " : " + $bytes + " bytes  text=" + $s.text.Length + " 字")
    } else {
        Write-Output ("  " + $s.tag + " : 没生成 WAV（念不出来？）")
    }
}
$synth.Dispose()
Write-Output ("WAV 落在：" + $outDir)
