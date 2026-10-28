import { describe, expect, it } from 'vitest';
import {
  animationNames,
  keyframesCss,
  keyframesFromCss,
  mergeKeyframes,
  normalizeKeyframesBody,
  parseKeyframesInput,
  renameAnimationValue,
  renameSvgAnimations,
} from './keyframes.ts';
import { mediaMatches } from '../html/stylesheet.ts';
import { collectMediaUrls, importHtml } from '../html/import.ts';
import { insertImported } from '../editing/insert.ts';
import { nodesToHtml } from '../export/html.ts';
import { createDocument } from '../model/document.ts';
import { readerOf, Transaction } from '../model/transaction.ts';
import { renderDocumentHtml } from '../render/to-html.ts';
import { identityUrls } from '../render/render-spec.ts';

describe('keyframes', () => {
  it('normalizes a body and refuses anything that could escape it', () => {
    expect(normalizeKeyframesBody(' from { opacity: 0; transform: translateY(8px) } 50%,75% {opacity:.5} to { opacity: 1 } ')).toBe(
      'from{opacity: 0; transform: translateY(8px);} 50%, 75%{opacity: .5;} to{opacity: 1;}'
    );
    expect(() => normalizeKeyframesBody('body { display: none }')).toThrow(/keyframe selector/);
    expect(() => normalizeKeyframesBody('')).toThrow();
    // A value can't close the block or the <style> element.
    expect(() => normalizeKeyframesBody('to { color: red } } * { display: none }')).toThrow(/keyframe selector/);
    expect(normalizeKeyframesBody('to { background: url("x</style>") }')).toBe('to{}');
  });

  it('reads @keyframes from a sheet, prefixed twins and @media included', () => {
    const css = `@-webkit-keyframes pop{to{transform:scale(1.1)}}
      @keyframes pop{from{transform:scale(1)}to{transform:scale(1.2)}}
      @media (prefers-reduced-motion: no-preference){@keyframes spin{to{rotate:360deg}}}
      @keyframes op-pulse{to{opacity:0}}
      .a{color:red}`;
    const out = keyframesFromCss(css);
    expect(out.map((k) => k.name)).toEqual(['pop', 'spin', 'design-op-pulse']);
    expect(out[0]!.css).toBe('from{transform: scale(1);} to{transform: scale(1.2);}');
    expect(keyframesCss(out)).toContain('@keyframes spin{to{rotate: 360deg;}}');
  });

  it('finds and renames animation names in shorthands', () => {
    expect(animationNames('animation', 'fadeUp 0.6s cubic-bezier(.2,.8,.2,1) 0.1s both, spin 1s linear infinite')).toEqual(['fadeUp', 'spin']);
    expect(animationNames('animation', '1s ease-in-out infinite alternate float')).toEqual(['float']);
    expect(animationNames('animationName', 'a, b')).toEqual(['a', 'b']);
    expect(animationNames('animation', 'none')).toEqual([]);
    const renames = new Map([['fadeUp', 'fadeUp-2']]);
    expect(renameAnimationValue('animation', 'fadeUp 0.6s both, spin 1s', renames)).toBe('fadeUp-2 0.6s both, spin 1s');
    expect(renameSvgAnimations('<g style="animation: fadeUp 1s infinite; opacity: 1"/>', renames)).toBe('<g style="animation: fadeUp-2 1s infinite; opacity: 1"/>');
  });

  it('merges: replace redefines, rename keeps the file’s own', () => {
    const existing = [{ name: 'fade', css: 'to{opacity: 1;}' }];
    const incoming = [
      { name: 'fade', css: 'to{opacity: 0.5;}' },
      { name: 'spin', css: 'to{rotate: 1turn;}' },
    ];
    expect(mergeKeyframes(existing, incoming, 'replace').keyframes).toEqual(incoming);
    const renamed = mergeKeyframes(existing, incoming, 'rename');
    expect(renamed.keyframes.map((k) => k.name)).toEqual(['fade', 'fade-2', 'spin']);
    expect(renamed.renames.get('fade')).toBe('fade-2');
    expect(mergeKeyframes(existing, [existing[0]!], 'rename').changed).toBe(false);
    // Pasting the same layers again reuses the name they got the first time.
    const again = mergeKeyframes(renamed.keyframes, incoming, 'rename');
    expect(again.changed).toBe(false);
    expect(again.renames.get('fade')).toBe('fade-2');
  });

  it('parses tool input with or without the @keyframes wrapper', () => {
    expect(parseKeyframesInput('fade', '@keyframes fade { from { opacity: 0 } to { opacity: 1 } }').css).toBe('from{opacity: 0;} to{opacity: 1;}');
    expect(parseKeyframesInput('fade', 'to { opacity: 1 }').name).toBe('fade');
    expect(() => parseKeyframesInput('none', 'to{opacity:1}')).toThrow();
  });
});

