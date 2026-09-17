# 「装好的应用真的干成一件活」的发布闸门（Windows 真机）。
#
# 它回答产品最核心的一句话：她那边零手工 —— 双击安装 → 打开 → 点一张卡 → 真的出一份文件。
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File accept-install.ps1 -Version 0.2.1
#   powershell -NoProfile -ExecutionPolicy Bypass -File accept-install.ps1 -Installer "C:\...\Cante_0.2.1_x64-setup.exe"
#
# 它做五件事，每一步都打印实际耗时：
#   1. 取安装包（给路径就用它；给 -Version 就从 GitHub Release 下载）
#   2. 静默安装，并列出安装目录（断言三个自带 exe + 卸载器都在、没有 .d / 0 字节垃圾）
#   3. 启动应用（CANTE_BIN 指向**包里那个** cante-bridge.exe、PI_BIN 指向这台机器上的 pi），
#      用 UI Automation 读窗口文字，断言第一屏是中文简单模式向导第 1 步，并把文字原样贴出来
#   4. 真的干成一件活：tauri-driver + WebDriver 在真实 WebView2 里点卡片 → 选文件
#      （原生对话框由 accept-file-dialog.ps1 填）→ 写一句话 → 生成计划 → 开始，
#      跑的过程中替她把审批页点成「允许这次」；结束后用**应用自带的** cante-sheets
#      读回产出文件核对内容，并比对原文件 sha256（没被改动）
#   5. 静默卸载，并列出卸载后检查的位置
#
# 为什么要替她设 CANTE_BIN / PI_BIN：这是**脚本替她做的**，从她的角度看仍然是「双击就行」。
# #150 之后连这一层都不需要（执行组件随包发），那时这两个变量就该从这个脚本里删掉。
#
# 注意：本文件必须保存为 UTF-8 with BOM（Windows PowerShell 5.1 否则按 GBK 解析中文）。

param(
    [string]$Installer = "",
    [string]$Version = "",
    [string]$WorkDir = "$env:TEMP\cante-accept-harness",
    [string]$Card = "从大表里挑出想要的行",
    [string]$Instruction = "把华东区的记录挑出来，另存成一张新表",
    [int]$JobTimeoutSec = 1200,
    [switch]$SkipUninstall,
    [switch]$KeepArtifacts
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$script:Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$script:GuiRoot = (Resolve-Path (Join-Path $script:Here '..\..')).Path
$script:RepoRoot = (Resolve-Path (Join-Path $script:GuiRoot '..')).Path
$script:InstallDir = Join-Path $env:LOCALAPPDATA 'Cante'
$script:ProfileDir = Join-Path $env:LOCALAPPDATA 'dev.cante.gui'
$script:Timings = New-Object System.Collections.Generic.List[object]

function Say($text) { Write-Output $text }
function Fail($text) { throw $text }

function Record-Step([string]$Name, [scriptblock]$Body) {
    Say ''
    Say ("==> " + $Name)
    $watch = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        & $Body
        $watch.Stop()
        $script:Timings.Add([pscustomobject]@{ Step = $Name; Seconds = [math]::Round($watch.Elapsed.TotalSeconds, 1); Result = 'OK' })
    } catch {
        $watch.Stop()
        $script:Timings.Add([pscustomobject]@{ Step = $Name; Seconds = [math]::Round($watch.Elapsed.TotalSeconds, 1); Result = ('FAIL: ' + $_.Exception.Message) })
        throw
    }
}

