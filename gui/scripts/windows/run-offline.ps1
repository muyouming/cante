# 「服务方真的没了」三种现场的真机验收驱动（#197 P1）。
#
# 它做一件事：为一种现场摆好假服务方 + 把 pi 指过去，跑一张卡，把**她屏幕上那一屏**
# 原样落盘（文字 / HTML / 截图 / 结构化结果 / 原文件哈希）。
#
# 三种现场（-Scenario）：
#   dead   —— 服务方端口不可达：把 pi 指到一个**没人听**的端口（连 TCP 都握不上）；
#   cut    —— 中途断掉：服务方答到第 2 个工具调用后彻底静音（不发 FIN，socket 挂着）；
#   forbid —— 代理挡住：每个请求都回 403（公司网关那种）。
#
# 它**只**摆现场、跑、落盘；结论由人写进报告 —— 脚本不替报告下结论。
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File gui\scripts\windows\run-offline.ps1 -Scenario dead
#   ... -Scenario cut    -StallSecs 90
#   ... -Scenario forbid
#
# 退出码：0 = 到了结局页并落盘；2 = 环境问题（应用/驱动/组件不在、会话建不起来）；
#         3 = 产品/流程问题（没到任何结局页）。
#
# 注意：本文件必须保存为 UTF-8 with BOM（Windows PowerShell 5.1 否则按 GBK 解析中文）。

param(
    [Parameter(Mandatory = $true)][ValidateSet('dead', 'cut', 'forbid')][string]$Scenario,
    [string]$Exe = "",
    [string]$WorkRoot = "",
    # 停滞后判据（秒）。产品的默认是 600（10 分钟）；这里默认压到 120，
    # 因为这一轮要**看见**桥报那条停滞，而不是真等 10 分钟。报告里会写明实际值。
    [int]$StallSecs = 120,
    [int]$TimeoutSec = 1500,
    # 造现场用的本地端口（dead/cut/forbid 各用一个，避免互相踩）。
    [int]$RelayPort = 0,
    # WebDriver 端口。默认 0 = 每次自动挑一个**空闲**端口。
    # 为什么不能写死 4445：反复跑之后旧的连接会停在 TIME_WAIT，tauri-driver 绑不上，
    # 报「can not listen to address」＋「No matching capabilities found」——
    # 看起来像产品坏了，其实是端口复用问题（实跑踩过）。
    [int]$WdPort = 0,
    [switch]$KeepWorkDir
)

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$script:Here = Split-Path -Parent $MyInvocation.MyCommand.Path
# Here = <repo>\gui\scripts\windows → 仓库根要往上数三层（windows → scripts → gui → <repo>）。
# 少了这一层就会变成 <repo>\gui，于是下面找构建产物时拼成 gui\gui\... 找不到，
# 静默回退到「装好的那份」—— 于是你以为在验当前代码，其实验的是旧安装包（踩过）。
$script:Repo = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $script:Here))
$script:Lines = New-Object System.Collections.Generic.List[string]
function Say([string]$text) { Write-Output $text; [void]$script:Lines.Add($text) }
function SayLines([string]$text) {
    if ([string]::IsNullOrEmpty($text)) { return }
    foreach ($line in ($text -split "`r?`n")) { Say $line }
}

function Run-Command {
    param([string]$File, [string[]]$Arguments, [int]$TimeoutSec = 300)
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $File
    # PS 5.1 上 ProcessStartInfo.ArgumentList 拿不到（.NET Framework 没有这个重载），
    # 所以用 Arguments 字符串自己拼引号：参数里可能有空格或中文（cante-sheets 的路径）。
    $quoted = @()
    foreach ($a in $Arguments) {
        $s = [string]$a
        if ($s -match '\s') { $s = '"' + $s + '"' }
        $quoted += $s
    }
    $psi.Arguments = ($quoted -join ' ')
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
    $psi.StandardErrorEncoding = [System.Text.Encoding]::UTF8
    try { $proc = [System.Diagnostics.Process]::Start($psi) } catch { return [pscustomobject]@{ Code = 127; Stdout = ''; Stderr = $_.Exception.Message } }
    $out = $proc.StandardOutput.ReadToEndAsync()
    $err = $proc.StandardError.ReadToEndAsync()
    if (-not $proc.WaitForExit($TimeoutSec * 1000)) {
        try { $proc.Kill() } catch {}
        return [pscustomobject]@{ Code = 124; Stdout = ''; Stderr = "超时：$TimeoutSec 秒没跑完" }
    }
    return [pscustomobject]@{ Code = $proc.ExitCode; Stdout = $out.Result; Stderr = $err.Result }
}