describe('stylesheets on import', () => {
  it('resolves rules by specificity, order, !important and var()', () => {
    const { roots, keyframes } = importHtml(`
      <style>
        :root { --brand: rgb(255, 0, 0); }
        .card { padding: 8px; background: var(--brand); animation: rise .5s ease-out both; }
        div.card { padding: 12px; }
        .card:hover { padding: 99px; }
        .card::before { content: "x"; }
        #hero { color: blue !important; }
        @media (max-width: 600px) { .card { padding: 1px; } }
        @keyframes rise { from { opacity: 0; transform: translateY(16px) } to { opacity: 1; transform: none } }
      </style>
      <div class="card" style="padding: 10px; width: 200px"><p id="hero" style="color: green">Hello</p></div>`);
    const card = roots[0]!;
    expect(card.styles.padding).toBe('10px'); // inline beats both rules
    expect(card.styles.backgroundColor ?? card.styles.background).toBe('rgb(255, 0, 0)');
    expect(card.styles.animation).toBe('rise .5s ease-out both');
    expect(card.children[0]!.styles.color).toBe('blue');
    expect(keyframes).toEqual([{ name: 'rise', css: 'from{opacity: 0; transform: translateY(16px);} to{opacity: 1; transform: none;}' }]);
  });

  it('keeps inline-only HTML exactly as before (tokens stay var())', () => {
    const { roots, keyframes } = importHtml('<div style="color: var(--color-primary); width: 10px; animation: spin 1s linear infinite">Hi</div>');
    expect(roots[0]!.styles.color).toBe('var(--color-primary)');
    expect(roots[0]!.styles.animation).toBe('spin 1s linear infinite');
    expect(keyframes).toEqual([]);
  });

  it('inherits typography from body rules', () => {
    const { roots } = importHtml('<style>body { font-family: Inter; color: rgb(1, 2, 3) }</style><p>Text</p>');
    expect(roots[0]!.styles.fontFamily).toBe('Inter');
    expect(roots[0]!.styles.color).toBe('rgb(1, 2, 3)');
  });

  it('evaluates media queries for a desktop screen', () => {
    expect(mediaMatches('screen and (min-width: 768px)')).toBe(true);
    expect(mediaMatches('(max-width: 640px)')).toBe(false);
    expect(mediaMatches('print')).toBe(false);
    expect(mediaMatches('(prefers-reduced-motion: reduce)')).toBe(false);
  });

  it('hoists keyframes from an SVG’s own sheet', () => {
    const { roots, keyframes } = importHtml(
      '<svg viewBox="0 0 10 10"><style>@keyframes turn{to{transform:rotate(360deg)}} .r{animation:turn 2s linear infinite;transform-origin:center}</style><rect class="r" width="5" height="5"/></svg>'
    );
    expect(keyframes.map((k) => k.name)).toEqual(['turn']);
    expect(roots[0]!.svg).toContain('animation:turn 2s linear infinite');
    expect(roots[0]!.svg).not.toContain('<style');
  });

  it('renames animations that use the editor’s own namespace', () => {
    const { roots, keyframes } = importHtml('<style>@keyframes op-glow{to{opacity:.5}}</style><div style="width:4px;height:4px;animation: op-glow 1s infinite"></div>');
    expect(keyframes[0]!.name).toBe('design-op-glow');
    expect(roots[0]!.styles.animation).toBe('design-op-glow 1s infinite');
  });
});