function Run-Command([string]$File, [string[]]$Arguments, [int]$TimeoutSec = 300) {
    # 外部命令统一带超时：卡住的子进程不该把整轮挂死（AGENTS.md §5）。
    # 用 .NET Process 而不是 Start-Process：后者在带重定向时拿不到 ExitCode（实测），
    # 而且读回来的字节会按 ANSI 解码，中文全成乱码。这里显式按 UTF-8 读、异步读流。
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $File
    $psi.Arguments = (($Arguments | ForEach-Object { '"' + ($_ -replace '"', '\"') + '"' }) -join ' ')
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
    $psi.StandardErrorEncoding = [System.Text.Encoding]::UTF8
    $proc = New-Object System.Diagnostics.Process
    $proc.StartInfo = $psi
    [void]$proc.Start()
    $outTask = $proc.StandardOutput.ReadToEndAsync()
    $errTask = $proc.StandardError.ReadToEndAsync()
    if (-not $proc.WaitForExit($TimeoutSec * 1000)) {
        try { $proc.Kill() } catch { }
        return [pscustomobject]@{ Code = 124; Stdout = ''; Stderr = ("超时：超过 ${TimeoutSec}s 没结束") }
    }
    return [pscustomobject]@{ Code = $proc.ExitCode; Stdout = $outTask.Result; Stderr = $errTask.Result }
}

function Resolve-ReleaseUrl([string]$Version, [string]$Asset) {
    $remote = & git -C $script:RepoRoot remote get-url origin 2>$null
    if ($remote -match 'github\.com[:/](?<owner>[^/]+)/(?<repo>[^/]+?)(\.git)?/?$') {
        return "https://github.com/$($Matches.owner)/$($Matches.repo)/releases/download/gui-v$Version/$Asset"
    }
    Fail "读不出 origin 仓库地址（git remote get-url origin -> '$remote'），没法拼 Release 下载地址。"
}

# ---------------------------------------------------------------------------
# 0. 前置：这台机器上要有的东西
# ---------------------------------------------------------------------------

Say '=== cante 安装验收（装好的应用 → 点一张卡 → 真出文件）==='
Say ("仓库根目录：" + $script:RepoRoot)
Say ("工作目录：" + $WorkDir)
New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null

