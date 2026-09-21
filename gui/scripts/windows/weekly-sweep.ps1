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
# 做法：拿到**原始字节**（探针从进程的 BaseStream 拿，读文件用 ReadAllBytes），
# 再按实际字节认编码：有 UTF-16 BOM、或字节里含 NUL → UTF-16LE；否则 UTF-8。
# WSL 彻底没了时失败路径也可能给个空数组，这里照样不炸。
function Read-WslBytes([byte[]]$Bytes) {
    if ($null -eq $Bytes -or $Bytes.Length -eq 0) { return '' }
    if ($Bytes.Length -ge 2 -and $Bytes[0] -eq 0xFF -and $Bytes[1] -eq 0xFE) {
        return [System.Text.Encoding]::Unicode.GetString($Bytes, 2, $Bytes.Length - 2)
    }
    if ($Bytes.Length -ge 3 -and $Bytes[0] -eq 0xEF -and $Bytes[1] -eq 0xBB -and $Bytes[2] -eq 0xBF) {
        return [System.Text.Encoding]::UTF8.GetString($Bytes, 3, $Bytes.Length - 3)
    }
    foreach ($b in $Bytes) {
        if ($b -eq 0) { return [System.Text.Encoding]::Unicode.GetString($Bytes) }
    }
    return [System.Text.Encoding]::UTF8.GetString($Bytes)
}

function Read-WslStreamFile([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return '' }
    return Read-WslBytes ([System.IO.File]::ReadAllBytes($Path))
}

# 跑一次 wsl.exe，把 stdout/stderr 读回来（经 stdin 喂脚本）。
# 参数只传简单 token（例如 -e bash -s、-l -v），不把带空格/换行的长命令塞进参数里
# （那是以前的老路，PS 5.1 的引号转义会把它拆坏）——脚本一律走 stdin。
# 每条外部命令都带超时上限（AGENTS.md §5）。到点没退的进程杀掉，并在结果里标
# TimedOut —— 这样报告里能写"超时：N 秒没跑完"，而不是把"没等到结果"写成"确认没有"。
function Invoke-WslCapture {
    param(
        [Parameter(Mandatory = $true)][string]$WslPath,
        [Parameter(Mandatory = $true)][string[]]$WslArguments,
        [string]$StandardInput,
        [int]$TimeoutSeconds = 120
    )
    $proc = $null
    $outMs = New-Object System.IO.MemoryStream
    $errMs = New-Object System.IO.MemoryStream
    try {
        # 为什么不用 Start-Process：PS 5.1 下 `Start-Process -PassThru`（不加 -Wait）
        # 返回的进程对象的 ExitCode 拿不到（真机实测：`$p.ExitCode` 是空的，
        # `[int]$p.ExitCode` 是 0；加了 -Wait 才对，但加了就没法设超时）。
        # 直接用 .NET 的 Process：ExitCode 可靠，又能从 BaseStream 拿原始字节，
        # 保住 #300 那条"按字节认 UTF-16LE / UTF-8"的做法。
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = $WslPath
        $psi.UseShellExecute = $false
        $psi.CreateNoWindow = $true
        $psi.RedirectStandardOutput = $true
        $psi.RedirectStandardError = $true
        $psi.RedirectStandardInput = $true
        # 参数只传简单 token（-d / -e / bash / -s / -l / -v），带空格的加引号。
        $psi.Arguments = (($WslArguments | ForEach-Object {
            if ($_ -match '[\s"]') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ }
        }) -join ' ')
        $proc = New-Object System.Diagnostics.Process
        $proc.StartInfo = $psi
        $null = $proc.Start()
        # 异步读完 stdout/stderr（不读的话，输出超过管道缓冲区会把子进程堵死）。
        $outTask = $proc.StandardOutput.BaseStream.CopyToAsync($outMs)
        $errTask = $proc.StandardError.BaseStream.CopyToAsync($errMs)
        # 把脚本以 UTF-8 字节直接写进 stdin。不用 StandardInput.Write：PS 5.1 跑在
        # .NET Framework 上，ProcessStartInfo 没有 StandardInputEncoding 这个属性
        # （真机实测：设了会报 'cannot be found on this object'），而 Write 会按
        # 控制台编码走。写 BaseStream 就没有这个问题。
        $inBytes = (New-Object System.Text.UTF8Encoding($false)).GetBytes([string]$StandardInput)
        if ($inBytes.Length -gt 0) { $proc.StandardInput.BaseStream.Write($inBytes, 0, $inBytes.Length) }
        $proc.StandardInput.BaseStream.Flush()
        $proc.StandardInput.Close()
        $timedOut = -not $proc.WaitForExit([int]($TimeoutSeconds * 1000))
        if ($timedOut) {
            try { $proc.Kill() } catch { }
            try { $null = $proc.WaitForExit(5000) } catch { }
        }
        try { $null = $outTask.Wait(10000) } catch { }
        try { $null = $errTask.Wait(10000) } catch { }
        $code = -1
        if ($proc.HasExited) { try { $code = $proc.ExitCode } catch { $code = -1 } }
        $text = ((Read-WslBytes $outMs.ToArray()) + (Read-WslBytes $errMs.ToArray())).Trim()
        return [pscustomobject]@{ ExitCode = $code; Text = $text; TimedOut = $timedOut }
    } catch {
        return [pscustomobject]@{ ExitCode = -1; Text = "$($_.Exception.Message)"; TimedOut = $false }
    } finally {
        foreach ($stream in @($outMs, $errMs)) { if ($null -ne $stream) { try { $stream.Dispose() } catch { } } }
        if ($null -ne $proc) { try { $proc.Dispose() } catch { } }
    }
}

