# OpenPaper for Windows

A desktop app and a small web installer, both built with [Tauri 2](https://tauri.app). They use the WebView2
runtime that ships with Windows 10 and 11, so neither one bundles a browser.

| | Size | What it is |
|---|---|---|
| `OpenPaper-Setup.exe` | ~4 MB | The installer people download. It fetches the current release, checks it, and installs it per user (no admin prompt). |
| `OpenPaper-<version>-windows-x64.zip` | ~50 MB | The release it fetches: the app, a Node.js runtime and the built server and editor (~140 MB installed). |
| `OpenPaper-windows-x64.json` | | The manifest the installer reads: version, zip URL, size and SHA-256. |

## How it works

**The app** (`app/`, `OpenPaper.exe`) is a native window around the editor. At launch it makes sure an OpenPaper
server is running, starting the bundled `node\node.exe server\cli.js serve` in the background when none is, while
its splash page loads, and then opens the editor from `http://127.0.0.1:<port>`. The server keeps running after the
window closes, because agents connected over MCP still use it.

- Closing the window hides it to the tray; **Quit OpenPaper** in the tray menu stops the app and the server it started.
  A server run from somewhere else, such as a git clone, is never stopped.
- One instance only: opening OpenPaper again brings the window back. `OpenPaper.exe --quit` quits the running one.
- Links that leave the editor open in the default browser. The editor gets no native APIs.
- Browser keys (reload, find, print, zoom, devtools) are off; editing keys work as usual. Dropped files reach the editor.
- Window size and position are remembered. The window follows the Windows light or dark setting.
- **Connect agent** in the app writes the bundled `node.exe` and `cli.js` paths into agent configs, so agents work
  without Node installed. The install folder stays the same across updates, so those paths stay valid.

**The installer** (`installer/`, `OpenPaper Setup.exe`) has the website's look: the same palette, type and buttons,
following light or dark mode. Install stays disabled until the Terms of Use and Privacy Policy box is ticked. Both
documents open in a panel inside the installer.

1. Reads the manifest, by default from `https://github.com/arshit09/OpenPaper/releases/latest/download/OpenPaper-windows-x64.json`.
2. Downloads the zip with progress, then checks its size and SHA-256.
3. Closes a running OpenPaper from the same folder (the app, its server, and any agent's `openpaper mcp` relay).
4. Unpacks into a hidden folder next to the install, then swaps it in, putting the old one back if that fails.
5. Adds Start menu and (optionally) desktop shortcuts, and an Apps & Features entry.
6. Copies itself into the install as `Uninstall OpenPaper.exe`. Run with `--uninstall`, it removes the app, its
   shortcuts and entry, and, only if that box is ticked, the user's designs in `~\.openpaper`.

Running the installer again updates or reinstalls in place. If WebView2 is missing (rare), it offers to install it first.

## Layout

```
apps/desktop/
├── Cargo.toml          workspace; release profile tuned for size
├── windows.manifest    asInvoker, so "Setup" in the name doesn't trigger an admin prompt
├── common/             shared: find, start and stop the server; processes; registry reads
├── app/                OpenPaper.exe: src/main.rs, splash page in ui/
├── installer/          OpenPaper Setup.exe: src/ (install, uninstall, Windows integration), page in ui/
└── scripts/package.mjs builds everything into release/
```

## Building a release

Needs Node 20.19+, `npm ci` at the repo root, Rust (stable, MSVC) and the Visual Studio C++ build tools.

```bash
npm run package:windows
```

This builds the editor, builds the server into `release/stage` (never into `packages/server/dist`), copies the
server's production dependencies from `node_modules` (the versions in `package-lock.json`) and prunes them, downloads
the official Node.js build for this Node version (checked against nodejs.org's SHA-256 list, cached in
`release/cache`), compiles both executables and writes the zip, manifest and installer to `release/`.

To publish, create a GitHub release tagged `v<version>` and attach all three files. The version comes from
`packages/server/package.json` and must match `apps/desktop/Cargo.toml`.

Options: `--node <version>` picks the bundled Node.js, `--skip-editor` reuses `apps/editor/dist`, `--base-url <url>`
changes where the manifest says the zip is (empty keeps it relative to the manifest), and `--manifest-url <url>`
changes where the installer looks for the manifest.

## Testing without publishing

Serve `release/` locally and point the installer at it. These variables also keep a test install away from a
real one:

| Variable | Used by | Effect |
|---|---|---|
| `OPENPAPER_SETUP_MANIFEST` | installer | Read the manifest from this URL |
| `OPENPAPER_INSTALL_DIR` | installer | Default install folder |
| `OPENPAPER_HOME` | both | Data folder (as for the server) |
| `OPENPAPER_PORT` | both | Use and start a server on this port only |
| `OPENPAPER_DESKTOP_RUNTIME` | app | Folder holding `node\` and `server\`, when not next to the exe |
| `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` | both | e.g. `--remote-debugging-port=9333` to drive the page over CDP |

```bash
node apps/desktop/scripts/package.mjs --base-url ""
python -m http.server 8766 --directory apps/desktop/release
OPENPAPER_SETUP_MANIFEST=http://127.0.0.1:8766/OpenPaper-windows-x64.json \
OPENPAPER_INSTALL_DIR=/tmp/op-test/OpenPaper OPENPAPER_HOME=/tmp/op-test/home OPENPAPER_PORT=29912 \
  apps/desktop/release/OpenPaper-Setup.exe
```

The test install still adds real shortcuts and an Apps & Features entry; uninstall it afterwards.

## Not done yet

- **Code signing.** Unsigned, both executables show Windows SmartScreen's "Windows protected your PC" on first run.
- **Updates from inside the app.** For now, running the installer again updates in place.
- **macOS and Linux.** The same Tauri project can build for them, but there WebKit would draw the editor, so the
  canvas needs testing against Chrome-rendered exports first.
