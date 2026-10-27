# Installs DJ Task Manager for the current user and registers the Windows app identity.
#
# Why this exists next to `npx tauri build`: Windows only brands a toast (name + icon,
# and the sticky alarm scenario) when the AppUserModelID it is raised under is registered.
# An NSIS install gets that from the Start Menu shortcut it creates. This script performs
# the same registration explicitly, so the app is installable without the bundler's
# GitHub-hosted toolchain, and it works from any folder.
#
# Everything is per-user (HKCU + %LOCALAPPDATA%), so no administrator rights are needed.
# Reversible with uninstall.ps1.
[CmdletBinding()]
param(
    [string]$Source = "",
    # Same folder the NSIS installer uses, so the two installers are interchangeable
    # rather than leaving two copies of the app side by side.
    [string]$InstallDir = (Join-Path $env:LOCALAPPDATA "DJ Task Manager"),
    [switch]$NoDesktopShortcut,
    [switch]$StartAfter
)

$ErrorActionPreference = "Stop"

$ExeName      = "dj-task-manager.exe"
$Aumid        = "app.djtaskmanager.desktop"
$DisplayName  = "DJ Task Manager"
$Config       = Join-Path $PSScriptRoot "..\src-tauri\tauri.conf.json"
$Publisher    = "DJ"
$UninstallKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\$Aumid"
# The key the NSIS installer writes. If it exists, its entry is the one that actually
# removes the product, so this script must not shadow it with a second listing.
$NsisKey      = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\$DisplayName"

# --- locate the built binary ------------------------------------------------
if (-not $Source) {
    $candidates = @(
        (Join-Path $PSScriptRoot "..\src-tauri\target\release\$ExeName"),
        (Join-Path $PSScriptRoot "..\dist\$ExeName")
    )
    $Source = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
}
if (-not $Source -or -not (Test-Path $Source)) {
    Write-Error "Could not find $ExeName. Build it first:  cargo build --release  (in src-tauri)"
    exit 1
}

# Take the version from the binary's own resource block, so what Add/Remove Programs
# shows can never drift from what was actually installed. tauri-build stamps it from
# tauri.conf.json at compile time.
$Version = (Get-Item $Source).VersionInfo.ProductVersion
if (-not $Version) {
    try { $Version = (Get-Content $Config -Raw | ConvertFrom-Json).version } catch { $Version = "0.0.0" }
}
$Source = (Resolve-Path $Source).Path

Write-Host "Installing $DisplayName $Version" -ForegroundColor Cyan
Write-Host "  from $Source"
Write-Host "  to   $InstallDir"

# --- copy files -------------------------------------------------------------
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

# Stop a running instance so the binary can be replaced.
$running = Get-Process -Name "dj-task-manager" -ErrorAction SilentlyContinue
if ($running) {
    Write-Host "  stopping running instance (pid $($running.Id -join ','))"
    $running | Stop-Process -Force
    Start-Sleep -Milliseconds 600
}

Copy-Item -LiteralPath $Source -Destination (Join-Path $InstallDir $ExeName) -Force

# The icon is used by the shortcut and by the AUMID registration.
$iconSrc = Join-Path (Split-Path -Parent $Source) "icons\icon.ico"
if (-not (Test-Path $iconSrc)) { $iconSrc = Join-Path $PSScriptRoot "..\src-tauri\icons\icon.ico" }
$iconPath = ""
if (Test-Path $iconSrc) {
    $iconPath = Join-Path $InstallDir "app-icon.ico"
    Copy-Item -LiteralPath $iconSrc -Destination $iconPath -Force
}

# --- register the app identity so toasts are branded -----------------------
# HKCU\Software\Classes\AppUserModelId\<aumid> is the documented way to give an
# unpackaged app a display name and icon for notifications.
$aumidKey = "HKCU:\Software\Classes\AppUserModelId\$Aumid"
New-Item -Path $aumidKey -Force | Out-Null
Set-ItemProperty -Path $aumidKey -Name "DisplayName" -Value $DisplayName
if ($iconPath) { Set-ItemProperty -Path $aumidKey -Name "IconUri" -Value $iconPath }
Write-Host "  registered AUMID: $Aumid"

# --- Start Menu shortcut ----------------------------------------------------
$startMenu = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\DJ Task Manager"
New-Item -ItemType Directory -Force -Path $startMenu | Out-Null

$shell = New-Object -ComObject WScript.Shell
$lnk = Join-Path $startMenu "$DisplayName.lnk"
$sc = $shell.CreateShortcut($lnk)
$sc.TargetPath = Join-Path $InstallDir $ExeName
$sc.WorkingDirectory = $InstallDir
$sc.Description = "Tasks, alarms and catch-up reminders that keep running from the tray."
if ($iconPath) { $sc.IconLocation = "$iconPath,0" }
$sc.Save()
Write-Host "  Start Menu shortcut: $lnk"

if (-not $NoDesktopShortcut) {
    $desktop = [Environment]::GetFolderPath("Desktop")
    $dlnk = Join-Path $desktop "$DisplayName.lnk"
    $dc = $shell.CreateShortcut($dlnk)
    $dc.TargetPath = Join-Path $InstallDir $ExeName
    $dc.WorkingDirectory = $InstallDir
    if ($iconPath) { $dc.IconLocation = "$iconPath,0" }
    $dc.Save()
    Write-Host "  Desktop shortcut: $dlnk"
}

# --- Add / Remove Programs entry -------------------------------------------
# If the NSIS installer already registered this product, its entry points at the real
# uninstaller. Writing ours over the top (or alongside) would leave a second listing
# whose "Uninstall" removes the wrong thing, so defer to it.
if (Test-Path $NsisKey) {
    Write-Host "  Add/Remove Programs entry left as the installer's own" -ForegroundColor Yellow
} else {
New-Item -Path $UninstallKey -Force | Out-Null
Set-ItemProperty -Path $UninstallKey -Name "DisplayName"      -Value $DisplayName
Set-ItemProperty -Path $UninstallKey -Name "DisplayVersion"   -Value $Version
Set-ItemProperty -Path $UninstallKey -Name "Publisher"        -Value $Publisher
Set-ItemProperty -Path $UninstallKey -Name "InstallLocation"  -Value $InstallDir
Set-ItemProperty -Path $UninstallKey -Name "NoModify"         -Value 1 -Type DWord
Set-ItemProperty -Path $UninstallKey -Name "NoRepair"         -Value 1 -Type DWord
$uninstallPs1 = Join-Path $PSScriptRoot "uninstall.ps1"
Set-ItemProperty -Path $UninstallKey -Name "UninstallString" `
    -Value "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$uninstallPs1`""
if ($iconPath) { Set-ItemProperty -Path $UninstallKey -Name "DisplayIcon" -Value "$iconPath,0" }
$size = [math]::Round(((Get-Item (Join-Path $InstallDir $ExeName)).Length / 1KB))
Set-ItemProperty -Path $UninstallKey -Name "EstimatedSize" -Value $size -Type DWord
Write-Host "  listed in Add/Remove Programs"
}

# --- launch ----------------------------------------------------------------
if ($StartAfter) {
    Start-Process -FilePath (Join-Path $InstallDir $ExeName)
    Write-Host "  started" -ForegroundColor Green
}

Write-Host ""
Write-Host "Done. Launch '$DisplayName' from the Start Menu." -ForegroundColor Green
Write-Host "Alarms are scheduled by the app's own background thread: it starts at sign-in"
Write-Host "(Settings > Launch at sign-in) and keeps running from the tray when closed."
Write-Host "To remove: powershell -File `"$uninstallPs1`""