# --- 写一份"看得懂"的失败报告 -------------------------------------------------
#
# 产品律 3：出错能看懂并有出路。**这份周报就是我们自己的出口**：报告只留 BOM 和
# 换行（5 字节）时，两周后没人点进来看的人根本不知道那天发生了什么。9/20 那次
# 靠乱码猜、9/21 那次直接空了 —— 同一个错犯两次。所以：
#
#   1. 任何失败路径都要写清三件事：发生了什么 / 你能怎么做 / 复制这段给技术同事；
#   2. "你能怎么做"按真因给（没 WSL / 没 bun / 没守护进程 / task-sweep 自己退），
#      四类的编号步骤不一样；
#   3. 原始输出一律走 Read-WslStreamFile 那条按字节认编码的路，保证是可读中文，
#      而不是把 wsl.exe 的 UTF-16LE 当 GBK 解出来的乱码（#300 修的就是这个）。
#
# 固定写 UTF-8 带 BOM（与 Set-Content -Encoding UTF8 一致），PS 5.1 读回来不乱。
function Write-FailureReport {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Headline,
        [Parameter(Mandatory = $true)][string]$What,
        [Parameter(Mandatory = $true)][string[]]$Steps,
        [string]$RawOutput = '',
        [string]$RawLabel = '复制这段给技术同事（这次真正发出去的输出，原样）'
    )
    $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm'
    $raw = if ([string]::IsNullOrWhiteSpace($RawOutput)) { '（没有任何输出）' } else { ($RawOutput -replace "`r`n", "`n").Trim() }
    if ([string]::IsNullOrWhiteSpace($raw)) { $raw = '（没有任何输出）' }
    # 原始输出可能很长（task-sweep 跑全量时是几十 KB）。报告是给人看的：留头 15 行
    # + 尾 45 行，中间标清省略多少行，完整输出在本次的日志文件里（路径在「发生了什么」/步骤里）。
    $rawLines = $raw -split "`n"
    if ($rawLines.Count -gt 60) {
        $skipped = $rawLines.Count - 60
        $raw = (($rawLines | Select-Object -First 15) -join "`n") +
               "`n`n…（中间省略 $skipped 行；完整输出在本次的日志文件里）…`n`n" +
               (($rawLines | Select-Object -Last 45) -join "`n")
    }
    $out = New-Object System.Collections.Generic.List[string]
    $out.Add("# 每周普查没跑成：$Headline")
    $out.Add('')
    $out.Add("生成时间：$stamp")
    $out.Add('')
    $out.Add('## 发生了什么')
    $out.Add('')
    $out.Add($What)
    $out.Add('')
    $out.Add('**这一份不是产品的结论，也不是某张卡跑输了的证据** —— 普查根本没跑起来（或在第一步就停了）。')
    $out.Add('')
    $out.Add('## 你能怎么做')
    $out.Add('')
    $n = 1
    foreach ($step in $Steps) { $out.Add("$n. $step"); $n++ }
    $out.Add('')
    $out.Add("## $RawLabel")
    $out.Add('')
    $out.Add('```')
    $out.Add($raw)
    $out.Add('```')
    [System.IO.File]::WriteAllText($Path, (($out -join "`n") + "`n"), (New-Object System.Text.UTF8Encoding($true)))
}

