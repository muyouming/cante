# 「真拔网线」那条现场用的防火墙规则（**必须提权**跑；由 run-offline.ps1 用 RunAs 调起来）。
#
# 它加/删一条**出站阻断**规则：让应用随包的那个动手组件（`pi\bun.exe`）连不上服务方。
# 这不是我们摆的假服务方 —— 它是**真的系统级出站阻断**，最接近「她的网线被拔了 / 公司网关
# 把流量掐了」那种物理现象。
#
# 为什么规则要**同时**按程序（-Program）和远端端口（-RemotePort）：
#   * 只按远端端口 ✗ —— 这台机器上**验收 agent 自己的会话也连着同一个网关端口**，
#     一条纯端口规则会把**验收者自己**一起掐掉（实测确认：两个不同程序都在用 20128），
#     于是脚本跑到一半就断了，什么证据都拿不到。
#   * 加上 -Program 只按应用自己的 `pi\bun.exe` ✓ —— 只掐被验收的那个程序，
#     验收 agent 不受影响（实测：victim 被拒、验收者的 node 照常连上）。
#   所以这条规则的「隔离」不是放松，是**必要**：不隔离就没人能活着写出报告。
#
# 回环说明：Windows 防火墙**不管回环**（实测：给 127.0.0.1 加出站阻断，同机回环照样
# 握手成功）。所以这一条现场必须指向**真的非回环端点**（这台机器上的服务方网关），
# 不能拿一个本地端口来假装。
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File fw-rule.ps1 -Mode add -Program "<app>\pi\bun.exe" -RemotePort 20128
#   powershell ... -File fw-rule.ps1 -Mode del
#   powershell ... -File fw-rule.ps1 -Mode query
# 退出码：0 = 成功；2 = 失败（原因写在结果文件里，也打在 stdout）。
#
# 注意：本文件必须保存为 UTF-8 with BOM（Windows PowerShell 5.1 否则按 GBK 解析中文）。

param(
    [Parameter(Mandatory = $true)][ValidateSet('add', 'del', 'query')][string]$Mode,
    [string]$Program = "",
    [int]$RemotePort = 0,
    [string]$Name = "cante-offline-wire"
)

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# 提权进程的 stdout 不一定能被外面拿到，所以把结果同时写一个文件（外面按文件读）。
# 用 GetTempPath 而不是 $env:TEMP：提权/从 Git Bash 起的进程里 $env:TEMP 有时是空的
# （实测），拼出来的路径会是 $null，Set-Content 直接报“Path 为空”。
$resultPath = Join-Path ([System.IO.Path]::GetTempPath()) 'cante-offline-fw-result.txt'
$lines = New-Object System.Collections.Generic.List[string]
function Emit([string]$t) { Write-Output $t; [void]$lines.Add($t) }
function Flush() { ($lines -join "`r`n") | Set-Content -Path $resultPath -Encoding UTF8 }

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
Emit ("admin=" + $isAdmin)

if ($Mode -eq 'add') {
    if (-not $Program) { Emit '失败：没有给 -Program（必须按程序隔离，见文件头）。'; Flush; exit 2 }
    if ($RemotePort -le 0) { Emit '失败：没有给 -RemotePort。'; Flush; exit 2 }
    try {
        # 幂等：先删掉可能残留的同名规则，免得 add 失败在"已存在"上。
        Remove-NetFirewallRule -DisplayName $Name -ErrorAction SilentlyContinue | Out-Null
        New-NetFirewallRule -DisplayName $Name -Direction Outbound -Action Block -Enabled True `
            -Program $Program -Protocol TCP -RemotePort $RemotePort -ErrorAction Stop | Out-Null
        $rule = Get-NetFirewallRule -DisplayName $Name -ErrorAction Stop | Select-Object -First 1
        Emit ("ADDED enabled=" + $rule.Enabled + " dir=" + $rule.Direction + " action=" + $rule.Action + " program=" + $Program + " port=" + $RemotePort)
    } catch {
        Emit ("ADD-FAIL: " + $_.Exception.Message)
        Flush
        exit 2
    }
} elseif ($Mode -eq 'del') {
    try {
        $before = [bool](Get-NetFirewallRule -DisplayName $Name -ErrorAction SilentlyContinue)
        Remove-NetFirewallRule -DisplayName $Name -ErrorAction Stop
        $after = [bool](Get-NetFirewallRule -DisplayName $Name -ErrorAction SilentlyContinue)
        Emit ("DELETED existedBefore=" + $before + " stillThere=" + $after)
    } catch {
        # 已经不在了也算成功（幂等），但要如实说清是"本来就没有"。
        $gone = -not [bool](Get-NetFirewallRule -DisplayName $Name -ErrorAction SilentlyContinue)
        if ($gone) { Emit ("DELETED(nothing-to-remove) " + $_.Exception.Message) }
        else { Emit ("DEL-FAIL: " + $_.Exception.Message); Flush; exit 2 }
    }
} else {
    $rules = Get-NetFirewallRule -DisplayName $Name -ErrorAction SilentlyContinue
    if ($rules) {
        foreach ($r in $rules) { Emit ("PRESENT enabled=" + $r.Enabled + " dir=" + $r.Direction + " action=" + $r.Action) }
    } else {
        Emit "ABSENT"
    }
}

Flush
exit 0
