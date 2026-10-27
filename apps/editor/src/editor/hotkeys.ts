/**
 * Key binding notation, matching and display. Pure (no DOM at import time), so it is unit-tested.
 *
 * Notation: modifiers and one key joined by `+`, e.g. `Mod+Shift+Z`, `Alt+[`, `Shift+1`, `Space`.
 * `Mod` is Ctrl on Windows/Linux and ⌘ on macOS; `Ctrl` is always the Control key.
 * Letters follow the keyboard layout (e.key, falling back to the physical key when Alt/⌥ or a
 * non-Latin layout changes the character); digits and punctuation use the physical key (e.code),
 * so `Shift+1` works although it types `!`. A lone modifier (`Alt`) is a valid binding.
 */

export type Modifier = 'Mod' | 'Ctrl' | 'Meta' | 'Alt' | 'Shift';

export interface KeyLike {
  key: string;
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

export interface Binding {
  ctrl: boolean;
  meta: boolean;
  alt: boolean;
  shift: boolean;
  key: string;
}

export function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  return /mac|iphone|ipad/i.test(nav.userAgentData?.platform || navigator.platform || navigator.userAgent);
}

const CODE_KEYS: Record<string, string> = {
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Period: '.',
  Comma: ',',
  Slash: '/',
  Equal: '=',
  Minus: '-',
  Quote: "'",
  Semicolon: ';',
  Backquote: '`',
  NumpadAdd: '+',
  NumpadSubtract: '-',
  Space: 'Space',
};

const MODIFIER_KEYS: Record<string, Modifier> = { Alt: 'Alt', Shift: 'Shift', Control: 'Ctrl', Meta: 'Meta' };

const ALIASES: Record<string, string> = { Esc: 'Escape', Del: 'Delete', Return: 'Enter', Up: 'ArrowUp', Down: 'ArrowDown', Left: 'ArrowLeft', Right: 'ArrowRight' };

/** Parse `Mod+Shift+Z` style notation. `Mod` resolves per platform. */
export function parseBinding(text: string, mac = false): Binding {
  let rest = text.trim();
  let key = '';
  if (rest === '+' || rest.endsWith('++')) {
    key = '+';
    rest = rest.slice(0, -1).replace(/\+$/, '');
  }
  const parts = rest ? rest.split('+') : [];
  if (!key) key = parts.pop() ?? '';
  const b: Binding = { ctrl: false, meta: false, alt: false, shift: false, key: '' };
  for (const raw of parts) {
    const m = raw.trim().toLowerCase();
    if (m === 'mod') {
      if (mac) b.meta = true;
      else b.ctrl = true;
    } else if (m === 'ctrl' || m === 'control') b.ctrl = true;
    else if (m === 'meta' || m === 'cmd') b.meta = true;
    else if (m === 'alt' || m === 'option') b.alt = true;
    else if (m === 'shift') b.shift = true;
    else throw new Error(`Unknown modifier "${raw}" in "${text}"`);
  }
  key = ALIASES[key] ?? key;
  b.key = key.length === 1 ? key.toLowerCase() : key === 'Control' ? 'Ctrl' : key;
  return b;
}

/** Key tokens an event can stand for (physical and typed). */
export function eventKeys(e: KeyLike): string[] {
  const keys: string[] = [];
  const typed = e.key ?? '';
  if (/^[a-z]$/i.test(typed)) keys.push(typed.toLowerCase());
  else {
    const letter = /^Key([A-Z])$/.exec(e.code);
    if (letter) keys.push(letter[1]!.toLowerCase());
  }
  const digit = /^(?:Digit|Numpad)(\d)$/.exec(e.code);
  if (digit) keys.push(digit[1]!);
  const punct = CODE_KEYS[e.code];
  if (punct) keys.push(punct);
  if (MODIFIER_KEYS[typed]) keys.push(MODIFIER_KEYS[typed]!);
  else if (typed === 'AltGraph') keys.push('Alt');
  else if (typed.length > 1) keys.push(typed);
  else if (typed && typed !== ' ' && !keys.includes(typed)) keys.push(typed);
  return keys;
}

/**
 * Does the event trigger the binding? Modifiers must match exactly, except `tolerate`d ones,
 * which may be held or not. `+` tolerates Shift (it is Shift+= on most layouts).
 */
const parsed = new Map<string, Binding>();

export function matchBinding(binding: string | Binding, e: KeyLike, mac = false, tolerate: readonly Modifier[] = []): boolean {
  let b: Binding;
  if (typeof binding === 'string') {
    const cacheKey = `${mac ? 'm' : 'w'}${binding}`;
    b = parsed.get(cacheKey) ?? parseBinding(binding, mac);
    parsed.set(cacheKey, b);
  } else b = binding;
  if (!eventKeys(e).includes(b.key)) return false;
  const lone = b.key === 'Alt' || b.key === 'Shift' || b.key === 'Ctrl' || b.key === 'Meta';
  const tol = new Set<string>(tolerate.flatMap((m) => (m === 'Mod' ? [mac ? 'Meta' : 'Ctrl'] : [m])));
  if (b.key === '+') tol.add('Shift');
  if (lone) tol.add(b.key);
  const same = (want: boolean, has: boolean, name: string) => want === has || tol.has(name);
  return same(b.ctrl, e.ctrlKey, 'Ctrl') && same(b.meta, e.metaKey, 'Meta') && same(b.alt, e.altKey, 'Alt') && same(b.shift, e.shiftKey, 'Shift');
}

const MAC_GLYPHS: Record<string, string> = { Ctrl: '⌃', Meta: '⌘', Alt: '⌥', Shift: '⇧' };
const KEY_NAMES: Record<string, string> = {
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Escape: 'Esc',
  Delete: 'Del',
  PageUp: 'PgUp',
  PageDown: 'PgDn',
};

/**
 * Key caps for display, e.g. `Mod+Shift+Z` → ['Ctrl', 'Shift', 'Z'] (or ['⌘', '⇧', 'Z'] on macOS).
 * Words that are not keys (Drag, Click, Scroll…) pass through, so gestures can share the notation.
 */
export function formatBinding(text: string, mac = false): string[] {
  const tokens = text === '+' ? ['+'] : text.endsWith('++') ? [...text.slice(0, -2).split('+'), '+'] : text.split('+');
  return tokens.map((t) => {
    const lower = t.toLowerCase();
    if (lower === 'mod') return mac ? '⌘' : 'Ctrl';
    if (lower === 'ctrl') return mac ? '⌃' : 'Ctrl';
    if (lower === 'meta' || lower === 'cmd') return mac ? '⌘' : 'Win';
    if (lower === 'alt') return mac ? MAC_GLYPHS.Alt! : 'Alt';
    if (lower === 'shift') return mac ? MAC_GLYPHS.Shift! : 'Shift';
    const key = ALIASES[t] ?? t;
    if (mac && key === 'Backspace') return '⌫';
    if (mac && key === 'Enter') return '↩';
    return KEY_NAMES[key] ?? (key.length === 1 ? key.toUpperCase() : key);
  });
}

/** Display string, e.g. "Ctrl+Shift+Z" or "⌘⇧Z". */
export function bindingLabel(text: string, mac = false): string {
  return formatBinding(text, mac).join(mac ? '' : '+');
}
