# Crops a rectangle out of a PNG so a small region can be inspected at full size.
#   powershell -File tools/crop-image.ps1 -Path verify\screen.png -X 1450 -Y 780 -W 460 -H 290
param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][int]$X,
    [Parameter(Mandatory = $true)][int]$Y,
    [Parameter(Mandatory = $true)][int]$W,
    [Parameter(Mandatory = $true)][int]$H,
    [string]$Out = ""
)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$src = [System.IO.Path]::GetFullPath($Path)
if (-not (Test-Path $src)) { Write-Error "no such file: $src"; exit 2 }
$img = [System.Drawing.Image]::FromFile($src)
$X = [Math]::Max(0, $X); $Y = [Math]::Max(0, $Y)
$W = [Math]::Min($W, $img.Width - $X); $H = [Math]::Min($H, $img.Height - $Y)
$bmp = New-Object System.Drawing.Bitmap($W, $H)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.DrawImage($img, (New-Object System.Drawing.Rectangle(0, 0, $W, $H)),
    (New-Object System.Drawing.Rectangle($X, $Y, $W, $H)), [System.Drawing.GraphicsUnit]::Pixel)
$g.Dispose(); $img.Dispose()

$dst = if ($Out) { [System.IO.Path]::GetFullPath($Out) } else { [System.IO.Path]::ChangeExtension($src, ".crop.png") }
if (Test-Path $dst) { Remove-Item $dst -Force }
$bmp.Save($dst, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output "cropped ${W}x${H} from $Path -> $dst"
