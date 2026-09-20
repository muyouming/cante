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
        exeTime  = $exeTime.ToString("s")
        distTime = if ($distTime) { $distTime.ToString("s") } else { "" }
        assets   = @($distFiles | ForEach-Object { $_.Name })
        checks   = $results
    } | ConvertTo-Json -Depth 4
    return
}

"exe  时间 = $exeTime"
"dist 时间 = $distTime"
"dist 资源 = " + (($distFiles | ForEach-Object { $_.Name }) -join ", ")
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