# 报告正文是不是空的（只有 BOM / 空白的算空；sweep.py 真写出来的报告永远不空）。
# "报告永远非空"这条判据就靠它：写完再判一次，空的话把失败节写进去。
function Get-ReportBody([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return '' }
    $bytes = [System.IO.File]::ReadAllBytes($Path)
    if ($bytes.Length -eq 0) { return '' }
    $text = [System.Text.Encoding]::UTF8.GetString($bytes)
    $trimChars = [char[]]@([char]0xFEFF, ' ', "`t", "`r", "`n")
    return $text.Trim($trimChars)
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
# 探针一律走 `-e bash -s`：脚本从 stdin 喂进去。为什么不用 `-e bash -lc '<多行>'`：
# Start-Process 的 -ArgumentList 不会替我们做引号转义，带空格 / 换行的参数会被悄悄
# 拆坏（真机实测：一条 `if ... fi` 被拆成语法错）。给了 -Distro 就指到那个发行版。
$probeArgs = @()
if ($Distro -ne '') { $probeArgs += @('-d', $Distro) }
$probeArgs += @('-e', 'bash', '-s')
# 探针超时：WSL 第一次启动可能慢，给的比普通命令宽一点。
$probeTimeout = 120

$wslProbe = Invoke-WslCapture -WslPath 'wsl.exe' -WslArguments $probeArgs `
    -StandardInput 'echo cante-wsl-ok' -TimeoutSeconds $probeTimeout
$wslList = Invoke-WslCapture -WslPath 'wsl.exe' -WslArguments @('-l', '-v') -TimeoutSeconds $probeTimeout
$wslOk = (-not $wslProbe.TimedOut) -and ($wslProbe.Text -match 'cante-wsl-ok')
if (-not $wslOk) {
    $rawA = @()
    if ($wslProbe.TimedOut) {
        $rawA += "WSL 探针：超时 —— $probeTimeout 秒没跑完。（这是『没等到结果』，不等于 WSL 真的不在。）"
    } else {
        $rawA += "WSL 探针（退出码 $($wslProbe.ExitCode)）："
        $rawA += $wslProbe.Text
    }
    $rawA += ''
    $rawA += "wsl -l -v（退出码 $($wslList.ExitCode)$(if ($wslList.TimedOut) { '；超时' })）："
    $rawA += $wslList.Text
    New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
    $stamp0 = Get-Date -Format 'yyyyMMdd'
    $rp0 = Join-Path $OutDir "report-$stamp0.md"
    Write-FailureReport -Path $rp0 -Headline '这台机器上的 WSL 现在用不了' -What ((@(
        '普查要驱动真守护进程，而守护进程只有 Linux/macOS 构建，所以它只能跑在 WSL 里。',
        '这一次连 WSL 都没起来 —— 是环境缺了东西，不是某张卡的结果。'
    ) + @(if ($Distro -ne '') { "（本次明确指定了发行版 `"$Distro`"；名字拼错也会走到这里，`wsl -l -v` 的输出见下。）" })) -join "`n") -Steps (@(
        '以管理员身份开一个 PowerShell，跑 `wsl --install`（或先 `wsl --list --verbose` 看现状）；',
        '装完**重启**这台机器；',
        '按 `gui/scripts/windows/wsl-ante-setup.ps1` 把守护进程装回 WSL 里；',
        '再手动跑一次 `gui\scripts\windows\weekly-sweep.ps1` 确认能出报告。'
    ) + @(if ($Distro -ne '') { '如果这一步是因为 -Distro 写了不存在的名字：用 `wsl -l -v` 里真正的名字重跑，或者干脆去掉 -Distro 用默认发行版。' })) -RawOutput ($rawA -join "`n")
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
    Write-FailureReport -Path $reportPath -Headline '没找到模型端点，普查没有真跑' -What $reason -Steps @(
        "打开 `$ModelsJson`，确认里面有一个名叫 `$Provider` 的服务方，并且有 baseUrl 与 apiKey；",
        '或者跑 weekly-sweep 时用 `-Provider <那个服务方>` 指定别的服务方；',
        '改好后再跑一次 `gui\scripts\windows\weekly-sweep.ps1`。'
    ) -RawOutput (@(
        "用来读端点的文件：$ModelsJson",
        "服务方：$Provider",
        "（这两个值不是密钥；baseUrl / apiKey 本身从不写进报告、不进日志、不进命令行。）"
    ) -join "`n")
    Write-Host "weekly-sweep: $reason" -ForegroundColor Red
    exit 2
}
Write-Line "==> 模型端点已就绪（值不打印；服务方：$Provider）"

