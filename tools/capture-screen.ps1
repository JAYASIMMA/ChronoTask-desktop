# Grabs the whole virtual desktop. Needed to see things the app window does not
# own, chiefly the Windows toast that appears in the shell's notification area.
param(
    [string]$Out = "verify\screen.png",
    [int]$DelayMs = 0
)
$ErrorActionPreference = "Stop"

$sig = @'
using System;using System.Runtime.InteropServices;
public static class Scr {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
'@
Add-Type -TypeDefinition $sig -Language CSharp
[void][Scr]::SetProcessDPIAware()
Add-Type -AssemblyName System.Windows.Forms, System.Drawing

if ($DelayMs -gt 0) { Start-Sleep -Milliseconds $DelayMs }

$vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap($vs.Width, $vs.Height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($vs.X, $vs.Y, 0, 0, $bmp.Size)
$g.Dispose()

$path = [System.IO.Path]::GetFullPath($Out)
New-Item -ItemType Directory -Force -Path ([System.IO.Path]::GetDirectoryName($path)) | Out-Null
if (Test-Path $path) { Remove-Item $path -Force }
$bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()

Write-Output "captured $($vs.Width)x$($vs.Height) (origin $($vs.X),$($vs.Y)) -> $path"
