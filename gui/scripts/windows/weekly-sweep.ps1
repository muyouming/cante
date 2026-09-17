#Requires -Version 5.1
<#
weekly-sweep.ps1 —— 每周一次的真机任务普查（Windows 计划任务的入口）。

它把 gui/scripts/sweep/ 那套普查跑起来，产出一份 Markdown 报告，并按次数保留最近几份。

为什么不是"直接跑 task-sweep.ps1"：这台机器上普查只能**跑在 WSL 里**。
上游的守护进程（ante / cante）只有 Linux 与 macOS 构建，Windows 上没有原生的，
而普查要驱动真守护进程把每张卡跑完。所以：

  1. 守护进程来自 WSL 里的 ~/cante-bin/ante（见 gui/scripts/windows/wsl-ante-setup.ps1）；
  2. 普查脚本（Python）和它要的 bun 也都在 WSL 里跑，这样它生成的路径全是 Linux 路径，
     守护进程才读得到；
  3. "读回产出"用的两个核验工具是 Windows 的 .exe —— WSL 能执行它们（互操作），
     但参数里的路径要先翻成 Windows 路径。所以这里现场生成两个十行的垫片脚本，
     通过 CANTE_SHEETS_BIN / CANTE_PDF_BIN 交给普查。
     （不这么做的话，普查要么挑到 Windows 构建留下的 0 字节占位符、直接 Exec format error，
      要么退回它内置的读取方式，报告里就不再是"产品自己的工具读回来的"了。）

密钥不进仓库、不进命令行：网关地址与密钥是在**运行时**从 pi 的 models.json 里读的，
只放进程环境变量，再用 WSLENV 渡过 WSL 边界（本脚本从不打印它们的值）。

用法（手工跑）：
    powershell -ExecutionPolicy Bypass -File gui\scripts\windows\weekly-sweep.ps1
    powershell -ExecutionPolicy Bypass -File gui\scripts\windows\weekly-sweep.ps1 -Cards excel.diff
    powershell -ExecutionPolicy Bypass -File gui\scripts\windows\weekly-sweep.ps1 -Quiet

退出码：普查的退出码（0 = 没有失败的卡，1 = 有卡失败，2 = 参数或环境问题）原样透传。

本文件存为 UTF-8 **带 BOM**：Windows PowerShell 5.1 读无 BOM 的 UTF-8 会按 ANSI 代码页
解释，中文注释与提示会乱码。
#>
[CmdletBinding()]
param(
    [string]$RepoRoot = 'C:\cante',
    [string]$OutDir = 'C:\cante-sweep',
    [string]$Distro = '',
    [string]$ModelsJson = "$env:USERPROFILE\.pi\agent\models.json",
    [string]$Provider = '9router',
    [string[]]$Cards = @(),
    [int]$TimeoutSeconds = 0,
    [int]$StallTimeoutSeconds = 0,
    [int]$Keep = 8,
    [switch]$Quiet
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }

function Write-Line([string]$Text) {
    if (-not $Quiet) { Write-Host $Text }
}

