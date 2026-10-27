/**
 * A small Markdown parser for agent replies: headings, paragraphs, lists, quotes, fenced code,
 * tables, rules and inline emphasis, code and links. It returns a tree that React renders, so no
 * HTML string is ever injected. Replies stream in, so unclosed syntax stays literal text and an
 * unclosed code fence runs to the end.
 */

export type Inline =
  | { type: 'text'; text: string }
  | { type: 'code'; text: string }
  | { type: 'strong' | 'em' | 'del'; children: Inline[] }
  | { type: 'link'; href: string; children: Inline[] }
  | { type: 'br' };

export type Align = 'left' | 'center' | 'right' | null;

export type Block =
  | { type: 'paragraph'; children: Inline[] }
  | { type: 'heading'; level: number; children: Inline[] }
  | { type: 'code'; lang: string; text: string }
  | { type: 'quote'; children: Block[] }
  | { type: 'list'; ordered: boolean; start: number; items: Block[][] }
  | { type: 'table'; align: Align[]; head: Inline[][]; rows: Inline[][][] }
  | { type: 'hr' };

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)/;
const HEADING = /^ {0,3}(#{1,6})(?:\s+(.*?))?(?:\s+#+)?\s*$/;
const HR = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^ {0,3}> ?/;
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])(?:\s+(.*))?$/;
const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

const indentOf = (line: string) => line.length - line.trimStart().length;
/** Line `i`, or '' past either end. */
const at = (lines: string[], i: number) => lines[i] ?? '';

export function parseMarkdown(src: string): Block[] {
  return parseBlocks(src.replace(/\r\n?/g, '\n').split('\n'));
}

function listItem(line: string) {
  const match = ITEM.exec(line);
  if (!match) return null;
  const [, lead = '', marker = '', text = ''] = match;
  return { indent: lead.length, ordered: /\d/.test(marker), marker, text, contentIndent: lead.length + marker.length + 1 };
}

function isTableStart(lines: string[], i: number): boolean {
  const next = at(lines, i + 1);
  return at(lines, i).includes('|') && next.includes('|') && TABLE_SEP.test(next);
}

function startsBlock(lines: string[], i: number): boolean {
  const line = at(lines, i);
  return FENCE.test(line) || HEADING.test(line) || HR.test(line) || QUOTE.test(line) || ITEM.test(line) || isTableStart(lines, i);
}

function parseBlocks(lines: string[]): Block[] {
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = at(lines, i);
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const [, marker = '', lang = ''] = fence;
      const close = new RegExp(`^ {0,3}${marker.charAt(0)}{${marker.length},}\\s*$`);
      const body: string[] = [];
      for (i++; i < lines.length && !close.test(at(lines, i)); i++) body.push(at(lines, i));
      i++;
      out.push({ type: 'code', lang, text: body.join('\n') });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      const [, hashes = '', title = ''] = heading;
      out.push({ type: 'heading', level: hashes.length, children: parseInline(title) });
      i++;
      continue;
    }
    if (HR.test(line)) {
      out.push({ type: 'hr' });
      i++;
      continue;
    }
    if (QUOTE.test(line)) {
      const body: string[] = [];
      for (; i < lines.length && QUOTE.test(at(lines, i)); i++) body.push(at(lines, i).replace(QUOTE, ''));
      out.push({ type: 'quote', children: parseBlocks(body) });
      continue;
    }
    if (ITEM.test(line)) {
      i = parseList(lines, i, out);
      continue;
    }
    if (isTableStart(lines, i)) {
      i = parseTable(lines, i, out);
      continue;
    }
    const para: string[] = [line.trim()];
    for (i++; i < lines.length && at(lines, i).trim() && !startsBlock(lines, i); i++) para.push(at(lines, i).trim());
    out.push({ type: 'paragraph', children: parseInline(para.join('\n')) });
  }
  return out;
}

