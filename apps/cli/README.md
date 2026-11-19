# OpenPaper CLI installers

One-line installs of the `openpaper` command (the server, the editor it serves, and the MCP relay agents launch) for
macOS, Linux and Windows. The website's [download page](../../website/download.html) shows the line for each platform.

```bash
# macOS and Linux
curl -fsSL https://github.com/arshit09/OpenPaper/releases/latest/download/install.sh | bash
```

```powershell
# Windows PowerShell
irm https://github.com/arshit09/OpenPaper/releases/latest/download/install.ps1 | iex
```

```bat
:: Windows CMD (runs install.ps1 with Windows PowerShell)
curl -fsSL https://github.com/arshit09/OpenPaper/releases/latest/download/install.cmd -o install.cmd && install.cmd && del install.cmd
```

The Windows desktop app ([apps/desktop](../desktop/README.md)) is separate: it has its own installer and folder, and
the two can sit side by side. They share the data folder, `~/.openpaper`.

## What the scripts do

1. Read `OpenPaper-cli.json` from the latest release (or `OPENPAPER_VERSION`'s): the version, the bundle's URL and
   SHA-256, the Node.js version, and the voice engine's URL and SHA-256 for each platform.
2. Download `OpenPaper-<version>-cli.tar.gz`, the built server and editor with their production dependencies. It's
   the same file on every platform, because nothing in it is native.
3. Download the official Node.js build for this machine from nodejs.org, checked against its `SHASUMS256.txt`. It's
   the version the Windows app bundles, and it's skipped when the install already has it.
4. Download the voice input engine, `sherpa-onnx-<platform>` from npm, checked against the SHA-256 in the manifest.
   This step is optional: if it fails, OpenPaper works without dictation.
5. Stop a server running from this install (asking it to shut down cleanly), swap the new files in with a rename,
   and start it again. Agents' `openpaper mcp` relays are left running.
6. Write the command, an uninstaller, and the PATH entry.

| | macOS and Linux | Windows |
|---|---|---|
| Install folder | `~/.local/share/openpaper` | `%LOCALAPPDATA%\Programs\OpenPaper CLI` |
| Command | `~/.local/bin/openpaper` | `<install>\bin\openpaper.cmd` |
| PATH | a marked line in `.zshrc`, `.bashrc` (`.bash_profile` on macOS), fish `conf.d` or `.profile` | the user `Path` (registry, kept as `REG_EXPAND_SZ`) |
| Platforms | macOS 11+ and glibc 2.28+ Linux, x64 and arm64 | Windows 10 1803+ and 11, x64 and Arm64 |

Agents get absolute paths to `<install>/node` and `<install>/server/cli.js`, and those folders stay put across
updates, so connected agents keep working. `openpaper uninstall` (handled by the command wrapper, not the server)
stops the server, removes the folder, the command and the PATH entry, and leaves the designs in `~/.openpaper`.

`install.ps1` is plain ASCII and runs inside `& { }`, because `irm | iex` runs it in the user's own session: it must
not leave functions behind or call `exit`. `install.cmd` clears `PSModulePath`, so Windows PowerShell started from
PowerShell 7 doesn't load 7's modules.

## Options

Environment variables, all optional:

| Variable | Effect |
|---|---|
| `OPENPAPER_VERSION` | Install this version (such as `0.3.0`) instead of the latest |
| `OPENPAPER_INSTALL_DIR` | Install folder |
| `OPENPAPER_BIN_DIR` | Where the command goes (macOS and Linux) |
| `OPENPAPER_MANIFEST_URL` | Read the manifest from here instead of the release (relative URLs in it resolve against it) |
| `OPENPAPER_NODE_MIRROR` | A mirror of `https://nodejs.org/dist` |
| `OPENPAPER_NO_SPEECH=1` | Skip the voice input engine |
| `OPENPAPER_NO_MODIFY_PATH=1` | Leave shell profiles and PATH alone |
| `OPENPAPER_INSTALL_PS1` | The `install.ps1` URL `install.cmd` runs |

## Building and testing

`npm run package:cli` (or a full `npm run package:windows`) writes the bundle, the manifest and copies of these
scripts with the right line endings to `apps/desktop/release/`. Attach them to the GitHub release; the URLs above
always point at the latest one.

To test without publishing, package with `--base-url ""` (or edit the manifest's `url` to the bare file name), serve
`apps/desktop/release/` locally, and set `OPENPAPER_MANIFEST_URL`, `OPENPAPER_INSTALL_DIR` and `OPENPAPER_HOME` to
scratch values. Start any test server with `--port`, so nothing reaches a server on the default port. In Docker,
mount the folder and use `file:///…/OpenPaper-cli.json` as the manifest URL; `--platform linux/arm64` covers arm64.
