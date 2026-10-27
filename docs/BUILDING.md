# Building from source

## Prerequisites

| Need | Notes |
| --- | --- |
| Rust | 1.77 or newer (`rust-version` in `src-tauri/Cargo.toml`) |
| MSVC toolchain + Windows SDK | `winget install Microsoft.VisualStudio.2022.BuildTools` with the C++ workload, or the default Rust installer's MSVC host |
| Node.js | current LTS — only used to run the Tauri CLI |
| WebView2 runtime | already present on Windows 11 and current Windows 10 |

```bash
git clone https://github.com/JAYASIMMA/ChronoTask-desktop.git
cd ChronoTask-desktop
npm install            # @tauri-apps/cli
```

No other JavaScript dependencies. The front end is plain HTML/CSS/JS with no build step.

## Layout

```
src-tauri/
  Cargo.toml            package + release profile (lto, codegen-units=1, strip)
  build.rs              emits rerun-if-changed for ui/  (see the trap below)
  tauri.conf.json       product name, identifier, window, bundle settings
  capabilities/         what the WebView is allowed to call
  src/                  Rust: commands, db/, scheduler, notify, state
  tests/                backend.rs, capabilities.rs
ui/
  index.html  styles.css  app.js
tools/                  build, install, verify, diagnostic scripts
```

## Run in development

```bash
npm run tauri dev        # or: cargo run  (from src-tauri, with the CLI doing the same)
```

The WebView loads `ui/` from disk, so front-end edits show on refresh. Rust edits
recompile and relaunch.

The development binary runs from `target\debug`, which is exactly the condition Windows
refuses to brand a toast for — expect anonymous notifications while developing. Settings
shows "Running unpackaged" to tell you that is a location effect, not a bug.

## Build the binary

```bash
cd src-tauri
cargo build --release
```

Output: `src-tauri/target/release/dj-task-manager.exe`, roughly 5 MB, with the front end
embedded. This file alone is a working portable app.

## Build the installer

```bash
npx tauri build
```

Produces `src-tauri/target/release/bundle/nsis/DJ Task Manager_<version>_x64-setup.exe`.
The bundle is configured for `currentUser` installation (no administrator rights), LZMA
compression, an embedded WebView2 bootstrapper, and a Start Menu folder.

### If the NSIS download times out

The CLI fetches its own NSIS toolchain from GitHub on first use, and that request
sometimes fails with `timeout: global` even though the URL is reachable — the CLI's HTTP
client, not your network. Seed the cache once and bundling runs offline:

```powershell
powershell -ExecutionPolicy Bypass -File tools/fetch-nsis.ps1
```

It installs into `%LOCALAPPDATA%\tauri\NSIS` and drops `nsis_tauri_utils.dll` into both
plugin directories. Re-running is harmless; pass `-Force` to replace.

## Tests

```bash
cd src-tauri
cargo test
```

45 tests: 7 unit (recurrence and DST resolution), 36 backend integration, 2 capability
probes. Every backend test runs against a real SQLite file in a scratch directory under
the temp folder, so nothing is mocked and migrations are exercised for real.

`tests/capabilities.rs` asserts the bundled SQLite engine actually supports what the
queries rely on — FTS5, JSON functions, the features that would otherwise fail only on
some other machine.

## Versioning

The version appears in three places and they must agree:

```
src-tauri/Cargo.toml      [package] version
src-tauri/tauri.conf.json version
package.json              version
```

`tauri.conf.json` overrides the crate version for the bundle name, so a mismatch
produces an installer whose filename and its own `FileVersion` resource disagree.
`tools/install.ps1` reads the version from the built binary's resource block, so it
cannot drift from what it installs.

## Windows scripting gotcha in this repo

PowerShell 5.1 reads a UTF-8 script **without a BOM** as ANSI. A UTF-8 em dash is the
bytes `E2 80 94`, and `0x94` is a right double quotation mark in Windows-1252 — so the
character silently terminates the string it sits in and the script fails to parse with
"The string is missing the terminator".

Keep `.ps1` files in `tools/` ASCII-only. Use `-` instead of `—`, `|` instead of `·`,
and `->` instead of `→`.

## Release checklist

```bash
cd src-tauri
cargo test                                   # all green
cargo build --release
npx tauri build                              # or after tools/fetch-nsis.ps1
```

Then stage the artifacts under release-safe names, checksum them, and publish:

```bash
mkdir -p dist
# GitHub rewrites spaces in asset names to dots, so drop the spaces here instead of
# shipping a filename nobody can type into a script.
cp "src-tauri/target/release/bundle/nsis/DJ Task Manager_${VERSION}_x64-setup.exe" \
   "dist/DJ-Task-Manager_${VERSION}_x64-setup.exe"
cp src-tauri/target/release/dj-task-manager.exe "dist/dj-task-manager-${VERSION}-x64-portable.exe"
(cd dist && sha256sum ./DJ-Task-Manager_*_setup.exe ./dj-task-manager-*-portable.exe > SHA256SUMS.txt)
```

```bash
gh release create "v${VERSION}" \
  --target "$(git rev-parse HEAD)" \
  --title "DJ Task Manager ${VERSION}" --latest \
  --notes-file /path/to/notes.md \
  "dist/DJ-Task-Manager_${VERSION}_x64-setup.exe" \
  "dist/dj-task-manager-${VERSION}-x64-portable.exe" \
  "dist/SHA256SUMS.txt"
```

Two things that bite here: `--target` wants a **full** commit SHA — a short one is
rejected with `Release.target_commitish is invalid` — and a freshly uploaded asset can
404 for a few seconds before the CDN serves it.

`dist/` is gitignored on purpose — binaries belong on the release, not in history.