# 清掉上一轮可能残留的子进程（tauri-driver / msedgedriver / cante-gui）。
# 为什么必须清：PowerShell 的 Process.Kill 杀掉父进程时**不会**连带杀掉
# tauri-driver 与 msedgedriver，它们会继续占着调试端口 —— 下一轮只会拿到
# 「can not listen to address」＋「No matching capabilities found」，看起来像产品坏了。
function Clear-StaleProcesses {
    foreach ($name in @('tauri-driver', 'msedgedriver', 'cante-gui')) {
        Get-Process -Name $name -ErrorAction SilentlyContinue | ForEach-Object {
            try { Stop-Process -Id $_.Id -Force; Say ('  清掉残留进程：' + $name + ' pid=' + $_.Id) } catch {}
        }
    }
    Start-Sleep -Seconds 2
}

# 清掉残留的假服务方（上一轮的 node relay.mjs）。
# 为什么必须清：relay 占着固定端口时，**新的 relay 起不来**（EADDRINUSE），
# 而旧的还在听 —— 于是应用连到的是上一轮的现场（甚至另一个场景的），
# 屏幕上的现象看着似像非像，结论就是错的。实跑踩过。
function Clear-StaleRelays {
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like '*relay.mjs*' } | ForEach-Object {
            try { Stop-Process -Id $_.ProcessId -Force; Say ('  清掉残留假服务方：pid=' + $_.ProcessId) } catch {}
        }
    Start-Sleep -Seconds 1
}

function Resolve-BuiltExe {
    # 本轮构建出来的（自带 executor\pi，零环境变量也能起）。优先它，因为它 = 当前 main。
    foreach ($c in @(
        (Join-Path $script:Repo 'gui\src-tauri\target\debug\cante-gui.exe'),
        (Join-Path $script:Repo 'gui\src-tauri\target\release\cante-gui.exe')
    )) {
        if (Test-Path $c) { return (Resolve-Path $c).Path }
    }
    return $null
}

function Resolve-InstalledExe([string]$Given) {
    if ($Given) {
        if (Test-Path $Given) { return (Resolve-Path $Given).Path }
        return $null
    }
    $built = Resolve-BuiltExe
    if ($built) { return $built }
    $installed = Join-Path $env:LOCALAPPDATA 'Cante\cante-gui.exe'
    if (Test-Path $installed) { return (Resolve-Path $installed).Path }
    return $null
}

# 把应用摆到一个**干净的隔离目录**再跑。为什么必须这样：随包发的 pi 是一个 bundle，
# 里面有个 `@earendil-works/chord/context` 是外部依赖；只要应用的**祖先目录里有
# node_modules**（从 git 工作树里直接跑构建产物就是这种情况），bun 的模块解析就会去
# 那里找、找不到就 `Cannot find module '@earendil-works/chord/context'`，pi 起不来。
# 装好的应用（%LOCALAPPDATA%\Cante）没有这一层，所以这是**开发工作树独有的坑**，
# 不是产品缺陷 —— 但也正因为如此，验收时**不能**直接从工作树跑构建产物。
function Stage-IsolatedApp([string]$SourceExe, [string]$DestRoot) {
    $srcDir = Split-Path $SourceExe
    $dest = Join-Path $DestRoot 'app'
    New-Item -ItemType Directory -Force -Path $dest | Out-Null
    foreach ($name in @('cante-gui.exe', 'cante-bridge.exe', 'cante-sheets.exe', 'cante-pdf.exe')) {
        $from = Join-Path $srcDir $name
        if (Test-Path $from) { Copy-Item $from (Join-Path $dest $name) -Force }
    }
    $piSrc = Join-Path $srcDir 'pi'
    if (Test-Path $piSrc) {
        Copy-Item $piSrc (Join-Path $dest 'pi') -Recurse -Force
    }
    return (Join-Path $dest 'cante-gui.exe')
}

