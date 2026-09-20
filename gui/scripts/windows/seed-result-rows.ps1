# 给「我做的结果」面板铺一份**可重复的**结果行（真机验收用的夹具）。
#
# 为什么需要它：`a11y-uia.ps1 -Scenario results` 要验的是「面板里每一行的按钮，
# 读屏能不能分清」。上一轮的 92 个可 Tab 按钮 / 47 行，是那台机器**攒了很久的真实历史**
# （别人的 worktree 跑出来的）。那不可重复：档案一清，面板就空了，N 变成 0，判据就没法比。
# 所以显式铺一份固定的行数，这样**修复前 / 修复后**两次跑的是同一个面板。
#
# 它做的事：
#   1. 用应用自带的 `cante-sheets` 造 K 份真结果文件（放在 -WorkDir\seed\ 下）；
#   2. 往应用配置目录（`%APPDATA%\dev.cante.gui\file-safety\runs.json`）写 K 条记录，
#      每条指向其中一份 —— 面板每行两个按钮，于是 N ≈ 2K（前面几行可能因虚拟化/滚动差异少一两个）；
#   3. `-Mode restore` 把**原样的 runs.json** 放回去（跑之前先备份），机器不留痕。
#
# 安全：只碰应用自己的配置目录里那**一个** runs.json；先备份、后还原；
#       不碰用户的任何文件（结果文件都造在自己的 WorkDir 里）。
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File seed-result-rows.ps1 -Mode seed   -Rows 47 -WorkDir <目录>
#   powershell -NoProfile -ExecutionPolicy Bypass -File seed-result-rows.ps1 -Mode restore             -WorkDir <目录>
#
# 退出码：0 = 成功；2 = 环境问题（找不到 cante-sheets / 配置目录）。
#
# 注意：本文件必须保存为 UTF-8 with BOM（Windows PowerShell 5.1 否则按 GBK 解析中文）。

param(
    [Parameter(Mandatory = $true)][ValidateSet('seed', 'restore')][string]$Mode,
    [int]$Rows = 47,
    [Parameter(Mandatory = $true)][string]$WorkDir,
    # 应用可执行文件（用来找它旁边的 cante-sheets.exe）。不给就查注册表/默认位置。
    [string]$Exe = ""
)

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$script:Lines = New-Object System.Collections.Generic.List[string]
function Say([string]$t) { Write-Host $t; [void]$script:Lines.Add($t) }

New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
$seedDir = Join-Path $WorkDir 'seed'
$configDir = Join-Path $env:APPDATA 'dev.cante.gui'
$storeDir = Join-Path $configDir 'file-safety'
$runsFile = Join-Path $storeDir 'runs.json'
# 备份与记号**放在 runs.json 旁边**，不放在 WorkDir 里。
#
# 为什么（这一轮踩到 ✗）：runs.json 是**全局一个**，而 WorkDir 是每次跑一个。
# 若记号/备份跟着 WorkDir 走，从**另一个** WorkDir 调 restore 就找不到它们，
# “还原”就变成“不动它”—— 把 47 条**假记录留在她面板里** ✗（我差点就这么留下了）。
$backup = Join-Path $storeDir 'runs.json.seed-backup'
$marker = Join-Path $storeDir 'runs.json.seed-marker'

function Resolve-Exe([string]$Given) {
    if ($Given) { if (Test-Path $Given) { return (Resolve-Path $Given).Path } else { return $null } }
    $entry = Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' -ErrorAction SilentlyContinue |
        Where-Object { $_.GetValue('DisplayName') -like '*Cante*' } | Select-Object -First 1
    if ($entry) {
        $loc = $entry.GetValue('InstallLocation')
        if ($loc) { $c = Join-Path ($loc.Trim('"')) 'cante-gui.exe'; if (Test-Path $c) { return (Resolve-Path $c).Path } }
    }
    $fb = Join-Path $env:LOCALAPPDATA 'Cante\cante-gui.exe'
    if (Test-Path $fb) { return (Resolve-Path $fb).Path }
    return $null
}

if ($Mode -eq 'restore') {
    Say '=== 还原 runs.json ==='
    # 判据只有一个：**跑之前是什么样，就还成什么样**。
    #   跑之前有 → 把备份放回去；
    #   跑之前没有 → 删掉（不能把“第一次铺进去的那份”当原样留下 —— 实测踩到过）。
    $originalExisted = $null
    if (Test-Path $marker) {
        try { $originalExisted = [bool](Get-Content $marker -Raw -Encoding UTF8 | ConvertFrom-Json).originalExisted } catch {}
    }
    if ($originalExisted -eq $true) {
        if (Test-Path $backup) { Copy-Item $backup $runsFile -Force; Say ("  已把备份放回：" + $runsFile) }
        else { Say '  环境问题：记号说有原始文件，但备份不在 —— 不动它，免得弄丢她的记录'; exit 2 }
    } elseif ($originalExisted -eq $false) {
        if (Test-Path $runsFile) { Remove-Item $runsFile -Force; Say '  已删除铺进去的 runs.json（跑之前本来就没有）' }
    } else {
        # 没有记号：跑之前的状态未知 —— 不瞎动。
        if (Test-Path $backup) { Copy-Item $backup $runsFile -Force; Say ("  （没有记号，但有备份）已放回：" + $runsFile) }
        else { Say '  （没有记号也没有备份 —— 不动它，避免误删她自己的记录）'; Say ('     记号应当在：' + $marker) }
    }
    if (Test-Path $marker) { Remove-Item $marker -Force }
    Say 'seed-result-rows: RESTORE OK'
    exit 0
}

