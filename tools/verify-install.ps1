# Checks that an installed copy of DJ Task Manager is complete: binary, shortcuts,
# Add/Remove Programs entry, and the AppUserModelID registration that Windows needs
# to brand a toast. Exits non-zero when something a user would notice is missing.
#
#   powershell -ExecutionPolicy Bypass -File tools/verify-install.ps1
param([string]$Aumid = "app.djtaskmanager.desktop", [string]$Name = "DJ Task Manager")
$ErrorActionPreference = "Continue"

$installDir  = Join-Path $env:LOCALAPPDATA "Programs\$Name"
$desktopDir  = [Environment]::GetFolderPath("Desktop")
$startMenu   = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs"
$uninstallKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\$Aumid"
$aumidKey     = "HKCU:\Software\Classes\AppUserModelId\$Aumid"

$results = @()
function Check([string]$label, [bool]$ok, [string]$detail) {
    $script:results += [pscustomobject]@{ Check = $label; Pass = $ok; Detail = $detail }
}

$exe = Join-Path $installDir "dj-task-manager.exe"
$exeOk = Test-Path $exe
Check "binary" $exeOk $exe
if ($exeOk) {
    $v = (Get-Item $exe).VersionInfo.ProductVersion
    Check "binary version" ($v -and $v -ne "") "v$v"
}

$lnk = Get-ChildItem $startMenu -Recurse -Filter "$Name.lnk" -ErrorAction SilentlyContinue | Select-Object -First 1
Check "start menu shortcut" ($null -ne $lnk) ($(if ($lnk) { $lnk.FullName } else { "$startMenu\$Name.lnk" }))

$desktopLnk = Join-Path $desktopDir "$Name.lnk"
Check "desktop shortcut" (Test-Path $desktopLnk) $desktopLnk

$un = Get-ItemProperty $uninstallKey -ErrorAction SilentlyContinue
Check "Add/Remove Programs entry" ($null -ne $un) ($(if ($un) { "$($un.DisplayName) $($un.DisplayVersion) by $($un.Publisher)" } else { $uninstallKey }))

$au = Get-ItemProperty $aumidKey -ErrorAction SilentlyContinue
Check "AUMID registered (branded toasts)" ($null -ne $au) ($(if ($au) { "DisplayName=$($au.DisplayName)" } else { $aumidKey }))

$run = Get-ItemProperty "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" -ErrorAction SilentlyContinue
$autostart = $run.PSObject.Properties.Name -contains $Name
Check "sign-in launch entry" $autostart ($(if ($autostart) { $run.$Name } else { "not registered (toggle in Settings)" }))

$data = Join-Path $env:APPDATA $Aumid
Check "data dir" (Test-Path $data) $data

$results | Format-Table -AutoSize -Wrap
$failed = @($results | Where-Object { -not $_.Pass })
if ($failed.Count) {
    Write-Host "$($failed.Count) check(s) did not pass" -ForegroundColor Yellow
    exit 1
}
Write-Host "all install checks passed" -ForegroundColor Green