function Test-AncestorNodeModules([string]$Dir) {
    $cur = $Dir
    for ($i = 0; $i -lt 12; $i++) {
        $nm = Join-Path $cur 'node_modules'
        if (Test-Path $nm) { return $cur }
        $parent = Split-Path $cur -Parent
        if (-not $parent -or $parent -eq $cur) { break }
        $cur = $parent
    }
    return ''
}

function Resolve-TauriDriver {
    $c = Join-Path $HOME '.cargo\bin\tauri-driver.exe'
    if (Test-Path $c) { return $c }
    $onPath = (Get-Command tauri-driver.exe -ErrorAction SilentlyContinue).Source
    if ($onPath) { return $onPath }
    return $null
}

function Resolve-MsEdgeDriver {
    foreach ($c in @(
        (Join-Path $script:Repo 'gui\e2e-windows\msedgedriver\msedgedriver.exe'),
        'C:\cante\gui\e2e-windows\msedgedriver\msedgedriver.exe'
    )) {
        if (Test-Path $c) { return (Resolve-Path $c).Path }
    }
    return $null
}

# --- 会话判断：必须是不提权的交互会话（提权会让 WebView2 忽略 WEBVIEW2_* 调试端口变量） ---
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
$sessionId = (Get-Process -Id $PID).SessionId
$hasDesktop = [bool](Get-Process explorer -ErrorAction SilentlyContinue)
Say ("会话：session=$sessionId elevated=$isAdmin 有桌面=$hasDesktop")
if ($isAdmin) {
    Say '环境问题：当前是提权会话。WebView2 150+ 在提权进程里会忽略 WEBVIEW2_* 调试端口变量，'
    Say '          WebDriver 会以「DevToolsActivePort file doesn''t exist」失败。'
    Say '          请用「当前用户 + Interactive + RunLevel Limited」的计划任务跑（见 DEVELOPING-WINDOWS-VM.md 坑 3）。'
    exit 2
}
if (-not $hasDesktop) {
    Say '环境问题：这个会话没有交互桌面（Session 0？），GUI 建不出窗口。'
    exit 2
}

$exePath = Resolve-InstalledExe $Exe
if (-not $exePath) { Say '环境问题：找不到 cante-gui.exe'; exit 2 }

Say ''
Say '=== 清掉上一轮残留的子进程（否则调试端口被占，会误判成产品坏了）==='
Clear-StaleProcesses
Clear-StaleRelays

# 摆到隔离目录：从工作树直接跑会被祖先 node_modules 干扰，pi 起不来。
$appRoot = Join-Path $WorkRoot 'app-root'
New-Item -ItemType Directory -Force -Path $appRoot | Out-Null
$shadow = Test-AncestorNodeModules (Split-Path $exePath)
$stagedExe = Stage-IsolatedApp $exePath $appRoot
if (-not (Test-Path $stagedExe)) { Say '环境问题：把应用摆到隔离目录失败'; exit 2 }
Say ("应用（原始）：" + $exePath)
if ($shadow) { Say ("  祖先目录有 node_modules：" + $shadow + "（会干扰随包 pi 的模块解析）") }
Say ("应用（隔离副本）：" + $stagedExe)
$exePath = $stagedExe