function Resolve-PiBin {
    $candidates = @(
        (Join-Path $HOME '.bun\bin\pi.exe'),
        (Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links\pi.exe')
    )
    foreach ($candidate in $candidates) { if (Test-Path $candidate) { return $candidate } }
    $onPath = (Get-Command pi.exe -ErrorAction SilentlyContinue).Source
    if ($onPath) { return $onPath }
    Fail "找不到原生 pi.exe（试过 $($candidates -join '、') 和 PATH）。npm 装的 pi.cmd 不行：桥用 CreateProcess 起它，看不见 .cmd。"
}

function Resolve-MsEdgeDriver {
    # 和 CI 用同一个位置（gui/e2e-windows/msedgedriver 已在 .gitignore 里），这样
    # 第二遍跑不用重新下载。
    $candidates = @(
        (Join-Path $script:GuiRoot 'e2e-windows\msedgedriver\msedgedriver.exe'),
        (Join-Path $HOME 'msedgedriver\msedgedriver.exe'),
        (Join-Path $WorkDir 'msedgedriver\msedgedriver.exe')
    )
    foreach ($candidate in $candidates) { if (Test-Path $candidate) { return $candidate } }
    return $null
}

function To-PosixPath([string]$Path) {
    # Git Bash 收 Windows 反斜杠路径会找不到文件；正斜杠两边都认。
    return $Path.Replace('\', '/')
}

function Resolve-TauriDriver {
    $candidate = Join-Path $HOME '.cargo\bin\tauri-driver.exe'
    if (Test-Path $candidate) { return $candidate }
    $onPath = (Get-Command tauri-driver.exe -ErrorAction SilentlyContinue).Source
    if ($onPath) { return $onPath }
    Fail "找不到 tauri-driver。先跑：cargo install tauri-driver --locked"
}

$piBin = Resolve-PiBin
Say ("pi：" + $piBin)

$node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $node) { Fail '找不到 node.exe。' }
if (-not (Test-Path (Join-Path $script:GuiRoot 'node_modules\selenium-webdriver'))) {
    Fail "缺少 gui/node_modules/selenium-webdriver。先在 gui/ 里跑 bun install。"
}

# ---------------------------------------------------------------------------
# 1. 取安装包
# ---------------------------------------------------------------------------

$setup = $null
Record-Step '1. 取安装包' {
    if ($Installer) {
        if (-not (Test-Path $Installer)) { Fail "给的安装包不存在：$Installer" }
        $script:setup = (Resolve-Path $Installer).Path
        Say ("用给定的安装包：" + $script:setup)
    } elseif ($Version) {
        $asset = "Cante_${Version}_x64-setup.exe"
        $target = Join-Path $WorkDir 'downloads'
        New-Item -ItemType Directory -Force -Path $target | Out-Null
        $local = Join-Path $target $asset
        if (Test-Path $local) { Remove-Item $local -Force }
        $gh = (Get-Command gh.exe -ErrorAction SilentlyContinue).Source
        if ($gh) {
            $remote = & git -C $script:RepoRoot remote get-url origin 2>$null
            $repo = ($remote -replace '.*github\.com[:/]', '') -replace '\.git/?$', ''
            Say ("用 gh release download gui-v$Version --repo $repo")
            $result = Run-Command $gh @('release', 'download', "gui-v$Version", '--repo', $repo, '--pattern', $asset, '--dir', $target, '--clobber') 600
            if ($result.Code -ne 0) { Fail ("gh release download 失败（exit " + $result.Code + "）：" + $result.Stderr) }
        } else {
            $url = Resolve-ReleaseUrl $Version $asset
            Say ("用 Invoke-WebRequest 下载：" + $url)
            Invoke-WebRequest -Uri $url -OutFile $local -TimeoutSec 300
        }
        if (-not (Test-Path $local)) { Fail "下载完没看到文件：$local" }
        $script:setup = $local
        Say ("下载到：" + $script:setup + "  (" + (Get-Item $script:setup).Length + " 字节)")
    } else {
        Fail '要给 -Installer <路径> 或 -Version <版本> 之一。'
    }
}

# ---------------------------------------------------------------------------
# 2. 静默安装 + 列目录
# ---------------------------------------------------------------------------

$installListPath = Join-Path $WorkDir 'installed-files.txt'
Record-Step '2. 静默安装 + 列安装目录' {
    # 幂等：装之前先把上一版卸掉（跑第二遍时也是干净起点）。
    $existingUninstaller = Join-Path $script:InstallDir 'uninstall.exe'
    if (Test-Path $existingUninstaller) {
        Say '已有旧安装，先静默卸载…'
        $u = Start-Process -FilePath $existingUninstaller -ArgumentList '/S' -PassThru -Wait
        $deadline = (Get-Date).AddSeconds(90)
        while ((Get-Date) -lt $deadline -and (Test-Path $script:InstallDir)) { Start-Sleep -Milliseconds 400 }
        Say ("旧安装卸载退出码 " + $u.ExitCode + "，目录还在=" + (Test-Path $script:InstallDir))
    }

    $p = Start-Process -FilePath $script:setup -ArgumentList '/S' -PassThru -Wait
    Say ("安装器退出码 " + $p.ExitCode)
    if ($p.ExitCode -ne 0) { Fail ("安装器返回 " + $p.ExitCode) }
    $deadline = (Get-Date).AddSeconds(120)
    while ((Get-Date) -lt $deadline -and -not (Test-Path (Join-Path $script:InstallDir 'cante-gui.exe'))) { Start-Sleep -Milliseconds 400 }
    if (-not (Test-Path (Join-Path $script:InstallDir 'cante-gui.exe'))) { Fail '装完没看到 cante-gui.exe' }

    $lines = New-Object System.Collections.Generic.List[string]
    foreach ($item in (Get-ChildItem $script:InstallDir -Recurse -Force | Sort-Object FullName)) {
        $rel = $item.FullName.Substring($script:InstallDir.Length)
        if ($item.PSIsContainer) { $lines.Add(('[DIR ]                 ' + $rel)) }
        else { $lines.Add(('{0,12}  {1}' -f $item.Length, $rel)) }
    }
    $lines | ForEach-Object { Say ('  ' + $_) }
    Set-Content -Path $installListPath -Value ($lines -join "`n") -Encoding UTF8

    $files = Get-ChildItem $script:InstallDir -Recurse -Force -File
    foreach ($required in 'cante-gui.exe', 'cante-sheets.exe', 'cante-pdf.exe', 'uninstall.exe') {
        if (-not ($files | Where-Object { $_.Name -eq $required })) { Fail "安装目录缺 $required" }
    }
    # cante-bridge.exe 也要在：应用要 CANTE_BIN 指向包里这一个，它不在就干不了活。
    if (-not ($files | Where-Object { $_.Name -eq 'cante-bridge.exe' })) { Fail '安装目录缺 cante-bridge.exe' }
    $junkD = $files | Where-Object { $_.Extension -eq '.d' }
    if ($junkD) { Fail ("安装目录里有 .d 垃圾：" + (($junkD | ForEach-Object { $_.Name }) -join ', ')) }
    $junkZero = $files | Where-Object { $_.Length -eq 0 -and $_.Extension -eq '' }
    if ($junkZero) { Fail ("安装目录里有 0 字节无扩展名垃圾：" + (($junkZero | ForEach-Object { $_.Name }) -join ', ')) }
    Say ("  检查：文件 " + $files.Count + " 个，没有 .d、没有 0 字节无扩展名文件（确认没有）")
}

$bridgeBin = Join-Path $script:InstallDir 'cante-bridge.exe'
$sheetBin = Join-Path $script:InstallDir 'cante-sheets.exe'
$guiExe = Join-Path $script:InstallDir 'cante-gui.exe'

# ---------------------------------------------------------------------------
# 3. 启动应用 + UI Automation 读第一屏
# ---------------------------------------------------------------------------

$windowTextPath = Join-Path $WorkDir 'window-text-first-screen.txt'
Record-Step '3. 启动应用 + 读第一屏（UI Automation）' {
    # 全新档案：向导才会出现（也保证跑第二遍看到的是同一屏）。
    if (Test-Path $script:ProfileDir) { Remove-Item $script:ProfileDir -Recurse -Force }

    # 脚本替她设的两个环境变量。PI_* 里属于「我这个 agent 的会话」的一律清掉，
    # 免得子 pi 继承了一个无关的会话文件。
    Get-ChildItem env: | Where-Object { $_.Name -like 'PI_*' -and $_.Name -ne 'PI_BIN' } | ForEach-Object {
        Remove-Item ("env:" + $_.Name) -ErrorAction SilentlyContinue
    }
    $env:CANTE_BIN = $bridgeBin
    $env:PI_BIN = $piBin

    $dump = Join-Path $script:Here 'dump-window-text.ps1'
    $result = Run-Command 'powershell.exe' @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $dump, '-Exe', $guiExe, '-WaitSeconds', '20', '-ForceAccessibility') 180
    Set-Content -Path $windowTextPath -Value ($result.Stdout + "`n--- stderr ---`n" + $result.Stderr) -Encoding UTF8
    if ($result.Code -ne 0) { Fail ("读窗口文字退出码 " + $result.Code + "（见 " + $windowTextPath + "）") }

    $text = $result.Stdout
    foreach ($needle in '欢迎使用 Cante', '我帮你把表格、文件这些麻烦事做完', '开始检查', '1欢迎', '2检查电脑', '3开始使用') {
        if ($text -notmatch [regex]::Escape($needle)) { Fail ("第一屏里没有「" + $needle + "」；原文见 " + $windowTextPath) }
    }
    Say '  第一屏断言通过：中文简单模式向导第 1 步。原文如下：'
    foreach ($line in ($text -split "`r?`n")) {
        if ($line -match '\|' -and $line -notmatch '^\s*(Pane|Window|Group|List)\s*\|\s*$') { Say ('  ' + $line.Trim()) }
    }
}

