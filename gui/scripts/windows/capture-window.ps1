# 尽最大努力截一张真实窗口图（SSH 会话里通常是空白/全黑，脚本会自己算出来告诉你）。
#
# 注意：本文件必须保存为 UTF-8 with BOM（Windows PowerShell 5.1 否则按 GBK 解析，
# 中文会变乱码并报语法错）。
#
# 为什么需要「算像素」：SSH 会话跑在 session 0，没有真正的桌面；WebView2 是
# DirectComposition 渲染，PrintWindow 常常只能拿到一张全黑图。全黑图不等于
# 「界面是黑的」，只等于「这条路拿不到画面」——所以脚本把非黑像素比例打出来，
# 让人一眼看出这张图能不能当证据。
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File capture-window.ps1 -OutDir C:\tmp\shots
# 对应用户文档：gui/WINDOWS-ACCEPTANCE-1.md 的「启动行为」与「我没能验证什么」。

param(
    [string]$Exe = "$env:LOCALAPPDATA\Cante\cante-gui.exe",
    [int]$WaitSeconds = 20,
    [string]$OutDir = "$env:TEMP\cante-acc-shot"
)

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Drawing

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32Cap {
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint nFlags);
    [DllImport("user32.dll", CharSet = CharSet.Auto)] public static extern int GetClassName(IntPtr hWnd, System.Text.StringBuilder s, int nMax);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
}
"@

function Section($title) { Write-Output ''; Write-Output ("=== " + $title + " ===") }

if (Test-Path $OutDir) { Remove-Item $OutDir -Recurse -Force }
New-Item -ItemType Directory -Path $OutDir | Out-Null

Section '启动'
$proc = Start-Process -FilePath (Resolve-Path $Exe).Path -PassThru
Write-Output ("PID = " + $proc.Id)
Start-Sleep -Seconds $WaitSeconds
$proc.Refresh()
Write-Output ("HasExited = " + $proc.HasExited)
if ($proc.HasExited) { Write-Output ("ExitCode = " + $proc.ExitCode); exit 1 }

Section '窗口事实'
$h = $proc.MainWindowHandle
Write-Output ("MainWindowHandle = " + $h)
Write-Output ("MainWindowTitle  = '" + $proc.MainWindowTitle + "'")
if ($h -eq [IntPtr]::Zero) { Write-Output '没有主窗口句柄，截不到任何东西。'; exit 2 }
$rect = New-Object Win32Cap+RECT
[void][Win32Cap]::GetWindowRect($h, [ref]$rect)
Write-Output ("窗口矩形 = " + $rect.Left + "," + $rect.Top + " - " + $rect.Right + "," + $rect.Bottom +
              "  (" + ($rect.Right - $rect.Left) + "x" + ($rect.Bottom - $rect.Top) + ")")
$sb = New-Object System.Text.StringBuilder 256
[void][Win32Cap]::GetClassName($h, $sb, 256)
Write-Output ("窗口类名 = " + $sb.ToString())
Write-Output ("IsWindowVisible = " + [Win32Cap]::IsWindowVisible($h))
Write-Output ("IsWindowEnabled = " + [Win32Cap]::IsWindowEnabled($h))
Write-Output ("IsIconic（最小化） = " + [Win32Cap]::IsIconic($h))

Section 'PrintWindow 截图'
$w = $rect.Right - $rect.Left
$hgt = $rect.Bottom - $rect.Top
if ($w -le 0 -or $hgt -le 0) { Write-Output '窗口尺寸为 0，没法截图。'; exit 3 }
$bmp = New-Object System.Drawing.Bitmap $w, $hgt
$gfx = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $gfx.GetHdc()
# 2 = PW_RENDERFULLCONTENT，DWM 合成的窗口要这个标志
$ok = [Win32Cap]::PrintWindow($h, $hdc, 2)
$gfx.ReleaseHdc($hdc)
$gfx.Dispose()
$out = Join-Path $OutDir 'main-window.png'
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
Write-Output ("PrintWindow 返回 = " + $ok)
Write-Output ("图片 = " + $out + "  (" + (Get-Item $out).Length + " bytes)")

Section '这张图到底有没有内容（非黑像素比例）'
$nonBlack = 0
$distinct = New-Object 'System.Collections.Generic.HashSet[string]'
for ($y = 0; $y -lt $hgt; $y += 4) {
    for ($x = 0; $x -lt $w; $x += 4) {
        $c = $bmp.GetPixel($x, $y)
        [void]$distinct.Add(("{0},{1},{2}" -f $c.R, $c.G, $c.B))
        if ($c.R -gt 8 -or $c.G -gt 8 -or $c.B -gt 8) { $nonBlack++ }
    }
}
$sampled = [math]::Ceiling($w / 4.0) * [math]::Ceiling($hgt / 4.0)
Write-Output ("采样点 = " + $sampled + "，非黑点 = " + $nonBlack + "，占比 = " + [math]::Round(100.0 * $nonBlack / $sampled, 2) + '%')
Write-Output ("不同颜色数 = " + $distinct.Count)
if ($nonBlack -eq 0) {
    Write-Output '结论：整张图全黑 —— 这张图不能证明界面渲染正常，只能说明「这条路拿不到画面」。'
} else {
    Write-Output '结论：图里有非黑内容，可以当参考，但真实观感仍要在 RDP 里人眼看。'
}

Section '降采样预览（把窗口缩成字符，粗看布局）'
# 目的：不靠人眼也能看出「这张图里到底有没有东西」。窗口 1193x796 → 78 列 x 30 行。
$cols = 78
$rows = 30
$cw = [math]::Max(1, [int][math]::Floor($w / $cols))
$ch = [math]::Max(1, [int][math]::Floor($hgt / $rows))
$ramp = ' .:-=+*#%@'
for ($r = 0; $r -lt $rows; $r++) {
    $line = ''
    for ($c = 0; $c -lt $cols; $c++) {
        $sum = 0.0
        $n = 0
        for ($y = $r * $ch; $y -lt [math]::Min(($r + 1) * $ch, $hgt); $y += 2) {
            for ($x = $c * $cw; $x -lt [math]::Min(($c + 1) * $cw, $w); $x += 2) {
                $p = $bmp.GetPixel($x, $y)
                $sum += 0.299 * $p.R + 0.587 * $p.G + 0.114 * $p.B
                $n++
            }
        }
        $lum = if ($n -gt 0) { $sum / $n } else { 0 }
        $idx = [int][math]::Floor($lum / 256.0 * $ramp.Length)
        if ($idx -ge $ramp.Length) { $idx = $ramp.Length - 1 }
        $line += $ramp[$idx]
    }
    Write-Output $line
}

Section '主色调（采样中出现最多的 8 种颜色）'
$counts = @{}
for ($y = 0; $y -lt $hgt; $y += 4) {
    for ($x = 0; $x -lt $w; $x += 4) {
        $c = $bmp.GetPixel($x, $y)
        $k = "#" + $c.R.ToString('X2') + $c.G.ToString('X2') + $c.B.ToString('X2')
        if ($counts.ContainsKey($k)) { $counts[$k]++ } else { $counts[$k] = 1 }
    }
}
$counts.GetEnumerator() | Sort-Object -Property Value -Descending | Select-Object -First 8 | ForEach-Object {
    Write-Output ("  {0}  {1} 次（{2}%）" -f $_.Key, $_.Value, [math]::Round(100.0 * $_.Value / $sampled, 2))
}

Section '收尾'
Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
Write-Output ("已停止进程 " + $proc.Id)
