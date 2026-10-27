# Checks that an installed copy of DJ Task Manager is complete: binary, shortcuts,
# Add/Remove Programs entry, and the AppUserModelID registration that Windows needs
# to brand a toast. Exits non-zero when something a user would notice is missing.
#
#   powershell -ExecutionPolicy Bypass -File tools/verify-install.ps1
param([string]$Aumid = "app.djtaskmanager.desktop", [string]$Name = "DJ Task Manager")
$ErrorActionPreference = "Continue"

# The NSIS installer uses %LOCALAPPDATA%\<name>; tools/install.ps1 used to write into
# %LOCALAPPDATA%\Programs\<name>. Accept either so the check works for both.
$installDir = @(
    (Join-Path $env:LOCALAPPDATA $Name),
    (Join-Path $env:LOCALAPPDATA "Programs\$Name")
) | Where-Object { Test-Path (Join-Path $_ "dj-task-manager.exe") } | Select-Object -First 1
if (-not $installDir) { $installDir = Join-Path $env:LOCALAPPDATA $Name }

$desktopDir  = [Environment]::GetFolderPath("Desktop")
$startMenu   = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs"
$uninstallKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall"
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

# Both installers register an entry, under different key names. More than one means the
# two have been run against each other and *Add / Remove Programs* shows duplicates.
# @() matters: a single pipeline result has no usable .Count otherwise.
$entries = @(Get-ChildItem $uninstallKey -ErrorAction SilentlyContinue |
    Where-Object { $_.PSChildName -in @($Aumid, $Name) } |
    ForEach-Object { [pscustomobject]@{ Key = $_.PSChildName; P = Get-ItemProperty $_.PSPath } })
Check "Add/Remove Programs entry" ($entries.Count -ge 1) `
    ($(if ($entries.Count) { ($entries | ForEach-Object { "$($_.P.DisplayName) $($_.P.DisplayVersion)" }) -join "; " } else { "none under $uninstallKey" }))
Check "single uninstall listing" ($entries.Count -le 1) `
    "$($entries.Count) listing(s) - run tools/uninstall.ps1 then reinstall once if this is more than one"

# Windows learns how to brand a toast from one of two places. The NSIS installer stamps
# the AppUserModelID onto the Start Menu shortcut, so no registry key exists; tools/
# install.ps1 writes the key explicitly. Either is enough - neither is both.
$au = Get-ItemProperty $aumidKey -ErrorAction SilentlyContinue
$identity = if ($au) { "registry key: DisplayName=$($au.DisplayName)" }
elseif ($lnk) { "start menu shortcut carries the AUMID (NSIS mechanism)" }
else { $null }
Check "app identity for branded toasts" ($null -ne $identity) ($(if ($identity) { $identity } else { "neither $aumidKey nor a shortcut" }))

# Written by the app itself on first launch, from the stored preference, so an install
# that has never been started legitimately has no entry yet. Report, do not fail.
$run = Get-ItemProperty "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" -ErrorAction SilentlyContinue
$autostart = $run.PSObject.Properties.Name -contains $Name
Write-Host ("note: sign-in launch entry {0}" -f $(if ($autostart) { "registered -> $($run.$Name)" } else { "not yet registered (the app writes it on first launch, or toggle Settings > Launch at sign-in)"}))

$data = Join-Path $env:APPDATA $Aumid
Check "data dir" (Test-Path $data) $data

$results | Format-Table -AutoSize -Wrap
$failed = @($results | Where-Object { -not $_.Pass })
if ($failed.Count) {
    Write-Host "$($failed.Count) check(s) did not pass" -ForegroundColor Yellow
    exit 1
}
Write-Host "all install checks passed" -ForegroundColor Green
