# 「服务方真的没了」几种现场的真机验收驱动（#197 P1 + 本轮补的两场）。
#
# 它做一件事：为一种现场摆好条件（假服务方，或**真的防火墙出站阻断**）+ 把 pi 指过去，
# 跑一张卡，把**她屏幕上那一屏**原样落盘（文字 / HTML / 截图 / 结构化结果 / 原文件哈希）。
#
# 六种现场（-Scenario）：
#   dead     —— 服务方端口不可达：把 pi 指到一个**没人听**的端口（连 TCP 都握不上）；
#   cut      —— 中途断掉：服务方答到第 2 个工具调用后彻底静音（不发 FIN，socket 挂着）；
#   forbid   —— 代理挡住：每个请求都回 403（公司网关那种）；
#   busy     —— 服务方自己忙不过来/这个月用完了（#286）：每个请求都回 503 +
#               「insufficient credits」。这一场要证的是她看到的既不是「你的文件有问题」、
#               也不是「你没配好」，而是「等一会儿 → 一直这样再找管网络的同事」那套话。
#   wire     —— **真把出站掐掉**（本轮新增）：**不是我们摆的假服务方**，而是用 Windows
#               防火墙按远端端口把这个应用自己的 `pi\bun.exe` 挡住，让它够不到真正的服务方。
#               这一场最接近「她的网线被拔了 / 公司网关把流量掐了」。
#               为什么按程序隔离：这台机器上验收 agent 自己也连着同一个网关端口，纯端口规则
#               会把验收者一起掐死（规则加/删都在报告里留证）。
#   proxy407 —— 代理**要你先登录/验证**（本轮新增）：假服务方对每个请求回 407 +
#               Proxy-Authenticate。它与 403 是**不同**的错法（403=就是不让过，
#               407=先证明你是谁），上一轮没覆盖。
#
# 它**只**摆现场、跑、落盘；结论由人写进报告 —— 脚本不替报告下结论。
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File gui\scripts\windows\run-offline.ps1 -Scenario dead
#   ... -Scenario cut       -StallSecs 90
#   ... -Scenario forbid
#   ... -Scenario busy
#   ... -Scenario proxy407
#   ... -Scenario wire      -Gateway "<主机>:<端口>"   # 不给就自动读这台机器默认服务方的地址
#
# 退出码：0 = 到了结局页并落盘；2 = 环境问题（应用/驱动/组件不在、会话建不起来、现场没摆上）；
#         3 = 产品/流程问题（没到任何结局页）。
#
# 注意：本文件必须保存为 UTF-8 with BOM（Windows PowerShell 5.1 否则按 GBK 解析中文）。

