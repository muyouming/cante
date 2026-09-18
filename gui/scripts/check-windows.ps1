# 那台 Windows 测试机上的"快检"：只跑 CI 做不到或不方便做的事。
#
# 为什么需要它：`gui/scripts/e2e.sh` 是**完整门禁**（bun install + vite build + 全量
# cargo test），CI 已经在 windows-latest 上跑同一份了。在那台机器上再跑一遍，实测要
# **30 分钟以上**（首次编译 Tauri 依赖树是大头），而其中绝大多数是重复劳动。
#
# 这台机器真正独有的价值是：装真安装包、开真窗口（WebView2）、跑真任务、出 Windows
# 安装包。所以这里只跑"几秒到一两分钟"的检查，用来在推分支之前挡住明显错误。
#
# 用法（PowerShell 5.1 可用）：
#   powershell -NoProfile -ExecutionPolicy Bypass -File gui\scripts\check-windows.ps1
#   powershell ... -File gui\scripts\check-windows.ps1 -IncludeCargo
param(
  [switch]$IncludeCargo,   # 加上 cargo test --lib（暖缓存约一两分钟）
  [switch]$SkipFrontend    # 只跑 Rust 部分
)

$ErrorActionPreference = 'Continue'
# 官方 bun.exe 必须优先：npm 装的 bun 只有 .ps1/.cmd，Rust 里 Command::new("bun") 找不到它 ✓。
# 但路径因机器而异（老机器放 tools\bun，新机器由 winget 装）→ 只在它真的存在时才插到最前 ✓。
$bunDir = "C:\Users\$env:USERNAME\tools\bun"
if (Test-Path $bunDir) { $env:PATH = "$bunDir;$env:USERPROFILE\.cargo\bin;" + $env:PATH }
else { $env:PATH = "$env:USERPROFILE\.cargo\bin;" + $env:PATH }
$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$failed = @()

function Step($name, $block) {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  Write-Host "==> $name" -ForegroundColor Cyan
  & $block
  $code = $LASTEXITCODE
  $sw.Stop()
  $secs = [Math]::Round($sw.Elapsed.TotalSeconds, 1)
  if ($code -ne 0) { Write-Host "    失败（退出码 $code，${secs}s）" -ForegroundColor Red; $script:failed += $name }
  else { Write-Host "    OK（${secs}s）" -ForegroundColor Green }
}

if (-not $SkipFrontend) {
  # 新克隆的机器上没有 node_modules —— 不先装上，下面两步会报一串
  # "Cannot find package 'solid-js'" / "Cannot find type definition file for 'bun'" ✗，
  # 看不出是谁的问题（2026-09-18 在一台新装的 Windows 上就是这么撞的 ✓）。
  if (-not (Test-Path "$repo\gui\node_modules") -and -not $SkipFrontend) {
    Step "装依赖（bun install，只在缺的时候跑）" { Push-Location "$repo\gui"; bun install; Pop-Location }
  }

  Step "前端测试（bun test src）" { Push-Location "$repo\gui"; bun test src; Pop-Location }
  Step "类型检查（bunx tsc --noEmit）" { Push-Location "$repo\gui"; bunx tsc --noEmit; Pop-Location }
}

if ($IncludeCargo) {
  # 只跑 lib 单测：全量 `cargo test` 会连集成测试一起跑（要 spawn 进程、更慢），
  # 那是 CI 的事。lib 单测足以挡住"编译不过 / 纯逻辑错了"。
  Step "Rust lib 单测（cargo test --lib）" {
    Push-Location "$repo\gui\src-tauri"; cargo test --lib; Pop-Location
  }
}

Write-Host ""
if ($failed.Count -eq 0) {
  Write-Host "check-windows: 全部通过" -ForegroundColor Green
  Write-Host "提醒：完整门禁由 CI 跑（ubuntu + windows-latest）。这台机器只做 CI 做不到的事：" -ForegroundColor DarkGray
  Write-Host "      装真安装包、开真窗口、跑真任务、出 Windows 包。" -ForegroundColor DarkGray
  exit 0
} else {
  Write-Host "check-windows: 失败项 —— $($failed -join '、')" -ForegroundColor Red
  exit 1
}
