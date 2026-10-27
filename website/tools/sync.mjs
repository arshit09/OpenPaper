// Stamps the shared icon sprite, header and footer (website/partials) into every page, between marker comments:
//   <!-- @icons --> … <!-- /@icons -->, <!-- @header --> … <!-- /@header -->, <!-- @footer --> … <!-- /@footer -->
// Pages stay plain static HTML; run `node website/tools/sync.mjs` after editing a partial.
// Pass file names to sync only those pages. The nav link matching <body data-nav="…"> gets aria-current="page".
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const site = join(dirname(fileURLToPath(import.meta.url)), '..');
const partial = (name) => readFileSync(join(site, 'partials', name), 'utf8').trim();
const parts = { icons: partial('icons.svg'), header: partial('header.html'), footer: partial('footer.html') };

let changed = 0;
const only = process.argv.slice(2);
const pages = only.length ? only : readdirSync(site).filter((f) => f.endsWith('.html'));
for (const file of pages) {
  const path = join(site, file);
  const before = readFileSync(path, 'utf8');
  const nav = before.match(/<body[^>]*\sdata-nav="([^"]+)"/)?.[1];
  let html = before;
  for (const [name, content] of Object.entries(parts)) {
    const re = new RegExp(`([ \\t]*)<!-- @${name} -->[\\s\\S]*?<!-- /@${name} -->`);
    html = html.replace(re, (_, indent) => {
      let body = content;
      if (name === 'header' && nav) body = body.replaceAll(`data-nav="${nav}"`, `data-nav="${nav}" aria-current="page"`);
      const indented = body.split('\n').map((l) => (l ? indent + l : l)).join('\n');
      return `${indent}<!-- @${name} -->\n${indented}\n${indent}<!-- /@${name} -->`;
    });
  }
  if (html !== before) {
    writeFileSync(path, html);
    changed++;
  }
}
console.log(`sync: updated ${changed} page(s)`);