# --- 2.5) WSL 里到底缺不缺东西（缺了就当面说清，别让 task-sweep 白退一次）----
#
# 为什么先探（2026-09-21 的教训）：那次 WSL 是好的，但里面**没有 bun**，
# task-sweep 第一步就退（退出码 2），报告本体只留下 5 个字节（BOM + 换行）。
# 从报告上看不出是"缺 bun"，下一个人只会以为"普查跑了、什么都没查出来"。
#
# 两条都走 Invoke-WslCapture（按实际字节认 UTF-16LE / UTF-8，见 #300），且在
# **交互会话**里跑：WSL 发行版是按 Windows 用户注册的，SYSTEM 会拿到
# WSL_E_LOCAL_SYSTEM_NOT_SUPPORTED。探针只报"有 / 没有"和 bun 版本号，不打印
# 任何密钥（密钥在这个脚本里只进进程环境变量）。
$bunProbe = Invoke-WslCapture -WslPath 'wsl.exe' -WslArguments $probeArgs -TimeoutSeconds $probeTimeout -StandardInput (@(
    'export PATH=$HOME/.bun/bin:$HOME/.local/bin:$PATH',
    '# 不只看 command -v： dangling 的软链也能被 command -v 找到，但跑不起来。',
    'if command -v bun >/dev/null 2>&1 && bun --version >/dev/null 2>&1; then',
    '  echo CANTE_BUN_OK',
    '  bun --version 2>&1 | head -n 1',
    'else',
    '  echo CANTE_BUN_MISSING',
    'fi'
) -join "`n")
$anteProbe = Invoke-WslCapture -WslPath 'wsl.exe' -WslArguments $probeArgs -TimeoutSeconds $probeTimeout -StandardInput (@(
    'if [ -x "$HOME/cante-bin/ante" ]; then',
    '  echo CANTE_ANTE_OK',
    'else',
    '  echo CANTE_ANTE_MISSING',
    'fi'
) -join "`n")
$bunOk = (-not $bunProbe.TimedOut) -and ($bunProbe.Text -match 'CANTE_BUN_OK')
$anteOk = (-not $anteProbe.TimedOut) -and ($anteProbe.Text -match 'CANTE_ANTE_OK')
$prereqEvidence = @(
    "bun 探针（退出码 $($bunProbe.ExitCode)$(if ($bunProbe.TimedOut) { "；超时 —— $probeTimeout 秒没跑完，不等于没有" })）：",
    $bunProbe.Text,
    '',
    "ante 探针（退出码 $($anteProbe.ExitCode)$(if ($anteProbe.TimedOut) { "；超时 —— $probeTimeout 秒没跑完，不等于没有" })）：",
    $anteProbe.Text
) -join "`n"
if (-not $bunOk) { Write-Line '==> WSL 探针：没看到 bun' }
if (-not $anteOk) { Write-Line '==> WSL 探针：没看到 cante-bin/ante' }

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

