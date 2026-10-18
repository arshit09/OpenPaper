# How OpenPaper's compatibility was derived

OpenPaper aims to behave like Paper's MCP server so that agents, prompts and workflows written for Paper work unchanged. Compatibility was established by studying what Paper publicly ships, then writing an independent implementation. No Paper source code, prose or artwork is included in this repository.

## Sources studied

1. **Paper Desktop (installed app).** It is an Electron app; its `resources/app.asar` was extracted with `@electron/asar` and analyzed with [REA](https://github.com/morluto/rea) (`rea analyze-javascript-application`), which mapped the main/preload modules, the 32 IPC channels, the `window.paper.desktop` bridge and the routes. This showed the MCP architecture: a Streamable HTTP server on `127.0.0.1:29979/mcp` that forwards every tool call into the editor web app, plus a Go `paper` CLI that relays stdio to it.
2. **The published tool configuration** that Paper's CLI downloads (`/mcp/desktop/config.json`): the 37 tool names, JSON input schemas, annotations and server instructions.
3. **The public web client bundle** (what any browser downloads from the Paper web app), read to document *behavior*: response shapes, error messages, ID formats, limits, the HTML import rules and the JSX output conventions.

The behavior was written up as specifications (inputs, outputs, error strings, edge cases) and OpenPaper was implemented from those specs.

## What is intentionally the same

- Tool names, parameter names/types/enums/required fields and annotations.
- Response shapes and field names (e.g. `createdNodes`, `descendantIdMap`, `ignoredStyles`, `fontsPerFamily`), the `{file, contentHash}` header, error texts, truncation messages and limits.
- ID formats: nodes `1-0`, `2F-0`; pages `p-1-0`; page roots `root_node_<pageId>`; 26-character file ids.
- Import semantics of `write_html` (Text node creation, inline flattening, freeform detection, image fills, `x-paper-clone`, `layer-name`) and `update_styles` (removal with `""`, inert-style reporting).
- Screenshot encoding limits, artboard placement, 40-second agent activity window, guide topic ids.

## What is OpenPaper's own

- All code, tool descriptions, guides, the status-bar markup and the UI.
- The local-first architecture (server-owned documents, WebSocket sync, headless rendering, per-actor undo).
- Bring-your-own-key image generation, the agent activity feed, "undo agent change", clipboard HTML.

## Reproducing the analysis

```bash
npx @electron/asar extract "<Paper install>/resources/app.asar" ./paper-asar
npx rea-agents analyze-javascript-application "$(pwd)/paper-asar" --json > evidence.json
```

Only inspect software you are licensed to use, and keep analysis output out of this repository.
