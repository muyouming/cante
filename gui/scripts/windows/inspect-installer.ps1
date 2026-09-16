# 拆开安装包看里面到底装了什么（不安装）。
#
# 注意：本文件必须保存为 UTF-8 with BOM（Windows PowerShell 5.1 否则按 GBK 解析，
# 中文会变乱码并报语法错）。
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File inspect-installer.ps1 -Setup <路径>
# 说明：需要 7-Zip（默认 C:\Program Files\7-Zip\7z.exe，可用 -SevenZip 指定）。
#      没有 7-Zip 时脚本会退化为「只算 SHA256 + 只报元数据」，并明说拿不到清单。
# 对应用户文档：gui/WINDOWS-ACCEPTANCE-1.md 的「安装包检查」一节。

param(
    [Parameter(Mandatory = $true)][string]$Setup,
    [string]$SevenZip = 'C:\Program Files\7-Zip\7z.exe',
    [string]$WorkDir = "$env:TEMP\cante-acc-inspect"
)

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Section($title) { Write-Output ''; Write-Output ("=== " + $title + " ===") }

if (-not (Test-Path $Setup)) { Write-Output ("找不到安装包：" + $Setup); exit 2 }
$Setup = (Resolve-Path $Setup).Path
$item = Get-Item $Setup

Section '文件本身'
[pscustomobject]@{
    FullName = $Setup
    SizeBytes= $item.Length
    SizeMB   = [math]::Round($item.Length / 1MB, 2)
    Modified = $item.LastWriteTime
} | Format-List

Section 'SHA256'
(Get-FileHash $Setup -Algorithm SHA256).Hash

Section '版本资源（安装器自己写的元数据）'
$item.VersionInfo | Format-List CompanyName, FileDescription, FileVersion, ProductName, ProductVersion

Section '是否带「来自互联网」标记（Mark of the Web）'
# 有 Zone.Identifier 才会触发 SmartScreen；浏览器下载和命令行下载不一样。
$zone = Get-Content $Setup -Stream Zone.Identifier -ErrorAction SilentlyContinue
if ($zone) { $zone } else { Write-Output '没有 Zone.Identifier（这份文件不是浏览器下载来的，SmartScreen 不会因此拦它）。' }

Section '安装包类型与内容清单'
if (-not (Test-Path $SevenZip)) {
    Write-Output ("没有 7-Zip（" + $SevenZip + "），无法列出包内文件。这一步没验证。")
    exit 3
}
Write-Output ("7-Zip 版本：" + ((& $SevenZip 2>&1 | Select-Object -First 2) -join ' '))

Write-Output ''
Write-Output '--- 容器类型 ---'
& $SevenZip l -slt $Setup 2>&1 | Select-String -Pattern '^(Type|SubType|Method|Physical Size|Path) ' | ForEach-Object { $_.Line }

Write-Output ''
Write-Output '--- 包内文件清单 ---'
& $SevenZip l $Setup 2>&1 | Write-Output

Section '解包后的实际文件（用来确认有没有守护进程/自带工具）'
if (Test-Path $WorkDir) { Remove-Item $WorkDir -Recurse -Force }
New-Item -ItemType Directory -Path $WorkDir | Out-Null
& $SevenZip x -o"$WorkDir" $Setup -y 2>&1 | Select-Object -Last 3 | Write-Output
Get-ChildItem $WorkDir -Recurse -File | Select-Object @{n='相对路径';e={$_.FullName.Substring($WorkDir.Length)}}, Length |
    Sort-Object 相对路径 | Format-Table -AutoSize

Section '包里有没有守护进程或自带工具（按文件名匹配）'
$files = Get-ChildItem $WorkDir -Recurse -File
foreach ($pat in @('cante.exe', 'ante.exe', 'cante-sheets*', 'cante-pdf*')) {
    $m = $files | Where-Object { $_.Name -like $pat }
    Write-Output ("{0} -> {1}" -f $pat, $(if ($m) { ($m | ForEach-Object { $_.Name }) -join ', ' } else { '<无>' }))
}

Section 'MSI 管理安装（只有 .msi 才跑）'
if ([System.IO.Path]::GetExtension($Setup) -ne '.msi') {
    Write-Output '不是 .msi，跳过。'
} else {
    # 7-Zip 列 MSI 只能给出 cab 里的短名（例如 "Path"），拿不到真实文件名。
    # msiexec /a 是「管理安装」：只解包不注册，解出来的目录树就是真实文件名。
    $adminDir = Join-Path $WorkDir 'msi-admin'
    $log = Join-Path $WorkDir 'msi-admin.log'
    $msiArgs = @('/a', $Setup, '/qn', ("TARGETDIR=" + $adminDir), '/L*v', $log)
    $msi = Start-Process -FilePath 'msiexec.exe' -ArgumentList $msiArgs -PassThru -Wait
    Write-Output ("msiexec /a ExitCode = " + $msi.ExitCode)
    Get-ChildItem $adminDir -Recurse -File -ErrorAction SilentlyContinue |
        Select-Object @{n='相对路径';e={$_.FullName.Substring($adminDir.Length)}}, Length |
        Format-Table -AutoSize
    $tools = Get-ChildItem $adminDir -Recurse -File | Where-Object { $_.Name -match 'cante-sheets|cante-pdf|cante\.exe|ante\.exe' }
    if ($tools) { $tools | ForEach-Object { Write-Output ('发现工具/守护进程：' + $_.Name) } }
    else { Write-Output 'MSI 里也没有 cante-sheets / cante-pdf / cante.exe / ante.exe。' }
}
