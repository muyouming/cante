# 真机任务普查的 Windows 入口：没有 bash 也能跑（issue #83 / ws/r15-winaccept）。
#
#   powershell -ExecutionPolicy Bypass -File gui\scripts\task-sweep.ps1 --list
#   powershell -ExecutionPolicy Bypass -File gui\scripts\task-sweep.ps1 excel.diff
#   powershell -ExecutionPolicy Bypass -File gui\scripts\task-sweep.ps1 pdf --zip
#
# 在 PowerShell 会话里直接跑也行（参数更不容易被外层命令行吞掉）：
#   .\gui\scripts\task-sweep.ps1 --list
#   .\gui\scripts\task-sweep.ps1 --zip
#
# 参数原样转给 python gui\scripts\sweep\sweep.py（--list / --timeout /
# --stall-timeout / --work / --report / --zip / 卡片名或整类前缀…），退出码原样
# 透传（0 = 没有失败，1 = 有卡失败，2 = 参数或环境问题）。它**不做** task-sweep.sh
# 里的 cargo build；Windows 上不该要求 Rust 工具链。
#
# 这个包装脚本只做三件事：
#   1) 把控制台输出钉成 UTF-8 —— 中文卡片名与报告在 PowerShell 里默认按 GBK
#      解释，会变成乱码；
#   2) 给 python 设 PYTHONUTF8 / PYTHONIOENCODING —— 它自己的 stdout/stderr 也要
#      UTF-8，两边都设才不会出现「一半正常一半乱码」；
#   3) 原样转发参数与退出码。
#
# 为什么没有 param() 块：一旦声明了参数，--list / --zip 会被 PowerShell 当成它自己
# 的参数名，直接报「找不到与参数名称 list 匹配的参数」。不声明 param() 时，所有参数
# 都原封不动落在 $args 里，这才是透明转发。万一外层 powershell.exe 把某个 --flag
# 吞掉了，就用 `... -File gui\scripts\task-sweep.ps1 -- --zip`，或者干脆直接跑
# `python gui\scripts\sweep\sweep.py --zip`。
#
# 本文件存为 UTF-8 **带 BOM**：Windows PowerShell 5.1（Server 2016/2019/2022 的
# 默认版）读 .ps1 时若没有 BOM，会按系统 ANSI 代码页解释，中文注释与提示会乱码。
# PowerShell 7 也读得懂带 BOM 的 UTF-8，所以 BOM 保留。

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Continue'

# --- 1) UTF-8 ---------------------------------------------------------------
try {
    # 只管本进程的控制台编码；不改系统设置、不改注册表、不改 chcp。
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
    [Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
    $OutputEncoding = New-Object System.Text.UTF8Encoding($false)
} catch {
    Write-Host "task-sweep: 设置 UTF-8 控制台编码失败（$($_.Exception.Message)），中文可能乱码。" -ForegroundColor Yellow
}
$env:PYTHONUTF8 = '1'
$env:PYTHONIOENCODING = 'utf-8:replace'

# --- 2) 找 python -----------------------------------------------------------
# 返回 @{ Exe = '...'; Prefix = @() }；找不到返回 $null。
# 注意别用 $argv[1..0] 这种切片：PowerShell 的 1..0 会倒着数，只有一个元素时
# 会插进一个 $null 参数。
function Find-Python {
    foreach ($name in @('python', 'python3', 'py')) {
        # 只要真正的可执行文件（-CommandType Application）：
        # App Execution Alias、别名、函数都不算，它们不保证能用。
        $cmd = Get-Command $name -CommandType Application -ErrorAction SilentlyContinue
        if (-not $cmd) { continue }
        $prefix = @()
        if ($name -eq 'py') { $prefix = @('-3') }
        try {
            $probe = & $cmd.Source @prefix -c "import sys; print('ok')" 2>$null
            $exit = Get-Variable -Name LASTEXITCODE -ValueOnly -ErrorAction SilentlyContinue
            if ($exit -eq 0 -and "$probe".Trim() -eq 'ok') {
                return @{ Exe = $cmd.Source; Prefix = $prefix }
            }
        } catch {
            continue
        }
    }
    return $null
}

$python = Find-Python
if (-not $python) {
    Write-Host 'task-sweep: 找不到 python。普查脚本要用 Python 3.10+：' -ForegroundColor Red
    Write-Host '  1) 装 Python 时勾上 Add python.exe to PATH：https://www.python.org/downloads/windows/'
    Write-Host '  2) 或者在 Microsoft Store 里搜 Python 安装'
    Write-Host '  3) 装完重开一个 PowerShell 再跑本脚本'
    exit 2
}

$pythonExe = $python.Exe
$pythonPrefix = @($python.Prefix)

try {
    $rawVersion = & $pythonExe @pythonPrefix -c "import sys; print('%d.%d.%d' % sys.version_info[:3])"
    $pythonVersion = "$rawVersion".Trim()
    if ([version]$pythonVersion -lt [version]'3.10') {
        Write-Host "task-sweep: 你的 python 是 $pythonVersion，我们只在 3.10+ 上验过；先跑，出错就把 Python 升上去。" -ForegroundColor Yellow
    }
} catch {
    Write-Host 'task-sweep: 没能确认 python 版本，继续跑。' -ForegroundColor Yellow
}

if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
    Write-Host 'task-sweep: 没找到 bun。普查要用产品自己的提示词函数（prompts.ts），所以 bun 是必须的。' -ForegroundColor Yellow
    Write-Host '  装上 bun 再跑：powershell -c "irm bun.sh/install.ps1 | iex"'
}

# --- 3) 转发 ----------------------------------------------------------------
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$sweep = Join-Path (Join-Path $here 'sweep') 'sweep.py'
if (-not (Test-Path -LiteralPath $sweep)) {
    Write-Host "task-sweep: 找不到普查脚本：$sweep" -ForegroundColor Red
    exit 2
}

$forwarded = @($args)
Write-Host "task-sweep: $pythonExe $($pythonPrefix -join ' ') $sweep $($forwarded -join ' ')"
& $pythonExe @pythonPrefix $sweep @forwarded
# 透传退出码：$LASTEXITCODE 在没跑过原生命令时是未设置的，先兜成 0
# （StrictMode 下直接读未设置的变量会报错）。
$code = Get-Variable -Name LASTEXITCODE -ValueOnly -ErrorAction SilentlyContinue
if ($null -eq $code) { $code = 0 }
exit $code
