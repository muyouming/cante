# 核对「这一轮编出来的产物里，真的有这一轮的文案吗」。
#
# 为什么要有这个脚本（两次栽在同一件事上，见 gui/docs/REVIEW-round7.md 追加节）：
#   ① 只看 exe 的文件时间就下结论 —— 时间新，但产物可能没重新打包；
#   ② 直接查 cante-gui.exe 的**字节**找界面文案 —— exe 里**本来就没有**界面文案，
#      前端资源在 gui/dist/assets/*.js，Tauri 构建时才编进去。用它只会得到一堆 False，
#      差一点把一个正常构建记成有问题。
#
# 用法（在 Windows 工作树里）：
#   powershell -NoProfile -ExecutionPolicy Bypass -File gui\scripts\windows\verify-modern-build.ps1 `
#       -WorkTree C:\cante-wt\docs -Text 一共,份结果
#
# 判据（三条都答得上，才能下结论）：
#   ① 产物是这一轮编出来的吗（exe 与 dist 的时间）；
#   ② 要找的字符串**真的属于**这个文件吗（查 dist，不是 exe）；
#   ③ 这个字符串**在源码里存在**吗（不在源码里，产物里当然也没有）。
#
# 中文在 .ps1 里会踩编码坑（PS 5.1 没 BOM 就按 GBK 解）→ 这里**不接受**脚本内写死的中文，
# 必须由 -Text 传入；传参走的是完整 Unicode，不进脚本正文。
[CmdletBinding()]
param(
    [string]$WorkTree = "C:\cante-wt\docs",
    [string[]]$Text = @(),
    [switch]$Json
)
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [Text.Encoding]::UTF8

# powershell.exe -File 传数组参数时会把它们**用逗号拼成一个字符串**（实测），
# 所以这里两种都接受：真数组，或者一个逗号分隔的字符串。这样从计划任务里传也好使。
if ($Text.Count -eq 1 -and $Text[0] -like "*,*") {
    $Text = $Text[0].Split(",") | ForEach-Object { $_.Trim() } | Where-Object { $_ }
}

$exe = Join-Path $WorkTree "gui\src-tauri\target\release\cante-gui.exe"
$distDir = Join-Path $WorkTree "gui\dist\assets"

if (-not (Test-Path $exe)) { throw "找不到产物：$exe（先构建）" }
if (-not (Test-Path $distDir)) { throw "找不到前端产物：$distDir（先跑 bun run build:web）" }

$exeTime = (Get-Item $exe).LastWriteTime
$distFiles = Get-ChildItem (Join-Path $distDir "*.js") -ErrorAction SilentlyContinue
$distTime = if ($distFiles) { ($distFiles | Sort-Object LastWriteTime -Descending)[0].LastWriteTime } else { $null }

# ── 这一轮编出来的，还是装着的旧版本？（#261 的那半条锚点）────────────────────
# 光有文件时间还不够：装着的旧版本和刚编出来的**长得一模一样**，名字都叫
# cante-gui.exe。所以要**让应用自己报**它是哪一份——copy-build.ts 会在打包前端时
# 注入一个标记串（明文在 dist 的 .js 里），这里把它读出来，与 dist / exe 的时间对。
# 对不上，就是**你在验一个旧的产物**——这正是这个脚本该拦住的错（#247 那一轮量出
# 0/12，量的是旧界面，结论作废）。
#
# 只查 dist（明文），不查 exe：前端资源在被 Tauri 打进 exe 之后是 brotli 压缩的，
# 拿 exe 的明文去找界面文案**永远不命中**，已知正常（#261）。标记串的拼法必须和
# copy-build.ts 里的 BUILD_STAMP_MARKER 一致（那边有测试盯着它只有一处定义）。
$stampPattern = 'CANTE-BUILD\|(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\|([0-9A-Za-z][0-9A-Za-z.+-]*)'
$stamps = @()
foreach ($f in $distFiles) {
    $content = [IO.File]::ReadAllText($f.FullName)
    foreach ($m in [regex]::Matches($content, $stampPattern)) {
        $t = [datetime]::ParseExact(
            $m.Groups[1].Value, "yyyy-MM-dd HH:mm",
            [Globalization.CultureInfo]::InvariantCulture)
        $stamps += [pscustomobject]@{ time = $t; version = $m.Groups[2].Value; file = $f.Name }
    }
}
$newest = if ($stamps.Count -gt 0) { $stamps | Sort-Object time -Descending | Select-Object -First 1 } else { $null }
$appTime = if ($newest) { $newest.time } else { $null }
$appVersion = if ($newest) { $newest.version } else { "" }
# 给输出用的一行说明（PowerShell 的 if 是语句不是表达式，不能塞进括号里，所以先算好）。
$appLabel = if ($appTime) { "$($appTime.ToString('yyyy-MM-dd HH:mm'))（版本 $appVersion）" } else { "（没读到）" }

