[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$AE=[System.Windows.Automation.AutomationElement]; $TS=[System.Windows.Automation.TreeScope]
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--force-renderer-accessibility'
$admin='C:\cante-scale\scroll-admin.json'
$env:CANTE_ADMIN_CONFIG=$admin
Add-Type -TypeDefinition @'
using System;using System.Runtime.InteropServices;
public static class SW3 { [StructLayout(LayoutKind.Sequential)]public struct RECT{public int Left,Top,Right,Bottom;}
 [DllImport("user32.dll")]public static extern bool GetClientRect(IntPtr h,out RECT r);
 [DllImport("user32.dll")]public static extern bool GetWindowRect(IntPtr h,out RECT r);
 [DllImport("user32.dll")]public static extern bool MoveWindow(IntPtr h,int x,int y,int w,int ht,bool rp);}
'@
$p=Start-Process -FilePath 'C:\cante-scale\app\cante-gui-vm.exe' -PassThru
Start-Sleep -Seconds 12
$h=$p.MainWindowHandle; $root=$AE::FromHandle($h)
$cr=New-Object 'SW3+RECT';[void][SW3]::GetClientRect($h,[ref]$cr)
$wr=New-Object 'SW3+RECT';[void][SW3]::GetWindowRect($h,[ref]$wr)
$cw=($wr.Right-$wr.Left)-$cr.Right; $ch=($wr.Bottom-$wr.Top)-$cr.Bottom
[void][SW3]::MoveWindow($h,0,0,(1024+$cw),(608+$ch),$true)
Start-Sleep -Seconds 3
foreach($e in $root.FindAll($TS::Descendants,[System.Windows.Automation.Condition]::TrueCondition)){ $n=$e.Current.Name; if($n -and $n.StartsWith('打开我做的结果')){ $e.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke(); break } }
Start-Sleep -Seconds 4
'--- 面板里的 Button（ControlType=Button）---'
foreach($e in $root.FindAll($TS::Descendants,[System.Windows.Automation.Condition]::TrueCondition)){
  if($e.Current.ControlType.ProgrammaticName -eq 'ControlType.Button'){
    $b=$e.Current.BoundingRectangle
    '  name="' + $e.Current.Name + '" y=' + [int]$b.Top + ' h=' + [int]$b.Height + ' 屏外=' + $e.Current.IsOffscreen
  }
}
'--- 有没有 ScrollPattern 的元素 ---'
$n=0
foreach($e in $root.FindAll($TS::Descendants,[System.Windows.Automation.Condition]::TrueCondition)){
  try{ $sp=$e.GetCurrentPattern([System.Windows.Automation.ScrollPattern]::Pattern); if($sp){ $n++; '  "' + $e.Current.Name + '" vScrollable=' + $sp.Current.VerticallyScrollable } }catch{}
}
'  ScrollPattern 元素数=' + $n
Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
