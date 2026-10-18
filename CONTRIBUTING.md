# Contributing to OpenPaper

Thanks for helping! OpenPaper is a TypeScript monorepo (npm workspaces).

## Setup

```bash
npm install
npm run build          # editor + server bundle
npm test               # vitest: core unit tests + MCP integration tests
npm run typecheck
```

Day-to-day development:

```bash
npm run dev            # server (tsx watch) on :29880, expects the editor dev server
npm run dev:editor     # Vite on :5173 (proxies /ws, /api, /media to the server)
```

Use a throwaway data directory while developing: `OPENPAPER_HOME=/tmp/op npm run dev`.

## Where things live

See [docs/architecture.md](docs/architecture.md). In short: document model and HTML/JSX logic in `packages/core`, MCP tools and the server in `packages/server`, the React canvas in `apps/editor`.

## Guidelines

- **MCP compatibility is a feature.** Tool names, parameters and response shapes match Paper's; don't change them without a very good reason. Add new behavior with new optional parameters or new tools.
- After changing tool definitions, regenerate the reference: `npx tsx packages/server/scripts/gen-docs.ts`.
- Shader packages are pinned to an Apache-2.0 release (`@paper-design/shaders` 0.0.77+; never 0.0.47–0.0.76, which were PolyForm Shield). After bumping them, regenerate presets with `node packages/core/scripts/gen-shader-presets.mjs` and update THIRD_PARTY_NOTICES.md.
- Rendering rules belong in `packages/core/src/render` so the canvas, headless screenshots and exports stay identical.
- Every mutation goes through a `Transaction`; never mutate a document in place.
- Add tests: importer behavior in `packages/core/src/html/import.test.ts`, tools in `packages/server/test/mcp.test.ts`.
- Keep it local-first: no telemetry, no network calls except fonts, user-requested images and image generation.
