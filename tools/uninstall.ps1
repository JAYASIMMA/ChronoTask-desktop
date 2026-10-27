# Removes DJ Task Manager for the current user: the app folder, shortcuts, the AUMID
# registration and any Add/Remove Programs entry - whichever installer put them there.
#
# If the NSIS setup.exe install is present, its own uninstaller is run first, because it
# knows about things this script cannot see. Everything else is then cleaned up by hand.
#
# The SQLite database under %APPDATA%\app.djtaskmanager.desktop is deliberately left
# alone - pass -PurgeData to delete it too.
[CmdletBinding()]
param(
    [switch]$PurgeData
)

$ErrorActionPreference = "Continue"

$Aumid       = "app.djtaskmanager.desktop"
$DisplayName = "DJ Task Manager"
# Both locations in history: the NSIS installer uses %LOCALAPPDATA%\<name>; older copies
# of tools/install.ps1 used %LOCALAPPDATA%\Programs\<name>.
$NsisDir     = Join-Path $env:LOCALAPPDATA $DisplayName
$LegacyDir   = Join-Path $env:LOCALAPPDATA "Programs\$DisplayName"

Write-Host "Uninstalling $DisplayName" -ForegroundColor Yellow

$running = Get-Process -Name "dj-task-manager" -ErrorAction SilentlyContinue
if ($running) {
    Write-Host "  stopping running instance"
    $running | Stop-Process -Force
    Start-Sleep -Milliseconds 600
}

$nsisUninstaller = Join-Path $NsisDir "uninstall.exe"
if (Test-Path $nsisUninstaller) {
    Write-Host "  NSIS install detected - running its own uninstaller"
    Start-Process -FilePath $nsisUninstaller -ArgumentList '/S' -Wait
    Start-Sleep -Milliseconds 600
}

foreach ($lnk in @(
    (Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\$DisplayName\$DisplayName.lnk"),
    (Join-Path ([Environment]::GetFolderPath("Desktop")) "$DisplayName.lnk")
)) {
    if (Test-Path -LiteralPath $lnk) { Remove-Item -LiteralPath $lnk -Force; Write-Host "  removed $lnk" }
}
$startFolder = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\$DisplayName"
if (Test-Path -LiteralPath $startFolder) { Remove-Item -LiteralPath $startFolder -Recurse -Force }

foreach ($key in @(
    "HKCU:\Software\Classes\AppUserModelId\$Aumid",
    "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\$Aumid",
    "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\$DisplayName"
)) {
    if (Test-Path -Path $key) { Remove-Item -Path $key -Recurse -Force; Write-Host "  removed $key" }
}

foreach ($dir in @($NsisDir, $LegacyDir)) {
    if (Test-Path -LiteralPath $dir) {
        Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue
        if (Test-Path -LiteralPath $dir) {
            Write-Host "  could not fully remove $dir (a file may still be in use)" -ForegroundColor Yellow
        } else {
            Write-Host "  removed $dir"
        }
    }
}

# The sign-in launch entry is written by the app itself; clear it so a removed binary
# does not leave Windows trying to start something that is gone.
$run = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
if ((Get-ItemProperty -Path $run -ErrorAction SilentlyContinue).PSObject.Properties.Name -contains $DisplayName) {
    Remove-ItemProperty -Path $run -Name $DisplayName
    Write-Host "  cleared the sign-in launch entry"
}

if ($PurgeData) {
    $data = Join-Path $env:APPDATA $Aumid
    if (Test-Path -LiteralPath $data) { Remove-Item -LiteralPath $data -Recurse -Force; Write-Host "  purged $data" }
} else {
    Write-Host "  kept your data: $(Join-Path $env:APPDATA $Aumid)"
}

Write-Host "Done." -ForegroundColor Green