# --- seed ---
$exePath = Resolve-Exe $Exe
if (-not $exePath) { Say '环境问题：找不到 cante-gui.exe（用 -Exe 指一个）'; exit 2 }
$sheets = Join-Path (Split-Path -Parent $exePath) 'cante-sheets.exe'
if (-not (Test-Path $sheets)) { Say ("环境问题：找不到 cante-sheets.exe（" + $sheets + "）"); exit 2 }

Say ("应用：" + $exePath)
Say ("cante-sheets：" + $sheets)
Say ("配置目录：" + $configDir)
New-Item -ItemType Directory -Force -Path $storeDir | Out-Null
New-Item -ItemType Directory -Force -Path $seedDir | Out-Null

# 先备份（只备份一次；重复 seed 不会把备份覆盖成“铺过的”那份）。
# 也要记下**跑之前到底有没有**这个文件：没有的话，restore 应该把它删掉，而不是
# 把“第一次铺进去的那份”又放回去（那样就留下了痕迹 —— 实测踩到）。
#
# **已经在铺过的状态里再 seed 一次**（没先 restore）时，要注意：
# `runs.json` 现在是**我们铺的**，不能拿它当真原样去备份、也不能重新算 originalExisted ✗。
# 否则第二次 seed 会把“夹具”当成“真实历史”记下来，最后 restore 就把夹具留下了——
# 实测踩到。所以在建备份/写记号之前先读一眼已有的记号：有就沿用它的 originalExisted。
$previousOriginal = $null
if (Test-Path $marker) {
    try { $previousOriginal = [bool](Get-Content $marker -Raw -Encoding UTF8 | ConvertFrom-Json).originalExisted } catch {}
}
$originalExisted = $null
if ($previousOriginal -ne $null) {
    $originalExisted = $previousOriginal
    Say ('  已经铺过一次了（记号还在）—— 沿用第一次记下的原样：originalExisted=' + $originalExisted)
} else {
    $originalExisted = Test-Path $runsFile
    if ($originalExisted) {
        if (-not (Test-Path $backup)) { Copy-Item $runsFile $backup -Force; Say ("  已备份原 runs.json → " + $backup) }
        else { Say ("  （备份已存在，不覆盖：" + $backup + "）") }
    } else {
        Say '  （跑之前本来就没有 runs.json；restore 时会把它删掉）'
    }
}

# 1) 造 K 份真结果文件（用应用自带的工具，跟别的验收一样）
$csv = Join-Path $seedDir 'input.csv'
@(
    '区域,月份,客户,金额',
    '华东区,3月,甲公司,1200',
    '华南区,3月,乙公司,980',
    '华东区,4月,丙公司,1500'
) -join "`n" | Set-Content -Path $csv -Encoding UTF8

$paths = @()
for ($i = 1; $i -le $Rows; $i++) {
    $xlsx = Join-Path $seedDir ('结果_挑出华东区-' + $i + '.xlsx')
    if (Test-Path $xlsx) { Remove-Item $xlsx -Force }
    & $sheets write $xlsx $csv --sheet '明细' 2>&1 | Out-Null
    if (Test-Path $xlsx) { $paths += $xlsx } else { Say ("  ✗ 第 $i 份没造出来") }
}
Say ("已造结果文件：" + $paths.Count + " 份（在 " + $seedDir + "）")
if ($paths.Count -lt $Rows) { Say ("环境问题：只造出 " + $paths.Count + "/" + $Rows + " 份"); exit 2 }

# 2) 写 K 条 run 记录（时间戳递减，面板从新到旧）
#    只写面板真正会读的字段：id / taskTitle / instruction / state / createdAt /
#    result.files[].path（见 gui/src/simple/results.ts 的 collectResults / filesOf）。
$now = [int64]((Get-Date).ToUniversalTime() - (Get-Date '1970-01-01')).TotalMilliseconds
$runs = @()
for ($i = 0; $i -lt $paths.Count; $i++) {
    $runs += [ordered]@{
        id = 'seedrun-' + ($i + 1)
        taskId = 'excel.pick'
        taskTitle = '从大表里挑出想要的行'
        instruction = '把华东区的记录挑出来，另存成一张新表'
        state = 'done'
        plan = @()
        impact = [ordered]@{ delete = @(); overwrite = @(); messages = $false }
        files = @($paths[$i])
        result = [ordered]@{
            files = @([ordered]@{ path = $paths[$i]; summary = '新增 1 个文件' })
            summary = '新增 1 个文件'
        }
        online = $false
        error = $null
        createdAt = $now - ($i * 60000)
    }
}
# 关键：**无 BOM** 写。PowerShell 5.1 的 `Set-Content -Encoding UTF8` 会加 BOM，
# 而应用的 `read_json` 是 `serde_json::from_str`（不接受 BOM）→ 整份历史读成空 ✗。
# 应用自己的 `write_json` 用的是 `write_all(text.as_bytes())`（无 BOM），所以这里也得无 BOM。
# 实测踩过：带 BOM 写进去，面板直接显示「还没有做过结果文件」。
function Write-TextNoBom([string]$Path, [string]$Text) {
    [System.IO.File]::WriteAllText($Path, $Text, (New-Object System.Text.UTF8Encoding($false)))
}

$runs | ConvertTo-Json -Depth 8 | ForEach-Object { Write-TextNoBom $runsFile $_ }
[ordered]@{ rows = $paths.Count; seededAt = (Get-Date).ToString('o'); runsFile = $runsFile; originalExisted = [bool]$originalExisted } |
    ConvertTo-Json | ForEach-Object { Write-TextNoBom $marker $_ }
Say ("已写 runs.json：" + $runsFile + "（" + $runs.Count + " 条）")
Say 'seed-result-rows: SEED OK'
exit 0
