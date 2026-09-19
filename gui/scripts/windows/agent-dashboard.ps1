# 在这台 Windows 机器上「一眼看清每个子 agent 在干什么、干到哪了」。
#
# 为什么需要它：我（集成者）在另一台机器上只能看到「分支有没有变化」✗；
# 而 agent 的**实时转录**落在 ~\.pi\agent\sessions\<工作树>\*.jsonl ✓。
# 判据不是"进程还在不在"（进程会一直躺着 ✓），而是**转录有没有在长** ✓。
#
# 用法（在这台机器上）：powershell -NoProfile -File agent-dashboard.ps1 [-SampleSeconds 8] [-Tail 60]
# 也可从别处经 qm guest exec / SSH 调（见 gui/DEVELOPING-WINDOWS.md）。
param(
  [int]$SampleSeconds = 8,
  [int]$Tail = 60,
  [string]$SessionRoot = ''
)

[Console]::OutputEncoding = [Text.Encoding]::UTF8
$ErrorActionPreference = 'Continue'

# 这个脚本常被**以 SYSTEM 身份**调用（qm guest exec / 计划任务），那时
# $env:USERPROFILE 指向 systemprofile ✗ —— 所以先找真正跑 agent 的那个账户的 ~\.pi ✓。
if (-not $SessionRoot) {
  $candidates = @()
  if ($env:USERPROFILE) { $candidates += (Join-Path $env:USERPROFILE '.pi\agent\sessions') }
  $candidates += @(Get-ChildItem 'C:\Users' -Directory -ErrorAction SilentlyContinue |
      ForEach-Object { Join-Path $_.FullName '.pi\agent\sessions' })
  $SessionRoot = $candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
}
if (-not $SessionRoot -or -not (Test-Path $SessionRoot)) {
  Write-Output "找不到 agent 转录目录（找过 $env:USERPROFILE 与 C:\Users\*）✗"
  exit 1
}
Write-Output ("transcripts: " + $SessionRoot)
Write-Output ""

# transcript 目录名把 C:\a\b 编成 --C--a-b-- ✓ —— 但分隔符与名字里的连字符长一样 ✗，
# 所以不能直接还原：先试「整段就是一层目录」（cante-wt-ci ✓），不行再从右往左把连字符当分隔符试 ✓。
function Resolve-Tree([string]$dirName) {
  if ($dirName -notmatch '^--(.)--(.*)--$') { return '' }
  $drive = $Matches[1] + ':\'
  $rest = $Matches[2]
  if (Test-Path ($drive + $rest)) { return ($drive + $rest) }
  $idx = $rest.LastIndexOf('-')
  while ($idx -gt 0) {
    $cand = $drive + $rest.Substring(0, $idx) + '\' + $rest.Substring($idx + 1)
    if (Test-Path $cand) { return $cand }
    $idx = $rest.LastIndexOf('-', $idx - 1)
  }
  return ''
}

$git = (Get-Command git.exe -ErrorAction SilentlyContinue).Source
if (-not $git) {
  foreach ($c in @("$env:ProgramFiles\Git\cmd\git.exe", "${env:ProgramFiles(x86)}\Git\cmd\git.exe",
                   "$env:LOCALAPPDATA\Programs\Git\cmd\git.exe")) {
    if ($c -and (Test-Path $c)) { $git = $c; break }
  }
}

$trees = @{}
Get-ChildItem $SessionRoot -Directory -ErrorAction SilentlyContinue | ForEach-Object {
  $trees[$_.Name] = (Resolve-Tree $_.Name)
}

function Get-LatestTranscript([string]$dir) {
  Get-ChildItem $dir -File -Filter *.jsonl -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
}

# 两次采样比较大小 —— 这是唯一能回答「现在在不在干活」的判据 ✓
$first = @{}
foreach ($k in $trees.Keys) {
  $f = Get-LatestTranscript (Join-Path $SessionRoot $k)
  if ($f) { $first[$k] = $f.Length }
}
Start-Sleep -Seconds $SampleSeconds

$now = Get-Date
foreach ($k in ($trees.Keys | Sort-Object)) {
  $dir = Join-Path $SessionRoot $k
  $f = Get-LatestTranscript $dir
  if (-not $f) { continue }
  $wt = $trees[$k]
  $delta = 0
  if ($first.ContainsKey($k)) { $delta = $f.Length - $first[$k] }
  $idleSec = [int]($now - $f.LastWriteTime).TotalSeconds

  $state = if ($delta -gt 0) { 'WORKING' }
           elseif ($idleSec -lt 120) { 'IDLE (just stopped)' }
           else { 'STOPPED' }

  $branch = ''; $dirty = 0; $ahead = 0; $unpushed = 0
  if ($wt -and (Test-Path $wt) -and $git) {
    $branch   = (& $git -C $wt branch --show-current 2>$null)
    $dirty    = (& $git -C $wt status --porcelain 2>$null | Measure-Object -Line).Lines
    $ahead    = (& $git -C $wt log --oneline origin/main..HEAD 2>$null | Measure-Object -Line).Lines
    $unpushed = (& $git -C $wt log --oneline '@{u}..HEAD' 2>$null | Measure-Object -Line).Lines
  }

  $idle = if ($idleSec -ge 3600) { '{0:N1}h' -f ($idleSec/3600) }
          elseif ($idleSec -ge 60) { '{0}m' -f [int]($idleSec/60) }
          else { "${idleSec}s" }

  Write-Output ("{0,-9} {1,-22} idle={2,-6} wrote=+{3,-8} branch={4} changes={5} commits={6} unpushed={7}" -f `
    $state, ($k -replace '^--.-.*-wt-','').Trim('-'), $idle, $delta, $branch, $dirty, $ahead, $unpushed)

  # 转录末尾：最后一句人话 + 最后用过的工具 —— 这就是「在干什么」✓
  $lines = Get-Content $f.FullName -Encoding UTF8 -Tail $Tail -ErrorAction SilentlyContinue
  $lastUser = ''; $lastAsst = ''; $lastTools = ''
  foreach ($l in $lines) {
    try { $o = $l | ConvertFrom-Json } catch { continue }
    if ($o.type -ne 'message') { continue }
    $role = $o.message.role
    $text = (($o.message.content | Where-Object { $_.type -eq 'text' } | ForEach-Object { $_.text }) -join ' ')
    if ($role -eq 'user' -and $text) { $lastUser = $text }
    if ($role -eq 'assistant') {
      $tools = (($o.message.content | Where-Object { $_.type -eq 'tool_use' } | ForEach-Object { $_.name }) -join ',')
      if ($tools) { $lastTools = $tools }
      if ($text -and $text.Length -gt 30) { $lastAsst = $text }
    }
  }
  function Flatten([string]$s, [int]$n) {
    $s = ($s -replace '\s+', ' ').Trim()
    if ($s.Length -le $n) { return $s }
    return $s.Substring(0, $n) + '…'
  }
  if ($lastTools) { Write-Output ("    tools: " + (Flatten $lastTools 100)) }
  if ($lastUser)  { Write-Output ("    asked: " + (Flatten $lastUser 150)) }
  if ($lastAsst)  { Write-Output ("    says:  " + (Flatten $lastAsst 220)) }
  Write-Output ""
}