$tauriDriver = Resolve-TauriDriver
if (-not $tauriDriver) { Say '环境问题：找不到 tauri-driver.exe'; exit 2 }
$msedge = Resolve-MsEdgeDriver
if (-not $msedge) { Say '环境问题：找不到 msedgedriver.exe'; exit 2 }
$sheetsBin = Join-Path (Split-Path $exePath) 'cante-sheets.exe'
if (-not (Test-Path $sheetsBin)) { Say "环境问题：找不到 cante-sheets.exe（$sheetsBin）"; exit 2 }

# dead/cut/forbid 各用一个固定端口，避免互相踩。
if ($RelayPort -eq 0) {
    $RelayPort = switch ($Scenario) { 'dead' { 18090 } 'cut' { 18091 } 'forbid' { 18092 } }
}

# WebDriver 端口：挑一个空闲的（不写死）。
function Get-FreePort {
    for ($i = 0; $i -lt 20; $i++) {
        $p = Get-Random -Minimum 25000 -Maximum 45000
        if (-not (Get-NetTCPConnection -LocalPort $p -ErrorAction SilentlyContinue)) { return $p }
    }
    return 4444
}
if ($WdPort -eq 0) { $WdPort = Get-FreePort }

if (-not $WorkRoot) {
    $WorkRoot = Join-Path $env:TEMP ("cante-offline-" + $Scenario + "-" + (Get-Date -Format 'yyyyMMdd-HHmmss'))
}
New-Item -ItemType Directory -Force -Path $WorkRoot | Out-Null
$jobDir = Join-Path $WorkRoot 'job'
$artifacts = Join-Path $WorkRoot 'artifacts'
New-Item -ItemType Directory -Force -Path $jobDir, $artifacts | Out-Null

Say ''
Say "=== 现场：$Scenario ==="
Say ("运行目录：" + $WorkRoot)
Say ("应用：" + $exePath)
Say ("假服务方端口：" + $RelayPort)
Say ("WebDriver 端口：" + $WdPort)

# ---------------------------------------------------------------------------
# 1) 造一个只属于这一轮的 pi 配置目录，把服务方指向我们摆的那个端口。
#    为什么用 PI_CODING_AGENT_DIR 而不是改 ~/.pi：那一份是这台机器真正在用的配置，
#    动它会把"跑在机器上的 pi"也指坏；而且验收完不该留下痕迹。
# ---------------------------------------------------------------------------
$script:piConfig = Join-Path $WorkRoot 'pi-config'
New-Item -ItemType Directory -Force -Path $script:piConfig | Out-Null
$baseUrl = "http://127.0.0.1:$RelayPort/v1"
$models = [ordered]@{
    providers = [ordered]@{
        probe = [ordered]@{
            api = 'openai-completions'
            apiKey = 'sk-probe-not-a-real-key'
            baseUrl = $baseUrl
            models = @([ordered]@{
                api = 'openai-completions'; id = 'relay-model'; name = 'relay-model'
                maxTokens = 4096; contextWindow = 128000; input = @('text')
            })
        }
    }
}
$models | ConvertTo-Json -Depth 10 | Set-Content -Path (Join-Path $script:piConfig 'models.json') -Encoding UTF8
[ordered]@{ defaultProvider = 'probe'; defaultModel = 'relay-model' } |
    ConvertTo-Json | Set-Content -Path (Join-Path $script:piConfig 'settings.json') -Encoding UTF8
Say ("pi 配置目录：" + $script:piConfig + "（baseUrl=" + $baseUrl + "）")
# 注入哨兵：pi 真去用了这个配置目录时，它会在这里自己写 auth.json / models-store.json。
# 跑完看不到这两个文件 = **现场根本没摆上**（pi 走的是别的配置，比如这台机器的真网关）。
# 为什么必须查：实跑里有过一次「明明指了死端口、结果它用真网关干成了活」——
# 那一轮的屏幕是成功的，但结论完全不可信（没断的东西当然不会报断）。
$script:sentinel = @('auth.json', 'models-store.json')

