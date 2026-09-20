# 真机验收：「我做的结果」面板里每一行的「复制位置」按钮，点下去真把**完整位置**放进剪贴板。
#
# 为什么要有这个脚本（可复跑的证据，不是自述）：
#   #290 让结果面板每行多了一个「复制 X 的位置」。本机（macOS）只能验到渲染与接线（SSR 单测）；
#   真 Windows + 真 WebView2 + **真剪贴板**这一面，只有这台机器能验。
#   本脚本把那一轮的做法固化成脚本：用夹具铺 3 行结果 → 打开面板 →
#   逐行按一下 → **逐字**核对 `Get-Clipboard` 是不是那一行自己的完整位置。
#
# 它做的两件事分开记录（不要混）：
#   1. 三条都走 UIA `InvokePattern`（读屏式点击，与 a11y-uia.ps1 同一条路）——
#      证明"每行各拿各的"，也证明"最后一行的提示是它自己那行"；
#   2. 对**第一行**再做一次**真鼠标点击**（SetCursorPos + mouse_event）——
#      证明"她真的用鼠标点"这条路也成立。
#   （第 2、3 行的矩形在任务栏/屏幕外，真鼠标点不到；所以真点击只挑在可视区内的那一行。）
#
# 退出码（沿用 AGENTS.md 的约定）：
#   0 = 通过；2 = 环境问题（找不到 bun / 铺不出行 / 窗口起不来 / 面板打不开）；
#   3 = 产品问题（按钮不在 / 复制的不是那一行的完整位置 / 出现"没能复制上"）。
#
# 用法（在那台 Windows 验收机上，Git Bash 或 PowerShell 都行）：
#   powershell -NoProfile -ExecutionPolicy Bypass -File gui\scripts\windows\accept-copy-location.ps1
#   想自己控制铺行：加 -SkipSeed（调用前先跑 seed-result-rows.ps1 -Mode seed；跑完自己 restore）
#
# 注意：本文件必须保存为 UTF-8 with BOM（Windows PowerShell 5.1 否则按 GBK 解析中文会报语法错）。

param(
    [string]$Exe = "",
    [string]$WorkDir = "",
    [int]$Rows = 3,
    [int]$WaitSeconds = 25,
    [switch]$SkipSeed
)

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms

Add-Type -Namespace CanteAccept -Name Win -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
[DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
'@

$script:Fail = 0
function Say($t) { Write-Output $t }
function Fail($t) { Write-Output $t; $script:Fail = 1 }
function Env-Fail($t) { Write-Output $t; exit 2 }

# DPI：UIA 的矩形与 SetCursorPos 都按物理像素；先声明本进程 DPI 感知，免得坐标被虚拟化。
[void][CanteAccept.Win]::SetProcessDPIAware()

function Resolve-AppExe {
    if ($Exe) { if (Test-Path $Exe) { return (Resolve-Path $Exe).Path } else { Env-Fail ("环境问题：-Exe 指的文件不存在：" + $Exe) } }
    $c = Join-Path $PSScriptRoot '..\..\src-tauri\target\release\cante-gui.exe'
    if (Test-Path $c) { return (Resolve-Path $c).Path }
    Env-Fail '环境问题：找不到 cante-gui.exe，用 -Exe 指一个'
}
function Resolve-Bun {
    $cmd = Get-Command bun -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $candidates = @(
        (Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links\bun.exe'),
        (Join-Path $env:USERPROFILE '.bun\bin\bun.exe')
    )
    foreach ($c in $candidates) { if (Test-Path $c) { return (Resolve-Path $c).Path } }
    Env-Fail '环境问题：找不到 bun.exe（夹具需要一个能跑 typescript 的 bun）'
}

$appExe = Resolve-AppExe
$bunExe = Resolve-Bun
$fakeCante = (Resolve-Path (Join-Path $PSScriptRoot '..\..\fixtures\fake-cante.ts')).Path
$seedScript = (Resolve-Path (Join-Path $PSScriptRoot 'seed-result-rows.ps1')).Path
if (-not $WorkDir) { $WorkDir = Join-Path $env:TEMP 'cante-copy-location' }
$seedDir = Join-Path $WorkDir 'seed'

Say '=== 产物 ==='
Say ("应用：" + $appExe)
$fi = Get-Item $appExe
Say ("时间戳：" + $fi.LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss') + "  大小：" + $fi.Length)
Say ("sha256：" + (Get-FileHash $appExe -Algorithm SHA256).Hash)

$seeded = $false
$proc = $null
function Restore-All {
    if ($proc) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
    if ($seeded) {
        Say ''
        Say '=== 还原 runs.json ==='
        & powershell -NoProfile -ExecutionPolicy Bypass -File $seedScript -Mode restore -WorkDir $WorkDir
    }
}
try {
    if (-not $SkipSeed) {
        Say ''
        Say '=== 铺 3 行结果（夹具）==='
        & powershell -NoProfile -ExecutionPolicy Bypass -File $seedScript -Mode seed -Rows $Rows -WorkDir $WorkDir -Exe $appExe
        if ($LASTEXITCODE -ne 0) { Env-Fail ("环境问题：铺行失败，退出码 " + $LASTEXITCODE) }
        $seeded = $true
    }

    $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--force-renderer-accessibility'
    $env:CANTE_BIN = '"' + $bunExe + '" "' + $fakeCante + '"'
    $env:FAKE_CANTE_SEED = '1'
    Say ''
    Say ("CANTE_BIN=" + $env:CANTE_BIN)

    Say ''
    Say '=== 启动（夹具模式）==='
    $proc = Start-Process -FilePath $appExe -PassThru
    Say ("PID = " + $proc.Id)
    Start-Sleep -Seconds $WaitSeconds
    $proc.Refresh()
    if ($proc.HasExited) { Env-Fail ("环境问题：进程已退出，ExitCode = " + $proc.ExitCode) }
    $h = $proc.MainWindowHandle
    Say ("MainWindowHandle = " + $h)
    Say ("MainWindowTitle  = '" + $proc.MainWindowTitle + "'")
    if ($h -eq [IntPtr]::Zero) { Env-Fail '环境问题：没有主窗口句柄（SSH 会话没有桌面？要 RDP）' }
    $script:appHwnd = $h
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($h)
    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker

    function All-Desc($el) {
        $out = New-Object System.Collections.Generic.List[object]
        function Rec($e) {
            if ($null -eq $e) { return }
            $out.Add($e)
            $c = $walker.GetFirstChild($e)
            while ($null -ne $c) { Rec $c; $c = $walker.GetNextSibling($c) }
        }
        Rec $el
        return $out
    }
    function Elements-Named($el, $needle) {
        $res = New-Object System.Collections.Generic.List[object]
        foreach ($e in (All-Desc $el)) {
            $n = [string]$e.Current.Name
            if ($n -and $n.Contains($needle)) { $res.Add($e) }
        }
        return $res
    }
    function Buttons-Named($el, $needle) {
        $res = New-Object System.Collections.Generic.List[object]
        foreach ($e in (Elements-Named $el $needle)) {
            if ([string]$e.Current.ControlType.ProgrammaticName -eq 'ControlType.Button') { $res.Add($e) }
        }
        return $res
    }
    function Wait-Element($el, $needle, $secs = 25) {
        $end = (Get-Date).AddSeconds($secs)
        while ((Get-Date) -lt $end) {
            $b = Elements-Named $el $needle
            if ($b.Count -gt 0) { return $b }
            Start-Sleep -Milliseconds 400
        }
        return $null
    }
    function Ensure-Foreground($tries = 12) {
        try { (New-Object -ComObject WScript.Shell).AppActivate($proc.Id) | Out-Null } catch {}
        Start-Sleep -Milliseconds 600
        for ($i = 0; $i -lt $tries; $i++) {
            if ([CanteAccept.Win]::GetForegroundWindow() -eq $script:appHwnd) { return $true }
            [void][CanteAccept.Win]::SetForegroundWindow($script:appHwnd)
            Start-Sleep -Milliseconds 200
        }
        return ([CanteAccept.Win]::GetForegroundWindow() -eq $script:appHwnd)
    }
    function Invoke-El($el) {
        try { ($el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)).Invoke(); return $true }
        catch { Say ('  Invoke 失败：' + $_.Exception.Message); return $false }
    }

    Say ''
    Say '=== 打开「我做的结果」==='
    [void](Ensure-Foreground)
    $openBtns = Wait-Element $root '打开我做的结果' 25
    if (-not $openBtns) { Env-Fail '环境问题：首页找不到「打开我做的结果」入口' }
    $entry = $null
    foreach ($e in $openBtns) {
        if ([string]$e.Current.ControlType.ProgrammaticName -eq 'ControlType.Button') { $entry = $e; break }
    }
    if (-not $entry) { $entry = $openBtns[0] }
    Say ("入口：" + $entry.Current.Name)
    [void](Invoke-El $entry)
    if (-not (Wait-Element $root '回到首页' 25)) { Env-Fail '环境问题：结果面板打不开' }
    Say '面板已打开（出现「回到首页」）✓'

    Say ''
    Say '=== 面板里每行的「复制位置」按钮 ==='
    $copyBtns = Buttons-Named $root '的位置'
    Say ("按钮数：" + $copyBtns.Count + "（期望 " + $Rows + "）")
    if ($copyBtns.Count -lt $Rows) { Fail ("产品问题：只找到 " + $copyBtns.Count + " 个「复制位置」按钮（#290 没接上？）") }
    foreach ($b in $copyBtns) {
        $r = $b.Current.BoundingRectangle
        Say ("  " + $b.Current.Name + "   [" + [int]$r.Width + "x" + [int]$r.Height + " @ " + [int]$r.Left + "," + [int]$r.Top + "]")
        if ([int]$r.Height -lt 44) { Fail ("产品问题：按钮高 " + [int]$r.Height + "px < 44px") }
    }

    # --- 真鼠标点击（先做：面板刚打开，第一行一定在可视区内）---
    # 判据是"她真用鼠标点"这条路也成立。先做是因为 UIA Invoke 会让 Chromium 把被点到的行
    # 滚进视野，做完再点第一行时它的屏幕位置已经变了；刚打开的那一刻点它最干净。
    Say ''
    Say '=== 真鼠标点击（第一行）==='
    $wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
    $target = $null
    foreach ($b in (Buttons-Named $root '的位置')) {
        $r = $b.Current.BoundingRectangle
        if ($r.Top -ge $wa.Top -and ($r.Top + $r.Height) -le $wa.Bottom -and ($r.Left + $r.Width) -le $wa.Right) { $target = $b; break }
    }
    if (-not $target) {
        Say '  可视区内没有可点的「复制位置」按钮（环境问题：面板滚动位置不同），真鼠标这一步跳过'
    }
    else {
        $name = $null
        for ($i = 1; $i -le $Rows; $i++) {
            $candidate = '结果_挑出华东区-' + $i + '.xlsx'
            if (([string]$target.Current.Name).Contains($candidate)) { $name = $candidate }
        }
        if (-not $name) { Fail '产品问题：可视区里第一个「复制位置」按钮的名字认不出是哪一份' }
        if ($name) {
            $expected = Join-Path $seedDir $name
            $r = $target.Current.BoundingRectangle
            $x = [int]($r.Left + $r.Width / 2); $y = [int]($r.Top + $r.Height / 2)
            Set-Clipboard -Value 'CANTE-REALCLICK-SENTINEL'
            $fg = Ensure-Foreground
            Say ("  目标：" + $target.Current.Name + "  矩形=" + [int]$r.Left + "," + [int]$r.Top + " " + [int]$r.Width + "x" + [int]$r.Height + " -> " + $x + "," + $y)
            Say ("  点击前在前台：" + $fg)
            [void][CanteAccept.Win]::SetCursorPos($x, $y)
            Start-Sleep -Milliseconds 600
            # 先晃一下再点：给 Chromium 一点时间处理 hover 的 WM_MOUSEMOVE，再发按下/抬起。
            [CanteAccept.Win]::mouse_event(0x0001, 2, 2, 0, [UIntPtr]::Zero)
            Start-Sleep -Milliseconds 300
            [CanteAccept.Win]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
            Start-Sleep -Milliseconds 80
            [CanteAccept.Win]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
            Start-Sleep -Seconds 2
            $clip = Get-Clipboard -Raw
            Say ("  期望完整位置：" + $expected)
            Say ("  剪贴板（逐字）：" + $clip)
            Say ("  与期望逐字相等：" + ($clip -eq $expected))
            if ($clip -ne $expected) { Fail '产品问题：真鼠标点下去，剪贴板不是这一行的完整位置' }
        }
    }

    # --- 三条都走 UIA Invoke，逐字核对"这一行自己的完整位置" ---
    $copied = @{}
    for ($i = 1; $i -le $Rows; $i++) {
        $name = '结果_挑出华东区-' + $i + '.xlsx'
        $expected = Join-Path $seedDir $name
        $hit = @()
        foreach ($b in (Buttons-Named $root '的位置')) {
            if (([string]$b.Current.Name).Contains($name)) { $hit += $b }
        }
        Say ''
        Say ("--- 第 " + $i + " 行：" + $name + " ---")
        Say ("  期望完整位置：" + $expected)
        if ($hit.Count -ne 1) { Fail ("产品问题：这一行的复制按钮不是唯一一个（命中 " + $hit.Count + "）"); continue }
        $sentinel = 'CANTE-COPY-SENTINEL-' + $i
        Set-Clipboard -Value $sentinel
        [void](Ensure-Foreground)
        if (-not (Invoke-El $hit[0])) { Fail '产品问题：InvokePattern 打不动这个按钮'; continue }
        Start-Sleep -Seconds 2
        $clip = Get-Clipboard -Raw
        Say ("  剪贴板（逐字）：" + $clip)
        $exact = ($clip -eq $expected)
        Say ("  与期望逐字相等：" + $exact)
        if (-not $exact) { Fail '产品问题：点这一行复制的不是它自己的完整位置' }
        $copied[$name] = $clip
    }
    # 三行各拿各的（互不相同）
    $distinct = ($copied.Values | Sort-Object -Unique).Count
    Say ''
    Say ("三行复制的值互不相同：" + ($distinct -eq $copied.Count) + "（" + $distinct + "/" + $copied.Count + "）")
    if ($distinct -ne $copied.Count) { Fail '产品问题：不同行复制出来的位置有重复' }

    Say ''
    Say '=== 复制提示句 ==='
    $bad = [bool](Elements-Named $root '没能复制上')
    $okNote = [bool](Elements-Named $root '已经复制好了')
    Say ("出现「已经复制好了」：" + $okNote)
    Say ("出现「没能复制上」：" + $bad)
    if ($bad) { Fail '产品问题：界面上出现了「没能复制上」' }
    Say ("面板仍开着（「回到首页」还在）：" + [bool](Elements-Named $root '回到首页'))
}
finally {
    Restore-All
}

Say ''
if ($script:Fail -ne 0) { Say '结论：产品问题（见上）'; exit 3 }
Say '结论：通过（每行各拿各的完整位置，真鼠标点击也成立）'
exit 0