/** Reads one list starting at `lines[i]` into `out` and returns the index after it. */
function parseList(lines: string[], i: number, out: Block[]): number {
  const first = listItem(at(lines, i))!;
  const items: string[][] = [];
  let current: string[] = [];
  let contentIndent = 0;
  while (i < lines.length) {
    const line = at(lines, i);
    const item = listItem(line);
    if (item && item.indent <= first.indent + 1 && item.ordered === first.ordered) {
      if (item.indent < first.indent) break;
      current = [item.text];
      items.push(current);
      contentIndent = item.contentIndent;
      i++;
      continue;
    }
    if (!line.trim()) {
      // A blank line ends the list unless more of it (an indented line or a sibling item) follows.
      let j = i + 1;
      while (j < lines.length && !at(lines, j).trim()) j++;
      const next = listItem(at(lines, j));
      const continues =
        j < lines.length && (indentOf(at(lines, j)) > first.indent + 1 || (next !== null && next.indent === first.indent && next.ordered === first.ordered));
      if (!continues) break;
      current.push('');
      i++;
      continue;
    }
    if (indentOf(line) > first.indent + 1) {
      current.push(line.slice(Math.min(contentIndent, indentOf(line))));
      i++;
      continue;
    }
    // A plain line right under an item's text continues that item's paragraph.
    if (!item && at(lines, i - 1).trim() && !startsBlock(lines, i)) {
      current.push(line.trim());
      i++;
      continue;
    }
    break;
  }
  out.push({ type: 'list', ordered: first.ordered, start: first.ordered ? parseInt(first.marker, 10) : 1, items: items.map(parseBlocks) });
  return i;
}

function splitRow(line: string): string[] {
  let row = line.trim();
  if (row.startsWith('|')) row = row.slice(1);
  if (row.endsWith('|') && !row.endsWith('\\|')) row = row.slice(0, -1);
  return row.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, '|'));
}

function parseTable(lines: string[], i: number, out: Block[]): number {
  const head = splitRow(at(lines, i));
  const align = splitRow(at(lines, i + 1)).map((cell): Align => {
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    return left && right ? 'center' : right ? 'right' : left ? 'left' : null;
  });
  const rows: Inline[][][] = [];
  for (i += 2; i < lines.length && at(lines, i).trim() && at(lines, i).includes('|'); i++) {
    const cells = splitRow(at(lines, i));
    rows.push(head.map((_, c) => parseInline(cells[c] ?? '')));
  }
  out.push({ type: 'table', align: head.map((_, c) => align[c] ?? null), head: head.map((cell) => parseInline(cell)), rows });
  return i;
}

const PUNCT = /[\s\p{P}\p{S}]/u;
const WORD = /[\p{L}\p{N}]/u;
const URL = /^https?:\/\/[^\s<>]+/;

