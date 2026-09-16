# 把窗口里的文字读出来（UI Automation），用来证明前端到底渲染出了什么。
#
# 注意：本文件必须保存为 UTF-8 with BOM（Windows PowerShell 5.1 否则按 GBK 解析，
# 中文会变乱码并报语法错）。
#
# 为什么需要这个：截图像素只能证明「画了东西」，证明不了「画的是哪句话」。
# WebView2 会把渲染出来的 DOM 暴露成 UI Automation 树，脚本把它打印出来，
# 于是「简单模式的文案有没有真的出现在窗口里」就有了可核对的证据。
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File dump-window-text.ps1
# 对应用户文档：gui/WINDOWS-ACCEPTANCE-1.md 的「启动行为」一节。

param(
    [string]$Exe = "$env:LOCALAPPDATA\Cante\cante-gui.exe",
    [int]$WaitSeconds = 20,
    [int]$MaxNodes = 400,
    # WebView2 默认把 DOM 的 UI Automation 树藏起来（Chromium 只在真的有辅助工具请求时才
    # 打开无障碍）。加这个开关就到启动前设 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS，
    # 把渲染进程的无障碍强制打开，于是能读到真实文案。
    [switch]$ForceAccessibility
)

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

function Section($title) { Write-Output ''; Write-Output ("=== " + $title + " ===") }

Section '启动'
if ($ForceAccessibility) {
    $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--force-renderer-accessibility'
    Write-Output 'WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--force-renderer-accessibility'
}
$proc = Start-Process -FilePath (Resolve-Path $Exe).Path -PassThru
Write-Output ("PID = " + $proc.Id)
Start-Sleep -Seconds $WaitSeconds
$proc.Refresh()
if ($proc.HasExited) { Write-Output ("进程已退出，ExitCode = " + $proc.ExitCode); exit 1 }

$h = $proc.MainWindowHandle
Write-Output ("MainWindowHandle = " + $h)
Write-Output ("MainWindowTitle  = '" + $proc.MainWindowTitle + "'")
if ($h -eq [IntPtr]::Zero) { Write-Output '没有主窗口句柄，读不到任何界面元素。'; exit 2 }

Section 'UI Automation 树（ControlType | Name）'
try {
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($h)
} catch {
    Write-Output ('FromHandle 失败：' + $_.Exception.Message)
    exit 3
}
Write-Output ("根元素：ControlType=" + $root.Current.ControlType.ProgrammaticName + "  Name='" + $root.Current.Name + "'")

$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$count = 0
$names = New-Object System.Collections.Generic.List[string]

function Walk($el, $depth) {
    if ($null -eq $el -or $script:count -ge $MaxNodes) { return }
    $script:count++
    $name = $el.Current.Name
    $type = $el.Current.ControlType.ProgrammaticName -replace '^ControlType\.', ''
    if (-not [string]::IsNullOrWhiteSpace($name)) { $script:names.Add($name) }
    Write-Output (('  ' * $depth) + $type + ' | ' + $name)
    $child = $walker.GetFirstChild($el)
    while ($null -ne $child) {
        Walk $child ($depth + 1)
        if ($script:count -ge $MaxNodes) { return }
        $child = $walker.GetNextSibling($child)
    }
}
$script:count = 0
$script:names = $names
Walk $root 0
Write-Output ('（共 ' + $count + ' 个元素，上限 ' + $MaxNodes + '）')

Section '窗口里出现过的文字（去重，方便核对文案）'
$names | Select-Object -Unique | ForEach-Object { Write-Output ('  ' + $_) }

Section '收尾'
Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
Write-Output ("已停止进程 " + $proc.Id)
