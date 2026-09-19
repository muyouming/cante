# 读/改「显示缩放」——只用 **DisplayConfig** 这一条官方路径（Windows 设置里那个滑块走的就是它），
# 不碰其它注册表（安全第一，见文件头边界）。
#
# 三种用法：
#   -Mode read   —— 只读：DPI、分辨率、.DisplayConfig 的 source/target 与缩放档位
#   -Mode set    -ScalePercent 125
#   -Mode restore            —— 设回本脚本读到的原值（原值在 set 时落盘到 -StateFile）
#
# 边界（照任务要求）：
#   * 只调 DisplayConfig 的 DPI 缩放（DISPLAYCONFIG_DEVICE_INFO_SET_SOURCE_DPI_SCALE = 19）；
#   * 不动 HKCU\Control Panel\Desktop 的 LogPixels、不重启会话；
#   * set 之前先把原值落盘；restore 用那份原值，幂等；
#   * 系统拒绝就**如实报 rc 并退出 2**，不做别的尝试。
#
# 退出码：0 = 成功；2 = 环境/权限/不支持（原因打在 stdout 与结果文件里）。
#
# 两个踩过的坑（写在这里免得下次再踩）：
#   * 设备信息类型常量是 **18/19**（GET/SET_SOURCE_DPI_SCALE），不是 14/15；写错得到 rc=31。
#   * **PowerShell 取嵌套值类型字段是复制**：`$g.header.size = ...` 改的是副本，传进去还是 0
#     → rc=31。所以整个调用要在 C# 里立好结构再传（下面 ScaleNative 就是这么做的）。
#
# 注意：本文件必须保存为 UTF-8 with BOM（Windows PowerShell 5.1 否则按 GBK 解析中文）。

param(
    [Parameter(Mandatory = $true)][ValidateSet('read', 'set', 'restore')][string]$Mode,
    [int]$ScalePercent = 0,
    [string]$StateFile = "$env:TEMP\cante-scale-state.json"
)

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class ScaleNative {
    [StructLayout(LayoutKind.Sequential)] public struct LUID { public uint LowPart; public int HighPart; }
    [StructLayout(LayoutKind.Sequential)] public struct HDR { public int type; public uint size; public LUID adapterId; public uint id; }
    [StructLayout(LayoutKind.Sequential)] public struct GET { public HDR header; public int minScaleRel; public int curScaleRel; public int maxScaleRel; }
    [StructLayout(LayoutKind.Sequential)] public struct SET { public HDR header; public int scaleRel; }
    [StructLayout(LayoutKind.Sequential)] public struct SRC { public LUID adapterId; public uint id; public uint modeInfoIdx; public uint statusFlags; }
    [StructLayout(LayoutKind.Sequential)] public struct TGT { public LUID adapterId; public uint id; public uint modeInfoIdx; public uint outputTechnology; public uint rotation; public uint scaling; public uint refreshNum; public uint refreshDen; public uint scanLineOrdering; public int targetAvailable; public uint statusFlags; }
    [StructLayout(LayoutKind.Sequential)] public struct PATH { public SRC sourceInfo; public TGT targetInfo; public uint flags; }
    [StructLayout(LayoutKind.Sequential)] public struct MODE { public int infoType; public uint id; public LUID adapterId; public ulong a; public ulong b; public ulong c; public ulong d; }

    [DllImport("user32.dll")] static extern int GetDisplayConfigBufferSizes(uint f, out uint np, out uint nm);
    [DllImport("user32.dll")] static extern int QueryDisplayConfig(uint f, ref uint np, [Out] PATH[] p, ref uint nm, [Out] MODE[] m, IntPtr t);
    [DllImport("user32.dll")] static extern int DisplayConfigGetDeviceInfo(ref GET i);
    [DllImport("user32.dll")] static extern int DisplayConfigSetDeviceInfo(ref SET i);
    [DllImport("user32.dll")] public static extern uint GetDpiForSystem();

    const int QDC_ONLY_ACTIVE_PATHS = 2;
    const int GET_SOURCE_DPI_SCALE = 18;
    const int SET_SOURCE_DPI_SCALE = 19;

    public static PATH[] Paths() {
        uint np = 0, nm = 0;
        int rc = GetDisplayConfigBufferSizes(QDC_ONLY_ACTIVE_PATHS, out np, out nm);
        if (rc != 0) throw new Exception("GetDisplayConfigBufferSizes rc=" + rc);
        var p = new PATH[np]; var m = new MODE[nm];
        rc = QueryDisplayConfig(QDC_ONLY_ACTIVE_PATHS, ref np, p, ref nm, m, IntPtr.Zero);
        if (rc != 0) throw new Exception("QueryDisplayConfig rc=" + rc);
        if (np < p.Length) { var t = new PATH[np]; Array.Copy(p, t, np); p = t; }
        return p;
    }

    public static uint[] SourceIds() {
        var list = new List<uint>();
        foreach (var path in Paths()) if (!list.Contains(path.sourceInfo.id)) list.Add(path.sourceInfo.id);
        return list.ToArray();
    }

    /// 读缩放档位；返回 rc（0 成功）。整个结构在 C# 里立好再传。
    public static int GetScale(uint sourceId, out int min, out int cur, out int max) {
        min = cur = max = 0;
        foreach (var path in Paths()) {
            if (path.sourceInfo.id != sourceId) continue;
            var g = new GET();
            g.header.type = GET_SOURCE_DPI_SCALE;
            g.header.size = (uint)Marshal.SizeOf(typeof(GET));
            g.header.adapterId = path.sourceInfo.adapterId;
            g.header.id = path.sourceInfo.id;
            int rc = DisplayConfigGetDeviceInfo(ref g);
            if (rc == 0) { min = g.minScaleRel; cur = g.curScaleRel; max = g.maxScaleRel; }
            return rc;
        }
        return -1;
    }

    public static int SetScale(uint sourceId, int scaleRel) {
        foreach (var path in Paths()) {
            if (path.sourceInfo.id != sourceId) continue;
            var s = new SET();
            s.header.type = SET_SOURCE_DPI_SCALE;
            s.header.size = (uint)Marshal.SizeOf(typeof(SET));
            s.header.adapterId = path.sourceInfo.adapterId;
            s.header.id = path.sourceInfo.id;
            s.scaleRel = scaleRel;
            return DisplayConfigSetDeviceInfo(ref s);
        }
        return -1;
    }
}
'@

