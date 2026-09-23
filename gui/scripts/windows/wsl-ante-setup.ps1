#Requires -Version 5.1
<#
wsl-ante-setup.ps1 —— 在 WSL 里准备好 Linux 版 ante，并打印该给应用设的 CANTE_BIN。

为什么需要它：上游只有 Linux / macOS 构建（官方 README 说 Windows 建议用 WSL），
所以 Windows 上的**真实端到端验收**只有一条路——守护进程跑在 WSL 里，Windows 上的
应用通过 CANTE_BIN 指过去。这个脚本把这条路的准备动作固定下来，谁都能照做、都能复核。

它**不是**交付给用户的方案：王姐不会装 WSL。它只是我们自己的验收手段。

怎么用（在 Windows PowerShell 5.1 里，不需要管理员）：

    powershell -ExecutionPolicy Bypass -File gui\scripts\windows\wsl-ante-setup.ps1

常用参数：

    -Version 0.preview.99     要装的版本（默认就是我们验过的那一版）
    -GatewayEnvFile           网关来源（默认 %USERPROFILE%\.ante\cante-gateway.env）
    -Provider                 回退时从 pi models.json 取哪个服务方（默认 9router）
    -Distro Ubuntu            指定 WSL 发行版（默认用 WSL 的默认发行版）
    -InstallDir /home/x/bin   安装目录（默认在 WSL 里 $HOME/cante-bin）
    -Force                    已装同版本也重新下载一次
    -CheckOnly                只做自检，不下载

脚本可重复运行：已经装好同一个版本就直接跳过下载。

注意：文件里有中文，必须带 UTF-8 BOM 保存（PowerShell 5.1 不认无 BOM 的 UTF-8，
会把中文读成乱码）。改动这个文件时请保留 BOM。
#>
[CmdletBinding()]
param(
    [string]$Version = "0.preview.99",
    [string]$Distro = "",
    [string]$InstallDir = "",
    [switch]$Force,
    [switch]$CheckOnly,
    # 网关（模型端点）来源。默认就是 gui/scripts/run-desktop.sh 读的那份；
    # 没有它的时候回退到 pi 的 models.json（和 weekly-sweep.ps1 同一套做法）。
    [string]$GatewayEnvFile = "$env:USERPROFILE\.ante\cante-gateway.env",
    [string]$ModelsJson = "$env:USERPROFILE\.pi\agent\models.json",
    [string]$Provider = "9router"
)

$ErrorActionPreference = "Stop"

# 中文输出要按 UTF-8 走，否则在部分代码页下会花屏。
try {
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
    $OutputEncoding = New-Object System.Text.UTF8Encoding($false)
} catch {
    # 控制台编码设不了不影响功能，继续。
}

$script:WslPath = $null
$script:DistroArgs = @()

function Write-Step([string]$Text) {
    Write-Host ""
    Write-Host "==> $Text" -ForegroundColor Cyan
}

function Write-Ok([string]$Text) {
    Write-Host "  [ok] $Text" -ForegroundColor Green
}

function Write-Note([string]$Text) {
    Write-Host "  [!]  $Text" -ForegroundColor Yellow
}

function Fail([string]$Text) {
    Write-Host ""
    Write-Host "[失败] $Text" -ForegroundColor Red
    Write-Host "       请把上面这几行完整贴回来（含报错原文），不要只描述。" -ForegroundColor DarkGray
    exit 1
}

# --- 把 wsl.exe 的输出按正确编码读回来 ---------------------------------------
#
# wsl.exe 自己打的字（例如"未安装 Linux 的 Windows 子系统…"那屏安装提示、发行版
# 列表）是 **UTF-16LE** 字节；WSL 里 bash 的输出是 UTF-8。用默认代码页捕获就会
# 花屏（报告里那段乱码就是这么来的，r18 修的），所以按实际字节认编码。
#
# 做法：Start-Process 原样重定向到临时文件（PowerShell 不经手解码），再读字节：
# 有 UTF-16 BOM、或含 NUL 字节 → UTF-16LE；否则 UTF-8。失败路径给空文件也不炸。
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

