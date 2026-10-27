/**
 * The in-page inspector the site proxy injects into every HTML document it serves.
 * It draws hover/selection outlines in a closed shadow root and talks to the editor with postMessage.
 *
 * Editor → inspector: `iframe.contentWindow.postMessage({ source: 'openpaper', ...InspectorCommand }, proxyOrigin)`.
 * Inspector → editor: `parent.postMessage({ source: 'openpaper-inspector', ...InspectorEvent }, editorOrigin)`.
 *
 * Messages arrive from the site's own JavaScript context, so the editor must treat everything in them
 * (text, html, attributes, even the message itself) as untrusted page content.
 */

export const INSPECTOR_PATH = '/__openpaper/inspector.js';
export const INSPECTOR_TAG = `<script src="${INSPECTOR_PATH}"></script>`;

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ElementSource {
  /** As the framework reports it: absolute, or relative to the dev server root (Vite, webpack). */
  file: string;
  /** 1-based; only when the framework records exact positions (React ≤18, Svelte, Astro, inspector attributes). */
  line?: number;
  column?: number;
}

export interface ElementInfo {
  /** Unique-ish CSS path; also how the selection is found again after HMR or a reload. */
  selector: string;
  tag: string;
  id?: string;
  classes: string[];
  /** innerText, whitespace collapsed, ≤300 chars. */
  text: string;
  /** outerHTML with deep children collapsed and long attributes cut, ≤2000 chars. */
  html: string;
  /** Viewport (iframe client) coordinates. */
  rect: Rect;
  /** role, aria-label, href, src, alt, type, name, placeholder, data-testid, title (when present). */
  attributes: Record<string, string>;
  /** Computed: color, background-color, font-family, font-size, font-weight, line-height, padding, margin, border-radius, display, gap. */
  styles: Record<string, string>;
  /** Nearest first, ≤5, stopping below <html>. */
  ancestors: Array<{ tag: string; id?: string; classes: string[] }>;
  source?: ElementSource;
  /** Component names, innermost first, ≤6 (React owners, Vue/Svelte/Angular components). */
  components?: string[];
  /** e.g. "next", "nuxt", "sveltekit", "astro", "astro+react", "react", "vue", "svelte", "angular", "vite". */
  framework?: string;
}

/** Editor → inspector (sent with `source: 'openpaper'`). */
export type InspectorCommand =
  | { type: 'hello' }
  | { type: 'mode'; inspect: boolean }
  | { type: 'clear' }
  | { type: 'select-parent' }
  | { type: 'working'; active: boolean }
  | { type: 'reload' };

/** Inspector → editor (sent with `source: 'openpaper-inspector'`). */
export type InspectorEvent =
  /** `url` is the page's address on the real dev server; `proxyUrl` is what the iframe actually loaded. */
  | { type: 'ready'; url: string; proxyUrl: string; title: string }
  | { type: 'location'; url: string; proxyUrl: string; title: string }
  | { type: 'selection'; elements: ElementInfo[] }
  /** Same order as the last `selection`; a zero rect while an element is briefly missing (HMR). */
  | { type: 'rects'; rects: Rect[] }
  | { type: 'mode'; inspect: boolean }
  /** Posted by the proxy's "can't reach your dev server" page instead of `ready`. */
  | { type: 'unreachable'; url: string; proxyUrl: string };

export interface InspectorConfig {
  /** Origins of the editor that frames the site; the only ones the inspector listens to or posts to. */
  editorOrigins: string[];
  /** The dev server's origin first, then loopback aliases (localhost ↔ 127.0.0.1) of it. */
  targetOrigins: string[];
}

/** The inspector as a classic script (ES2019, no dependencies, safe to run twice). */
export function inspectorScript(config: InspectorConfig): string {
  const json = JSON.stringify({ editorOrigins: config.editorOrigins, targetOrigins: config.targetOrigins }).replace(/</g, '\\u003c');
  return INSPECTOR_SOURCE.replace('__OPENPAPER_CONFIG__', json);
}

