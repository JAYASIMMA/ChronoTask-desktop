# Installation

Two ways to run DJ Task Manager on Windows 10 or 11. Pick the installer unless you
specifically want a single file you can drop anywhere.

## Download

| File | What it is |
| --- | --- |
| `DJ-Task-Manager_2.6.0_x64-setup.exe` | NSIS installer, ~3.6 MB. Recommended. |
| `dj-task-manager-2.6.0-x64-portable.exe` | The same app as one ~5 MB file, no installer. |
| `SHA256SUMS.txt` | Checksums for both. |

Release assets never contain spaces: GitHub rewrites them to dots, so the bundler's
`DJ Task Manager_2.6.0_x64-setup.exe` is published as
`DJ-Task-Manager_2.6.0_x64-setup.exe`. Ask for the hyphenated name — a `%20` URL 404s.

From the [release page](https://github.com/JAYASIMMA/ChronoTask-desktop/releases/tag/v2.6.0),
or from a shell:

```powershell
$base = 'https://github.com/JAYASIMMA/ChronoTask-desktop/releases/download/v2.6.0'
Invoke-WebRequest "$base/DJ-Task-Manager_2.6.0_x64-setup.exe" -OutFile setup.exe
Invoke-WebRequest "$base/SHA256SUMS.txt" -OutFile SHA256SUMS.txt
Get-FileHash .\setup.exe -Algorithm SHA256   # compare against SHA256SUMS.txt
```

Nothing is signed with a code-signing certificate, so SmartScreen will warn on first
run. That is expected for an unsigned build, not a tampered one — the checksum is how
you confirm integrity. Newly uploaded assets can take a few seconds to serve; a 404
immediately after publishing usually clears on retry.

## Install with the setup file

Double-click it, or run it silently:

```powershell
Start-Process .\setup.exe -ArgumentList '/S' -Wait
```

The installer runs per-user (`currentUser`), so **no administrator rights are needed**
and nothing is written to `Program Files` or `HKLM`. It creates:

```
%LOCALAPPDATA%\Programs\DJ Task Manager\dj-task-manager.exe
%APPDATA%\Microsoft\Windows\Start Menu\Programs\DJ Task Manager\DJ Task Manager.lnk
%USERPROFILE%\Desktop\DJ Task Manager.lnk
HKCU\Software\Classes\AppUserModelId\app.djtaskmanager.desktop
HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\app.djtaskmanager.desktop
HKCU\Software\Microsoft\Windows\CurrentVersion\Run   →  dj-task-manager.exe --minimized
```

That `AppUserModelId` key is what lets Windows brand your toasts. Without it a toast
arrives anonymous, silent and without buttons — see
[Troubleshooting](TROUBLESHOOTING.md#toasts-are-unbranded-or-silent).

If WebView2 is not already on the machine, the installer embeds Microsoft's bootstrapper
and installs it silently as part of setup.

## Verify the install

```powershell
git clone https://github.com/JAYASIMMA/ChronoTask-desktop.git
cd ChronoTask-desktop
powershell -ExecutionPolicy Bypass -File tools/verify-install.ps1
```

It checks eight things and exits non-zero if any fail: binary present, version stamped,
Start Menu shortcut, desktop shortcut, *Add / Remove Programs* entry, `AppUserModelID`
registration, sign-in run key, and the data directory.

## Portable use

Run `dj-task-manager-2.6.0-x64-portable.exe` from anywhere, including a USB drive. The
database still lives in `%APPDATA%\app.djtaskmanager.desktop`, so two copies on the same
account share one workspace.

One caveat: Windows refuses to brand toasts for a binary running under a
`target\debug` or `target\release` path, and the app detects that and says so in
*Settings → Background & Startup*. From any other folder the toast is branded, but the
*Open* / *Dismiss* action buttons only appear once the Start Menu shortcut exists —
that is a Windows requirement, not an app setting. `tools/install.ps1` registers the
shortcut and the `AppUserModelID` by hand if you want branding from a portable binary
without the installer.

## Upgrading

Install over the top. The database is never touched by setup, and pending schema
migrations apply themselves on first launch — the ladder currently runs to version 4.
Check *Settings → Database Health & Analytics* afterwards: it lists applied migrations.

## Uninstall

Either *Add / Remove Programs → DJ Task Manager → Uninstall*, or:

```powershell
powershell -ExecutionPolicy Bypass -File tools/uninstall.ps1            # keeps your data
powershell -ExecutionPolicy Bypass -File tools/uninstall.ps1 -PurgeData # deletes the database too
```

`uninstall.ps1` removes what `install.ps1` put there; for an installer-based install the
native uninstaller is `%LOCALAPPDATA%\Programs\DJ Task Manager\uninstall.exe`.
