/**
 * Id helpers.
 *
 * Ids follow Paper's visible formats so agents that know Paper feel at home:
 *   node        `<counter>-<client>` in upper-case base-36, e.g. `1-0`, `2F-0`
 *   page        `p-<counter>-<client>`, e.g. `p-1-0`
 *   page root   `root_node_<pageId>`
 * The OpenPaper server is the only writer, so the client index is always 0.
 */

export const CLIENT_INDEX = 0;

export function formatNodeId(counter: number, client = CLIENT_INDEX): string {
  return `${counter.toString(36).toUpperCase()}-${client.toString(36).toUpperCase()}`;
}

export function formatPageId(counter: number, client = CLIENT_INDEX): string {
  return `p-${counter.toString(36)}-${client.toString(36)}`;
}

export function pageRootIdFor(pageId: string): string {
  return `root_node_${pageId}`;
}

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/** Random id from a URL-safe alphabet (crypto-strength when available). */
export function randomId(length = 12): string {
  const bytes = new Uint8Array(length);
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.getRandomValues) c.getRandomValues(bytes);
  else for (let i = 0; i < length; i++) bytes[i] = Math.floor(Math.random() * 256);
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[bytes[i]! % ALPHABET.length];
  return out;
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** 26-char ULID (48-bit time + 80-bit randomness, Crockford base32) — Paper's file id shape. */
export function ulid(now = Date.now()): string {
  let time = '';
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const bytes = new Uint8Array(16);
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.getRandomValues) c.getRandomValues(bytes);
  else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  let rand = '';
  for (let i = 0; i < 16; i++) rand += CROCKFORD[bytes[i]! % 32];
  return time + rand;
}

export const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export const newFileId = () => ulid();
export const newThreadId = () => ulid();
export const newMessageId = () => ulid();

/**
 * Parse a file id from a bare id, a `/file/<id>[/<pageId>]` route or a full URL.
 * Returns null when no valid id is found.
 */
export function parseFileReference(raw: unknown): { fileId: string; pageId: string | null } | null {
  if (typeof raw !== 'string') return null;
  let s = raw.trim();
  if (!s) return null;
  if (s.includes('://')) {
    try {
      const url = new URL(s);
      // Editor URLs keep the route in the hash: http://127.0.0.1:29880/#/file/<id>/<page>
      s = url.hash.startsWith('#/') ? url.hash.slice(1) : url.pathname;
    } catch {
      return null;
    }
  } else {
    s = s.split(/[?#]/)[0]!;
  }
  const segments = s.split('/').filter(Boolean);
  const fileIdx = segments.indexOf('file');
  const fileId = fileIdx >= 0 ? segments[fileIdx + 1] : segments[0];
  if (!fileId || !ULID_RE.test(fileId)) return null;
  let pageId: string | null = null;
  const rawPage = fileIdx >= 0 ? segments[fileIdx + 2] : undefined;
  if (rawPage) {
    try {
      pageId = decodeURIComponent(rawPage) || null;
    } catch {
      pageId = rawPage;
    }
  }
  return { fileId, pageId };
}