/** Finds the closing `marker` for an opener ending at `from`, skipping code spans. */
function findClose(s: string, from: number, marker: string): number {
  const c = marker.charAt(0);
  const n = marker.length;
  for (let j = from; j < s.length; j++) {
    const ch = s.charAt(j);
    if (ch === '\\') {
      j++;
      continue;
    }
    if (ch === '`') {
      const run = /^`+/.exec(s.slice(j))![0];
      const end = s.indexOf(run, j + run.length);
      j = end === -1 ? j + run.length - 1 : end + run.length - 1;
      continue;
    }
    if (ch !== c) continue;
    let run = 1;
    while (s.charAt(j + run) === c) run++;
    const end = j + run;
    // A closer follows text, a lone `*` doesn't close on a `**`, and `_` doesn't close inside a word.
    if (j > from && !/\s/.test(s.charAt(j - 1)) && run >= n && !(n === 1 && run === 2) && (c !== '_' || !WORD.test(s.charAt(end)))) return end - n;
    j = end - 1;
  }
  return -1;
}

function trimUrl(url: string): string {
  // Leave trailing punctuation (and an unbalanced closing paren) outside the link.
  let end = url.length;
  while (end > 0 && /[.,;:!?'"*_~]/.test(url.charAt(end - 1))) end--;
  url = url.slice(0, end);
  while (url.endsWith(')') && (url.match(/\(/g)?.length ?? 0) < (url.match(/\)/g)?.length ?? 0)) url = url.slice(0, -1);
  return url;
}

export function parseInline(s: string): Inline[] {
  const out: Inline[] = [];
  let text = '';
  const push = (node: Inline) => {
    if (text) out.push({ type: 'text', text });
    text = '';
    out.push(node);
  };
  let i = 0;
  while (i < s.length) {
    const ch = s.charAt(i);
    if (ch === '\\' && /[\p{P}\p{S}]/u.test(s.charAt(i + 1))) {
      text += s.charAt(i + 1);
      i += 2;
      continue;
    }
    if (ch === '\n') {
      push({ type: 'br' });
      i++;
      continue;
    }
    if (ch === '`') {
      const run = /^`+/.exec(s.slice(i))![0];
      const end = s.indexOf(run, i + run.length);
      if (end !== -1) {
        const code = s.slice(i + run.length, end);
        push({ type: 'code', text: /^ .*[^ ].* $/.test(code) ? code.slice(1, -1) : code });
        i = end + run.length;
        continue;
      }
      text += run;
      i += run.length;
      continue;
    }
    if (ch === '*' || ch === '_' || ch === '~') {
      const run = (ch === '~' ? /^~+/ : ch === '*' ? /^\*+/ : /^_+/).exec(s.slice(i))![0];
      const size = ch === '~' ? 2 : Math.min(run.length, 3);
      const marker = ch.repeat(size);
      const opens =
        run.length >= size &&
        (ch !== '~' || run.length === 2) &&
        i + size < s.length &&
        !/\s/.test(s.charAt(i + size)) &&
        (ch !== '_' || i === 0 || PUNCT.test(s.charAt(i - 1)));
      const close = opens ? findClose(s, i + size, marker) : -1;
      if (close !== -1) {
        const children = parseInline(s.slice(i + size, close));
        push(
          ch === '~'
            ? { type: 'del', children }
            : size === 3
              ? { type: 'strong', children: [{ type: 'em', children }] }
              : { type: size === 2 ? 'strong' : 'em', children },
        );
        i = close + size;
        continue;
      }
      text += run;
      i += run.length;
      continue;
    }
    if (ch === '[') {
      const link = parseLink(s, i);
      if (link) {
        push({ type: 'link', href: link.href, children: parseInline(link.label) });
        i = link.end;
        continue;
      }
    }
    if (ch === 'h' && (i === 0 || !WORD.test(s.charAt(i - 1)))) {
      const match = URL.exec(s.slice(i));
      if (match) {
        const url = trimUrl(match[0]);
        if (url.length > 'https://'.length) {
          push({ type: 'link', href: url, children: [{ type: 'text', text: url }] });
          i += url.length;
          continue;
        }
      }
    }
    text += ch;
    i++;
  }
  if (text) out.push({ type: 'text', text });
  return out;
}

/** `[label](href)` starting at `s[i]`, or null when it isn't a complete link. */
function parseLink(s: string, i: number): { label: string; href: string; end: number } | null {
  let depth = 0;
  let j = i;
  for (; j < s.length; j++) {
    const ch = s.charAt(j);
    if (ch === '\\') j++;
    else if (ch === '[') depth++;
    else if (ch === ']' && --depth === 0) break;
  }
  if (j >= s.length || s.charAt(j + 1) !== '(') return null;
  const close = s.indexOf(')', j + 2);
  if (close === -1) return null;
  const href = s.slice(j + 2, close).trim().split(/\s+/)[0] ?? '';
  if (!href) return null;
  return { label: s.slice(i + 1, j), href, end: close + 1 };
}

/** Links open only to the web or email; anything else (javascript:, data:, relative) renders as text. */
export function safeHref(href: string): string | null {
  return /^(https?:\/\/|mailto:)/i.test(href) ? href : null;
}