describe('media and embed layers', () => {
  it('imports video, lottie and embeds', () => {
    const { roots } = importHtml(
      `<div style="display:flex">
        <video autoplay muted loop playsinline width="320" height="180"><source src="https://x.test/a.mp4" type="video/mp4"></video>
        <lottie-player src="https://x.test/a.json" speed="2" loop="false" style="width:120px;height:120px"></lottie-player>
        <x-embed layer-name="Particles" style="width:300px;height:200px"><canvas id="c"></canvas><script>let a = 1 < 2;</script></x-embed>
        <iframe src="https://player.example/v/1" width="560" height="315"></iframe>
        <iframe src="javascript:alert(1)"></iframe>
      </div>`,
      { resolveMedia: (u) => ({ url: u.replace('https://x.test/', '/media/') }) }
    );
    const kids = roots[0]!.children;
    expect(kids.map((k) => k.component)).toEqual(['Video', 'Lottie', 'Embed', 'Embed']);
    expect(kids[0]).toMatchObject({ src: '/media/a.mp4', styles: { width: '320px', height: '180px' } });
    expect(kids[1]).toMatchObject({ src: '/media/a.json', attrs: { speed: '2', loop: 'false' } });
    expect(kids[2]!.label).toBe('Particles');
    expect(kids[2]!.html).toBe('<canvas id="c"></canvas><script>let a = 1 < 2;</script>');
    expect(kids[3]).toMatchObject({ src: 'https://player.example/v/1', styles: { width: '560px', height: '315px' } });
  });

  it('collects media urls but not images or embed contents', () => {
    expect(
      collectMediaUrls('<video><source src="a.webm"></video><x-lottie src="b.json"></x-lottie><x-embed><video src="c.mp4"></video></x-embed><img src="d.png">')
    ).toEqual(['a.webm', 'b.json']);
  });
});

