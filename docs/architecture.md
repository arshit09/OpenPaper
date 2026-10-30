# Architecture

OpenPaper is a single local process (the **server**) plus a browser-based **editor**. Agents connect to the server over MCP; editors connect over a WebSocket. Both talk to the same live documents.

```
 Claude Code / Cursor / Codex ──stdio──▶ openpaper mcp ─┐
                                                        │ Streamable HTTP
 Any HTTP MCP client ──────────────────────────────────▶├──▶ /mcp ─────┐
                                                        │              ▼
 Editor (browser) ◀──────────── WebSocket /ws ─────────▶│        Tool runtime ──▶ DocumentHub ──▶ files/*.json
                                                        │              │                 │
                                                        │              ▼                 └── patches ──▶ every editor
                                                        │   RenderService (headless Chrome: screenshots,
                                                        │   exports, layout) · Tailwind worker · images
```

## Packages

### `packages/core` (isomorphic)
- `model/` — `PaperDocument` (pages, page list with dividers, flat node map, tokens, `@keyframes`, comments), `Transaction` (copy-on-write mutations → forward + inverse `Patch`), tree helpers, ids (`1-0`, `p-1-0`, `root_node_<page>`, ULID file ids), labels.
- `html/` — HTML → layers importer (`importHtml`; `<video>`, Lottie tags, `<x-embed>` / `<iframe>` become media layers), `<style>` sheets resolved into inline styles with css-select (`stylesheet.ts`: specificity, `!important`, `var()`, `@media` at 1440px), SVG cleaning/sanitizing, id scoping.
- `animation/` — `@keyframes` parsing (validated and re-serialized, so a rule can't escape its block), `animation` name references (rename on paste conflicts), Lottie JSON / dotLottie unpacking.
- `editing/` — inserting imported layers (insert-children / replace), artboard placement.
- `render/` — the render rules shared by the canvas and headless renders (`renderSpec`), static HTML documents.
- `export/` — JSX (Tailwind or inline styles) and clean HTML export.
- `query/` — read-tool payloads (`get_basic_info`, `get_tree_summary`, …), `find_nodes` matching (glob + color equivalence).
- `tokens/` — token names, ordering, CSS/Tailwind output, content hash.
- `shaders/` — the shader registry (30 effects: parameters, ranges, optional groups), presets generated from `@paper-design/shaders-react` (`scripts/gen-shader-presets.mjs`), parameter validation and the props handed to the GPU library (colours resolved to hex, tokens included).
- `figma/` — paste from Figma: decoding the clipboard's fig-kiwi archive (embedded kiwi schema + deflate/zstd) and converting Figma nodes to importable HTML (auto layout → flex, text runs, vectors, gradients, instances with overrides).
- `sync/protocol.ts`, `commands/types.ts` — editor ⇄ server messages and editor commands.

### `packages/server` (the `openpaper` CLI)
- `server.ts` — wires everything; `app.ts` — HTTP routes (`/mcp`, `/ws`, `/media`, `/local-asset`, `/api/*`, static editor).
- `hub.ts` — `DocumentHub` / `LiveDocument`: the authoritative copy of each open file, one undo timeline per file (a person's undo reaches their own and every agent's changes, an agent's only its own; records others changed since are skipped, a layer and its parent together; progress such as a finished image is folded into the change it completes; each entry keeps only the records it touched, with a budget per author), debounced atomic saves.
- `mcp/http.ts` — Streamable HTTP endpoint. Each request gets a fresh stateless SDK transport while OpenPaper keeps its own session table, so clients holding a session id from before a restart keep working.
- `mcp/stdio-relay.ts` — `openpaper mcp`: stdio ⇄ HTTP relay that starts the server when needed and restarts it if it dies.
- `tools/` — the 37 Paper-compatible MCP tools plus OpenPaper's `update_shader`, `get_keyframes` and `set_keyframes` (definitions, handlers, guides, dispatcher).
- `sync.ts`, `views.ts` — editor connections, what each editor is viewing (MCP tools default to the user's file/page/selection), server → editor RPC.
- `presence.ts` — agent activity per node (40 s expiry), working indicators, activity log.
- `render/` — headless Chrome/Edge via puppeteer-core: measurement, screenshots (Paper's 2000 px / JPEG 0.92 / 4.5 MB limits), PNG/JPG/WebP/PDF export, local font discovery. Pages settle their animations before anything is read (finite ones at their end, loops removed), or freeze at `get_screenshot`'s `animationTime`; `lottie-runtime.ts` draws Lottie layers like the shader runtime does shaders (`/__op/lottie.js`).
- `embed.ts` — Embed layers' HTML served at `/__op/embed/<file>/<node>` with a CSP sandbox (opaque origin, framed only by OpenPaper) and a small runtime that pauses requestAnimationFrame loops, animations and media on request.
- `thumbnails.ts` — home-screen previews of the page each file was last shown on in an editor (else its first page with content), zoomed to fit and rendered in the headless browser (transparent WebP in `<home>/cache/thumbnails`, painted over the canvas colour by the card). A file is rendered again only after it changes or was left on another page: 15 s after the last edit while open (2 s when nobody has it open), right away when the user leaves it or switches away from the window, and for missing ones when the file list is requested. One render at a time; a browser launched only for thumbnails closes 30 s later.
- `tailwind.ts` — Tailwind CSS v4 canonicalizer in a worker thread.
- `assets.ts`, `media.ts` — content-addressed media store (images, MP4/WebM video, Lottie JSON; `.lottie` archives unpacked); data URIs, local files and remote files are imported on write; byte ranges for video.
- `images.ts` — `paper-gen://` generation via OpenAI / Gemini.
- `harness.ts` — writes MCP config for agent apps.
- `render/shader-runtime.ts` — browser script (served at `/__op/shaders.js`, prebuilt to `dist/shader-runtime.js`) that mounts shader layers in headless render documents at their stored frame; the renderer waits for it before capturing.
- `vcs/` — version control. `folder.ts` writes a design as a folder Git diffs well (`openpaper.json`, one JSON file per page with layers parents-first and keys in a fixed order, `tokens.json`, `comments.json`, `assets/`) and reads it back (SVG cleaned like any import; id counters worked out from the ids). `service.ts` binds files to folders (`<home>/vcs.json`), writes a tracked design's folder 0.7 s after its last edit, loads the folder instead when it changed outside OpenPaper while the design didn't (a pull or branch switch in a terminal, seen through a size/mtime stamp), and runs git for status, commits (only the design's folder, our own files force-added), branches, fast-forward pulls, pushes and snapshots of a commit (`ls-tree` + `cat-file --batch`; missing assets go into the media store). Operations on one file are queued; index-changing commands run one at a time. `github.ts` finds the GitHub logins already on the computer (`gh auth`, else Git's credential manager, asked without prompts), lists and creates repositories over the REST API, and signs git's requests with an `http.extraheader` passed through the environment. `git.ts` runs git without prompts or editors and with literal pathspecs.
- `figma.ts` — Figma token settings and the REST lookup that turns pasted image-fill hashes into downloads (`figma-image://` URLs in the asset resolver).
- `agent/` — the built-in design agent: a Claude API tool loop (streaming, adaptive thinking, prompt caching, server-side compaction) over the same `ToolRuntime` the MCP endpoint uses, so it behaves exactly like an external agent and shows up in presence and the activity feed. Text, thinking summaries and tool steps stream to editors over the WebSocket (`{t: "agent"}` events); the API key and model/effort settings live in `<home>/config.json`. It can instead run on a coding agent the user installed: `claude-code.ts`, `codex.ts` and `agy.ts` launch Claude Code, the Codex CLI or the Antigravity CLI headless against the MCP endpoint (shared process plumbing in `cli.ts`) and turn their JSON output into the same chat events. agy runs from `<home>/agy`, whose workspace plugin carries the MCP server and a hook that lets only the design tools and its image subagent through.

### `apps/editor` (React)
- `sync/` — WebSocket client and session (open file, commands, undo, view reporting, RPC handlers).
- `editor/canvas/` — canvas (pan/zoom world, the file's `@keyframes` sheet), `NodeView` (one React component per layer, using core's render rules; `MotionLayers.tsx` for Lottie and Embed layers), `motion.ts` (replay, measuring and capturing with animations at rest), overlay (selection, handles, agent indicators, comment pins), interactions (tools/gestures), inline text editor. The top bar's play/pause (`animationsPaused` in the store) holds CSS, SVG, video, Lottie, embed and shader motion still.
- `editor/panels/` — layers & pages, tokens, inspector, code, comments, agents, version control (`VersionPanel.tsx`: setup, changes, commit, branches, history), export.
- Older versions: `#/file/<id>/version/<commit>` shows a commit's snapshot read-only (`preview` in the store holds the live document, which server patches keep current; commands, undo, design-changing shortcuts and canvas gestures are refused), with `VersionBanner.tsx` over the canvas.
- `editor/AgentDock.tsx` — the built-in agent's chat, docked at the bottom of the canvas.
- `editor/shaders/` — shader layers on the canvas (library loaded lazily), the picker with generated previews, inspector controls (presets, sliders with live preview, colours, groups, images, play/pause).
- `editor/figma/` — Figma paste (loaded on demand) and the token prompt for image fills.

## Data flow of an agent edit

1. The agent calls `write_html` (stdio relay → HTTP → `ToolRuntime`).
2. Image URLs in the HTML are resolved first (downloaded into the media store).
3. Inside one transaction the HTML is imported (`importHtml`) and inserted (`insertImported`); ids come from the document's counter.
4. The commit produces a patch; the hub broadcasts it to every editor viewing the file and schedules a save.
5. Presence records the agent's activity; editors show the working indicator and a highlight on the new layers.
6. When the agent asks for positions or a screenshot, layout is measured by the editor that shows the page (or headless Chrome) for that exact document version.

## Rendering contract

A layer renders as a real element with its stored camelCase CSS: Frames and Rectangles as `div`, Text as `div` with `white-space: pre-wrap`, SVG as the sanitized markup with per-layer id scoping. Top-level layers sit on the canvas at their `left`/`top`; children of freeform frames (`display: "*"`) are absolutely positioned. Typography lives on Text layers. The same rules produce the canvas, headless screenshots, exports and (minus positioning) the JSX/HTML export.