$script:Lines = New-Object System.Collections.Generic.List[string]
function Say([string]$t) { Write-Output $t; [void]$script:Lines.Add($t) }
function Flush([string]$suffix) {
    $dir = Split-Path $StateFile -Parent
    if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    ($script:Lines -join "`r`n") | Set-Content -Path ($StateFile + $suffix) -Encoding UTF8
}

# --- 常见事实（三种模式都打，便于对照） ---
Add-Type -AssemblyName System.Windows.Forms
$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$dc = [System.Runtime.InteropServices.Marshal]::GetHINSTANCE([System.Reflection.Assembly]::GetExecutingAssembly().GetModules()[0])
# LOGPIXELSX via a device context
Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public static class G{ [DllImport("gdi32.dll")]public static extern int GetDeviceCaps(IntPtr h,int i); [DllImport("user32.dll")]public static extern IntPtr GetDC(IntPtr h); [DllImport("user32.dll")]public static extern int ReleaseDC(IntPtr h,IntPtr d);}'
$hdc = [G]::GetDC([IntPtr]::Zero)
$logX = [G]::GetDeviceCaps($hdc, 88)
[void][G]::ReleaseDC([IntPtr]::Zero, $hdc)

Say ("GetDpiForSystem = " + [ScaleNative]::GetDpiForSystem())
Say ("LOGPIXELSX       = " + $logX + "  （96 = 100%，120 = 125%，144 = 150%）")
Say ("主屏物理尺寸   = " + $b.Width + "x" + $b.Height)
$k = 'HKCU:\Control Panel\Desktop'
Say ("注册表 LogPixels      = " + (Get-ItemProperty $k -Name LogPixels -ErrorAction SilentlyContinue).LogPixels + "（没设过就是空）")
Say ("注册表 Win8DpiScaling = " + (Get-ItemProperty $k -Name Win8DpiScaling -ErrorAction SilentlyContinue).Win8DpiScaling)

try { $paths = [ScaleNative]::Paths() } catch { Say ("DisplayConfig 不可用：" + $_.Exception.Message); Say 'ENV:DisplayConfig 读不到'; Flush '.read.txt'; exit 2 }

Say ''
Say ("=== DisplayConfig 活动路径（" + @($paths).Count + " 条）===")
foreach ($p in $paths) {
    Say ("  sourceId=" + $p.sourceInfo.id + "  targetId=" + $p.targetInfo.id + "  outputTech=" + $p.targetInfo.outputTechnology + "  targetAvailable=" + $p.targetInfo.targetAvailable)
}