# 跑一次 wsl.exe，把 stdout/stderr 读回来（可选经 stdin 喂脚本），**带超时**。
#
# 为什么用 .NET 的 Process 而不是 Start-Process：PS 5.1 下 `Start-Process -Wait`
# 没法设超时，而 AGENTS.md §5 要求每条可能变慢的外部命令都有上限、并且把
# 「超时（没等到结果）」和「确认没有」分开报。.NET 的 WaitForExit(ms) 既能设上限，
# ExitCode 也可靠，还能从 BaseStream 拿**原始字节**（保住上面那条按字节认编码的做法）。
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
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = $WslPath
        $psi.UseShellExecute = $false
        $psi.CreateNoWindow = $true
        $psi.RedirectStandardOutput = $true
        $psi.RedirectStandardError = $true
        $psi.RedirectStandardInput = $true
        # 参数只传简单 token（-d / -e / bash / -s / 一个 Linux 路径）；带空格的加引号。
        $psi.Arguments = (($WslArguments | ForEach-Object {
            if ($_ -match '[\s"]') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ }
        }) -join ' ')
        $proc = New-Object System.Diagnostics.Process
        $proc.StartInfo = $psi
        $null = $proc.Start()
        # 异步读完 stdout/stderr（不读的话，输出超过管道缓冲区会把子进程堵死）。
        $outTask = $proc.StandardOutput.BaseStream.CopyToAsync($outMs)
        $errTask = $proc.StandardError.BaseStream.CopyToAsync($errMs)
        # 脚本以 UTF-8 字节直接写进 stdin（PS 5.1 的 StandardInput.Write 会按控制台编码走）。
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

