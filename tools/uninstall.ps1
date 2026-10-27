# Removes what install.ps1 put in place: the app folder, shortcuts, the AUMID
# registration and the Add/Remove Programs entry.
#
# The SQLite database under %APPDATA%\app.djtaskmanager.desktop is deliberately left
# alone — pass -PurgeData to delete it too.
[CmdletBinding()]
param(
    [switch]$PurgeData
)

$ErrorActionPreference = "Continue"

$ExeName     = "dj-task-manager.exe"
$Aumid       = "app.djtaskmanager.desktop"
$DisplayName = "DJ Task Manager"
$InstallDir  = Join-Path $env:LOCALAPPDATA "Programs\DJ Task Manager"

Write-Host "Uninstalling $DisplayName" -ForegroundColor Yellow

$running = Get-Process -Name "dj-task-manager" -ErrorAction SilentlyContinue
if ($running) {
    Write-Host "  stopping running instance"
    $running | Stop-Process -Force
    Start-Sleep -Milliseconds 600
}

foreach ($lnk in @(
    (Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\DJ Task Manager\$DisplayName.lnk"),
    (Join-Path ([Environment]::GetFolderPath("Desktop")) "$DisplayName.lnk")
)) {
    if (Test-Path $lnk) { Remove-Item -LiteralPath $lnk -Force; Write-Host "  removed $lnk" }
}
$startFolder = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\DJ Task Manager"
if (Test-Path $startFolder) { Remove-Item -LiteralPath $startFolder -Recurse -Force }

foreach ($key in @(
    "HKCU:\Software\Classes\AppUserModelId\$Aumid",
    "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\$Aumid"
)) {
    if (Test-Path $key) { Remove-Item -Path $key -Recurse -Force; Write-Host "  removed $key" }
}

if (Test-Path $InstallDir) {
    Remove-Item -LiteralPath $InstallDir -Recurse -Force
    Write-Host "  removed $InstallDir"
}

if ($PurgeData) {
    $data = Join-Path $env:APPDATA "app.djtaskmanager.desktop"
    if (Test-Path $data) { Remove-Item -LiteralPath $data -Recurse -Force; Write-Host "  purged $data" }
} else {
    Write-Host "  kept your data: $([Environment]::GetFolderPath('ApplicationData'))\app.djtaskmanager.desktop"
}

Write-Host "Done." -ForegroundColor Green