describe('keyframes in a file', () => {
  it('merges on insert, travels with copies and renders in static documents', () => {
    const doc = createDocument();
    const rootId = Object.values(doc.pages)[0]!.rootId;
    const tx = new Transaction(doc);
    tx.setKeyframes([{ name: 'rise', css: 'to{opacity: 0.2;}' }]);
    const imported = importHtml('<style>@keyframes rise{from{opacity:0}to{opacity:1}}</style><div style="width:10px;height:10px;animation:rise 1s both"></div>');
    const { topLevelIds } = insertImported(tx, imported.roots, rootId, 'insert-children', { keyframes: { list: imported.keyframes, mode: 'rename' } });
    const { doc: next } = tx.commit();
    const reader = readerOf(next);
    expect(next.keyframes!.map((k) => k.name)).toEqual(['rise', 'rise-2']);
    expect(next.nodes[topLevelIds[0]!]!.styles.animation).toBe('rise-2 1s both');

    const html = nodesToHtml(reader, topLevelIds);
    expect(html).toMatch(/^<style>\n@keyframes rise-2 \{/);
    expect(html).not.toContain('@keyframes rise {');

    const page = renderDocumentHtml(reader, identityUrls, { rootIds: topLevelIds, offsetX: 0, offsetY: 0, background: '#fff', fontCss: [] });
    expect(page).toContain('@keyframes rise{to{opacity: 0.2;}}');
    expect(page).toContain('@keyframes rise-2{from{opacity: 0;} to{opacity: 1;}}');
  });
});

describe('hardening (review findings)', () => {
  it('never lets a keyframes body add rules to the page', () => {
    // A backslash before a quote is an escape to browsers, not the start of a string.
    const evil = 'from{a\\"}}*{background:red}x{":1}';
    let body = '';
    try {
      body = normalizeKeyframesBody(evil);
    } catch {
      body = '';
    }
    expect(body).not.toMatch(/background|\*/);
    // Odd property names, escapes and unbalanced quotes in values are dropped.
    expect(normalizeKeyframesBody(`to { "bad": 2; --ok: 1; content: "a'b"; font-family: x\\,y; width: 1px }`)).toBe('to{--ok: 1; width: 1px;}');
    // An unclosed string swallows the rest, as in a browser: no block, no rule.
    expect(() => normalizeKeyframesBody('to { content: "open }')).toThrow();
    // Stored rules are checked again where they meet the page (a file edited on disk).
    const css = keyframesCss([
      { name: 'ok', css: 'to{opacity: 1;}' },
      { name: 'x}*{color:red', css: 'to{opacity: 1;}' },
      { name: 'evil', css: 'to{opacity: 1;}} *{color: red;}' },
    ]);
    expect(css).toBe('@keyframes ok{to{opacity: 1;}}');
  });

  it('caps var() substitution that grows exponentially', () => {
    const levels = Array.from({ length: 9 }, (_, i) => `--v${i + 1}: ${Array(6).fill(`var(--v${i})`).join(' ')};`).join(' ');
    const started = Date.now();
    const { roots } = importHtml(`<style>:root { --v0: 1px; ${levels} } .a { width: 10px; height: 10px; margin: var(--v9) }</style><div class="a"></div>`);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(roots[0]!.styles.width).toBe('10px');
    expect((roots[0]!.styles.margin ?? '').length).toBeLessThan(200);
  });

  it('keeps the page body outside an embedded document', () => {
    const html = '<div style="display:flex"><p>Before</p><x-embed class="hero"><html><body><canvas></canvas><script>go()</script></body></html></x-embed></div>';
    const plain = importHtml(html);
    expect(plain.roots.length).toBe(1);
    expect(plain.roots[0]!.children.map((c) => c.component)).toEqual(['Text', 'Embed']);
    const styled = importHtml(`<style>.hero { width: 640px; height: 480px; border-radius: 12px }</style>${html}`);
    const embed = styled.roots[0]!.children[1]!;
    expect(embed).toMatchObject({ component: 'Embed', styles: { width: '640px', height: '480px', borderRadius: '12px' } });
    expect(embed.html).toContain('<script>go()</script>');
  });

  it('follows cascade layers, range queries, :not(:hover) and attribute specificity', () => {
    const { roots } = importHtml(`<style>
      @layer base, utilities;
      @layer utilities { .t { color: rgb(255, 0, 0) } }
      @layer base { .card .t { color: rgb(0, 0, 255) } }
      @media (width >= 48rem) { .wide { display: flex; gap: 8px } }
      @media (width < 40rem) { .wide { display: none } }
      .b:not(:hover) { opacity: 0.5 }
      [id=x] { width: 5px } .p.q.r { width: 9px }
    </style>
    <div class="card"><p class="t">Hi</p></div>
    <div class="wide"><span>a</span><span>b</span></div>
    <div class="b" style="width:2px;height:2px"></div>
    <div id="x" class="p q r" style="height:2px"></div>`);
    expect(roots[0]!.styles.color ?? roots[0]!.children[0]?.styles.color).toBe('rgb(255, 0, 0)');
    expect(roots[1]!.styles.display).toBe('flex');
    expect(roots[2]!.styles.opacity).toBe('0.5');
    expect(roots[3]!.styles.width).toBe('9px');
  });
});

describe('dotLottie archives', () => {
  it('unpacks only what a dotLottie holds, within size limits', async () => {
    const { zipSync, strToU8 } = await import('fflate');
    const { dotLottieToJson } = await import('./lottie.ts');
    const anim = JSON.stringify({ v: '5.7.4', fr: 30, ip: 0, op: 30, w: 10, h: 10, layers: [] });
    const ok = zipSync({ 'manifest.json': strToU8('{"animations":[{"id":"a"}]}'), 'animations/a.json': strToU8(anim), 'junk.bin': new Uint8Array(1024) });
    expect(JSON.parse(dotLottieToJson(ok)!).w).toBe(10);
    // An animation that would unpack past the limit is refused without being inflated.
    const bomb = zipSync({ 'animations/a.json': new Uint8Array(60 * 1024 * 1024) }, { level: 9 });
    expect(bomb.length).toBeLessThan(1024 * 1024);
    expect(dotLottieToJson(bomb)).toBeNull();
  });
});