# 容差 30 分钟：前端打进 dist 再到 exe 落盘有先后，差几分钟正常；而「装着的旧版本」
# 和「刚编出来的」差的是几小时（#261 实测 02:27 对 14:36），30 分钟拦得住。
$toleranceMinutes = 30
$freshness = "unknown"
$freshnessNote = ""
if ($null -eq $appTime) {
    $freshnessNote = "核不出来：dist 里没有应用自报的构建时间。先确认这一轮真跑过 bun run build:web、构建注入在不在。"
} else {
    $distFar = ($null -ne $distTime) -and ([math]::Abs(($distTime - $appTime).TotalMinutes) -gt $toleranceMinutes)
    $exeBehind = ($exeTime - $appTime).TotalMinutes -lt (0 - $toleranceMinutes)
    if ($distFar -or $exeBehind) {
        $freshness = "stale"
        $freshnessNote = "你在验一个旧的产物。应用自报 $($appTime.ToString('yyyy-MM-dd HH:mm')) 做好的，与 dist / exe 的时间对不上。"
    } else {
        $freshness = "fresh"
        $freshnessNote = "这一轮的产物：应用自报 $($appTime.ToString('yyyy-MM-dd HH:mm')) 做好的，与 dist / exe 对得上。"
    }
}

$results = @()
foreach ($needle in $Text) {
    $hits = @()
    foreach ($f in $distFiles) {
        $content = [IO.File]::ReadAllText($f.FullName)
        if ($content.Contains($needle)) { $hits += $f.Name }
    }
    $results += [pscustomobject]@{
        text    = $needle
        inDist  = ($hits.Count -gt 0)
        files   = ($hits -join ",")
    }
}

if ($Json) {
    [pscustomobject]@{
        exeTime       = $exeTime.ToString("s")
        distTime      = if ($distTime) { $distTime.ToString("s") } else { "" }
        appBuildTime  = if ($appTime) { $appTime.ToString("s") } else { "" }
        appVersion    = $appVersion
        freshness     = $freshness
        freshnessNote = $freshnessNote
        assets        = @($distFiles | ForEach-Object { $_.Name })
        checks        = $results
    } | ConvertTo-Json -Depth 4
    return
}

"exe  时间 = $exeTime"
"dist 时间 = $distTime"
"应用自报 = $appLabel"
"dist 资源 = " + (($distFiles | ForEach-Object { $_.Name }) -join ", ")
""
# 时间这条**排在文案之前**下结论：MISS 不能单独断定产物有问题（前端被 brotli 压进
# exe，明文找不到是已知正常）；但「你验的是旧产物」必须先拦住——不然下面那些文案
# 结论全是拿旧界面量出来的（#247 的 0/12 就是这么来的）。
$freshnessNote
if ($freshness -eq "stale") {
    "结论：你在验一个旧的产物，下面的文案结论不要用。"
    exit 3
}
if ($freshness -eq "unknown") {
    "结论：核不出来（不算通过）。"
    exit 2
}
""
$missing = 0
foreach ($r in $results) {
    $mark = if ($r.inDist) { "OK  " } else { "MISS" }
    if (-not $r.inDist) { $missing++ }
    "$mark $($r.text)  ->  $($r.files)"
}
""
if ($missing -gt 0) {
    "有 $missing 条没在 dist 里找到。**先别下结论**，按判据查："
    "  ① 这一轮真的跑过 bun run build:web 吗（看 dist 时间）？"
    "  ② 这个字符串在源码里存在吗（grep gui\src\simple\copy-*.ts）？"
    "  ③ 它已经在当前 main 上了吗（还没合并就必然没有）？"
    exit 2
}

"全部命中。"