# --- 一条 Linux 路径 → WSL 里能用的路径 -------------------------------------
function To-WslPath([string]$WindowsPath) {
    $full = [System.IO.Path]::GetFullPath($WindowsPath)
    $drive = $full.Substring(0, 1).ToLowerInvariant()
    $rest = $full.Substring(2).Replace('\', '/')
    return "/mnt/$drive$rest"
}

# --- 0) 目录 ----------------------------------------------------------------
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$logDir = Join-Path $OutDir 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$binDir = Join-Path $OutDir 'bin'
New-Item -ItemType Directory -Force -Path $binDir | Out-Null

$stamp = Get-Date -Format 'yyyyMMdd'
$reportPath = Join-Path $OutDir "report-$stamp.md"
$logPath = Join-Path $logDir "sweep-$stamp.log"
$started = Get-Date

Write-Line "==> 每周普查开始：$($started.ToString('s'))"

# --- 1) 报告写不进去就别装模作样 --------------------------------------------
try {
    Set-Content -LiteralPath $reportPath -Value '' -Encoding UTF8
} catch {
    Write-Host "weekly-sweep: 报告写不进去（$reportPath）：$($_.Exception.Message)" -ForegroundColor Red
    exit 2
}

# --- 2) 网关地址与密钥：运行时从 pi 的 models.json 读，不落盘 -----------------
$baseUrl = ''
$apiKey = ''
if (Test-Path -LiteralPath $ModelsJson) {
    try {
        $config = Get-Content -LiteralPath $ModelsJson -Raw -Encoding UTF8 | ConvertFrom-Json
        $entry = $config.providers.$Provider
        if ($entry) {
            $baseUrl = [string]$entry.baseUrl
            $apiKey = [string]$entry.apiKey
        }
    } catch {
        Write-Host "weekly-sweep: 读 $ModelsJson 失败：$($_.Exception.Message)" -ForegroundColor Yellow
    }
}
if ([string]::IsNullOrWhiteSpace($baseUrl) -or [string]::IsNullOrWhiteSpace($apiKey)) {
    $reason = "没找到模型端点。普查需要 OPENAI_COMPATIBLE_BASE_URL / OPENAI_COMPATIBLE_API_KEY，" +
              "本机是从 $ModelsJson 的服务方 `"$Provider`" 里读的。把那个服务方补上（或改 -Provider），再跑一次。"
    @(
        '# 真机任务普查报告（本次没真跑）',
        '',
        "生成时间：$($started.ToString('yyyy-MM-dd HH:mm'))",
        '',
        $reason,
        '',
        '**这份报告不代表任何卡通过，也不代表失败** —— 它是"没有真跑"的记录。'
    ) | Set-Content -LiteralPath $reportPath -Encoding UTF8
    Write-Host "weekly-sweep: $reason" -ForegroundColor Red
    exit 2
}
Write-Line "==> 模型端点已就绪（值不打印；服务方：$Provider）"

# --- 3) 现场生成两个垫片（LF 行尾、无 BOM，WSL 里才跑得起来）----------------
$shimLines = @(
    '#!/usr/bin/env bash',
    '# 由 gui/scripts/windows/weekly-sweep.ps1 生成：把 Linux 路径翻成 Windows 路径，',
    '# 再交给 Windows 版的产品工具（核验产出用）。改这个垫片请改生成它的脚本。',
    'set -euo pipefail',
    'name="$(basename "$0")"',
    'exe="/mnt/c/cante/gui/src-tauri/target/release/${name}.exe"',
    'if [ ! -x "$exe" ]; then',
    '  echo "$name: 找不到 Windows 版工具：$exe" >&2',
    '  exit 127',
    'fi',
    'args=()',
    'for a in "$@"; do',
    '  case "$a" in',
    '    /*) args+=("$(wslpath -w "$a")") ;;',
    '    *) args+=("$a") ;;',
    '  esac',
    'done',
    'exec "$exe" "${args[@]}"'
)
$shimText = ($shimLines -join "`n") + "`n"
foreach ($tool in @('cante-sheets', 'cante-pdf')) {
    $p = Join-Path $binDir $tool
    [System.IO.File]::WriteAllText($p, $shimText, (New-Object System.Text.UTF8Encoding($false)))
}

# --- 4) 组装 WSL 里要跑的那条命令 -------------------------------------------
$repoWsl = To-WslPath $RepoRoot
$outWsl = To-WslPath $OutDir
$reportWsl = To-WslPath $reportPath
$workWsl = "$outWsl/wsl-work"

# 两个旋钮只在显式给了非 0 值时才传，否则交出 sweep.py 的默认（1800 / 300 秒）。
$sweepArgs = @('bash', 'gui/scripts/task-sweep.sh', '--work', "'$workWsl'", '--report', "'$reportWsl'")
if ($TimeoutSeconds -gt 0) { $sweepArgs += @('--timeout', "$TimeoutSeconds") }
if ($StallTimeoutSeconds -gt 0) { $sweepArgs += @('--stall-timeout', "$StallTimeoutSeconds") }
if ($Cards.Count -gt 0) { $sweepArgs += $Cards }

$inner = @(
    'export PATH=$HOME/.bun/bin:$HOME/.local/bin:$PATH',
    'export CANTE_BIN=$HOME/cante-bin/ante',
    "export CANTE_SHEETS_BIN=$outWsl/bin/cante-sheets",
    "export CANTE_PDF_BIN=$outWsl/bin/cante-pdf",
    "mkdir -p '$workWsl'",
    "cd '$repoWsl'",
    ($sweepArgs -join ' ')
) -join "`n"

$wslArgs = @()
if ($Distro -ne '') { $wslArgs += @('-d', $Distro) }
$wslArgs += @('-e', 'bash', '-lc', $inner)
$sweepCode = 1

$wslOutput = @()

# 环境变量渡到 WSL：WSLENV 里不做路径转换（这两个值不是路径）。
$env:OPENAI_COMPATIBLE_BASE_URL = $baseUrl
$env:OPENAI_COMPATIBLE_API_KEY = $apiKey
$env:WSLENV = 'OPENAI_COMPATIBLE_BASE_URL:OPENAI_COMPATIBLE_API_KEY'

# --- 5) 跑 ----------------------------------------------------------------
Write-Line "==> 在 WSL 里跑普查（报告：$reportPath）"
$header = @(
    "== weekly-sweep $($started.ToString('s')) ==",
    "repo   : $RepoRoot",
    "out    : $OutDir",
    "distro : $(if ($Distro -ne '') { $Distro } else { '<WSL 默认>' })",
    "cards  : $(if ($Cards.Count -gt 0) { $Cards -join ' ' } else { '<全部>' })",
    ''
) -join "`n"
Set-Content -LiteralPath $logPath -Value $header -Encoding UTF8

# 注意：PowerShell 5.1 下，原生命令往 stderr 写东西 + $ErrorActionPreference='Stop'
# 会变成终止性错误（NativeCommandError），脚本会当场死掉 —— 而 wsl.exe 那边的子进程会
# 继续跑完，于是看起来像"任务跑了但什么都没写"。任务第一次跑就栽在这里（报告出来了，
# 但这行后面的日志/历史都没写），所以采集这一段必须活在 Stop 之外。
$sweepCode = 1
$previous = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
try {
    $wslOutput = & wsl.exe @wslArgs 2>&1 | ForEach-Object { "$_" }
    $raw = Get-Variable -Name LASTEXITCODE -ValueOnly -ErrorAction SilentlyContinue
    if ($null -ne $raw) { $sweepCode = $raw }
} finally {
    $ErrorActionPreference = $previous
}
$wslOutput | Add-Content -LiteralPath $logPath -Encoding UTF8
$wslOutput | ForEach-Object { Write-Line $_ }

$finished = Get-Date
$summary = "结束：$($finished.ToString('s'))；退出码 $sweepCode；报告 $reportPath"
Add-Content -LiteralPath $logPath -Value $summary -Encoding UTF8
Write-Line "==> $summary"

# --- 6) 保留最近几份 -------------------------------------------------------
$reports = Get-ChildItem -LiteralPath $OutDir -Filter 'report-*.md' -File | Sort-Object Name -Descending
$reports | Select-Object -Skip $Keep | ForEach-Object {
    Write-Line "==> 删掉旧报告：$($_.Name)"
    Remove-Item -LiteralPath $_.FullName -Force
}
$logs = Get-ChildItem -LiteralPath $logDir -Filter 'sweep-*.log' -File | Sort-Object Name -Descending
$logs | Select-Object -Skip $Keep | ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force }

# 滚动的一行历史，方便一眼看"这几个月都在什么状态"
$historyPath = Join-Path $OutDir 'history.log'
Add-Content -LiteralPath $historyPath -Encoding UTF8 -Value (
    "$($started.ToString('s'))  退出码=$sweepCode  $(if (Test-Path -LiteralPath $reportPath) { '{0:N0} 字节' -f (Get-Item -LiteralPath $reportPath).Length } else { '没有报告' })  $reportPath"
)

exit $sweepCode