# ---------------------------------------------------------------------------
# 4. 真的干成一件活
# ---------------------------------------------------------------------------

$jobDir = Join-Path $WorkDir 'job'
$driveArtifacts = Join-Path $WorkDir 'drive-artifacts'
$driveResult = Join-Path $driveArtifacts 'accept-drive-result.json'
$outputReadPath = Join-Path $WorkDir 'output-read-back.txt'

Record-Step '4. 真的干成一件活（WebDriver + 桥 + pi）' {
    # 4a. 输入文件：用应用自带的 cante-sheets 造，这样连输入都是产品自己的工具产出的。
    if (-not $KeepArtifacts -and (Test-Path $jobDir)) { Remove-Item $jobDir -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $jobDir | Out-Null
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
    $make = Run-Command $sheetBin @('write', $inputXlsx, $csv, '--sheet', '明细') 120
    if ($make.Code -ne 0) { Fail ("cante-sheets write 失败：" + $make.Stderr) }
    $inputHashBefore = (Get-FileHash $inputXlsx -Algorithm SHA256).Hash
    Say ("  输入：" + $inputXlsx + "  sha256=" + $inputHashBefore)

    # 4b. 驱动：真 WebView2 里点卡片 → 选文件 → 生成计划 → 开始 → 审批。
    $msedge = Resolve-MsEdgeDriver
    if (-not $msedge) {
        $dest = Join-Path $script:GuiRoot 'e2e-windows\msedgedriver'
        Say '  没有 msedgedriver，用仓库脚本取一个（要和这台机器的 WebView2 版本一致）…'
        $bash = (Get-Command bash.exe -ErrorAction SilentlyContinue).Source
        if (-not $bash) { Fail '找不到 bash.exe，没法取 msedgedriver。' }
        $script = To-PosixPath (Join-Path $script:GuiRoot 'e2e-windows\install-msedgedriver.sh')
        $fetch = Run-Command $bash @($script, (To-PosixPath $dest)) 600
        Say ('  ' + (($fetch.Stdout -split "`r?`n" | Where-Object { $_ } | Select-Object -Last 4) -join ' / '))
        if ($fetch.Code -ne 0) { Fail ("取 msedgedriver 失败：" + $fetch.Stderr) }
        $script:msedge = Join-Path $dest 'msedgedriver.exe'
    } else { $script:msedge = $msedge }
    $tauriDriver = Resolve-TauriDriver
    Say ("  msedgedriver：" + $script:msedge)
    Say ("  tauri-driver：" + $tauriDriver)

    $env:ACCEPT_APP = $guiExe
    $env:ACCEPT_CANTE_BIN = $bridgeBin
    $env:ACCEPT_PI_BIN = $piBin
    $env:ACCEPT_MSEDGEDRIVER = $script:msedge
    $env:ACCEPT_TAURI_DRIVER = $tauriDriver
    $env:ACCEPT_WORKDIR = $jobDir
    $env:ACCEPT_INPUT = $inputXlsx
    $env:ACCEPT_CARD = $Card
    $env:ACCEPT_INSTRUCTION = $Instruction
    $env:ACCEPT_ARTIFACTS = $driveArtifacts
    $env:ACCEPT_RESULT_JSON = $driveResult
    $env:ACCEPT_SCRIPT_DIR = $script:Here
    $env:ACCEPT_TIMEOUT_MS = [string]($JobTimeoutSec * 1000)
    New-Item -ItemType Directory -Force -Path $driveArtifacts | Out-Null

    $drive = Run-Command $node @((Join-Path $script:Here 'accept-drive.mjs')) ($JobTimeoutSec + 120)
    Say $drive.Stdout
    if ($drive.Stderr) { Say ('  --- driver stderr ---'); Say $drive.Stderr }
    if ($drive.Code -ne 0) { Fail ("驱动这一步失败（exit " + $drive.Code + "）。详情见 " + $driveResult) }

    $info = Get-Content $driveResult -Raw -Encoding UTF8 | ConvertFrom-Json
    Say ("  驱动内耗时：" + (($info.steps | ForEach-Object { $_.name + '=' + $_.ms + 'ms' }) -join '，'))
    Say ("  替她点了：审批 " + $info.counters.approvals + " 次、结构化提问 " + $info.counters.questions + " 次、追问 " + $info.counters.followups + " 次")

    # 4c. 磁盘上的事实：产出文件在不在、能不能打开、内容对不对、原件动没动。
    $outputs = Get-ChildItem $jobDir -File | Where-Object { $_.Name -like '结果_*.xlsx' }
    if (-not $outputs) { Fail ("工作目录里没有 结果_*.xlsx 产出（目录：" + $jobDir + "）") }
    $output = $outputs | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    $read = Run-Command $sheetBin @('read', $output.FullName) 120
    Set-Content -Path $outputReadPath -Value ($read.Stdout + "`n--- stderr ---`n" + $read.Stderr) -Encoding UTF8
    if ($read.Code -ne 0) { Fail ("用 cante-sheets 读产出失败（exit " + $read.Code + "）：" + $read.Stderr) }
    Say ("  产出：" + $output.FullName + "  " + $output.Length + " 字节")
    Say '  用应用自带的 cante-sheets 读回来：'
    ($read.Stdout -split "`r?`n") | Where-Object { $_ } | ForEach-Object { Say ('    ' + $_) }

    $lines = ($read.Stdout -split "`r?`n") | Where-Object { $_ }
    if ($lines.Count -lt 2) { Fail '读出来的产出是空的。' }
    $dataRows = $lines | Select-Object -Skip 1
    if (($dataRows | Where-Object { $_ -notmatch '^华东区,' }).Count -gt 0) { Fail '产出里混进了非华东区的行。' }
    if ($dataRows.Count -ne 3) { Fail ("产出应有 3 行华东区记录，实际 " + $dataRows.Count + " 行。") }

    $inputHashAfter = (Get-FileHash $inputXlsx -Algorithm SHA256).Hash
    if ($inputHashBefore -ne $inputHashAfter) { Fail "原文件被改动了（sha256 变了）" }
    Say ("  原文件 sha256 跑前跑后一致（" + $inputHashAfter + "）→ 没有被改动")
}

# ---------------------------------------------------------------------------
# 5. 收尾：卸载 + 残留检查
# ---------------------------------------------------------------------------

Record-Step '5. 静默卸载 + 残留检查' {
    if ($SkipUninstall) {
        Say '  -SkipUninstall：跳过卸载（安装保持原样）。'
        return
    }
    $uninstaller = Join-Path $script:InstallDir 'uninstall.exe'
    if (Test-Path $uninstaller) {
        $p = Start-Process -FilePath $uninstaller -ArgumentList '/S' -PassThru -Wait
        Say ("  卸载器退出码 " + $p.ExitCode)
        $deadline = (Get-Date).AddSeconds(90)
        while ((Get-Date) -lt $deadline -and (Test-Path $script:InstallDir)) { Start-Sleep -Milliseconds 400 }
    }
    Say ("  安装目录 %LOCALAPPDATA%\Cante 还在 = " + (Test-Path $script:InstallDir))
    $registry = Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' -ErrorAction SilentlyContinue |
        Where-Object { $_.GetValue('DisplayName') -like '*Cante*' }
    Say ("  HKCU 卸载登记里还有 Cante = " + ([bool]$registry))
    $startMenu = Get-ChildItem (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs') -Recurse -Force -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -like '*Cante*' }
    Say ("  开始菜单快捷方式还在 = " + ([bool]$startMenu))
    $desktop = Get-ChildItem ([Environment]::GetFolderPath('Desktop')) -Force -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -like '*Cante*' }
    Say ("  桌面快捷方式还在 = " + ([bool]$desktop))
    Say ("  应用档案 %LOCALAPPDATA%\dev.cante.gui 还在 = " + (Test-Path $script:ProfileDir) + "（WebView2 用户数据，预期保留）")
}

# ---------------------------------------------------------------------------
# 汇总
# ---------------------------------------------------------------------------

Say ''
Say '=== 每一步的实际耗时 ==='
$script:Timings | ForEach-Object { Say ('  {0,-32} {1,7} s  {2}' -f $_.Step, $_.Seconds, $_.Result) }
$total = ($script:Timings | Measure-Object Seconds -Sum).Sum
Say ('  {0,-32} {1,7} s' -f '合计', $total)
Say ''
Say ('证据都在：' + $WorkDir)
Say 'accept-install: OK — 装好的应用 + 包里的桥 + 这台机器上的 pi，点一张卡真的出了一份文件。'