param(
    [Parameter(Mandatory = $true)][ValidateSet('dead', 'cut', 'forbid', 'wire', 'proxy407', 'busy')][string]$Scenario,
    [string]$Exe = "",
    [string]$WorkRoot = "",
    # 停滞后判据（秒）。产品的默认是 600（10 分钟）；这里默认压到 120，
    # 因为这一轮要**看见**桥报那条停滞，而不是真等 10 分钟。报告里会写明实际值。
    [int]$StallSecs = 120,
    [int]$TimeoutSec = 1500,
    # 造现场用的本地端口（dead/cut/forbid/proxy407 各用一个，避免互相踩）。
    [int]$RelayPort = 0,
    # wire 那一场要掐的服务方地址（"主机:端口"）。不给就自动读这台机器默认服务方的地址。
    # 报告里写 <网关地址>，不许出现真实内网地址。
    [string]$Gateway = "",
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
# 顺序坑：下面这几行以前在**第 255 行**才给 $WorkRoot 赋默认值，而它在这里就被用了 ✗
# —— $WorkRoot 空 -> Join-Path 直接抛 ParameterArgumentValidationErrorEmptyStringNotAllowed，
# 整轮死在"摆隔离目录"这一步（实测：wire 场景就是这么死的 ✗）。先算好再用。
if (-not $WorkRoot) {
    $WorkRoot = Join-Path $env:TEMP ("cante-offline-" + $Scenario + "-" + (Get-Date -Format 'yyyyMMdd-HHmmss'))
}
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

# dead/cut/forbid/proxy407 各用一个固定端口，避免互相踩（wire 不用中继端口）。
if ($RelayPort -eq 0) {
    $RelayPort = switch ($Scenario) { 'dead' { 18090 } 'cut' { 18091 } 'forbid' { 18092 } 'proxy407' { 18093 } 'busy' { 18095 } default { 18094 } }
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

New-Item -ItemType Directory -Force -Path $WorkRoot | Out-Null
$jobDir = Join-Path $WorkRoot 'job'
$artifacts = Join-Path $WorkRoot 'artifacts'
New-Item -ItemType Directory -Force -Path $jobDir, $artifacts | Out-Null

Say ''
Say "=== 现场：$Scenario ==="
Say ("运行目录：" + $WorkRoot)
Say ("应用：" + $exePath)
if ($Scenario -ne 'wire') { Say ("假服务方端口：" + $RelayPort) }
Say ("WebDriver 端口：" + $WdPort)

# ---------------------------------------------------------------------------
# 0) wire 那一场：先把要掐的服务方地址定下来（默认读这台机器默认服务方的地址）。
#    地址只活在内存和这一轮的日志里；报告里一律写 <网关地址>。
# ---------------------------------------------------------------------------
$script:wireHost = ''
$script:wirePort = 0
$script:wireRuleName = 'cante-offline-wire'
$script:fwResult = Join-Path ([System.IO.Path]::GetTempPath()) 'cante-offline-fw-result.txt'
$script:wireRuleApplied = $false
$script:wireRuleRemoved = $true
$script:wireAppBun = ''
$script:wireBeforeConnect = '(n/a)'
$script:wireAfterConnect = '(n/a)'

function Resolve-Gateway([string]$Spec) {
    if ($Spec -match '^(.+):(\d+)$') { return @($Matches[1], [int]$Matches[2]) }
    # 没给就读这台机器默认服务方的 baseUrl（不落盘、不打印）。
    $modelsPath = Join-Path $HOME '.pi\agent\models.json'
    if (-not (Test-Path $modelsPath)) { return $null }
    try {
        $json = Get-Content $modelsPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $settingsPath = Join-Path $HOME '.pi\agent\settings.json'
        $defaultProvider = ''
        if (Test-Path $settingsPath) {
            $s = Get-Content $settingsPath -Raw -Encoding UTF8 | ConvertFrom-Json
            $defaultProvider = [string]$s.defaultProvider
        }
        $names = @($json.providers.PSObject.Properties.Name)
        if (-not $defaultProvider) { $defaultProvider = $names[0] }
        $baseUrl = [string]$json.providers.$defaultProvider.baseUrl
        if ($baseUrl -match '^https?://([^/:]+):(\d+)') { return @($Matches[1], [int]$Matches[2]) }
    } catch { return $null }
    return $null
}

function Invoke-Elevated([string[]]$ArgList) {
    # RunAs 会弹 UAC；这台机器是 ConsentPromptBehaviorAdmin=0（直接提升，不弹密保桌面），
    # 实测静默通过。拿不到提升就如实失败，不假装规则加上了。
    $script:fwResult = Join-Path ([System.IO.Path]::GetTempPath()) 'cante-offline-fw-result.txt'
    Remove-Item $script:fwResult -ErrorAction SilentlyContinue
    try {
        $p = Start-Process powershell -ArgumentList (@('-NoProfile', '-ExecutionPolicy', 'Bypass') + $ArgList) -Verb RunAs -PassThru -WindowStyle Hidden
        if (-not $p.WaitForExit(120000)) { try { $p.Kill() } catch {}; return [pscustomobject]@{ ok = $false; why = '提权过程超时' } }
    } catch {
        return [pscustomobject]@{ ok = $false; why = ('提权失败（' + $_.Exception.Message + '）') }
    }
    if (-not (Test-Path $script:fwResult)) { return [pscustomobject]@{ ok = $false; why = '提权进程没留下结果文件' } }
    $text = Get-Content $script:fwResult -Raw -Encoding UTF8
    return [pscustomobject]@{ ok = ($p.ExitCode -eq 0); why = $text.Trim(); text = $text.Trim() }
}

if ($Scenario -eq 'wire') {
    $gw = Resolve-Gateway $Gateway
    if (-not $gw) {
        Say '环境问题：wire 现场需要服务方地址（-Gateway "主机:端口"），也没能从这台机器的默认服务方读出来。'
        exit 2
    }
    $script:wireHost = $gw[0]
    $script:wirePort = $gw[1]
    # 掐的是应用随包的那个动手组件（pi\bun.exe）。它就在隔离副本旁边。
    $script:wireAppBun = Join-Path (Split-Path $exePath) 'pi\bun.exe'
    if (-not (Test-Path $script:wireAppBun)) {
        Say ("环境问题：wire 现场找不到应用随包的动手组件（" + $script:wireAppBun + '）')
        exit 2
    }
    Say ("要掐的服务方：" + $script:wireHost + ':' + $script:wirePort + '（报告里写 <网关地址>）')
    Say ("被掐的程序：" + $script:wireAppBun)
}

# ---------------------------------------------------------------------------
# 1) 造一个只属于这一轮的 pi 配置目录。
#    * dead/cut/forbid/proxy407/busy：把服务方指向我们摆的本地中继。
#    * wire：把服务方指向**真的服务方**（也就是这台机器默认那个），因为这一场要验的
#      就是「真正的出站被系统级挡掉」——如果还指向本地中继，那就又变成我们摆的现场了。
#    为什么用 PI_CODING_AGENT_DIR 而不是改 ~/.pi：那一份是这台机器真正在用的配置，
#    动它会把"跑在机器上的 pi"也指坏；而且验收完不该留下痕迹。
# ---------------------------------------------------------------------------
$script:piConfig = Join-Path $WorkRoot 'pi-config'
New-Item -ItemType Directory -Force -Path $script:piConfig | Out-Null
if ($Scenario -eq 'wire') {
    # 把这台机器默认服务方的配置**拷进**隔离目录：pi 会用真地址、真凭据，
    # 但配置目录仍是我们这一轮的（哨兵照样能查出「现场真的注入了吗」）。
    foreach ($name in @('models.json', 'settings.json')) {
        $from = Join-Path $HOME (".pi\agent\" + $name)
        if (Test-Path $from) { Copy-Item $from (Join-Path $script:piConfig $name) -Force }
    }
    Say ("pi 配置目录：" + $script:piConfig + "（wire：沿用这台机器默认服务方的地址与凭据，配置目录是本轮的）")
} else {
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
}
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
# 3) 摆现场。
#    * dead/cut/forbid/proxy407/busy：起假服务方（dead 模式的 relay 会立即退出 —— 端口保持没人听）。
#    * wire：**不起中继**，而是用 Windows 防火墙把这个应用自己的动手组件
#      （`pi\bun.exe`）到真服务方的出站掐掉。这是本轮新增的那种「真拔网线」。
# ---------------------------------------------------------------------------
$relayScript = Join-Path $script:Here 'offline-probe\relay.mjs'
$relayLog = Join-Path $WorkRoot ("relay-" + $Scenario + ".log")
$relayProc = $null

if ($Scenario -eq 'wire') {
    $fwScript = Join-Path $script:Here 'offline-probe\fw-rule.ps1'
    if (-not (Test-Path $fwScript)) { Say ("环境问题：找不到 fw-rule.ps1（" + $fwScript + '）'); exit 2 }

    # 3.0 **先清一次残留**：上一次跑如果中途死掉（超时、断电、被杀），
    #     那条系统级阻断规则会留在机器上 —— 实测真的留下过一条。
    #     有就删掉并**如实说**，然后才继续。
    $pre = Invoke-Elevated @('-File', $fwScript, '-Mode', 'query')
    if ($pre.why -notmatch 'ABSENT') {
        Say ('开跑前发现上一次留下的阻断规则（' + $pre.why + '）—— 先删掉再继续。')
        $preDel = Invoke-Elevated @('-File', $fwScript, '-Mode', 'del')
        Say ("（提权）清残留：" + $preDel.why)
        if (-not $preDel.ok) { Say '环境问题：清不掉上一次留下的阻断规则 —— 先人工处理，这一轮不算数。'; exit 2 }
    }

    # 3a. 加规则**之前**：被掐的那个程序连得上服务方吗？
    #     必须用**被挡住的那个程序**（pi\bun.exe）来跑这把尺子 —— 用 node 跑是错的：
    #     规则只按 bun.exe 拦，node 跑当然照样通，那就证明不了“拦住了”。
    $connectCheck = Join-Path $script:Here 'offline-probe\connect-check.mjs'
    $beforeCheck = Run-Command $script:wireAppBun @($connectCheck, $script:wireHost, "$($script:wirePort)", '8000') 30
    $script:wireBeforeConnect = ($beforeCheck.Stdout.Trim() + ' (exit ' + $beforeCheck.Code + ')')
    Say ("加规则前，被掐的那个程序连 " + '<网关地址>' + " 通吗：" + $script:wireBeforeConnect)

    # 3b. 加规则（提权）。
    $add = Invoke-Elevated @('-File', $fwScript, '-Mode', 'add', '-Program', $script:wireAppBun, '-RemotePort', "$($script:wirePort)")
    Say ("（提权）加规则：" + $add.why)
    if (-not $add.ok) { Say '环境问题：防火墙规则没加上（提权失败？）—— 这一轮不算数。'; exit 2 }
    $script:wireRuleApplied = $true

    # 3c. 加规则**之后**：用同一个程序再连一次，确认真的按住了。
    Start-Sleep -Seconds 2
    $afterCheck = Run-Command $script:wireAppBun @($connectCheck, $script:wireHost, "$($script:wirePort)", '8000') 30
    $script:wireAfterConnect = ($afterCheck.Stdout.Trim() + ' (exit ' + $afterCheck.Code + ')')
    Say ("加规则后，同一个程序再连一次：" + $script:wireAfterConnect)
    if ($afterCheck.Code -eq 0) {
        Say '环境问题：规则加上了但连接仍成功 —— 现场没摆上（可能规则没生效，或者程序路径不对）。这一轮不算数。'
        exit 2
    }
    Say '现场已摆上：同一条连接在加规则前通、加规则后被拒/超时。'
} elseif (Test-Path $relayScript) {
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

# 确认端口状态符合预期（dead = 没人听；cut/forbid/proxy407/busy = 在听）—— 记事实，不猜。
# wire 没有本地中继端口（它挡的是到真服务方的出站），所以这一条跳过。
if ($Scenario -ne 'wire') {
    $probe = Test-NetConnection -ComputerName 127.0.0.1 -Port $RelayPort -WarningAction SilentlyContinue
    $listening = [bool]$probe.TcpTestSucceeded
    Say ("端口 " + $RelayPort + " 有人听 = " + $listening + "（dead 期望 False，其余期望 True）")
}

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

$result = $null
$resultPath = $env:OFFLINE_RESULT_JSON
if (Test-Path $resultPath) {
    $result = Get-Content $resultPath -Raw -Encoding UTF8 | ConvertFrom-Json
    Say ("结局：" + $result.outcome)
}

# ---------------------------------------------------------------------------
# busy 那一场（#286）：屏幕上的话必须是「服务方用不了」那一套 —— 中文、两步出路，
# 而且**不把英文原文/状态码端给她**（原文只该藏在「复制详情」里）。
# 期望文案从**产品源码里取**（copy-service.ts），不手抄 —— 手抄会漂移。
# ---------------------------------------------------------------------------
$script:busyFailed = $false
if ($Scenario -eq 'busy') {
    $copySrc = Get-Content (Join-Path $script:Repo 'gui\src\simple\copy-service.ts') -Raw -Encoding UTF8
    $waitLabel = [regex]::Match($copySrc, 'wait:\s*\{\s*label:\s*"([^"]+)"').Groups[1].Value
    $waitWhy = [regex]::Match($copySrc, 'wait:\s*\{\s*label:\s*"[^"]+",\s*why:\s*"([^"]+)"').Groups[1].Value
    $adminLabel = [regex]::Match($copySrc, 'admin:\s*\{\s*label:\s*"([^"]+)"').Groups[1].Value
    $adminWhy = [regex]::Match($copySrc, 'admin:\s*\{\s*label:\s*"[^"]+",\s*why:\s*"([^"]+)"').Groups[1].Value
    $screen = [string]$result.outcomeText
    Say ''
    Say '=== busy 那一场的判据（#286：服务方忙/用完，说的是不是人话）==='
    $bad = 0
    foreach ($pair in @(
        @('按钮「过一会儿再试」', $waitLabel),
        @('那句解释', $waitWhy),
        @('按钮「复制详情给管网络的同事」', $adminLabel),
        @('那句解释', $adminWhy))) {
        $hit = ($screen.Contains([string]$pair[1]))
        Say ('  ' + $(if ($hit) { '[对]' } else { '[缺]' }) + ' ' + $pair[0] + '：' + $pair[1])
        if (-not $hit) { $bad++ }
    }
    # 零术语：英文原文/状态码/「额度」不该出现在她看的这一屏。
    foreach ($word in @('insufficient', 'quota', 'credits', '503', '429', '额度')) {
        $hit = ($screen.Contains($word))
        Say ('  ' + $(if ($hit) { '[✗ 出现了]' } else { '[对] 没有' }) + ' ' + $word)
        if ($hit) { $bad++ }
    }
    Say ('  → ' + $(if ($bad -eq 0) { '通过' } else { "不通过（$bad 条不对）" }))
    if ($bad -gt 0) { $script:busyFailed = $true }
}

# wire 那一场：无论如何都要把规则删掉（这是系统级改动，不能留在机器上）。
# 删不掉要大声说出来 —— 一条留下的阻断规则会让**下一次**验收莫名其妙。
if ($script:wireRuleApplied) {
    $fwScript = Join-Path $script:Here 'offline-probe\fw-rule.ps1'
    $del = Invoke-Elevated @('-File', $fwScript, '-Mode', 'del')
    Say ("（提权）删规则：" + $del.why)
    $script:wireRuleRemoved = $del.ok
    # 删完再查一次，确认真的不在了。
    $query = Invoke-Elevated @('-File', $fwScript, '-Mode', 'query')
    Say ("删后复查：" + $query.why)
    if ($query.why -notmatch 'ABSENT') {
        Say '  ✗ 规则删除后复查不是 ABSENT —— 机器上可能还留着一条阻断规则，请手动确认。'
        $script:wireRuleRemoved = $false
    }
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
if ($Scenario -eq 'wire') {
    $footer += @(
        '',
        '=== wire 那一场的事实（服务方地址写 <网关地址>）===',
        ('服务方：<网关地址>（本机日志里是真实值）'),
        ('被掐的程序：' + $script:wireAppBun),
        ('规则名：' + $script:wireRuleName),
        ('加规则前的连接：' + $script:wireBeforeConnect),
        ('加规则后的连接：' + $script:wireAfterConnect),
        ('规则加上了 = ' + $script:wireRuleApplied),
        ('规则删掉了 = ' + $script:wireRuleRemoved)
    )
}
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
if (-not $script:wireRuleRemoved -and $script:wireRuleApplied) {
    Say '环境问题：防火墙规则没能确认删除 —— 先手动清掉再说话（不让把机器带着一条阻断规则离开）。'
    exit 2
}
# 现场真的摆上了吗。
#   * 非 wire：看 pi 有没有在我们的配置目录里留下哨兵文件（上一轮的经验：没有哨兵就是没注入）。
#   * wire：哨兵不适用（我们拷的就是这台机器的真配置，pi 不一定重新写 auth.json）。
#     改用一个更硬的反向判据：**如果这一场真的被挡住了，就绝不可能出现「做好了」**。
#     屏幕成功 = 阻断没咬到（现场没摆上）。再加一条由驱动层亲自报的 `wireBlocked`。
$script:injected = $true
if ($Scenario -eq 'wire') {
    $wireDone = $result -and $result.outcome -eq 'done'
    Say ("wire 现场反向判据：结局=done 吗？" + $wireDone + '（期望 False —— 被挡住就该报错，不该做成一件事）')
    if ($wireDone) { $script:injected = $false }
} else {
    foreach ($name in $script:sentinel) {
        if (-not (Test-Path (Join-Path $script:piConfig $name))) { $script:injected = $false }
    }
    Say ("现场注入了 = " + $script:injected + "（看 pi 有没有在配置目录里写 auth.json / models-store.json）")
}
if (-not $script:injected) {
    Say '   ✗ 这一轮**不算数**：现场没摆上（哨兵不在 / 或被阻断的那一场竟然做成了）。'
    Say '     屏幕上是成功也好、失败也好，都不能当作这一种现场的证据。'
    Say '环境问题：现场没摆上（见上面「不算数」那几行）—— 这一轮的结果不能用。'
    exit 2
}
if ($script:busyFailed) {
    Say '产品问题：busy 现场屏幕上那套话不对（逐条见上，判据取自 copy-service.ts）。'
    exit 3
}
exit 0