# 把一段 bash 脚本从 stdin 交给 WSL 里的 bash 跑。
#
# 为什么不写成 wsl.exe -e bash -lc "……"：PowerShell 5.1 往原生程序传带引号的
# 参数时会吃掉里层的双引号，命令行一旦复杂就会悄悄变形。走 stdin 就没有这个问题
# ——所以下面所有 bash 片段都只经 stdin，不拼接进命令行。
function Invoke-WslScript {
    param(
        [Parameter(Mandatory = $true)][string]$Script,
        [string]$Label = "bash",
        [int]$TimeoutSeconds = 120
    )
    $distroArgs = @($script:DistroArgs) + @('-e', 'bash', '-s')
    # 不能直接把原生程序的 stderr 2>&1 重定向进来（$ErrorActionPreference = 'Stop'
    # 时会抛 NativeCommandError），也不能用默认代码页解 —— 交给 Invoke-WslCapture，
    # 它按实际字节认 UTF-16LE / UTF-8。
    $capture = Invoke-WslCapture -WslPath $script:WslPath -WslArguments $distroArgs `
        -StandardInput $Script -TimeoutSeconds $TimeoutSeconds
    return [pscustomobject]@{
        ExitCode = $capture.ExitCode
        Text     = $capture.Text
        TimedOut = $capture.TimedOut
        Label    = $Label
    }
}

# 直接跑一条 wsl.exe 命令（不喂 stdin），把 stdout/stderr 原样打到屏幕上，
# 同时带超时、把退出码和原文拿回来（第 4 步的 --version / --help 用它）。
function Invoke-WslDirect {
    param(
        [Parameter(Mandatory = $true)][string[]]$WslArguments,
        [int]$TimeoutSeconds = 120
    )
    $capture = Invoke-WslCapture -WslPath $script:WslPath -WslArguments $WslArguments -TimeoutSeconds $TimeoutSeconds
    if ($capture.Text.Length -gt 0) {
        foreach ($line in ($capture.Text -split "`r?`n")) { Write-Host "      $line" -ForegroundColor DarkGray }
    }
    return $capture
}

function Show-Captured($Result) {
    if ($Result.Text.Length -eq 0) { return }
    foreach ($line in ($Result.Text -split "`r?`n")) {
        Write-Host "      $line" -ForegroundColor DarkGray
    }
}

# ---------------------------------------------------------------------------
# 1. 找到 wsl.exe
# ---------------------------------------------------------------------------

Write-Step "1/5 检查 wsl.exe"

$systemRoot = $env:SystemRoot
if (-not $systemRoot) { $systemRoot = "C:\Windows" }
$candidate = Join-Path $systemRoot "System32\wsl.exe"
if (Test-Path -LiteralPath $candidate) {
    $script:WslPath = $candidate
} else {
    $found = Get-Command "wsl.exe" -ErrorAction SilentlyContinue
    if ($found) {
        $script:WslPath = $found.Source
    } else {
        Fail "找不到 wsl.exe。请先装 WSL 和 Ubuntu：在管理员 PowerShell 里跑 wsl --install -d Ubuntu，重启后再跑本脚本。"
    }
}
Write-Ok "wsl.exe：$script:WslPath"

if ($Distro -ne "") {
    $script:DistroArgs = @("-d", $Distro)
    Write-Ok "使用发行版：$Distro"
} else {
    Write-Ok "使用 WSL 的默认发行版"
}

# ---------------------------------------------------------------------------
# 2. 确认 WSL 里真有 Linux 在跑
# ---------------------------------------------------------------------------

Write-Step "2/5 确认 WSL 里的 Linux 能跑"

$probe = Invoke-WslScript -Script 'printf "WSL_OK:%s\n" "$(uname -s)"' -Label "uname"
if ($probe.TimedOut) {
    Fail "探测 WSL 里的 Linux 超时：120 秒没返回，已经把它停掉。这是『没等到结果』，不等于 WSL 不在（第一次启动可能很慢）—— 先手动跑一次 wsl.exe -e echo hello 看看。"
}
if ($probe.ExitCode -ne 0 -or $probe.Text -notlike "*WSL_OK:*") {
    Show-Captured $probe
    Fail "WSL 里没跑起来 Linux。先手动跑一次 wsl.exe -e echo hello 看看（第一次启动可能要等一会儿，或者要你先设置 Linux 用户名）。"
}
Write-Ok ($probe.Text.Trim())

$homeProbe = Invoke-WslScript -Script 'printf "HOME:%s" "$HOME"' -Label "home"
if ($homeProbe.TimedOut) {
    Fail "读 WSL 里的家目录超时：120 秒没返回（『没等到结果』，不等于拿不到）—— 先手动跑一次 wsl.exe -e echo $HOME 看看。"
}
if ($homeProbe.ExitCode -ne 0 -or $homeProbe.Text -notlike "HOME:/*") {
    Show-Captured $homeProbe
    Fail "拿不到 WSL 里的 HOME 目录。"
}
$wslHome = $homeProbe.Text.Substring(5).Trim()
Write-Ok "WSL 里的家目录：$wslHome"

# ---------------------------------------------------------------------------
# 2.5 修 WSL 的 DNS（入口自己写，不赌持久化）
# ---------------------------------------------------------------------------
#
# 为什么要有这一步（2026-09-21 实况）：WSL NAT 的默认 DNS 指向那个自动生成的
# systemd 存根——/etc/resolv.conf 里只有一行 nameserver 10.255.255.254，而
# **下次 wsl 实例重启它会被打回原样**。改 /etc/wsl.conf 让它持久化的做法在真机上
# 没调通（改完 wsl --shutdown，第二个脚本神秘退出 1），所以不赌持久化：
# **每次进来先自己写一遍**，两行 nameserver，比持久化还稳。
#
# 探针分两层，别把两种失败混成一句「检查网络」（那会给出错的出路）：
#   1) 下载域名解析不了、但别的域名能解析 → 这个名字/下载源的问题，不是 WSL 没网；
#   2) 别的域名也解析不了             → 写了 resolv.conf 还是不通 = 这台机器真没网。
# 注意直接 `getent ... | head -1 && echo OK` 是错的：管道会把 getent 的退出码
# 换掉，解析失败也会报 OK（现场那个“DNS_OK”就是这么来的）。这里一律看退出码。

Write-Step "2.5/5 修 WSL 的 DNS（入口自己写 /etc/resolv.conf，不赌持久化）"

$dnsScript = @'
dns_host="cante.run"
rm -f /etc/resolv.conf 2>/dev/null || true
if printf 'nameserver 223.5.5.5\nnameserver 1.1.1.1\n' > /etc/resolv.conf 2>/dev/null; then
  printf 'CANTE_DNS_WRITTEN\n'
else
  printf 'CANTE_DNS_UNWRITABLE\n'
fi
printf 'CANTE_DNS_FIRST:%s\n' "$(head -n 1 /etc/resolv.conf 2>/dev/null)"
if getent hosts "$dns_host" >/dev/null 2>&1; then
  printf 'CANTE_DNS_RESOLVED:%s\n' "$dns_host"
else
  printf 'CANTE_DNS_UNRESOLVED:%s\n' "$dns_host"
  for other in example.com www.baidu.com; do
    if getent hosts "$other" >/dev/null 2>&1; then
      printf 'CANTE_DNS_FALLBACK_OK:%s\n' "$other"
      break
    fi
  done
fi
'@
$dns = Invoke-WslScript -Script $dnsScript -Label "dns" -TimeoutSeconds 180
Show-Captured $dns
$dnsWritten = ($dns.Text -like "*CANTE_DNS_WRITTEN*")
$dnsResolved = ($dns.Text -like "*CANTE_DNS_RESOLVED:*")
$dnsFallbackOk = ($dns.Text -like "*CANTE_DNS_FALLBACK_OK:*")

if ($dns.TimedOut) {
    Fail "改 WSL 的 DNS 超时：180 秒没返回，已经把它停掉。这是『没等到结果』，不等于改失败——先手动跑一次 wsl.exe -e cat /etc/resolv.conf 看看 WSL 是不是卡住了。"
} elseif ($dnsResolved) {
    Write-Ok "已写入 /etc/resolv.conf（223.5.5.5 / 1.1.1.1），并能解析 cante.run"
} elseif (-not $dnsWritten) {
    if ($CheckOnly) {
        Write-Note "写不进 /etc/resolv.conf（多半不是 root 用户）。-CheckOnly 不下载，继续自检。"
    } else {
        Fail "写不进 WSL 的 /etc/resolv.conf（这步要 root；现在这个 Linux 用户多半不是）。先手动验证：wsl.exe -e bash -lc 'id -u; cat /etc/resolv.conf'。"
    }
} elseif ($dnsFallbackOk) {
    Write-Note "DNS 现在是通的（example.com 这类名字能解析），但下载域名 cante.run 解析不了——这是这个名字/下载源的问题，不是 WSL 没网。"
} else {
    if ($CheckOnly) {
        Write-Note "WSL 的 DNS 写了还是不通（可连备用的例子域名也解析不了）。-CheckOnly 不下载，继续自检。"
    } else {
        Fail "WSL 的 DNS 写了还是不通 = 这台机器真没网。脚本已经自己写了 /etc/resolv.conf（223.5.5.5 / 1.1.1.1）并且重试过别的域名，所以不是 WSL 存根那件事。先手动确认：wsl.exe -e bash -lc 'cat /etc/resolv.conf; getent hosts example.com; ping -c 1 223.5.5.5'。"
    }
}

# ---------------------------------------------------------------------------
# 3. 解析安装目录
# ---------------------------------------------------------------------------

if ($InstallDir -eq "") {
    $InstallDir = "$wslHome/cante-bin"
}
if (-not $InstallDir.StartsWith("/")) {
    Fail "安装目录要写成 Linux 路径（以 / 开头），例如 /home/你/cante-bin；收到的是：$InstallDir"
}
if ($Version -notmatch '^[A-Za-z0-9._-]+$') {
    Fail "版本号只能有字母数字和 . _ -（例如 0.preview.99 或 nightly）；收到的是：$Version"
}

Write-Step "3/5 准备安装目录：$InstallDir（版本 $Version）"

if ($CheckOnly) {
    Write-Note "-CheckOnly：跳过下载，只做自检"
} else {
    $template = @'
set -euo pipefail

install_dir="__INSTALL_DIR__"
want="__VERSION__"
force="__FORCE__"

pick_binary() {
  for name in ante cante; do
    if [ -x "$install_dir/$name" ]; then
      printf '%s\n' "$install_dir/$name"
      return 0
    fi
  done
  return 1
}

mkdir -p "$install_dir"

if [ "$force" != "1" ]; then
  if bin=$(pick_binary); then
    current=$("$bin" --version 2>/dev/null | head -n 1 || true)
    case "$current" in
      *"$want"*)
        printf 'BINARY:%s\n' "$bin"
        printf 'STATE:ALREADY:%s\n' "$current"
        exit 0
        ;;
    esac
    printf 'NOTE:dir has %s, want %s\n' "$current" "$want"
  fi
fi

printf 'STATE:DOWNLOADING:%s\n' "$want"

if ! curl -fsSL https://cante.run/install.sh | CANTE_INSTALL_DIR="$install_dir" bash -s -- "$want"; then
  printf 'FAILED:download\n'
  exit 1
fi

if ! bin=$(pick_binary); then
  printf 'FAILED:no-binary\n'
  exit 1
fi

printf 'BINARY:%s\n' "$bin"
printf 'STATE:INSTALLED\n'
'@

    $forceFlag = "0"
    if ($Force) { $forceFlag = "1" }
    $payload = $template.Replace("__INSTALL_DIR__", $InstallDir).Replace("__VERSION__", $Version).Replace("__FORCE__", $forceFlag)

    Write-Host "  正在下载并解包（从 cante.run/install.sh；大版本要几分钟，这一条最多等 30 分钟）…" -ForegroundColor DarkGray
    $install = Invoke-WslScript -Script $payload -Label "install" -TimeoutSeconds 1800
    if ($install.TimedOut) {
        Fail "下载/安装超过 30 分钟还没结束，已经把它停掉。这是『没等到结果』，不等于下载失败 —— 先手动跑一次 wsl.exe -e bash -lc 'curl -fsSL https://cante.run/install.sh | bash' 看它到底卡在哪。"
    }
    if ($install.ExitCode -ne 0 -or $install.Text -notlike "*BINARY:*") {
        Show-Captured $install
        if ($install.Text -like "*FAILED:download*") {
            # 不要张口就说「检查网络」：脚本开头已经自己写过 resolv.conf，先把 DNS 这一层排掉，
            # 剩下的才是真的下载源 / 域名 / HTTP 问题（2026-09-21 现场就是这两层混在一起）。
            $dnsHint = "脚本开头已经在 WSL 里自己写过 /etc/resolv.conf（223.5.5.5 / 1.1.1.1）"
            if ($dnsResolved) { $dnsHint += "，而且当时 cante.run 能解析" }
            elseif ($dnsFallbackOk) { $dnsHint += "，而且当时别的域名能解析（只是 cante.run 这个名字解析不了）" }
            else { $dnsHint += "，而且当时别的域名也解析不了" }
            Fail "下载失败。$dnsHint。所以先别怀疑 WSL 的 DNS：手动跑一次 wsl.exe -e bash -lc 'curl -fsSv https://cante.run/install.sh -o /dev/null'，看 curl 报的是名字解析不了（域名/下载源的问题），还是连上了但 HTTP 报错（版本号不存在 / 服务器问题）。"
        }
        if ($install.Text -like "*FAILED:no-binary*") {
            Fail "装完了但 $InstallDir 里没有可执行的 ante/cante。可能这个版本号不存在——试试 -Version nightly。"
        }
        Fail "在 WSL 里安装失败（退出码 $($install.ExitCode)）。"
    }

    $binLine = ($install.Text -split "`r?`n" | Where-Object { $_ -like "BINARY:*" } | Select-Object -First 1)
    $binPath = $binLine.Substring(7).Trim()
    $stateLine = ($install.Text -split "`r?`n" | Where-Object { $_ -like "STATE:*" } | Select-Object -First 1)
    Write-Ok "二进制：$binPath"
    if ($stateLine) { Write-Ok $stateLine }
}

# ---------------------------------------------------------------------------
# 4. 自检：在 WSL 里跑 --version 和 --help
# ---------------------------------------------------------------------------

Write-Step "4/5 自检（都在 WSL 里跑）"

$distroArgs = $script:DistroArgs

# 到安装目录里找可执行文件（-CheckOnly 时没有上一步的结果，靠这里）。
$probeTemplate = @'
for n in __DIR__/ante __DIR__/cante; do
  if [ -x "$n" ]; then
    printf 'BINARY:%s\n' "$n"
    break
  fi
done
'@
$probeScript = $probeTemplate.Replace("__DIR__", $InstallDir)
$probeBin = Invoke-WslScript -Script $probeScript -Label "which"
if ($probeBin.Text -like "*BINARY:*") {
    $line = ($probeBin.Text -split "`r?`n" | Where-Object { $_ -like "BINARY:*" } | Select-Object -First 1)
    $binPath = $line.Substring(7).Trim()
} elseif (-not $binPath) {
    Show-Captured $probeBin
    Fail "在 $InstallDir 里没找到 ante/cante。先跑一次不带 -CheckOnly 的本脚本（-CheckOnly 只做自检，不会安装）。"
}
Write-Ok "用这个二进制：$binPath"

Write-Host "  $ wsl.exe $($script:DistroArgs -join ' ') -e $binPath --version" -ForegroundColor DarkGray
$versionResult = Invoke-WslDirect -WslArguments (@($distroArgs) + @('-e', $binPath, '--version')) -TimeoutSeconds 120
if ($versionResult.TimedOut) {
    Fail "ante --version 超时：120 秒没返回，已经把它停掉。这是『没等到结果』，不等于它坏了。"
}
if ($versionResult.ExitCode -ne 0) {
    Fail "ante --version 失败（退出码 $($versionResult.ExitCode)）。上面那行就是应用的守护进程；它跑不起来，应用里就不会有会话。"
}
Write-Ok "ante --version 正常"

Write-Host "  $ wsl.exe $($script:DistroArgs -join ' ') -e $binPath --help" -ForegroundColor DarkGray
$helpResult = Invoke-WslDirect -WslArguments (@($distroArgs) + @('-e', $binPath, '--help')) -TimeoutSeconds 120
if ($helpResult.TimedOut) {
    Fail "ante --help 超时：120 秒没返回，已经把它停掉。"
}
if ($helpResult.ExitCode -ne 0) {
    Fail "ante --help 失败（退出码 $($helpResult.ExitCode)）。"
}
Write-Ok "ante --help 正常"

# ---------------------------------------------------------------------------
# 4.5 把网关配进 WSL（issue #303）
# ---------------------------------------------------------------------------
#
# 为什么要有这一步（2026-09-21 实测）：ante 装好、bun 也在，但 WSL 里的守护
# 进程**没有任何模型端点**——起来之后第一次请求才失败，报告上就表现为"整批卡
# 0 秒全灭、原因列全是（无）"，看起来像卡坏了。守护进程只认环境变量
# （OPENAI_COMPATIBLE_BASE_URL / OPENAI_COMPATIBLE_API_KEY），所以这里把
# Windows 侧那份网关落成 WSL 里的 ~/.ante/cante-gateway.env（chmod 600）——
# task-sweep.sh 与 run-desktop.sh 读的是同一个位置。
#
# 密钥不进仓库、不进日志、不进命令行：值只出现在喂给 WSL 的 stdin / 环境里，
# 本脚本只打印"来源 / 长度 / 掩码后的主机"。

Write-Step "4.5/5 把网关配进 WSL（没有它守护进程起来也用不了）"

$gwBase = ''
$gwKey = ''
$gwSource = ''

if (Test-Path -LiteralPath $GatewayEnvFile) {
    # 和 gui/scripts/run-desktop.sh 同一份格式：一行一个 export VAR=value。
    foreach ($line in (Get-Content -LiteralPath $GatewayEnvFile -Encoding UTF8)) {
        if ($line -match '^\s*(?:export\s+)?OPENAI_COMPATIBLE_BASE_URL\s*=\s*(.+?)\s*$') {
            $gwBase = $Matches[1].Trim('"', "'")
        }
        if ($line -match '^\s*(?:export\s+)?OPENAI_COMPATIBLE_API_KEY\s*=\s*(.+?)\s*$') {
            $gwKey = $Matches[1].Trim('"', "'")
        }
    }
    if ($gwBase -and $gwKey) { $gwSource = $GatewayEnvFile }
}
if (-not $gwSource -and (Test-Path -LiteralPath $ModelsJson)) {
    try {
        $cfg = Get-Content -LiteralPath $ModelsJson -Raw -Encoding UTF8 | ConvertFrom-Json
        $entry = $cfg.providers.$Provider
        if ($entry) {
            $gwBase = [string]$entry.baseUrl
            $gwKey = [string]$entry.apiKey
            if ($gwBase -and $gwKey) { $gwSource = "$ModelsJson（服务方 $Provider）" }
        }
    } catch { }
}

if (-not $gwSource) {
    Write-Note "没找到网关：$GatewayEnvFile 不在，$ModelsJson 里也没有可用的服务方 $Provider。"
    Write-Note "跳过这一步。但请记住：WSL 里的守护进程没有端点时，普查会整批 0 秒失败。"
} elseif ($CheckOnly) {
    Write-Note "-CheckOnly：只确认有网关来源（$gwSource），不写入 WSL。"
} else {
    # 掩码：只报主机形状，绝不打印值本身。内网 IP 也不打全（只留前两段 + x）：
    # 这份输出经常被贴进验收报告，把 10.x / 192.168.x 整个写进去等于把内网拓扑带出去。
    $maskedHost = $gwBase -replace '^\w+://([^/:]+).*$', '$1'
    if ($maskedHost -match '^(\d{1,3}\.\d{1,3})\.\d{1,3}\.\d{1,3}$') { $maskedHost = "$($Matches[1]).x.x" }
    $gwScript = @'
set -euo pipefail
dir="$HOME/.ante"
mkdir -p "$dir"
umask 077
{
  printf 'export OPENAI_COMPATIBLE_BASE_URL=%s\n' "$OPENAI_COMPATIBLE_BASE_URL"
  printf 'export OPENAI_COMPATIBLE_API_KEY=%s\n' "$OPENAI_COMPATIBLE_API_KEY"
} > "$dir/cante-gateway.env"
chmod 600 "$dir/cante-gateway.env"
if [ -s "$dir/cante-gateway.env" ]; then
  printf 'GATEWAY_WRITTEN:%s:%s\n' "$dir/cante-gateway.env" "$(stat -c %a "$dir/cante-gateway.env")"
  printf 'GATEWAY_KEY_LEN:%s\n' "${#OPENAI_COMPATIBLE_API_KEY}"
else
  printf 'GATEWAY_EMPTY\n'
  exit 1
fi
'@
    # 值经进程环境 + WSLENV 渡过边界（不拼进命令行，免得出现在进程列表里）。
    $prevBase = $env:OPENAI_COMPATIBLE_BASE_URL
    $prevKey = $env:OPENAI_COMPATIBLE_API_KEY
    $prevWslEnv = $env:WSLENV
    $env:OPENAI_COMPATIBLE_BASE_URL = $gwBase
    $env:OPENAI_COMPATIBLE_API_KEY = $gwKey
    $env:WSLENV = 'OPENAI_COMPATIBLE_BASE_URL:OPENAI_COMPATIBLE_API_KEY'
    try {
        $gw = Invoke-WslScript -Script $gwScript -Label "gateway"
    } finally {
        # 还原，别让后面几步在不知情的情况下带着密钥。
        $env:OPENAI_COMPATIBLE_BASE_URL = $prevBase
        $env:OPENAI_COMPATIBLE_API_KEY = $prevKey
        $env:WSLENV = $prevWslEnv
    }
    if ($gw.ExitCode -ne 0 -or $gw.Text -notlike "*GATEWAY_WRITTEN:*") {
        Show-Captured $gw
        Fail "把网关写进 WSL 失败（退出码 $($gw.ExitCode)）。"
    }
    Write-Ok "网关来源：$gwSource"
    Write-Ok "已写入 WSL 的 ~/.ante/cante-gateway.env（权限 600；主机 $maskedHost，密钥 $($gwKey.Length) 位）"
    Write-Note "task-sweep.sh 与 run-desktop.sh 读的是同一个位置；值不进仓库、不进报告。"
}

# ---------------------------------------------------------------------------
# 5. 打印 CANTE_BIN
# ---------------------------------------------------------------------------

$canteBin = "wsl.exe -e $binPath serve"

Write-Step "5/5 该给应用设的 CANTE_BIN"
Write-Host ""
Write-Host "    $canteBin" -ForegroundColor White
Write-Host ""
Write-Host "  两种设法（挑一种）：" -ForegroundColor DarkGray
Write-Host "  a) 只对这个终端窗口生效——从它启动应用就能用（验收时最省事）：" -ForegroundColor DarkGray
Write-Host "     `$env:CANTE_BIN = `"$canteBin`"" -ForegroundColor Yellow
Write-Host "  b) 设成用户级环境变量（之后新开的窗口都会带上，要重新登录才彻底生效）：" -ForegroundColor DarkGray
Write-Host "     [Environment]::SetEnvironmentVariable(`"CANTE_BIN`", `"$canteBin`", `"User`")" -ForegroundColor Yellow
Write-Host ""
Write-Host "  注意：" -ForegroundColor DarkGray
Write-Host "  - 应用要由带了 CANTE_BIN 的那个终端启动（或设成用户变量后重新登录），否则它还是去找 Windows 上的 cante。" -ForegroundColor DarkGray
Write-Host "  - 应用认得这条命令末尾的 serve，不会再自己补一个（不会变成 ante serve serve）。" -ForegroundColor DarkGray
Write-Host "  - 这只是我们的验收手段，不是给用户装的东西。用户机器上不该需要 WSL。" -ForegroundColor DarkGray
Write-Host ""
Write-Host "[完成] WSL 里的守护进程就绪。" -ForegroundColor Green