# ---------------------------------------------------------------------------
# 2) 造输入表（用应用自带的 cante-sheets，连输入都是产品自己的工具产出的）
# ---------------------------------------------------------------------------
$csv = Join-Path $jobDir 'input.csv'
@(
    '区域,月份,客户,金额',
    '华东区,3月,甲公司,1200',
    '华南区,3月,乙公司,980',
    '华东区,4月,丙公司,1500',
    '华北区,4月,丁公司,1100',
    '华东区,5月,戊公司,760'
) -join "`n" | Set-Content -Path $csv -Encoding UTF8
$inputXlsx = Join-Path $jobDir '销售明细.xlsx'
if (Test-Path $inputXlsx) { Remove-Item $inputXlsx -Force }
$make = Run-Command $sheetsBin @('write', $inputXlsx, $csv, '--sheet', '明细') 120
if ($make.Code -ne 0) { Say ("环境问题：cante-sheets write 失败：" + $make.Stderr); exit 2 }
$hashBefore = (Get-FileHash $inputXlsx -Algorithm SHA256).Hash
Say ("输入：" + $inputXlsx)
Say ("输入 sha256（跑之前）：" + $hashBefore)

# ---------------------------------------------------------------------------
# 3) 起假服务方（dead 模式的 relay 会立即退出 —— 端口保持没人听）
# ---------------------------------------------------------------------------
$relayScript = Join-Path $script:Here 'offline-probe\relay.mjs'
$relayLog = Join-Path $WorkRoot ("relay-" + $Scenario + ".log")
$relayProc = $null
if (Test-Path $relayScript) {
    $relayProc = Start-Process -FilePath 'node' -ArgumentList @($relayScript, $Scenario, "$RelayPort") `
        -RedirectStandardOutput $relayLog -RedirectStandardError ($relayLog + '.err') -PassThru -WindowStyle Hidden
    Start-Sleep -Seconds 2
    Say ("假服务方进程 pid=" + $relayProc.Id + "，日志：" + $relayLog)
    if (Test-Path $relayLog) { SayLines ((Get-Content $relayLog -TotalCount 5) -join "`n") }
    # 现场必须是我们摆的那个：端口没人听 ≠ 我们的 relay 在听。
    if ((Test-Path $relayLog) -and ((Get-Content $relayLog -Raw) -match 'EADDRINUSE')) {
        Say '环境问题：假服务方绑不上端口（EADDRINUSE）—— 一定是上一轮的 relay 还在跑，现场不是我们摆的那个。'
        Say '           先清掉残留 relay（脚本开头的 Clear-StaleRelays 就是干这个），再跑。'
        exit 2
    }
    if (Test-Path ($relayLog + '.err')) {
        $errText = Get-Content ($relayLog + '.err') -Raw -ErrorAction SilentlyContinue
        if ($errText -and $errText -match 'EADDRINUSE') {
            Say '环境问题：假服务方绑不上端口（EADDRINUSE，见 ' + $relayLog + '.err）'
            exit 2
        }
    }
} else {
    Say ("环境问题：找不到 relay.mjs（" + $relayScript + "）")
    exit 2
}

# 确认端口状态符合预期（dead = 没人听；cut/forbid = 在听）—— 记事实，不猜。
$probe = Test-NetConnection -ComputerName 127.0.0.1 -Port $RelayPort -WarningAction SilentlyContinue
$listening = [bool]$probe.TcpTestSucceeded
Say ("端口 " + $RelayPort + " 有人听 = " + $listening + "（dead 期望 False，cut/forbid 期望 True）")

$env:OFFLINE_APP = $exePath
$env:OFFLINE_INPUT = $inputXlsx
$env:OFFLINE_WORKDIR = $jobDir
$env:OFFLINE_SCENARIO = $Scenario
$env:OFFLINE_ARTIFACTS = $artifacts
$env:OFFLINE_MSEDGEDRIVER = $msedge
$env:OFFLINE_TAURI_DRIVER = $tauriDriver
$env:OFFLINE_PI_CONFIG_DIR = $script:piConfig
$env:OFFLINE_STALL_SECS = [string]$StallSecs
$env:OFFLINE_DIALOG_HELPER = Join-Path $script:Here 'accept-file-dialog.ps1'
$env:OFFLINE_RESULT_JSON = Join-Path $artifacts 'offline-result.json'
$env:OFFLINE_WD_PORT = [string]$WdPort
$env:OFFLINE_TIMEOUT_MS = [string](($TimeoutSec - 120) * 1000)

