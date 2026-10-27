# Clicks inside the app window at client-area coordinates using a real mouse
# event. SendKeys can miss the WebView2 child window, so pointer input is the
# reliable way to drive a specific control from a script.
#
#   powershell -File tools/click-in-window.ps1 -X 66 -Y 254
#
# Add -Double for a double click, or -Wheel N to scroll N notches down instead of
# clicking (negative scrolls up). Coordinates are CSS/client pixels, so they match
# what tools/capture-window.ps1 records.
param(
    [string]$ProcessName = "dj-task-manager",
    [int]$X = 0,
    [int]$Y = 0,
    [switch]$Double,
    [int]$Wheel = 0,
    [int]$WaitMs = 700
)
$ErrorActionPreference = "Stop"

$sig = @'
using System;using System.Runtime.InteropServices;
public static class Clicker {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, int d, IntPtr e);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  public const uint LEFTDOWN = 0x02, LEFTUP = 0x04, WHEEL_FLAG = 0x0800;
  public const int WHEEL_STEP = 120;
  public static void Click(int x, int y) {
    SetCursorPos(x, y);
    mouse_event(LEFTDOWN, 0, 0, 0, IntPtr.Zero);
    mouse_event(LEFTUP, 0, 0, 0, IntPtr.Zero);
  }
  // A negative wheel delta moves the page down, so a positive "ticks" argument
  // reads as "scroll down N notches", which is what the caller means.
  // The constants avoid a bare `WHEEL` name: PowerShell member lookup is
  // case-insensitive, so a `WHEEL` field hides a `Wheel` method.
  public static void Wheel(int x, int y, int ticks) {
    SetCursorPos(x, y);
    for (int i = 0; i < Math.Abs(ticks); i++) {
      mouse_event(WHEEL_FLAG, 0, 0, -WHEEL_STEP * Math.Sign(ticks), IntPtr.Zero);
    }
  }
}
'@
Add-Type -TypeDefinition $sig -Language CSharp

$p = Get-Process -Name $ProcessName -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $p) { Write-Error "no window for process '$ProcessName'"; exit 2 }
$h = $p.MainWindowHandle
if ([Clicker]::IsIconic($h)) { [Clicker]::ShowWindow($h, 9) | Out-Null }
[Clicker]::BringWindowToTop($h) | Out-Null
[Clicker]::SetForegroundWindow($h) | Out-Null
Start-Sleep -Milliseconds 300

$pt = New-Object Clicker+POINT
$pt.X = $X
$pt.Y = $Y
if (-not [Clicker]::ClientToScreen($h, [ref]$pt)) { Write-Error "ClientToScreen failed"; exit 3 }
$rect = New-Object Clicker+RECT
[Clicker]::GetClientRect($h, [ref]$rect) | Out-Null
if ($X -lt 0 -or $Y -lt 0 -or $X -gt $rect.R -or $Y -gt $rect.B) {
    Write-Warning "($X,$Y) is outside the $($rect.R)x$($rect.B) client area"
}

$action = "clicked client ($X,$Y)"
if ($Wheel -ne 0) {
    [Clicker]::Wheel($pt.X, $pt.Y, $Wheel)
    $action = "scrolled $($Wheel) notch(es) at client ($X,$Y)"
} else {
    [Clicker]::Click($pt.X, $pt.Y)
    if ($Double) { Start-Sleep -Milliseconds 90; [Clicker]::Click($pt.X, $pt.Y) }
}
Start-Sleep -Milliseconds $WaitMs
Write-Output "$action -> screen ($($pt.X),$($pt.Y)) on pid $($p.Id)"
