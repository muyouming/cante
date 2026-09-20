# 收集 Windows 真机验收需要的环境事实。
#
# 注意：本文件必须保存为 UTF-8 with BOM。Windows PowerShell 5.1 读没有 BOM 的
# .ps1 会按 GBK 解析，脚本里的中文会变成乱码并直接报语法错。仓库里其他 .ps1 同理。
#
# 只读：不安装、不启动、不改任何东西。
# 用法（PowerShell）：  powershell -NoProfile -ExecutionPolicy Bypass -File collect-environment.ps1
# 对应用户文档：gui/WINDOWS-ACCEPTANCE-1.md 的「环境事实」一节。

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Section($title) { Write-Output ''; Write-Output ("=== " + $title + " ===") }

# --- 把 wsl.exe 的输出按正确编码读回来 ---------------------------------------
# wsl.exe 自己打的字（发行版列表、安装提示）是 **UTF-16LE**；WSL 里命令的输出是
# UTF-8。用默认代码页捕获会花屏，所以按实际字节认编码（r18 修的）。
# Start-Process 原样重定向到文件，再读字节：有 UTF-16 BOM 或含 NUL → UTF-16LE，
# 否则 UTF-8；空文件/失败路径也不炸。
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

Section '操作系统'
$os = Get-CimInstance Win32_OperatingSystem
[pscustomobject]@{
    Caption     = $os.Caption
    Version     = $os.Version
    BuildNumber = $os.BuildNumber
    Architecture= $os.OSArchitecture
    TotalMemGB  = [math]::Round($os.TotalVisibleMemorySize / 1MB, 2)
    FreeMemGB   = [math]::Round($os.FreePhysicalMemory / 1MB, 2)
    ComputerName= $os.CSName
    LastBoot    = $os.LastBootUpTime
} | Format-List

$cv = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
[pscustomobject]@{
    ProductName    = $cv.ProductName
    DisplayVersion = $cv.DisplayVersion
    CurrentBuild   = $cv.CurrentBuild
    UBR            = $cv.UBR
    EditionID      = $cv.EditionID
} | Format-List

Section 'CPU / 显卡'
(Get-CimInstance Win32_Processor | Select-Object Name, NumberOfCores, NumberOfLogicalProcessors) | Format-List
(Get-CimInstance Win32_VideoController | Select-Object Name, DriverVersion) | Format-List

Section '当前会话类型（SSH / RDP / 控制台）'
# SessionName = 'Console' 表示真的有人在机器前面看了；SSH 会话看不到窗口。
Write-Output ("SESSIONNAME env = '" + $env:SESSIONNAME + "'")
Write-Output ("Environment.UserInteractive = " + [Environment]::UserInteractive)
Write-Output '--- qwinsta（会话列表）---'
try { (qwinsta.exe 2>&1 | Out-String).Trim() | Write-Output } catch { Write-Output ('qwinsta 失败：' + $_.Exception.Message) }
Write-Output '--- quser（登录用户）---'
try { (quser.exe 2>&1 | Out-String).Trim() | Write-Output } catch { Write-Output ('quser 失败：' + $_.Exception.Message) }
Write-Output '--- Win32_ComputerSystem.UserName（控制台登录用户）---'
Get-CimInstance Win32_ComputerSystem | Select-Object UserName | Format-List
Write-Output '--- 交互式登录会话（Win32_LogonSession，LogonType 2/10）---'
Get-CimInstance Win32_LoggedOnUser -ErrorAction SilentlyContinue | Select-Object -First 10 | Format-Table -AutoSize

Section 'WebView2 Runtime'
$keys = @(
    'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
    'HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
    'HKCU:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
)
$found = $false
foreach ($k in $keys) {
    if (Test-Path $k) {
        $found = $true
        Write-Output ("命中注册表：" + $k)
        Get-ItemProperty $k | Select-Object name, pv, location | Format-List
    } else {
        Write-Output ("未命中：" + $k)
    }
}
if (-not $found) { Write-Output '结论：注册表里没有 WebView2 Runtime。' }
Write-Output '磁盘上的 WebView2 版本目录：'
foreach ($d in @('C:\Program Files (x86)\Microsoft\EdgeWebView\Application',
                 'C:\Program Files\Microsoft\EdgeWebView\Application')) {
    $items = Get-ChildItem $d -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name
    if ($items) { Write-Output ("  " + $d + " -> " + ($items -join ', ')) }
    else { Write-Output ("  " + $d + " -> 不存在") }
}

Section '是否已经装过 Cante'
$uninstallRoots = @(
    'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*'
)
$hits = Get-ItemProperty $uninstallRoots -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -match 'Cante' }
if ($hits) { $hits | Select-Object DisplayName, DisplayVersion, InstallLocation, UninstallString | Format-List }
else { Write-Output '卸载注册表项：无（这台机器此前没装过 Cante）。' }

foreach ($p in @("$env:LOCALAPPDATA\Cante", "$env:LOCALAPPDATA\Programs\Cante",
                 'C:\Program Files\Cante', 'C:\Program Files (x86)\Cante',
                 "$env:USERPROFILE\.cante", "$env:USERPROFILE\.ante")) {
    Write-Output ("{0} -> {1}" -f $p, (Test-Path $p))
}

Section '守护进程线索（上游 cante/ante 只有 macOS/Linux 构建）'
Write-Output ("CANTE_BIN env = '" + $env:CANTE_BIN + "'")
$canteCmd = Get-Command cante -ErrorAction SilentlyContinue
Write-Output ("PATH 里的 cante  = " + $(if ($canteCmd) { $canteCmd.Source } else { '<未找到>' }))
$anteCmd = Get-Command ante -ErrorAction SilentlyContinue
Write-Output ("PATH 里的 ante   = " + $(if ($anteCmd) { $anteCmd.Source } else { '<未找到>'} ))
Write-Output 'WSL 发行版（wsl.exe 的输出可能是 UTF-16LE，按实际字节解码）：'
try {
    $wslCapture = Invoke-WslCapture -WslPath 'wsl.exe' -WslArguments @('-l', '-v')
    $wslCapture.Text -split "`r?`n" | Where-Object { $_.Trim() -ne '' } | ForEach-Object { Write-Output ('  ' + $_.Trim()) }
} catch { Write-Output ('wsl 不可用：' + $_.Exception.Message) }

Section '取证工具'
foreach ($t in @('C:\Program Files\7-Zip\7z.exe')) {
    Write-Output ("{0} -> {1}" -f $t, (Test-Path $t))
}
