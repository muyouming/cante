[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Write-Host '=== Narrator logs available ==='
Get-WinEvent -ListLog * -ErrorAction SilentlyContinue |
  Where-Object { $_.LogName -match 'Narrator' } |
  Select-Object LogName, IsEnabled, RecordCount, LogFilePath | Format-Table -AutoSize | Out-String

Write-Host '=== provider config ==='
try {
    $p = Get-WinEvent -ListProvider 'Microsoft-Windows-Narrator' -ErrorAction Stop
    'provider: ' + $p.Name
    'events defined: ' + $p.Events.Count
    $p.Events | Select-Object -First 14 Id, Description | Format-Table -AutoSize -Wrap | Out-String
} catch { 'provider lookup failed: ' + $_.Exception.Message }

Write-Host '=== recent events from that provider (any channel) ==='
$events = Get-WinEvent -FilterHashtable @{ ProviderName = 'Microsoft-Windows-Narrator' } -MaxEvents 8 -ErrorAction SilentlyContinue
if ($events) {
    foreach ($e in $events) { '  [' + $e.TimeCreated + '] id=' + $e.Id + ' ' + (($e.Message -split "`n")[0]) }
} else {
    '  （没有事件记录 —— 可能只写 ETW 实时通道，或没开）'
}