$script:records = @()
Say ''
Say '=== 每个 source 的缩放档位 ==='
foreach ($id in [ScaleNative]::SourceIds()) {
    $mn = 0; $cu = 0; $mx = 0
    $rc = [ScaleNative]::GetScale($id, [ref]$mn, [ref]$cu, [ref]$mx)
    if ($rc -eq 0) {
        Say ("  sourceId=$id  minRel=$mn curRel=$cu maxRel=$mx  （相对「推荐缩放」的偏移，25% 一档）")
        $script:records += [pscustomobject]@{ sourceId = $id; minRel = $mn; curRel = $cu; maxRel = $mx }
    } else {
        Say ("  sourceId=$id  读缩放失败 rc=$rc" + $(if ($rc -eq 87) { "（87 = ERROR_INVALID_PARAMETER：这个适配器/输出不支持按 source 调缩放）" } elseif ($rc -eq 31) { "（31 = ERROR_GEN_FAILURE）" } else { "" }))
    }
}

switch ($Mode) {
    'read' {
        Flush '.read.txt'
        Say ''
        if (@($script:records).Count -gt 0) { Say 'scale: READ OK（读到了档位）' } else { Say 'scale: READ OK（但**没有任何 source 支持读缩放** —— 见上面的 rc）' }
        exit 0
    }
    'set' {
        if ($ScalePercent -le 0) { Say 'set 需要 -ScalePercent'; exit 2 }
        # 原值落盘（restore 用）
        [ordered]@{
            when = (Get-Date).ToString('o')
            logpixels = $logX
            dpi = [ScaleNative]::GetDpiForSystem()
            sources = $script:records
        } | ConvertTo-Json -Depth 6 | Set-Content -Path $StateFile -Encoding UTF8
        Say ''
        Say ("原值已落盘：" + $StateFile)

        if (@($script:records).Count -eq 0) {
            Say 'ENV:没有任何 source 支持读缩放档位 —— 因此也无法设置（不猜档位）。按边界不做别的尝试。'
            Flush '.set.txt'
            exit 2
        }
        $rec = $script:records[0]
        $curPercent = [int]([Math]::Round($logX * 100.0 / 96.0))
        $delta = [int](($ScalePercent - $curPercent) / 25)
        $targetRel = $rec.curRel + $delta
        if ($targetRel -lt $rec.minRel) { $targetRel = $rec.minRel }
        if ($targetRel -gt $rec.maxRel) { $targetRel = $rec.maxRel }
        Say ("目标：" + $ScalePercent + "%（当前 " + $curPercent + "%）→ curRel " + $rec.curRel + " → " + $targetRel)
        $rc = [ScaleNative]::SetScale($rec.sourceId, $targetRel)
        Say ("DisplayConfigSetDeviceInfo rc=" + $rc)
        if ($rc -ne 0) {
            Say ("ENV:设置失败 rc=" + $rc + " —— 按边界不再做别的尝试")
            Flush '.set.txt'
            exit 2
        }
        Start-Sleep -Seconds 2
        $logX2 = [G]::GetDeviceCaps([G]::GetDC([IntPtr]::Zero), 88)
        foreach ($p in $paths) { [void][G]::ReleaseDC([IntPtr]::Zero, $p) }
        Say ("设置后 LOGPIXELSX = " + $logX2 + "（期望 ≈ " + $ScalePercent + "% 对应 " + [int](96 * $ScalePercent / 100) + "）")
        Flush '.set.txt'
        Say 'scale: SET OK'
        exit 0
    }
    'restore' {
        if (-not (Test-Path $StateFile)) { Say ("ENV:没有原值存档（" + $StateFile + "），不敢瞎还原"); exit 2 }
        $state = Get-Content $StateFile -Raw -Encoding UTF8 | ConvertFrom-Json
        Say ''
        Say ("原始记录：logpixels=" + $state.logpixels + "、sources=" + (($state.sources | ForEach-Object { $_.sourceId.ToString() + '/' + $_.curRel }) -join ','))
        $ok = $true
        foreach ($rec in $state.sources) {
            $rc = [ScaleNative]::SetScale($rec.sourceId, $rec.curRel)
            Say ("  还原 sourceId=" + $rec.sourceId + " → curRel=" + $rec.curRel + " rc=" + $rc)
            if ($rc -ne 0) { $ok = $false }
        }
        Start-Sleep -Seconds 2
        $hdc2 = [G]::GetDC([IntPtr]::Zero)
        $logX2 = [G]::GetDeviceCaps($hdc2, 88)
        [void][G]::ReleaseDC([IntPtr]::Zero, $hdc2)
        Say ("还原后 LOGPIXELSX = " + $logX2 + "（原值 " + $state.logpixels + "）一致=" + ($logX2 -eq $state.logpixels))
        Flush '.restore.txt'
        if (-not $ok) { Say 'ENV:还原时有一步 rc≠0，见上'; exit 2 }
        Say 'scale: RESTORE OK'
        exit 0
    }
}
