# Prints the geometry needed to translate screenshot pixels into click targets:
# window bounds, client bounds, and the screen position of client (0,0).
param([string]$ProcessName = "dj-task-manager")
$ErrorActionPreference = "Stop"

$sig = @'
using System;using System.Runtime.InteropServices;
public static class G {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L,T,R,B; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X,Y; }
}
'@
Add-Type -TypeDefinition $sig -Language CSharp
[void][G]::SetProcessDPIAware()

Add-Type -AssemblyName System.Windows.Forms
$vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
"virtual screen: $($vs.Width)x$($vs.Height) at $($vs.X),$($vs.Y)"

$p = Get-Process -Name $ProcessName -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $p) { Write-Error "no window for $ProcessName"; exit 2 }
$h = $p.MainWindowHandle

$wr = New-Object G+RECT
[void][G]::GetWindowRect($h, [ref]$wr)
$cr = New-Object G+RECT
[void][G]::GetClientRect($h, [ref]$cr)
$pt = New-Object G+POINT
[void][G]::ClientToScreen($h, [ref]$pt)

"window rect : $($wr.R - $wr.L)x$($wr.B - $wr.T) at $($wr.L),$($wr.T)"
"client rect : $($cr.R)x$($cr.B)"
"client(0,0) : screen $($pt.X),$($pt.Y)  (offset from window origin: $(($pt.X - $wr.L)),$(($pt.Y - $wr.T)))"
