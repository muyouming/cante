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

# --- 把 wsl.exe 的输出按正确编码读回来 ---------------------------------------
#
# 为什么不能直接 `& wsl.exe ... | Out-String`：wsl.exe 自己打的字（比如"未安装
# Linux 的 Windows 子系统…"那屏安装提示）是 **UTF-16LE** 字节，而 PowerShell 5.1
# 按控制台代码页（这台机器上是 GBK）去解，就成了一串乱码，还会混进 NUL。子进程
# （WSL 里 bash 那些东西）的输出倒是 UTF-8 —— 所以不能一律当 UTF-16 解。
# 2026-09-20 起的每份报告里那段"原始输出"就是这么变垃圾的（r18 修的）。
#
# 可靠做法：让 Start-Process 把 stdout/stderr **原样**重定向到文件（PowerShell 不经手
# 解码），再按实际字节认编码：有 UTF-16 BOM、或字节里含 NUL → UTF-16LE；否则 UTF-8。
# WSL 彻底没了时失败路径也可能给个空文件，ReadAllBytes 返回空数组，这里照样不炸。
function Read-WslStreamFile([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return '' }
    $bytes = [System.IO.File]::ReadAllBytes($Path)
    if ($bytes.Length -eq 0) { return '' }
    if ($bytes.Length -ge 2 -and $bytes[0] -eq 0xFF -and $bytes[1] -eq 0xFE) {
        return [System.Text.Encoding]::Unicode.GetString($bytes, 2, $bytes.Length - 2)
    }
    if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
        return [System.Text.Encoding]::UTF8.GetString($bytes, 3, $bytes.Length - 3)
    }
    foreach ($b in $bytes) {
        if ($b -eq 0) { return [System.Text.Encoding]::Unicode.GetString($bytes) }
    }
    return [System.Text.Encoding]::UTF8.GetString($bytes)
}

# 跑一次 wsl.exe，把 stdout/stderr 读回来（可选经 stdin 喂脚本）。
# 参数只传简单 token（例如 -e bash -s、-l -v），不要塞带空格/换行的长命令 ——
# Start-Process 不会替我们做参数引号转义。
function Invoke-WslCapture {
    param(
        [Parameter(Mandatory = $true)][string]$WslPath,
        [Parameter(Mandatory = $true)][string[]]$WslArguments,
        [string]$StandardInput
    )
    $outFile = [System.IO.Path]::GetTempFileName()
    $errFile = [System.IO.Path]::GetTempFileName()
    $inFile = ''
    $saved = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $startArgs = @{
            FilePath               = $WslPath
            ArgumentList           = $WslArguments
            RedirectStandardOutput = $outFile
            RedirectStandardError  = $errFile
            NoNewWindow            = $true
            Wait                   = $true
            PassThru               = $true
        }
        if ($PSBoundParameters.ContainsKey('StandardInput')) {
            $inFile = [System.IO.Path]::GetTempFileName()
            [System.IO.File]::WriteAllText($inFile, [string]$StandardInput, (New-Object System.Text.UTF8Encoding($false)))
            $startArgs['RedirectStandardInput'] = $inFile
        }
        $proc = Start-Process @startArgs
        $code = -1
        if ($null -ne $proc) { $code = $proc.ExitCode }
        $text = (Read-WslStreamFile $outFile) + (Read-WslStreamFile $errFile)
        return [pscustomobject]@{ ExitCode = $code; Text = $text.Trim() }
    } catch {
        return [pscustomobject]@{ ExitCode = -1; Text = "$($_.Exception.Message)" }
    } finally {
        $ErrorActionPreference = $saved
        foreach ($f in @($outFile, $errFile, $inFile)) {
            if ($f -and (Test-Path -LiteralPath $f)) {
                Remove-Item -LiteralPath $f -Force -ErrorAction SilentlyContinue
            }
        }
    }
}

# --- -1) WSL 到底能不能用（不能用就当面说清，别留个空报告）------------------
#
# 为什么要有这一步（2026-09-20 实测的教训）：这台机器上的 WSL 一度被禁用
# （Microsoft-Windows-Subsystem-Linux 与 VirtualMachinePlatform 都是 Disabled，
#  HKCU 下没有 Lxss 键，两个发行版目录都空）。此时 `wsl.exe` 自己只会打一屏安装提示，
# 而普查跑到最后留下一个 **5 字节**的报告 + 退出码 1 —— 从报告上**看不出**是
# "WSL 没了"，下一个人只会以为"普查跑了、什么都没查出来"。
# 所以先问一句：能不能真的在 WSL 里跑一条命令。不能就写清原因再退出。
# 注意：不能直接 `& wsl.exe ... 2>&1 | Out-String` —— 那样会把 wsl.exe 的
# UTF-16LE 输出按 GBK 解成乱码（见上面 Read-WslStreamFile 的注释）。走 Invoke-WslCapture。
$wslProbe = $null
try {
    $wslProbe = (Invoke-WslCapture -WslPath 'wsl.exe' -WslArguments @('-e', 'echo', 'cante-wsl-ok')).Text
} catch {
    $wslProbe = "$_"
}
if ($wslProbe -notmatch 'cante-wsl-ok') {
    $why = @(
        "# 每周普查没跑成：这台机器上的 WSL 现在用不了",
        "",
        "普查要驱动真守护进程，而守护进程只有 Linux/macOS 构建，所以它只能跑在 WSL 里。",
        "这一次连 WSL 都没起来，**不是产品的结论，也不是某张卡的结果** —— 是环境缺了东西。",
        "",
        "## 你能怎么做",
        "",
        "1. 以管理员身份开一个 PowerShell，跑 `wsl --install`（或先 `wsl --list --verbose` 看现状）；",
        "2. 装完**重启**这台机器；",
        "3. 按 `gui/scripts/windows/wsl-ante-setup.ps1` 把守护进程装回 WSL 里；",
        "4. 再手动跑一次 `gui\\scripts\\windows\\weekly-sweep.ps1` 确认能出报告。",
        "",
        "## 这次探到的实情（原始输出，供技术同事定位）",
        "",
        '```',
        ($wslProbe -replace "`r?`n", "`n").Trim(),
        '```'
    ) -join "`n"
    New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
    $stamp0 = Get-Date -Format 'yyyyMMdd'
    $rp0 = Join-Path $OutDir "report-$stamp0.md"
    Set-Content -LiteralPath $rp0 -Value $why -Encoding UTF8
    Write-Line "==> WSL 不可用，已把原因写进报告：$rp0"
    Write-Line "==> 这不是产品结论 —— 是环境缺了 WSL。"
    exit 3
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
#
# 为什么这一段不走上面的 Invoke-WslCapture（UTF-16 自动识别）：这里拿的是 WSL 里
# bash/普查**子进程**的 UTF-8 输出，而 $wslArgs 里有 `-e bash -lc <多行脚本>` 这种
# 带空格换行的参数 —— Start-Process 的 -ArgumentList 不会替我们做引号转义，硬换会把
# 命令拆坏。能走到这里说明上面的探针已确认 WSL 可用；wsl.exe 自己那屏 UTF-16 提示
# 走的是探针那条路（已按字节解码）。已知限制：若 -d 指了不存在的发行版，wsl.exe
# 自己的报错仍可能花屏 —— 留待有 WSL 的机器上再收口。
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