# --- 5.5) 失败也要留一份看得懂的报告 ----------------------------------------
#
# 走到这里可能四种情况：有东西没装（bun / 守护进程）、探针超时、task-sweep 自己退
# 了、或者正常出了报告。前三种都要把真因写进报告，不能只留一个空文件。分类依据
# 是各步自己的探针 / 退出码，不是"猜"。
#
# 四类分得清（各自的"你能怎么做"不一样）：
#   1. WSL 起不来        —— 最上面那条探针（Invoke-WslCapture，退出码 / 超时）
#   2. WSL 里缺 bun      —— command -v bun
#   3. WSL 里缺守护进程  —— test -x $HOME/cante-bin/ante（这个脚本用的就是这条路径）
#   4. task-sweep 自己退 —— 前三样都在，退出码非 0 且没写出报告
$sweepRaw = ($wslOutput -join "`n")
if ([string]::IsNullOrWhiteSpace($sweepRaw)) {
    $rawWithSweep = $prereqEvidence
} else {
    $rawWithSweep = $prereqEvidence + "`n`n--- task-sweep 这次的输出 ---`n" + $sweepRaw
}

if ($bunProbe.TimedOut) {
    Write-FailureReport -Path $reportPath -Headline '探测 WSL 里的 bun 超时（没等到结果）' -What (@(
        "探测 bun 的那条命令 $probeTimeout 秒没返回，已经把它停掉。",
        '**这是『没等到结果』，不等于 WSL 里没有 bun** —— 两回事要分开写（AGENTS.md §5）。这也**不是产品的结论**。'
    ) -join "`n") -Steps @(
        '先手动跑一次 `wsl.exe -e echo hello` 看看 WSL 是不是只是启动慢（第一次启动可能要等一会儿）；',
        '能跑起来后，再跑一次 `gui\scripts\windows\weekly-sweep.ps1`；',
        '如果每次都超时，在管理员 PowerShell 里跑一次 `wsl --update` 再看。'
    ) -RawOutput $rawWithSweep
    $sweepCode = 2
} elseif (-not $bunOk) {
    Write-FailureReport -Path $reportPath -Headline 'WSL 里没有 bun' -What (@(
        "WSL 起来了，但里面没有 bun。普查第一步就要用它（调产品自己的提示词函数），所以 task-sweep 当场就退了（本次退出码 $sweepCode）。",
        '**这既不是产品的结论，也不是某张卡的结果。** 报告本体因此本来是空的，现在把真因写在这里。'
    ) -join "`n") -Steps @(
        '在 WSL 里装 bun。注意：WSL 里通常没有 unzip，官方那条 `curl bun.sh/install | bash` 会报 `unzip is required`；照 `gui/WINDOWS-ACCEPTANCE-4.md` 的办法，下 `bun-linux-x64.zip` 再用 `python3` 解压到 `$HOME/.bun/bin/bun`。',
        '确认装好了：`wsl.exe -e bash -lc ''export PATH=$HOME/.bun/bin:$PATH; bun --version''` 能打印版本号。',
        '再手动跑一次 `gui\scripts\windows\weekly-sweep.ps1`，这次应该能出真正的报告。'
    ) -RawOutput $rawWithSweep
    $sweepCode = 2
} elseif ($anteProbe.TimedOut) {
    Write-FailureReport -Path $reportPath -Headline '探测 WSL 里的守护进程超时（没等到结果）' -What (@(
        "探测 `$HOME/cante-bin/ante` 的那条命令 $probeTimeout 秒没返回，已经把它停掉。",
        '**这是『没等到结果』，不等于守护进程不在** —— 两回事要分开写（AGENTS.md §5）。这也**不是产品的结论**。'
    ) -join "`n") -Steps @(
        '先手动跑一次 `wsl.exe -e ls -l ~/cante-bin` 看看 WSL 是不是只是启动慢；',
        '能跑起来后，再跑一次 `gui\scripts\windows\weekly-sweep.ps1`。'
    ) -RawOutput $rawWithSweep
    $sweepCode = 2
} elseif (-not $anteOk) {
    Write-FailureReport -Path $reportPath -Headline 'WSL 里没有守护进程（ante）' -What (@(
        "WSL 和 bun 都在，但 `$HOME/cante-bin/ante` 不在（或者不是可执行文件）。",
        "普查要驱动真守护进程，没有它一张卡也跑不了（本次 task-sweep 退出码 $sweepCode）。"
    ) -join "`n") -Steps @(
        '在 Windows 上跑 `gui\scripts\windows\wsl-ante-setup.ps1`，把守护进程装回 WSL 的 `$HOME/cante-bin`；',
        '确认装好了：`wsl.exe -e ~/cante-bin/ante --version` 能打印版本号；',
        '再手动跑一次 `gui\scripts\windows\weekly-sweep.ps1`。'
    ) -RawOutput $rawWithSweep
    $sweepCode = 2
} elseif ([string]::IsNullOrWhiteSpace((Get-ReportBody $reportPath))) {
    # 前三样都在，task-sweep 却退了非 0、而且没写出报告 —— 第四类。
    $headlineD = if ($sweepCode -eq 0) { 'task-sweep 说成功，却没写出报告' } else { "task-sweep 自己退了非 0（退出码 $sweepCode），而且没写出报告" }
    Write-FailureReport -Path $reportPath -Headline $headlineD -What (@(
        "WSL、bun、`$HOME/cante-bin/ante` 都在，但 task-sweep 这次退出码是 $sweepCode，而且报告本体是空的。",
        "日志（含原始输出）在：$logPath"
    ) -join "`n") -Steps @(
        "打开日志 ``$logPath`` 看最后几行（原始输出也已经贴在下面）；",
        '常见原因：模型端点连不上（网关或密钥）、参数里的卡名认不出、夹具生成缺依赖（pypdf / Pillow）；',
        '修好上面那条，再跑一次 `gui\scripts\windows\weekly-sweep.ps1`。'
    ) -RawOutput $rawWithSweep
    if ($sweepCode -eq 0) { $sweepCode = 2 }
}

