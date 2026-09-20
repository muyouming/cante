# GBK(936) 的 CSV 交进来时，她看到的是不是人话（#279 的真机判据）。
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File gui\scripts\windows\accept-gbk-csv.ps1
#   ... -Exe "C:\Program Files\Cante\cante-sheets.exe"   # 也可以指装完以后的产物
#   ... -Cleanup                                          # 跑完删掉临时目录（默认保留当证据）
#
# 为什么单独有这么一条：真机（系统代码页 936）上，微信/旧 Excel 导出的 CSV 是 GBK 的。
# 拒收本身是对的（不猜编码、不让乱码进结果 ✓），但**拒收时说的话**必须是她的语言、而且
# 得给她那一步（#279：原来会把 std::fs 的 `stream did not contain valid UTF-8` 端到她面前）。
# 这条只在**真 Windows** 上跑得通：它要用 `cante-sheets.exe` 这个随包产物，真发一次命令。
#
# 它做三件事：
#   1. 用**代码页 936** 显式造一份 GBK 的 CSV（不靠宿主机的 ANSI 代码页 —— 这台不是 936 的
#      机器上也造得出真 GBK；内容里带中文，所以它一定不是合法 UTF-8 ✓）；
#   2. 真跑 `cante-sheets.exe write 结果.xlsx 那份.csv`，拿**退出码 + stderr 原始字节**
#      —— 不看源码、不看注释（AGENTS.md §3.6）；
#   3. 逐条核对：退出 2 / 没有半成品落盘 / 逐字全中文（合法 UTF-8、无 U+FFFD、无 `?`）/
#      含「另存为」那一步 / 不含 stream·valid·utf-8 这类英文 / 路径外只允许 Excel·WPS·xlsx·csv。
#
# 退出码：0 = 全通过；3 = **产品问题**（产物给出的不是人话）；2 = **环境问题**（找不到
#         `cante-sheets.exe`、起不来）；1 = 脚本自身出错。
#         判据里**没有**「跳过也算通过」这一档：跑不成就是 2，不许写成 ✓。
#
# 不覆盖 ✗：GBK 的 xlsx、UTF-16 的 CSV、WPS 自己的格式（#279 一律落到同一句中文，但只有
#   UTF-8 那条另有两组单测盯着 ✓）；**窗口那一侧**也不行 —— 这条只验命令行产物发出来的字，
#   她在界面上看到的那一屏要 RDP 会话才看得到（AGENTS.md §6）。
#
# 注意：本文件必须保存为 UTF-8 with BOM（Windows PowerShell 5.1 否则按 GBK 解析中文，直接乱码）。

param(
    [string]$Exe = "",
    [string]$BaseDir = "",
    [switch]$Cleanup
)

$ErrorActionPreference = 'Stop'

# ---- 证据收集：每行都进 $script:Lines，最后写 report.txt ----
$script:Lines = New-Object System.Collections.Generic.List[string]
function Say([string]$text) {
    $script:Lines.Add($text)
    Write-Host $text
}

function Fail([string]$why) {
    Say ''
    Say ('accept-gbk-csv: 脚本自身出错 —— ' + $why)
    exit 1
}

