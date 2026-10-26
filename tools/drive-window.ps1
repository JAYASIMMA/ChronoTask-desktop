# Focuses the ChronoTask window and sends a keystroke to it, so a specific view
# can be selected before capturing. Digits 1..5 map to the workspace views.
param(
    [string]$ProcessName = "chronotask",
    [string]$Keys = "1",
    [int]$WaitMs = 900
)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms

$sig = @'
using System;using System.Text;using System.Runtime.InteropServices;
public static class Foc {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint f);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  public static readonly IntPtr TOP = new IntPtr(-1);
  public const uint NOMOVE = 2, NOSIZE = 1;
}
'@
Add-Type -TypeDefinition $sig -Language CSharp

$p = Get-Process -Name $ProcessName -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $p) { Write-Error "no $ProcessName window"; exit 2 }
$h = $p.MainWindowHandle
if ([Foc]::IsIconic($h)) { [Foc]::ShowWindow($h, 9) | Out-Null }
[Foc]::ShowWindow($h, 5) | Out-Null
[Foc]::SetWindowPos($h, [Foc]::TOP, 0, 0, 0, 0, ([Foc]::NOMOVE -bor [Foc]::NOSIZE)) | Out-Null
[Foc]::BringWindowToTop($h) | Out-Null
[Foc]::SetForegroundWindow($h) | Out-Null
Start-Sleep -Milliseconds 400
[System.Windows.Forms.SendKeys]::SendWait($Keys)
Start-Sleep -Milliseconds $WaitMs
Write-Output "sent '$Keys' to pid $($p.Id)"