// Plain ES2019 in a string: no optional chaining, no `??`, no template literals (it lives in one).
const INSPECTOR_SOURCE = String.raw`(function () {
  'use strict';
  var w = window;
  var doc = document;
  if (w.__openpaperInspector__) return;
  try { Object.defineProperty(w, '__openpaperInspector__', { value: true }); } catch (e) { w.__openpaperInspector__ = true; }
  // Leave the document as the server rendered it, so hydration sees no extra node.
  var own = doc.currentScript;
  if (own && own.parentNode) own.parentNode.removeChild(own);

  var CONFIG = __OPENPAPER_CONFIG__;
  var EDITOR_ORIGINS = CONFIG.editorOrigins || [];
  var TARGET_ORIGINS = CONFIG.targetOrigins || [];
  var FRAMED = w.parent !== w;
  var ACCENT = '#0d99ff';
  var LOST_GRACE_MS = 1000;
  var RESTORE_MS = 10000;
  var SAVED_KEY = '__openpaper_selection__';
  var ELLIPSIS = '\u2026';

  var editorOrigin = null;
  var inspecting = false;
  var working = false;
  var selection = [];
  var restoring = null;
  var hoverEl = null;
  var pointer = null;
  var lastRects = '[]';
  var lastLocation = '';
  var readyAt = 0;
  var frame = 0;
  var host = null;
  var root = null;
  var hoverBox = null;
  var hoverLabel = null;
  var hoverName = null;
  var hoverSize = null;
  var boxes = [];
  var inspectStyle = null;
  var labels = typeof WeakMap === 'function' ? new WeakMap() : null;

  // --- Messaging ------------------------------------------------------------

  function send(msg, origin) {
    msg.source = 'openpaper-inspector';
    try { w.parent.postMessage(msg, origin); } catch (e) {}
  }

  function post(msg) {
    if (FRAMED && editorOrigin) send(msg, editorOrigin);
  }

  /** Before the editor says hello: the parent's origin if the browser tells us, else each allowed one (mismatches are dropped). */
  function announce(msg) {
    if (!FRAMED) return;
    if (editorOrigin) return send(msg, editorOrigin);
    var parent = null;
    try { if (location.ancestorOrigins && location.ancestorOrigins.length) parent = location.ancestorOrigins[0]; } catch (e) {}
    if (parent) {
      if (EDITOR_ORIGINS.indexOf(parent) >= 0) send(msg, parent);
      return;
    }
    for (var i = 0; i < EDITOR_ORIGINS.length; i++) send(msg, EDITOR_ORIGINS[i]);
  }

  function sendReady(announced) {
    lastLocation = location.href + '\n' + doc.title;
    readyAt = Date.now();
    if (announced) announce(pageMessage('ready'));
    else post(pageMessage('ready'));
    if (selection.length) postSelection();
  }

  function targetUrl(href) {
    try {
      var u = new URL(href);
      if (TARGET_ORIGINS.length && u.origin === location.origin) return TARGET_ORIGINS[0] + u.pathname + u.search + u.hash;
    } catch (e) {}
    return href;
  }

  function pageMessage(type) {
    return { type: type, url: targetUrl(location.href), proxyUrl: location.href, title: doc.title };
  }

  w.addEventListener('message', function (event) {
    var data = event.data;
    if (!data || typeof data !== 'object' || data.source !== 'openpaper') return;
    if (!FRAMED || event.source !== w.parent || EDITOR_ORIGINS.indexOf(event.origin) < 0) return;
    var known = editorOrigin === event.origin;
    editorOrigin = event.origin;
    switch (data.type) {
      case 'hello':
        // An editor that answers every ready with hello would otherwise ping-pong with us forever.
        if (known && Date.now() - readyAt < 1000) break;
        sendReady(false);
        break;
      case 'mode': setInspect(!!data.inspect, false); break;
      case 'clear': clearSelection(); break;
      case 'select-parent': selectParent(); break;
      case 'working': setWorking(!!data.active); break;
      case 'reload': location.reload(); break;
    }
  });

  // --- Location -------------------------------------------------------------

  function checkLocation() {
    var key = location.href + '\n' + doc.title;
    if (key === lastLocation) return;
    lastLocation = key;
    post(pageMessage('location'));
  }

  function soon() { setTimeout(checkLocation, 0); }

  ['pushState', 'replaceState'].forEach(function (name) {
    var original = history[name];
    if (typeof original !== 'function') return;
    history[name] = function () {
      var result = original.apply(this, arguments);
      soon();
      return result;
    };
  });
  w.addEventListener('popstate', soon);
  w.addEventListener('hashchange', soon);
  setInterval(checkLocation, 1000); // titles often change after the route does

  function onReady() {
    sendReady(true);
    if (selection.length || restoring) schedule();
  }
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', onReady);
  else onReady();

  // Keep the selection across full reloads (HMR full-reload, the editor's reload).
  try {
    var saved = JSON.parse(sessionStorage.getItem(SAVED_KEY) || 'null');
    sessionStorage.removeItem(SAVED_KEY);
    if (saved && saved.url === location.href && Date.now() - saved.at < 60000 && saved.items && saved.items.length) {
      restoring = { items: saved.items, until: Date.now() + RESTORE_MS };
    }
  } catch (e) {}
  w.addEventListener('pagehide', function () {
    try {
      if (!selection.length) return sessionStorage.removeItem(SAVED_KEY);
      var items = selection.map(function (s) { return { selector: s.selector, tag: s.tag }; });
      sessionStorage.setItem(SAVED_KEY, JSON.stringify({ url: location.href, at: Date.now(), items: items }));
    } catch (e) {}
  });

  // Absolute links to the dev server would leave the proxy (and the inspector) behind.
  function toProxy(href) {
    try {
      var u = new URL(href, doc.baseURI);
      if (u.origin !== location.origin && TARGET_ORIGINS.indexOf(u.origin) >= 0) return location.origin + u.pathname + u.search + u.hash;
    } catch (e) {}
    return null;
  }
  function onNavigateClick(e) {
    if (inspecting) return;
    var t = e.composedPath ? e.composedPath()[0] : e.target;
    var a = t && t.closest ? t.closest('a[href]') : null;
    if (!a) return;
    var fixed = toProxy(a.getAttribute('href'));
    if (fixed) a.setAttribute('href', fixed);
  }
  w.addEventListener('click', onNavigateClick, true);
  w.addEventListener('auxclick', onNavigateClick, true);
  w.addEventListener('submit', function (e) {
    var form = e.target;
    if (!form || !form.getAttribute) return;
    var fixed = form.getAttribute('action') && toProxy(form.getAttribute('action'));
    if (fixed) form.setAttribute('action', fixed);
    var submitter = e.submitter;
    var formAction = submitter && submitter.getAttribute && submitter.getAttribute('formaction');
    var fixedAction = formAction && toProxy(formAction);
    if (fixedAction) submitter.setAttribute('formaction', fixedAction);
  }, true);

  // --- Inspect mode ---------------------------------------------------------

  function setInspect(on, echo) {
    if (on === inspecting) return;
    inspecting = on;
    if (!on) { hoverEl = null; pointer = null; }
    if (on) {
      if (!inspectStyle) {
        inspectStyle = doc.createElement('style');
        inspectStyle.textContent = '*,*::before,*::after{cursor:default!important;-webkit-user-select:none!important;user-select:none!important}';
      }
      doc.documentElement.appendChild(inspectStyle);
    } else if (inspectStyle && inspectStyle.parentNode) {
      inspectStyle.parentNode.removeChild(inspectStyle);
    }
    render();
    schedule();
    if (echo) post({ type: 'mode', inspect: on });
  }

  function onBlocked(e) {
    if (!inspecting) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.type === 'click' && e.isTrusted) pick(e);
  }
  ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'dblclick', 'auxclick', 'contextmenu', 'dragstart', 'selectstart'].forEach(function (type) {
    w.addEventListener(type, onBlocked, true);
  });

  w.addEventListener('pointermove', function (e) {
    if (!inspecting) return;
    pointer = { x: e.clientX, y: e.clientY };
    setHover(hit(e.clientX, e.clientY));
  }, { capture: true, passive: true });

  w.addEventListener('scroll', function () {
    if (inspecting && pointer) setHover(hit(pointer.x, pointer.y));
    if (selection.length) schedule();
  }, { capture: true, passive: true });

  w.addEventListener('mouseout', function (e) {
    if (!inspecting || e.relatedTarget) return;
    pointer = null;
    setHover(null);
  }, true);

  w.addEventListener('resize', schedule, { passive: true });

  w.addEventListener('keydown', function (e) {
    if (!inspecting || e.key !== 'Escape') return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (selection.length) clearSelection();
    else setInspect(false, true);
  }, true);

  function hit(x, y) {
    return normalizeTarget(doc.elementFromPoint(x, y));
  }

  function normalizeTarget(el) {
    if (!el || el.nodeType !== 1 || el === host) return null;
    while (el.ownerSVGElement) el = el.ownerSVGElement; // the whole icon, not one <path>
    if (el === doc.documentElement) el = doc.body || el;
    return el;
  }

  function setHover(el) {
    if (el === hoverEl) return;
    hoverEl = el;
    schedule();
  }

  function pick(e) {
    var el = hit(e.clientX, e.clientY) || normalizeTarget(e.target);
    if (!el) return;
    if (e.shiftKey) toggle(el);
    else selectOnly(el);
  }

  // --- Selection ------------------------------------------------------------

  function entry(el) {
    return { el: el, selector: selectorFor(el), tag: el.localName, lostAt: 0 };
  }

  function isSelected(el) {
    for (var i = 0; i < selection.length; i++) if (selection[i].el === el) return true;
    return false;
  }

  function selectOnly(el) {
    restoring = null;
    if (selection.length === 1 && selection[0].el === el) return;
    selection = [entry(el)];
    changed();
  }

  function toggle(el) {
    restoring = null;
    for (var i = 0; i < selection.length; i++) {
      if (selection[i].el === el) {
        selection.splice(i, 1);
        return changed();
      }
    }
    selection.push(entry(el));
    changed();
  }

  function clearSelection() {
    restoring = null;
    selection = [];
    changed();
  }

  function selectParent() {
    var next = [];
    selection.forEach(function (s) {
      var p = s.el.parentElement;
      if (!p || p === doc.documentElement) p = s.el;
      if (next.indexOf(p) < 0) next.push(p);
    });
    if (!next.length) return;
    selection = next.map(entry);
    changed();
  }

  function setWorking(on) {
    if (on === working) return;
    working = on;
    render();
    // The agent is done: send fresh details of what it changed.
    if (!on && selection.length) postSelection();
  }

  function changed() {
    postSelection();
    render();
    schedule();
  }

  function postSelection() {
    post({ type: 'selection', elements: selection.map(describeSafe) });
    lastRects = '';
    postRects();
  }

  function postRects() {
    var rects = selection.map(function (s) { return s.el.isConnected ? rectOf(s.el) : { x: 0, y: 0, width: 0, height: 0 }; });
    var key = JSON.stringify(rects);
    if (key === lastRects) return;
    lastRects = key;
    post({ type: 'rects', rects: rects });
  }

  function find(selector, tag) {
    try {
      var el = doc.querySelector(selector);
      return el && el.localName === tag && el !== host ? el : null;
    } catch (e) {
      return null;
    }
  }

  /** HMR replaced a selected node: find it again by selector, or drop it after a short grace period. */
  function reattach(now) {
    var dirty = false;
    for (var i = selection.length - 1; i >= 0; i--) {
      var s = selection[i];
      if (s.el.isConnected) { s.lostAt = 0; continue; }
      var found = find(s.selector, s.tag);
      if (found && !isSelected(found)) {
        s.el = found;
        s.selector = selectorFor(found);
        s.lostAt = 0;
        dirty = true;
      } else if (!s.lostAt) {
        s.lostAt = now;
      } else if (now - s.lostAt > LOST_GRACE_MS) {
        selection.splice(i, 1);
        dirty = true;
      }
    }
    if (dirty) postSelection();
  }

  function restore(now) {
    var left = [];
    var added = false;
    restoring.items.forEach(function (item) {
      var el = find(item.selector, item.tag);
      if (el && !isSelected(el)) { selection.push(entry(el)); added = true; }
      else if (!el) left.push(item);
    });
    restoring.items = left;
    if (!left.length || now > restoring.until) restoring = null;
    if (added) postSelection();
  }

  // --- Frame loop -----------------------------------------------------------

  function schedule() {
    if (!frame) frame = requestAnimationFrame(tick);
  }

  function tick() {
    frame = 0;
    if (doc.readyState === 'loading') return schedule();
    var now = Date.now();
    if (restoring) restore(now);
    reattach(now);
    render();
    postRects();
    if (selection.length || restoring || (inspecting && hoverEl)) schedule();
  }

  // --- Overlay --------------------------------------------------------------

  var CSS_TEXT = [
    ':host{all:initial}',
    '.box{position:absolute;left:0;top:0;box-sizing:border-box;pointer-events:none;display:none}',
    '.hover{border:1px solid ' + ACCENT + '}',
    '.sel{border:1.5px solid ' + ACCENT + '}',
    '.working{overflow:hidden;animation:op-pulse 1.6s ease-out infinite}',
    '.working::after{content:"";position:absolute;inset:0;background:linear-gradient(105deg,transparent 35%,rgba(13,153,255,.24) 50%,transparent 65%);background-size:300% 100%;animation:op-sweep 1.8s linear infinite}',
    '@keyframes op-pulse{0%{box-shadow:0 0 0 0 rgba(13,153,255,.5)}70%{box-shadow:0 0 0 6px rgba(13,153,255,0)}100%{box-shadow:0 0 0 0 rgba(13,153,255,0)}}',
    '@keyframes op-sweep{from{background-position:100% 0}to{background-position:0 0}}',
    '@media (prefers-reduced-motion:reduce){.working,.working::after{animation:none}.working{box-shadow:0 0 0 3px rgba(13,153,255,.35)}.working::after{background:rgba(13,153,255,.12)}}',
    '.label{position:absolute;left:0;top:0;display:none;max-width:60vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:500 11px/18px ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#fff;background:' + ACCENT + ';padding:0 6px;border-radius:4px;box-shadow:0 1px 2px rgba(0,0,0,.2)}',
    '.dim{opacity:.75;margin-left:6px;font-variant-numeric:tabular-nums}'
  ].join('');

  function make(className, parent) {
    var el = doc.createElement('div');
    el.className = className;
    (parent || root).appendChild(el);
    return el;
  }

  function ensureOverlay() {
    if (!host) {
      host = doc.createElement('openpaper-overlay');
      host.setAttribute('aria-hidden', 'true');
      host.style.cssText = 'all:initial!important;display:block!important;position:fixed!important;inset:0!important;top:0!important;right:0!important;bottom:0!important;left:0!important;pointer-events:none!important;z-index:2147483647!important;';
      root = host.attachShadow ? host.attachShadow({ mode: 'closed' }) : host;
      var style = doc.createElement('style');
      style.textContent = CSS_TEXT;
      root.appendChild(style);
      hoverBox = make('box hover');
      hoverLabel = make('label');
      hoverName = doc.createElement('span');
      hoverSize = doc.createElement('span');
      hoverSize.className = 'dim';
      hoverLabel.appendChild(hoverName);
      hoverLabel.appendChild(hoverSize);
    }
    // Outside <body>, so frameworks that own the body never see (or remove) it.
    if (!host.isConnected) doc.documentElement.appendChild(host);
  }

  function place(box, r) {
    if (!r || (r.width === 0 && r.height === 0)) { box.style.display = 'none'; return; }
    box.style.display = 'block';
    box.style.transform = 'translate(' + r.left + 'px,' + r.top + 'px)';
    box.style.width = r.width + 'px';
    box.style.height = r.height + 'px';
  }

  function render() {
    if (doc.readyState === 'loading') return;
    var hover = inspecting && hoverEl && hoverEl.isConnected && !isSelected(hoverEl) ? hoverEl : null;
    if (!host && !selection.length && !hover) return;
    ensureOverlay();
    for (var i = 0; i < selection.length; i++) {
      var box = boxes[i] || (boxes[i] = make('box sel'));
      var cls = working ? 'box sel working' : 'box sel';
      if (box.className !== cls) box.className = cls;
      place(box, selection[i].el.isConnected ? selection[i].el.getBoundingClientRect() : null);
    }
    for (var j = selection.length; j < boxes.length; j++) boxes[j].style.display = 'none';
    if (!hover) {
      hoverBox.style.display = 'none';
      hoverLabel.style.display = 'none';
      return;
    }
    var r = hover.getBoundingClientRect();
    place(hoverBox, r);
    var name = labelFor(hover);
    var size = Math.round(r.width) + '\u00d7' + Math.round(r.height);
    if (hoverName.textContent !== name) hoverName.textContent = name;
    if (hoverSize.textContent !== size) hoverSize.textContent = size;
    hoverLabel.style.display = 'block';
    var lw = hoverLabel.offsetWidth;
    var vw = doc.documentElement.clientWidth || w.innerWidth;
    var vh = doc.documentElement.clientHeight || w.innerHeight;
    var top = r.top - 22;
    if (top < 2) top = r.bottom + 4 + 18 <= vh ? r.bottom + 4 : Math.max(2, r.top + 2);
    var left = Math.max(2, Math.min(r.left, vw - lw - 2));
    hoverLabel.style.transform = 'translate(' + left + 'px,' + top + 'px)';
  }

  function labelFor(el) {
    var cached = labels && labels.get(el);
    if (cached) return cached;
    var name = null;
    try {
      var meta = frameworkInfo(el);
      if (meta.components && meta.components.length) name = meta.components[0];
    } catch (e) {}
    name = name || tagLabel(el);
    if (labels) labels.set(el, name);
    return name;
  }

  function tagLabel(el) {
    var text = el.localName;
    if (el.id) text += '#' + el.id;
    else if (el.classList && el.classList.length) text += '.' + el.classList[0];
    return clip(text, 40);
  }

  // --- Element details ------------------------------------------------------

  function clip(s, n) {
    return s.length > n ? s.slice(0, n - 1) + ELLIPSIS : s;
  }

  function round(v) {
    return Math.round(v * 10) / 10;
  }

  function rectOf(el) {
    var r = el.getBoundingClientRect();
    return { x: round(r.left), y: round(r.top), width: round(r.width), height: round(r.height) };
  }

  function classesOf(el, max) {
    return el.classList ? Array.prototype.slice.call(el.classList, 0, max || 50) : [];
  }

  function textOf(el) {
    var t = typeof el.innerText === 'string' ? el.innerText : el.textContent || '';
    return clip(t.replace(/[ \t\u00a0]+/g, ' ').replace(/ *\n\s*/g, '\n').trim(), 300);
  }

  var VOID = { area: 1, base: 1, br: 1, col: 1, embed: 1, hr: 1, img: 1, input: 1, link: 1, meta: 1, source: 1, track: 1, wbr: 1 };

  function escapeHtml(s, attr) {
    s = s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return attr ? s.replace(/"/g, '&quot;') : s;
  }

  function serialize(node, level, maxDepth) {
    var tag = node.localName;
    var out = '<' + tag;
    for (var i = 0; i < node.attributes.length; i++) {
      var a = node.attributes[i];
      out += ' ' + a.name + (a.value === '' ? '' : '="' + escapeHtml(clip(a.value, 120), true) + '"');
    }
    out += '>';
    if (VOID[tag]) return out;
    var kids = node.childNodes;
    if (tag === 'script' || tag === 'style') return out + (node.textContent ? ELLIPSIS : '') + '</' + tag + '>';
    if (!kids.length) return out + '</' + tag + '>';
    if (level >= maxDepth) return out + ELLIPSIS + '</' + tag + '>';
    var shown = 0;
    for (var k = 0; k < kids.length; k++) {
      var c = kids[k];
      if (c.nodeType === 3) {
        var t = c.nodeValue.replace(/\s+/g, ' ');
        if (t.trim()) out += escapeHtml(clip(t, 80));
      } else if (c.nodeType === 1) {
        if (shown >= 12 || out.length > 4000) {
          out += '<!-- ' + (node.children.length - shown) + ' more -->';
          break;
        }
        out += serialize(c, level + 1, maxDepth);
        shown++;
      }
    }
    return out + '</' + tag + '>';
  }

  function htmlOf(el) {
    var out = '';
    for (var depth = 3; depth >= 0; depth--) {
      out = serialize(el, 0, depth);
      if (out.length <= 2000) return out;
    }
    return clip(out, 2000);
  }

  var ATTRS = ['role', 'aria-label', 'href', 'src', 'alt', 'type', 'name', 'placeholder', 'data-testid', 'title'];

  function attributesOf(el) {
    var out = {};
    ATTRS.forEach(function (name) {
      var v = el.getAttribute(name);
      if (v !== null) out[name] = clip(v, 300);
    });
    return out;
  }

  var STYLES = ['color', 'background-color', 'font-family', 'font-size', 'font-weight', 'line-height', 'padding', 'margin', 'border-radius', 'display', 'gap'];
  var LONGHANDS = {
    padding: ['padding-top', 'padding-right', 'padding-bottom', 'padding-left'],
    margin: ['margin-top', 'margin-right', 'margin-bottom', 'margin-left'],
    'border-radius': ['border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius'],
    gap: ['row-gap', 'column-gap']
  };

  function shorthand(v) {
    if (v.length === 2) return v[0] === v[1] ? v[0] : v.join(' ');
    if (v[1] === v[3]) {
      if (v[0] === v[2]) return v[0] === v[1] ? v[0] : v[0] + ' ' + v[1];
      return v[0] + ' ' + v[1] + ' ' + v[2];
    }
    return v.join(' ');
  }

  function stylesOf(el) {
    var out = {};
    var cs;
    try { cs = getComputedStyle(el); } catch (e) { return out; }
    STYLES.forEach(function (name) {
      var v = cs.getPropertyValue(name);
      if (!v && LONGHANDS[name]) v = shorthand(LONGHANDS[name].map(function (p) { return cs.getPropertyValue(p); }));
      if (v) out[name] = v;
    });
    return out;
  }

  function ancestorsOf(el) {
    var out = [];
    for (var p = el.parentElement; p && p !== doc.documentElement && out.length < 5; p = p.parentElement) {
      var a = { tag: p.localName, classes: classesOf(p, 12) };
      if (p.id) a.id = p.id;
      out.push(a);
    }
    return out;
  }

  function describe(s) {
    var el = s.el;
    var info = {
      selector: s.selector,
      tag: el.localName,
      classes: classesOf(el),
      text: textOf(el),
      html: htmlOf(el),
      rect: rectOf(el),
      attributes: attributesOf(el),
      styles: stylesOf(el),
      ancestors: ancestorsOf(el)
    };
    if (el.id) info.id = el.id;
    try {
      var meta = frameworkInfo(el);
      if (meta.source) info.source = meta.source;
      if (meta.components && meta.components.length) info.components = meta.components;
      if (meta.framework) info.framework = meta.framework;
    } catch (e) {}
    return info;
  }

  function describeSafe(s) {
    try {
      return describe(s);
    } catch (e) {
      return { selector: s.selector, tag: s.tag, classes: [], text: '', html: '', rect: { x: 0, y: 0, width: 0, height: 0 }, attributes: {}, styles: {}, ancestors: [] };
    }
  }

  // --- Selectors ------------------------------------------------------------

  function cssEscape(s) {
    if (w.CSS && CSS.escape) return CSS.escape(s);
    return String(s).replace(/[^\w-]/g, function (c) { return '\\' + c; });
  }

  /** Ids generated at runtime (React useId, Radix, Headless UI, Ember) change between renders. */
  function stableId(id) {
    return !/^\d|[:\u00ab\u00bb\s]|\d{4,}|^_r_|^(radix|headlessui|mui|rc|react-aria|ember)[-_\d]/i.test(id);
  }

  function unique(selector, el) {
    try {
      var all = doc.querySelectorAll(selector);
      return all.length === 1 && all[0] === el;
    } catch (e) {
      return false;
    }
  }

  function step(el) {
    if (el === doc.body) return { text: 'body', done: true };
    if (el.id && stableId(el.id) && unique('#' + cssEscape(el.id), el)) return { text: '#' + cssEscape(el.id), done: true };
    var testId = el.getAttribute('data-testid');
    if (testId) {
      var bySel = el.localName + '[data-testid="' + testId.replace(/["\\]/g, '\\$&') + '"]';
      if (unique(bySel, el)) return { text: bySel, done: true };
    }
    var text = cssEscape(el.localName);
    var parent = el.parentElement;
    if (parent) {
      var count = 0;
      var index = 0;
      for (var c = parent.firstElementChild; c; c = c.nextElementSibling) {
        if (c.localName === el.localName) {
          count++;
          if (c === el) index = count;
        }
      }
      if (count > 1) text += ':nth-of-type(' + index + ')';
    }
    return { text: text, done: !parent };
  }

  function selectorFor(el) {
    var parts = [];
    for (var node = el; node && node.nodeType === 1 && node !== doc.documentElement; node = node.parentElement) {
      var s = step(node);
      parts.unshift(s.text);
      if (s.done) break;
    }
    return parts.join(' > ') || el.localName;
  }

  // --- Framework metadata (dev builds only; all best effort) -------------------

  var INTERNAL = /^(InnerLayoutRouter|OuterLayoutRouter|RenderFromTemplateContext|ScrollAndFocusHandler|InnerScrollAndFocusHandler|RedirectBoundary|RedirectErrorBoundary|NotFoundBoundary|NotFoundErrorBoundary|HTTPAccessFallbackBoundary|HTTPAccessFallbackErrorBoundary|LoadingBoundary|ErrorBoundaryHandler|DevRootHTTPAccessFallbackBoundary|AppDevOverlay|AppDevOverlayErrorBoundary|ReactDevOverlay|HotReload|AppRouter|ServerRoot|ClientPageRoot|ClientSegmentRoot|MetadataBoundary|ViewportBoundary|OutletBoundary|SegmentViewNode|SegmentStateProvider|Suspense|StrictMode|Fragment)$/;

  function loc(file, line, column) {
    if (!file) return null;
    var out = { file: String(file) };
    var l = parseInt(line, 10);
    var c = parseInt(column, 10);
    if (l > 0) out.line = l;
    if (l > 0 && c > 0) out.column = c;
    return out;
  }

  function parseLoc(value) {
    var v = String(value).trim().replace(/:[A-Za-z][\w-]*$/, ''); // code-inspector appends ":tag"
    var m = /^(.*?):(\d+)(?::(\d+))?$/.exec(v);
    var file = m ? m[1] : v;
    if (!/\.[A-Za-z0-9]+$/.test(file)) return null;
    return m ? loc(file, m[2], m[3]) : loc(file);
  }

  var LOC_ATTRS = ['data-v-inspector', 'data-insp-path', 'data-source', 'data-source-loc', 'data-loc', 'data-locator'];

  function attrSource(node) {
    if (!node.getAttribute) return null;
    var v = node.getAttribute('data-inspector-relative-path');
    if (v) return loc(v, node.getAttribute('data-inspector-line'), node.getAttribute('data-inspector-column'));
    v = node.getAttribute('data-astro-source-file');
    if (v) {
      var parts = (node.getAttribute('data-astro-source-loc') || '').split(':');
      return loc(v, parts[0], parts[1]);
    }
    v = node.getAttribute('data-source-file');
    if (v) return loc(v, node.getAttribute('data-source-line'), node.getAttribute('data-source-column'));
    for (var i = 0; i < LOC_ATTRS.length; i++) {
      v = node.getAttribute(LOC_ATTRS[i]);
      var parsed = v && parseLoc(v);
      if (parsed) return parsed;
    }
    return null;
  }

  function baseName(file) {
    var name = String(file).split(/[\\/]/).pop() || '';
    return name.replace(/\.[^.]+$/, '') || null;
  }

  /** Paths in stack frames: Vite (/src/x.tsx, /@fs/abs), webpack-internal, file://, React server frames (rsc://). */
  function urlToFile(url) {
    var rsc = /^rsc:\/\/React\/[^/]+\/(.*)$/.exec(url);
    if (rsc) url = rsc[1];
    url = url.replace(/[?#].*$/, '');
    var path = null;
    try {
      if (/^file:\/\//i.test(url)) {
        path = decodeURIComponent(url.replace(/^file:\/\//i, ''));
        if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1);
      } else if (/^webpack-internal:\/\/\//.test(url)) {
        path = url.replace(/^webpack-internal:\/\/\/(\([^)]*\)\/)?/, '').replace(/^\.\//, '');
      } else if (/^webpack:\/\//.test(url)) {
        path = url.replace(/^webpack:\/\/[^/]*\//, '').replace(/^\.\//, '');
      } else if (/^https?:\/\//.test(url)) {
        var u = new URL(url);
        if (u.origin !== location.origin && TARGET_ORIGINS.indexOf(u.origin) < 0) return null;
        path = decodeURIComponent(u.pathname);
        if (path.indexOf('/@fs/') === 0) {
          path = path.slice(4);
          if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1);
        } else {
          path = path.replace(/^\/+/, '');
        }
      }
    } catch (e) {
      return null;
    }
    if (!path || /node_modules|(^|\/)\.vite\/|^@vite|^@react-refresh|^@id\/|(^|\/)_next\/|^__/.test(path)) return null;
    return path;
  }

  /** React 19 keeps the JSX call site only as a captured stack; its line numbers are of transformed code, so file only. */
  function stackSource(err) {
    var stack;
    try { stack = String(err.stack || ''); } catch (e) { return null; }
    var lines = stack.split('\n');
    for (var i = 0; i < lines.length; i++) {
      var m = /((?:https?|file|webpack-internal|webpack|rsc):\/\/\S+?):\d+:\d+\)?\s*$/.exec(lines[i]);
      if (!m) continue;
      var file = urlToFile(m[1]);
      if (file) return { file: file };
    }
    return null;
  }

  function reactFiber(node) {
    var keys = Object.keys(node);
    for (var i = 0; i < keys.length; i++) {
      if (keys[i].indexOf('__reactFiber$') === 0 || keys[i].indexOf('__reactInternalInstance$') === 0) return node[keys[i]];
    }
    return null;
  }

  function reactName(type) {
    if (!type || typeof type === 'string') return null;
    if (typeof type === 'function') return type.displayName || type.name || null;
    if (typeof type === 'object') {
      if (type.displayName) return type.displayName;
      if (type.render) return reactName(type.render); // forwardRef
      if (type.type) return reactName(type.type); // memo
    }
    return null;
  }

  function reactSource(fiber) {
    for (var f = fiber, g = 0; f && g < 15; f = f.return, g++) {
      var ds = f._debugSource; // React <= 18
      if (ds && ds.fileName) return loc(ds.fileName, ds.lineNumber, ds.columnNumber);
      if (f._debugStack) {
        var s = stackSource(f._debugStack); // React 19
        if (s) return s;
      }
    }
    return null;
  }

  function pushName(names, name) {
    if (name && !INTERNAL.test(name) && names[names.length - 1] !== name) names.push(name);
  }

  /** Owners first (who wrote the JSX, including server components in React 19), else the render tree. */
  function reactComponents(fiber) {
    var names = [];
    var owner = fiber._debugOwner;
    for (var g = 0; owner && g < 50 && names.length < 6; g++) {
      pushName(names, typeof owner.tag === 'number' ? reactName(owner.type) : owner.name);
      owner = owner._debugOwner || owner.owner || null;
    }
    if (names.length) return names;
    for (var f = fiber.return, h = 0; f && h < 200 && names.length < 6; f = f.return, h++) pushName(names, reactName(f.type));
    return names;
  }

  function vueInfo(node) {
    var names = [];
    var file = null;
    var inst = node.__vueParentComponent;
    for (var g = 0; inst && g < 30 && names.length < 6; inst = inst.parent, g++) {
      var t = inst.type || {};
      if (!file && t.__file) file = t.__file;
      pushName(names, t.name || t.__name || (t.__file ? baseName(t.__file) : null));
    }
    var vm = !names.length && node.__vue__; // Vue 2
    for (var h = 0; vm && h < 30 && names.length < 6; vm = vm.$parent, h++) {
      var o = vm.$options || {};
      if (!file && o.__file) file = o.__file;
      pushName(names, o.name || o._componentTag || (o.__file ? baseName(o.__file) : null));
    }
    return { source: file ? { file: file } : null, components: names };
  }

  function svelteInfo(meta) {
    var l = meta.loc;
    var source = null;
    if (l && l.file) {
      var zeroBased = 'char' in l; // Svelte 4 records 0-based lines; Svelte 5 1-based. Columns are 0-based in both.
      source = loc(l.file, l.line + (zeroBased ? 1 : 0), l.column + 1);
    }
    var names = [];
    if (l && l.file) pushName(names, baseName(l.file));
    for (var p = meta.parent, g = 0; p && g < 30 && names.length < 6; p = p.parent, g++) {
      if (p.type === 'component') pushName(names, p.componentTag || (p.file ? baseName(p.file) : null));
    }
    return { source: source, components: names };
  }

  function angularComponents(el) {
    var ng = w.ng;
    if (!ng || typeof ng.getOwningComponent !== 'function') return null;
    var names = [];
    var comp = null;
    try { comp = (ng.getComponent && ng.getComponent(el)) || ng.getOwningComponent(el); } catch (e) {}
    for (var g = 0; comp && g < 20 && names.length < 6; g++) {
      pushName(names, comp.constructor && comp.constructor.name ? comp.constructor.name.replace(/^_+/, '') : null);
      var next = null;
      try {
        var hostEl = ng.getHostElement(comp);
        next = hostEl ? ng.getOwningComponent(hostEl) : null;
      } catch (e) {}
      comp = next === comp ? null : next;
    }
    return names;
  }

  function hasKeyPrefix(obj, prefix) {
    try {
      var keys = Object.keys(obj);
      for (var i = 0; i < keys.length; i++) if (keys[i].indexOf(prefix) === 0) return true;
    } catch (e) {}
    return false;
  }

  function pageFramework() {
    if (w.next || w.__NEXT_DATA__ || w.__next_f || doc.getElementById('__next')) return 'next';
    if (w.__NUXT__ || w.useNuxtApp || doc.getElementById('__nuxt')) return 'nuxt';
    if (hasKeyPrefix(w, '__sveltekit')) return 'sveltekit';
    if (w.__remixContext) return 'remix';
    if (w.__reactRouterContext) return 'react-router';
    if (w.___gatsby || doc.getElementById('___gatsby')) return 'gatsby';
    if (doc.querySelector('astro-island,astro-dev-toolbar,[data-astro-source-file],meta[name="generator"][content^="Astro"]')) return 'astro';
    return null;
  }

  function frameworkInfo(el) {
    var source = null;
    var components = null;
    var lib = null;
    for (var node = el, depth = 0; node && node.nodeType === 1 && depth < 12; node = node.parentElement, depth++) {
      if (!source) source = attrSource(node);
      if (!lib) {
        var fiber = reactFiber(node);
        if (fiber) {
          lib = 'react';
          if (!source) source = reactSource(fiber);
          components = reactComponents(fiber);
        } else if (node.__vueParentComponent || node.__vue__) {
          lib = 'vue';
          var vue = vueInfo(node);
          if (!source) source = vue.source;
          components = vue.components;
        } else if (node.__svelte_meta) {
          lib = 'svelte';
          var svelte = svelteInfo(node.__svelte_meta);
          if (!source) source = svelte.source;
          components = svelte.components;
        }
      }
      if (source && lib) break;
    }
    if (!lib && (w.ng || doc.querySelector('[ng-version]'))) {
      lib = 'angular';
      components = angularComponents(el);
    }
    var page = pageFramework();
    var framework = page === 'astro' && lib ? 'astro+' + lib : page || lib || (doc.querySelector('script[src*="/@vite/client"]') ? 'vite' : null);
    return { source: source, components: components, framework: framework };
  }
})();
`;
