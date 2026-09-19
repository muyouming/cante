[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class DevName {
    [StructLayout(LayoutKind.Sequential)] public struct LUID { public uint LowPart; public int HighPart; }
    [StructLayout(LayoutKind.Sequential)] public struct HDR { public int type; public uint size; public LUID adapterId; public uint id; }
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct SRCNAME {
        public HDR header;
        public uint flags; public uint outputTechnology; public uint edidManufactureId; public uint edidProductCodeId;
        public uint connectorInstance;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst=64)] public string monitorFriendlyDeviceName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst=128)] public string monitorDevicePath;
    }
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct TGTNAME {
        public HDR header; public uint flags; public uint outputTechnology;
        public ushort edidManufactureId; public ushort edidProductCodeId;
        public uint connectorInstance;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst=64)] public string monitorFriendlyDeviceName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst=128)] public string monitorDevicePath;
    }
    [StructLayout(LayoutKind.Sequential)] public struct SRC { public LUID adapterId; public uint id; public uint modeInfoIdx; public uint statusFlags; }
    [StructLayout(LayoutKind.Sequential)] public struct TGT { public LUID adapterId; public uint id; public uint modeInfoIdx; public uint outputTechnology; public uint rotation; public uint scaling; public uint refreshNum; public uint refreshDen; public uint scanLineOrdering; public int targetAvailable; public uint statusFlags; }
    [StructLayout(LayoutKind.Sequential)] public struct PATH { public SRC sourceInfo; public TGT targetInfo; public uint flags; }
    [StructLayout(LayoutKind.Sequential)] public struct MODE { public int infoType; public uint id; public LUID adapterId; public ulong a; public ulong b; public ulong c; public ulong d; }
    [DllImport("user32.dll")] static extern int GetDisplayConfigBufferSizes(uint f, out uint np, out uint nm);
    [DllImport("user32.dll")] static extern int QueryDisplayConfig(uint f, ref uint np, [Out] PATH[] p, ref uint nm, [Out] MODE[] m, IntPtr t);
    [DllImport("user32.dll")] static extern int DisplayConfigGetDeviceInfo(ref SRCNAME i);
    [DllImport("user32.dll")] static extern int DisplayConfigGetDeviceInfo(ref TGTNAME i);
    const int QDC_ONLY_ACTIVE_PATHS = 2;
    const int GET_SOURCE_NAME = 1;
    const int GET_TARGET_NAME = 2;
    public static PATH[] Paths() {
        uint np=0, nm=0;
        if (GetDisplayConfigBufferSizes(QDC_ONLY_ACTIVE_PATHS, out np, out nm) != 0) return new PATH[0];
        var p = new PATH[np]; var m = new MODE[nm];
        if (QueryDisplayConfig(QDC_ONLY_ACTIVE_PATHS, ref np, p, ref nm, m, IntPtr.Zero) != 0) return new PATH[0];
        if (np < p.Length) { var t = new PATH[np]; Array.Copy(p, t, np); p = t; }
        return p;
    }
    public static string TargetName(uint targetId) {
        foreach (var path in Paths()) {
            if (path.targetInfo.id != targetId) continue;
            var n = new TGTNAME();
            n.header.type = GET_TARGET_NAME;
            n.header.size = (uint)Marshal.SizeOf(typeof(TGTNAME));
            n.header.adapterId = path.targetInfo.adapterId;
            n.header.id = path.targetInfo.id;
            int rc = DisplayConfigGetDeviceInfo(ref n);
            if (rc == 0) return n.monitorFriendlyDeviceName + " | " + n.monitorDevicePath + " | outputTech=" + n.outputTechnology;
            return "rc=" + rc;
        }
        return "(not found)";
    }
    public static string SourceName(uint sourceId) {
        foreach (var path in Paths()) {
            if (path.sourceInfo.id != sourceId) continue;
            var n = new SRCNAME();
            n.header.type = GET_SOURCE_NAME;
            n.header.size = (uint)Marshal.SizeOf(typeof(SRCNAME));
            n.header.adapterId = path.sourceInfo.adapterId;
            n.header.id = path.sourceInfo.id;
            int rc = DisplayConfigGetDeviceInfo(ref n);
            if (rc == 0) return n.monitorFriendlyDeviceName + " | " + n.monitorDevicePath;
            return "rc=" + rc;
        }
        return "(not found)";
    }
}
'@
'--- adapters / outputs (DisplayConfig) ---'
foreach ($p in [DevName]::Paths()) {
    "source id=$($p.sourceInfo.id)  name=" + [DevName]::SourceName($p.sourceInfo.id)
    "target id=$($p.targetInfo.id)  name=" + [DevName]::TargetName($p.targetInfo.id)
    "  target outputTech=$($p.targetInfo.outputTechnology)  scaling=$($p.targetInfo.scaling)"
}
'--- WMI video controller (driver) ---'
Get-CimInstance Win32_VideoController | ForEach-Object { "  $($_.Name) | driver=$($_.DriverVersion) | $($_.CurrentHorizontalResolution)x$($_.CurrentVerticalResolution)@$($_.CurrentRefreshRate)" }
'--- PnP display devices ---'
Get-PnpDevice -Class Display -ErrorAction SilentlyContinue | ForEach-Object { "  $($_.Status)  $($_.FriendlyName)" }
