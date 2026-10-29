# OpenPaper website

The OpenPaper site: static HTML, CSS and a small script, with no dependencies and no build step.

## Preview locally

```bash
npx serve website          # or: python -m http.server 4321 --directory website
```

## Pages

The homepage stays minimal: a headline, the live editor demo, three ideas, a quick start, and links to everything else.
The details live on topic pages, reached from `explore.html`.

| Page | What it covers |
|---|---|
| `index.html` | Home: hero, live build demo, three ideas, quick start, topic links |
| `explore.html` | Hub with an illustrated card for every topic |
| `canvas.html` | Tools, layout, layers, tokens, comments, undo, export |
| `code.html` | Code tab demo, copy as React or Tailwind, agents writing components, pasting HTML |
| `shaders.html` | Effect picker demo and the full library of 30 shaders |
| `figma.html` | What comes across, where it lands, image tokens, what isn't supported |
| `shortcuts.html` | Every shortcut, searchable, with a Windows/macOS toggle |
| `agents.html` | Built-in agent, connecting agents, live presence, screenshots, prompts |
| `mcp.html` | Transports, every MCP tool, Paper compatibility |
| `install.html` | The Windows app download, running from source on macOS and Linux, the `openpaper` CLI, environment variables, development |
| `privacy.html` | The data folder, localhost only, what goes online and when |
| `terms.html` | Terms of Use (the same text the Windows installer shows) |
| `faq.html` | Common questions |

## Files

```
website/
├── *.html                 the pages
├── partials/              shared header, footer and icon sprite
├── tools/sync.mjs         stamps the partials into every page
└── assets/
    ├── css/site.css           tokens, layout and components
    ├── css/illustrations.css  the animated illustrations (.ill-*)
    ├── js/site.js             theme, tabs, copy buttons, reveals, shader canvases,
    │                          shortcut search, and the hero's live-build playback
    └── brand/                 favicons and app icon (from apps/editor/public and docs/brand)
```

## Editing

- **Header, footer or icons:** edit the file in `partials/`, then run `node website/tools/sync.mjs`. Each page holds a
  stamped copy between `<!-- @header -->`, `<!-- @footer -->` and `<!-- @icons -->` markers, so pages work without a
  build step. The nav item that matches `<body data-nav="…">` is marked as the current page.
- **New icon:** add a `<symbol id="i-name">` to `partials/icons.svg` (the editor's lucide icons live in
  `node_modules/lucide-react/dist/esm/icons`), sync, and use it with `<svg class="i"><use href="#i-name" /></svg>`.
- **New topic page:** copy a topic page such as `figma.html`, keep the markers, set `data-nav` (`explore` for topic
  pages), update its pager links and the pages next to it, add it to `explore.html` and `partials/footer.html`, then sync.
- **Illustrations** are HTML and CSS in `illustrations.css`, sized in container units, so they scale with any card.
  Each one's resting state is its finished frame, which is what visitors with reduced motion see.
- When the editor UI changes, update the replica in `index.html` (`.mock`).

## Design

- **Palette:** only the logo's colours, Ink `#111111`, Fold `#8C8C8C` and Paper `#FFFFFF`, plus the editor's neutral
  greys. The serif phrase in each headline uses Fold, like the logo's peeled edge.
- **Type:** Inter (the editor's UI font), Instrument Serif for one accent phrase per headline, Fragment Mono for code.
- **Agent logos** (the homepage's "Works with" list) are one-colour marks from [theSVG](https://thesvg.org), stored as
  `b-*` symbols in `partials/icons.svg`. They are trademarks of their owners, shown only to identify compatible tools.
- **Layout language:** based on the Subframe style from [Refero Styles](https://styles.refero.design/), adapted to
  OpenPaper's palette.
- Light and dark themes follow the system and can be toggled. Animations pause off screen and are skipped under
  `prefers-reduced-motion`.

## Deploying

Publish the `website/` folder as the site root on any static host (Netlify, Vercel or Cloudflare Pages with the output
directory set to `website`, or GitHub Pages through an Actions workflow that uploads this folder). Once the site has a
URL, make each page's `og:image` an absolute URL so link previews pick it up.

## Keeping it accurate

Copy mirrors the root `README.md`, `docs/mcp-tools.md` and the shader registry in `packages/core/src/shaders`. When
features, agents, tools, shortcuts or requirements change, update the matching page.
