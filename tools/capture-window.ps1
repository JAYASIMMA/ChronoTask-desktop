# Captures the ChronoTask window to a PNG for visual verification of a build.
# Uses PrintWindow with PW_RENDERFULLCONTENT so occlusion and z-order do not matter,
# and marks the process DPI-aware so the geometry is in physical pixels.
param(
    [string]$Out = "dj-task-manager-window.png",
    [string]$ProcessName = "dj-task-manager",
    [ValidateSet("print", "screen")] [string]$Method = "print",
    [int]$SettleMs = 1200
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$sig = @'
using System;
using System.Text;
using System.Drawing;
using System.Runtime.InteropServices;
public static class Win {
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint f);
    [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern IntPtr GetWindowDC(IntPtr h);
    [DllImport("user32.dll")] public static extern int ReleaseWindowDC(IntPtr h, IntPtr dc);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
    public const uint PW_CLIENTONLY = 1, PW_RENDERFULLCONTENT = 2;
    public static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
    public static readonly IntPtr HWND_NOTOPMOST = new IntPtr(-2);
    public static readonly IntPtr HWND_BOTTOM = new IntPtr(1);
    public const uint SWP_NOMOVE = 2, SWP_NOSIZE = 1, SWP_NOACTIVATE = 0x10;
    public static string Title(IntPtr h) {
        int len = GetWindowTextLength(h);
        var sb = new StringBuilder(len + 1);
        GetWindowText(h, sb, sb.Capacity);
        return sb.ToString();
    }
    // Sends the window's own device context into a bitmap; works while occluded.
    public static Bitmap Grab(IntPtr h, int w, int hh) {
        var bmp = new Bitmap(w, hh, System.Drawing.Imaging.PixelFormat.Format32bppArgb);
        using (var g = Graphics.FromImage(bmp)) {
            IntPtr hdc = g.GetHdc();
            bool ok = PrintWindow(h, hdc, PW_RENDERFULLCONTENT | PW_CLIENTONLY);
            g.ReleaseHdc(hdc);
            if (!ok) throw new Exception("PrintWindow returned false");
        }
        return bmp;
    }
}
'@
Add-Type -TypeDefinition $sig -Language CSharp -ReferencedAssemblies 'System.Drawing.dll'
[Win]::SetProcessDPIAware() | Out-Null

$proc = Get-Process -Name $ProcessName -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $proc) { Write-Error "no window for process '$ProcessName'"; exit 2 }

$hwnd = $proc.MainWindowHandle
Write-Output "window: $([Win]::Title($hwnd))  (pid $($proc.Id))"
if ([Win]::IsIconic($hwnd)) { [Win]::ShowWindow($hwnd, 9) | Out-Null }
[Win]::ShowWindow($hwnd, 5) | Out-Null
# Nudge it above its own siblings for the screen fallback, then restore.
[Win]::SetWindowPos($hwnd, [Win]::HWND_TOPMOST, 0, 0, 0, 0,
    ([Win]::SWP_NOMOVE -bor [Win]::SWP_NOSIZE)) | Out-Null
Start-Sleep -Milliseconds $SettleMs

$rect = New-Object Win+RECT
[Win]::GetWindowRect($hwnd, [ref]$rect) | Out-Null
$w = $rect.Right - $rect.Left
$h = $rect.Bottom - $rect.Top
if ($w -le 0 -or $h -le 0) { Write-Error "no window area (${w}x${h})"; exit 4 }

function Is-Blank($bmp) {
    # WebView2 can hand back an all-black surface; sample a grid to detect that.
    $colors = @{}
    for ($x = 40; $x -lt $bmp.Width; $x += 137) {
        for ($y = 40; $y -lt $bmp.Height; $y += 131) {
            $c = $bmp.GetPixel($x, $y)
            $colors["$($c.R),$($c.G),$($c.B)"] = 1
        }
    }
    return $colors.Count -le 2
}

$bmp = $null
if ($Method -eq 'print') {
    try {
        $bmp = [Win]::Grab($hwnd, $w, $h)
        if (Is-Blank $bmp) { Write-Output "PrintWindow returned a blank surface; falling back to screen grab"; $bmp.Dispose(); $bmp = $null }
    } catch { Write-Output "PrintWindow failed ($($_.Exception.Message)); falling back to screen grab"; $bmp = $null }
}
if (-not $bmp) {
    $bmp = New-Object System.Drawing.Bitmap($w, $h, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($rect.Left, $rect.Top, 0, 0, (New-Object System.Drawing.Size($w, $h)))
    $g.Dispose()
}

$outFull = if ([IO.Path]::IsPathRooted($Out)) { $Out } else { Join-Path (Get-Location) $Out }
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $outFull) | Out-Null
$bmp.Save($outFull, [System.Drawing.Imaging.ImageFormat]::Png)
$distinct = (Is-Blank $bmp)
$bmp.Dispose()

[Win]::SetWindowPos($hwnd, [Win]::HWND_NOTOPMOST, 0, 0, 0, 0,
    ([Win]::SWP_NOMOVE -bor [Win]::SWP_NOSIZE -bor [Win]::SWP_NOACTIVATE)) | Out-Null

Write-Output "captured ${w}x${h} -> $outFull$(if ($distinct) { ' [WARNING: image looks blank]' })"
