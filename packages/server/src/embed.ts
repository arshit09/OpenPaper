/**
 * Embed layers: a layer's own HTML (scripts included) served into its sandboxed frame. The response
 * is sandboxed by CSP too (an opaque origin even when opened in a tab), and it may only be framed by
 * OpenPaper itself. A small script added at the top lets the editor pause and resume what plays.
 */

/** Response headers for an embed document. */
export const EMBED_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'content-security-policy': "sandbox allow-scripts allow-pointer-lock; frame-ancestors 'self'",
  'x-content-type-options': 'nosniff',
} as const;

/**
 * Runs inside the embed before its own scripts (plain JS: it is sent as text). A message
 * `{ "op-animations": "pause" | "play" }` from the parent freezes or resumes requestAnimationFrame
 * loops, CSS and Web Animations, media and SVG animations.
 */
const RUNTIME_JS = `(() => {
  const realRaf = window.requestAnimationFrame.bind(window);
  const realCancel = window.cancelAnimationFrame.bind(window);
  let paused = false;
  let nextId = 1;
  const queued = new Map();
  const live = new Map();
  window.requestAnimationFrame = (cb) => {
    const id = nextId++;
    if (paused) queued.set(id, cb);
    else live.set(id, realRaf((t) => { live.delete(id); if (paused) queued.set(id, cb); else cb(t); }));
    return id;
  };
  window.cancelAnimationFrame = (id) => {
    queued.delete(id);
    const real = live.get(id);
    if (real !== undefined) realCancel(real);
    live.delete(id);
  };
  const held = new Set();
  const media = new Set();
  const pause = () => {
    if (paused) return;
    paused = true;
    for (const a of document.getAnimations()) if (a.playState === 'running') { a.pause(); held.add(a); }
    for (const m of document.querySelectorAll('video, audio')) if (!m.paused) { m.pause(); media.add(m); }
    for (const s of document.querySelectorAll('svg')) s.pauseAnimations();
  };
  const play = () => {
    if (!paused) return;
    paused = false;
    for (const a of held) a.play();
    held.clear();
    for (const m of media) m.play().catch(() => {});
    media.clear();
    for (const s of document.querySelectorAll('svg')) s.unpauseAnimations();
    const callbacks = [...queued.entries()];
    queued.clear();
    for (const [id, cb] of callbacks) live.set(id, realRaf((t) => { live.delete(id); cb(t); }));
  };
  window.addEventListener('message', (e) => {
    if (e.source !== window.parent) return;
    const cmd = e.data && e.data['op-animations'];
    if (cmd === 'pause') pause();
    else if (cmd === 'play') play();
  });
})();`;

const RUNTIME = `<script>${RUNTIME_JS}</script>`;

/** The layer's HTML as a document, with the runtime first. */
export function embedDocument(html: string): string {
  const head = /<head\b[^>]*>/i.exec(html);
  if (head) return html.slice(0, head.index + head[0].length) + RUNTIME + html.slice(head.index + head[0].length);
  const root = /<html\b[^>]*>/i.exec(html);
  if (root) return html.slice(0, root.index + root[0].length) + RUNTIME + html.slice(root.index + root[0].length);
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  if (doctype) return doctype[0] + RUNTIME + html.slice(doctype[0].length);
  // A fragment: standards mode, no page margin (the layer is the page).
  return `<!doctype html><html><head><meta charset="utf-8">${RUNTIME}<style>html,body{margin:0;height:100%}</style></head><body>${html}</body></html>`;
}
