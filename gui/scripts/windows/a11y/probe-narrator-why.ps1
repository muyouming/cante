$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
# 把「Narrator 到底能不能起、为什么起不来」查清楚（不猜：看退出码、看事件日志、看进程树）。
$narr = 'C:\Windows\System32\Narrator.exe'
Write-Output ("Narrator.exe = " + $narr + "  存在=" + (Test-Path $narr))

Write-Output ''
Write-Output '--- 直接 Start-Process，等 10 秒，看它还在不在、退出码多少 ---'
Get-Process Narrator -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1
$p = Start-Process $narr -PassThru
Start-Sleep -Seconds 10
$p.Refresh()
Write-Output ("  pid=" + $p.Id + "  HasExited=" + $p.HasExited + $(if ($p.HasExited) { "  ExitCode=" + $p.ExitCode } else { "" }))
if (-not $p.HasExited) {
    Write-Output ("  仍在运行：MainWindowHandle=" + $p.MainWindowHandle + "  Title='" + $p.MainWindowTitle + "'")
    Write-Output ("  线程数=" + $p.Threads.Count)
}
Get-Process Narrator -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1

Write-Output ''
Write-Output '--- Narrator 是不是 UWP/包？看它的包身份 ---'
$cap = Get-Command Get-AppxPackage -ErrorAction SilentlyContinue
if ($cap) {
    $pkg = Get-AppxPackage -Name '*Narrator*' -ErrorAction SilentlyContinue
    if ($pkg) { $pkg | Select-Object Name,PackageFullName,InstallLocation | Format-List } else { Write-Output '  （没有名为 Narrator 的 AppX 包）' }
} else { Write-Output '  （这个 PowerShell 没有 Get-AppxPackage）' }

Write-Output ''
Write-Output '--- 最近 5 分钟的应用程序日志里，来源含 Narrator 的条目 ---'
try {
    Get-WinEvent -FilterHashtable @{ LogName = 'Application'; StartTime = (Get-Date).AddMinutes(-5) } -ErrorAction Stop |
        Where-Object { $_.Message -match 'Narrator' -or $_.ProviderName -match 'Narrator' } |
        Select-Object -First 5 TimeCreated, ProviderName, LevelDisplayName, Message | Format-List
    Write-Output '  （上面为空 = 最近 5 分钟日志里没有 Narrator 条目）'
} catch { Write-Output ('  读事件日志失败：' + $_.Exception.Message) }

Write-Output ''
Write-Output '--- Narrator 是不是被策略关掉（组策略/注册表）---'
$keys = @(
    'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Accessibility',
    'HKCU:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Accessibility',
    'HKLM:\SOFTWARE\Policies\Microsoft\Windows\Narrator'
)
foreach ($k in $keys) {
    if (Test-Path $k) {
        Write-Output ("  " + $k)
        (Get-ItemProperty $k -ErrorAction SilentlyContinue).PSObject.Properties |
            Where-Object { $_.Name -notlike 'PS*' } |
            ForEach-Object { Write-Output ('    ' + $_.Name + ' = ' + $_.Value) }
    } else { Write-Output ("  " + $k + " （不存在）") }
}