# ---- 参数与产物位置 ----
$repoRoot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))  # gui\scripts\windows -> 仓库根
if (-not $Exe) {
    $Exe = Join-Path $repoRoot 'gui\src-tauri\target\release\cante-sheets.exe'
}
if (-not (Test-Path -LiteralPath $Exe)) {
    Say 'accept-gbk-csv: 环境问题 —— 找不到 cante-sheets.exe，没法发这条命令。'
    Say ('  找过：' + $Exe)
    Say '  先编出来（cargo build --release --bin cante-sheets），装完的机器上用 -Exe 指安装目录里的那个。'
    exit 2
}
$ExeItem = Get-Item -LiteralPath $Exe
Say 'accept-gbk-csv: GBK(936) 的 CSV 交进来时，她看到的是不是人话（#279）'
Say ('  产物：' + $ExeItem.FullName)
Say ('  产物时间：' + $ExeItem.LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss') + '   字节：' + $ExeItem.Length)

if (-not $BaseDir) {
    $BaseDir = Join-Path $env:TEMP ('cante-accept-gbk-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
}
New-Item -ItemType Directory -Force -Path $BaseDir | Out-Null
$csvPath = Join-Path $BaseDir 'gbk-input.csv'
$outPath = Join-Path $BaseDir 'gbk-result.xlsx'
$errPath = Join-Path $BaseDir 'stderr.txt'
$outStreamPath = Join-Path $BaseDir 'stdout.txt'
$reportFile = Join-Path $BaseDir 'gbk-csv-report.txt'
Say ('  工作目录：' + $BaseDir)

# ---- 1. 造真 GBK 的 CSV（显式 936，不依赖本机 ANSI 代码页）----
$gbk = [System.Text.Encoding]::GetEncoding(936)
# 注意：这里的变量不能叫 $lines —— PowerShell 变量名不分大小写，它会盖掉上面那个
# 证据列表 $script:Lines（写成数组以后 .Add 就报「集合的大小是固定的」，真踩过 ✗）。
$csvLines = @(
    "$([char]0x59D3)$([char]0x540D),$([char]0x91D1)$([char]0x989D),$([char]0x65E5)$([char]0x671F)",  # 姓名,金额,日期
    "$([char]0x674E)$([char]0x56DB),1200.5,2026-01-05",                                                 # 李四,…
    "$([char]0x738B)$([char]0x4E94),340,2026-01-06",                                                    # 王五,…
    "$([char]0x5408)$([char]0x8BA1),,1540.5"                                                            # 合计,…
)
$csvText = ($csvLines -join "`r`n") + "`r`n"
[System.IO.File]::WriteAllBytes($csvPath, $gbk.GetBytes($csvText))

$head = ([System.IO.File]::ReadAllBytes($csvPath) | Select-Object -First 12 | ForEach-Object { $_.ToString('X2') }) -join ' '
Say ''
Say '--- 1. 拿代码页 936 造一份（她机器上微信/旧 Excel 存出来的就是这种）---'
Say ('  ' + $csvPath)
Say ('  头 12 字节：' + $head + '   （D0 D5 C3 FB = 「姓名」的 GBK 编码 ✓）')

$isValidUtf8 = $true
try { [void](New-Object System.Text.UTF8Encoding($false, $true)).GetString([System.IO.File]::ReadAllBytes($csvPath)) }
catch { $isValidUtf8 = $false }
Say ('  这份字节按 UTF-8 读：' + $(if ($isValidUtf8) { '读得下来（那它就不是 GBK 的样本 ✗）' } else { '读不下来 → 确实是「不是 UTF-8」的那一类 ✓' }))

# ---- 2. 真跑一次（拿退出码和 stderr 原始字节，不看源码）----
Remove-Item -LiteralPath $outPath, $errPath, $outStreamPath -Force -ErrorAction SilentlyContinue
Say ''
Say '--- 2. 真跑：cante-sheets.exe write 结果.xlsx 那份.csv ---'
$proc = Start-Process -FilePath $Exe -ArgumentList @('write', $outPath, $csvPath) `
    -RedirectStandardError $errPath -RedirectStandardOutput $outStreamPath -NoNewWindow -Wait -PassThru
$errBytes = if (Test-Path -LiteralPath $errPath) { [System.IO.File]::ReadAllBytes($errPath) } else { @() }
$stdoutBytes = if (Test-Path -LiteralPath $outStreamPath) { [System.IO.File]::ReadAllBytes($outStreamPath) } else { @() }
Say ('  退出码：' + $proc.ExitCode)
Say ('  stderr ' + $errBytes.Length + ' 字节，stdout ' + $stdoutBytes.Length + ' 字节')

$utf8Ok = $true
$errText = ''
try { $errText = (New-Object System.Text.UTF8Encoding($false, $true)).GetString([byte[]]$errBytes) }
catch { $utf8Ok = $false }
Say ''
Say '--- 她看到的原文（stderr 逐字）---'
Say $(if ($utf8Ok) { '  ' + $errText } else { '  （不是合法 UTF-8，逐字打不出来）' })

# ---- 3. 逐条核对 ----
$noPath = $errText.Replace($csvPath, '<这份表>').Replace($BaseDir, '<工作目录>')
$latin = @([regex]::Matches($noPath, '[A-Za-z]+') | ForEach-Object { $_.Value } | Sort-Object -Unique)
$allowedLatin = @('Excel', 'WPS', 'xlsx', 'csv')
$strayLatin = @($latin | Where-Object { $allowedLatin -notcontains $_ })
$englishLeaks = @([regex]::Matches($noPath, '(?i)stream|valid|utf-?8|os error|did not contain') | ForEach-Object { $_.Value } | Sort-Object -Unique)

$checks = [ordered]@{
    '退出码 = 2'                    = ($proc.ExitCode -eq 2)
    'stdout 是空的（数据只走 stdout）' = ($stdoutBytes.Length -eq 0)
    '没有半成品落盘（结果文件不存在）' = (-not (Test-Path -LiteralPath $outPath))
    'stderr 是合法 UTF-8（没被编码糟蹋）' = $utf8Ok
    '逐字没有 U+FFFD 替换字符'      = (-not $errText.Contains([char]0xFFFD))
    '逐字没有 ? 问号占位'            = (-not $errText.Contains('?'))
    '含「另存为」那一步'             = $errText.Contains('另存为')
    '不含 stream/valid/utf-8 这类英文' = ($englishLeaks.Count -eq 0)
    '路径、Excel、WPS、.xlsx、.csv 之外没有拉丁字母' = ($strayLatin.Count -eq 0)
    '有中文（不是空话）'             = ([regex]::IsMatch($errText, '[\u4e00-\u9fff]'))
}

Say ''
Say '--- 3. 逐条对（判据全部来自 #279 的提交信息）---'
foreach ($name in $checks.Keys) {
    Say ('  [' + $(if ($checks[$name]) { '✓' } else { '✗' }) + '] ' + $name)
}
if ($englishLeaks.Count -gt 0) { Say ('      漏出来的英文：' + ($englishLeaks -join '、')) }
if ($strayLatin.Count -gt 0) { Say ('      多出来的拉丁字母串：' + ($strayLatin -join '、')) }

$passed = @($checks.Values | Where-Object { $_ }).Count
$total = $checks.Count
$exitCode = if ($passed -eq $total) { 0 } else { 3 }

Say ''
Say ('  通过 ' + $passed + ' / ' + $total)
Say ''
Say ('accept-gbk-csv: 结论 = ' + $exitCode + '（0=通过 / 2=环境问题 / 3=产品问题）')

$result = [pscustomobject]@{
    ok = ($exitCode -eq 0)
    exitCode = $exitCode
    exe = $ExeItem.FullName
    exeBytes = $ExeItem.Length
    exeBuiltAt = $ExeItem.LastWriteTime.ToString('s')
    csvBytesHead = $head
    csvWasNotUtf8 = (-not $isValidUtf8)
    childExitCode = $proc.ExitCode
    stderr = $errText
    stderrBytes = $errBytes.Length
    stdoutBytes = $stdoutBytes.Length
    outputFileCreated = (Test-Path -LiteralPath $outPath)
    englishLeaks = $englishLeaks
    strayLatin = $strayLatin
    checks = $checks
    passed = $passed
    total = $total
    baseDir = $BaseDir
}
$result | ConvertTo-Json -Depth 6 | Set-Content -Path (Join-Path $BaseDir 'gbk-csv-result.json') -Encoding UTF8
$script:Lines -join "`n" | Set-Content -Path $reportFile -Encoding UTF8
Say ('报告：' + $reportFile)

if ($Cleanup) {
    Remove-Item -LiteralPath $BaseDir -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host ('（-Cleanup：已删掉 ' + $BaseDir + '）')
}

exit $exitCode