# 最后一道保底：报告永远不能是空的（产品律 3 的出口）。
if ([string]::IsNullOrWhiteSpace((Get-ReportBody $reportPath))) {
    Write-FailureReport -Path $reportPath -Headline '普查跑完了，却没有写出报告' -What 'task-sweep 返回了，但报告文件还是空的。这既不是通过，也不是某张卡失败。' -Steps @(
        "打开日志 ``$logPath`` 看原始输出；",
        '再跑一次 `gui\scripts\windows\weekly-sweep.ps1`；',
        '若还是这样，把日志和这份报告一起交给技术同事。'
    ) -RawOutput $rawWithSweep
}

$finished = Get-Date
$summary = "结束：$($finished.ToString('s'))；退出码 $sweepCode；报告 $reportPath"
Add-Content -LiteralPath $logPath -Value $summary -Encoding UTF8
Write-Line "==> $summary"

# --- 6) 保留最近几份 -------------------------------------------------------
# 现有行为：按文件名（即日期）倒序，只留最近 $Keep 份（默认 8），多出来的删掉。
# 本次改动不动这段 —— 失败报告和成功报告都走这里，所以磁盘不会被撑破。
# 断言级说明：report-*.md 与 logs/sweep-*.log 各留 $Keep 份；这里是唯一会
# 删历史报告的地方（上面所有失败路径都只是**写**当前这一份，不删旧的）。
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
