<#
    Pre-seeds the NSIS toolchain that `npx tauri build` downloads on first use.

    Why this exists: the HTTP client inside the Tauri CLI times out fetching
    github.com releases on some networks, while a plain download of the same URL
    succeeds. Seeding %LOCALAPPDATA%\tauri\NSIS once makes bundling work offline
    afterwards, on any machine, without patching the CLI.

    Usage:
        powershell -ExecutionPolicy Bypass -File tools/fetch-nsis.ps1
        powershell -ExecutionPolicy Bypass -File tools/fetch-nsis.ps1 -Force
#>
[CmdletBinding()]
param(
    [switch]$Force,
    [string]$NsisVersion = "3.13",
    [string]$UtilsVersion = "0.5.3"
)
$ErrorActionPreference = "Stop"

$CacheRoot  = Join-Path $env:LOCALAPPDATA "tauri"
$NsisDir    = Join-Path $CacheRoot "NSIS"
$NsisUrl    = "https://github.com/tauri-apps/binary-releases/releases/download/nsis-$NsisVersion/nsis-$NsisVersion.zip"
$UtilsUrl   = "https://github.com/tauri-apps/nsis-tauri-utils/releases/download/nsis_tauri_utils-v$UtilsVersion/nsis_tauri_utils.dll"

if ((Test-Path (Join-Path $NsisDir "makensis.exe")) -and -not $Force) {
    Write-Host "NSIS already present: $NsisDir (use -Force to replace it)" -ForegroundColor Yellow
    exit 0
}

New-Item -ItemType Directory -Force -Path $CacheRoot | Out-Null
$tmp = Join-Path $env:TEMP ("djtm-nsis-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

try {
    $zip = Join-Path $tmp "nsis.zip"
    Write-Host "Downloading NSIS $NsisVersion" -ForegroundColor Cyan
    Invoke-WebRequest -Uri $NsisUrl -OutFile $zip -UseBasicParsing
    Write-Host "Downloading nsis_tauri_utils v$UtilsVersion" -ForegroundColor Cyan
    $utils = Join-Path $tmp "nsis_tauri_utils.dll"
    Invoke-WebRequest -Uri $UtilsUrl -OutFile $utils -UseBasicParsing

    Write-Host "Extracting" -ForegroundColor Cyan
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $extract = Join-Path $tmp "x"
    [System.IO.Compression.ZipFile]::ExtractToDirectory($zip, $extract)
    # The archive wraps everything in nsis-<version>/; the cache wants its contents at the root.
    $inner = Get-ChildItem $extract -Directory | Select-Object -First 1
    if ($null -eq $inner) { $inner = Get-Item $extract }

    if (Test-Path $NsisDir) { Remove-Item $NsisDir -Recurse -Force }
    Move-Item $inner.FullName $NsisDir

    # makensis runs the ANSI engine, but the Tauri plugin is loaded from x86-unicode;
    # drop it in both so the script compiles whichever path it looks up.
    foreach ($arch in @("x86-unicode", "x86-ansi")) {
        $dir = Join-Path $NsisDir "Plugins\$arch"
        if (Test-Path $dir) {
            Copy-Item $utils (Join-Path $dir "nsis_tauri_utils.dll") -Force
            Write-Host "  plugin -> Plugins\$arch"
        }
    }

    if (-not (Test-Path (Join-Path $NsisDir "makensis.exe"))) {
        Write-Error "extracted tree has no makensis.exe: $NsisDir"
        exit 1
    }
    Write-Host ""
    Write-Host "Ready. Bundling can now run without the CLI's own download:" -ForegroundColor Green
    Write-Host "  $NsisDir\makensis.exe"
} finally {
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
