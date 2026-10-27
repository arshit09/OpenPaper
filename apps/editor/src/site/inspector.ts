import type { SiteElementInfo } from '@openpaper/core';

/**
 * postMessage protocol with the inspector the site proxy injects into the user's pages.
 * Messages to it carry `source: 'openpaper'`; its replies carry `source: 'openpaper-inspector'`.
 */
export type ToInspector =
  | { type: 'hello' }
  | { type: 'mode'; inspect: boolean }
  | { type: 'clear' }
  | { type: 'select-parent' }
  | { type: 'working'; active: boolean }
  | { type: 'reload' };

export interface InspectorRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * `url` is the page's address on the dev server; `proxyUrl` is what the frame loaded. `selection` is re-sent with
 * fresh info when HMR replaces a selected node or a reload restores the selection. `unreachable` comes from the
 * proxy's "dev server is down" page, which retries by itself.
 */
export type FromInspector =
  | { type: 'ready'; url: string; proxyUrl: string; title: string }
  | { type: 'location'; url: string; proxyUrl: string; title: string }
  | { type: 'selection'; elements: SiteElementInfo[] }
  | { type: 'rects'; rects: InspectorRect[] }
  | { type: 'mode'; inspect: boolean }
  | { type: 'unreachable'; url: string; proxyUrl: string };

export function isInspectorMessage(data: unknown): data is FromInspector & { source: 'openpaper-inspector' } {
  return !!data && typeof data === 'object' && (data as { source?: unknown }).source === 'openpaper-inspector' && typeof (data as { type?: unknown }).type === 'string';
}

const NOUNS: Record<string, string> = {
  a: 'link',
  button: 'button',
  img: 'image',
  svg: 'icon',
  p: 'paragraph',
  li: 'list item',
  input: 'field',
  textarea: 'text field',
  select: 'dropdown',
  label: 'label',
  nav: 'navigation',
  header: 'header',
  footer: 'footer',
  section: 'section',
  form: 'form',
};

/** What to call an element in a sentence: “link”, “heading”, or its tag. */
function noun(tag: string): string {
  return NOUNS[tag] ?? (/^h[1-6]$/.test(tag) ? 'heading' : tag);
}

/** Chat label for clicked elements, said the way a person would: `“Get started” link`, `<PricingCard>`, `div.hero`. */
export function elementLabel(elements: SiteElementInfo[]): string {
  if (elements.length !== 1) return `${elements.length} elements`;
  const el = elements[0]!;
  const text = el.text.replace(/\s+/g, ' ').trim();
  if (text && text.length <= 24) return `“${text}” ${noun(el.tag)}`;
  if (el.components?.[0]) return `<${el.components[0]}>`;
  if (el.id) return `${el.tag}#${el.id}`;
  if (el.classes[0]) return `${el.tag}.${el.classes[0]}`;
  return text ? `“${text.slice(0, 20)}…” ${noun(el.tag)}` : noun(el.tag);
}

/**
 * The proxy listens on 127.0.0.1; when the editor itself is open as `localhost`, frame it under that name too,
 * so the site stays same-site with the editor and its cookies aren't treated as third-party.
 */
export function sameSiteProxyUrl(proxyUrl: string, editorHostname: string): string {
  const url = new URL(proxyUrl);
  if (editorHostname === 'localhost') url.hostname = 'localhost';
  return url.href;
}

/** Map a URL between two origins (proxy ⇄ site), keeping path, query and hash. */
export function rebase(url: string, from: string, to: string): string {
  try {
    const u = new URL(url);
    const f = new URL(from);
    if (u.origin !== f.origin) return url;
    return new URL(`${u.pathname}${u.search}${u.hash}`, new URL(to).origin).href;
  } catch {
    return url;
  }
}

/** Normalize what people paste: `localhost:3000` → `http://localhost:3000/`. Null when it isn't a web address. */
export function normalizeSiteUrl(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  try {
    const url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}