# 清应用档案：向导只在全新档案（或真的没走过向导）时出现。不清的话，上一轮留下的
# 状态会让首页/向导的预期时有时无 —— 现场本身没变，但屏幕变了，结论就不可比。
$profileDir = Join-Path $env:LOCALAPPDATA 'dev.cante.gui'
if (Test-Path $profileDir) {
    Remove-Item $profileDir -Recurse -Force -ErrorAction SilentlyContinue
    Say ("已清应用档案：" + $profileDir)
}

Say ''
Say '=== 跑一张卡，直到结局页（成功/失败都算结局，都落盘）==='
$drive = Run-Command 'node' @((Join-Path $script:Here 'offline-probe\drive-offline.mjs')) $TimeoutSec
SayLines $drive.Stdout
if ($drive.Stderr) { Say '  --- driver stderr ---'; SayLines $drive.Stderr }

# ---------------------------------------------------------------------------
# 4) 核对原文件哈希（产品律：原文件绝不被改动）
# ---------------------------------------------------------------------------
$hashAfter = (Get-FileHash $inputXlsx -Algorithm SHA256).Hash
Say ''
Say ("输入 sha256（跑之后）：" + $hashAfter)
Say ("原文件哈希一致 = " + ($hashBefore -eq $hashAfter))

# 现场到底摆上了没有：看 pi 有没有在我们的配置目录里留下痕迹。
$script:injected = $true
foreach ($name in $script:sentinel) {
    if (-not (Test-Path (Join-Path $script:piConfig $name))) { $script:injected = $false }
}
Say ("现场注入了 = " + $script:injected + "（看 pi 有没有在配置目录里写 auth.json / models-store.json）")
if (-not $script:injected) {
    Say '   ✗ 这一轮**不算数**：pi 没有用我们摆的配置目录，现场没摆上（它很可能走了这台机器的真网关）。'
    Say '     屏幕上是成功也好、失败也好，都不能当作这一种现场的证据。'
}

$result = $null
$resultPath = $env:OFFLINE_RESULT_JSON
if (Test-Path $resultPath) {
    $result = Get-Content $resultPath -Raw -Encoding UTF8 | ConvertFrom-Json
    Say ("结局：" + $result.outcome)
}

# 写出这一轮的人看报告（含屏幕原文）
$report = Join-Path $WorkRoot 'report.txt'
$footer = @(
    '',
    '=== 哈希对照 ===',
    ('输入表：' + $inputXlsx),
    ('跑之前 sha256：' + $hashBefore),
    ('跑之后 sha256：' + $hashAfter),
    ('一致 = ' + ($hashBefore -eq $hashAfter))
)
($script:Lines + $footer) -join "`r`n" | Set-Content -Path $report -Encoding UTF8
Say ''
Say ("报告：" + $report)
Say ("产物目录：" + $artifacts)

if ($relayProc -and -not $relayProc.HasExited) {
    try { Stop-Process -Id $relayProc.Id -Force } catch {}
    Say ("假服务方已停（pid=" + $relayProc.Id + "）")
}

# 收尾也清一次：driving 失败时 tauri-driver/msedgedriver 会留下来占端口。
Clear-StaleProcesses
Clear-StaleRelays

if ($drive.Code -eq 124) { Say '产品/流程问题：驱动超时（整轮没在上限内结束）'; exit 3 }
if ($drive.Code -ne 0) { Say ('产品/流程问题：驱动退出码 ' + $drive.Code + '（没到结局页，见上面的输出）'); exit 3 }
if (-not $script:injected) {
    Say '环境问题：现场没注入（见上面「现场注入了 = False」）—— 这一轮的结果不能用。'
    exit 2
}
exit 0
