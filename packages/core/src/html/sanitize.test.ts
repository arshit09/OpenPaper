import { describe, expect, it } from 'vitest';
import { cleanSvgMarkup, scopeSvgIds } from './svg.ts';
import { sanitizeSvg } from './sanitize.ts';
import { globMatcher } from '../tokens/tokens.ts';

describe('sanitizeSvg', () => {
  it('drops comments, which HTML can end early with `<!-->`', () => {
    const out = sanitizeSvg('<svg><!--><img src=x onerror=alert(1)>--><rect/></svg>');
    expect(out).not.toContain('<!--');
    expect(out).not.toContain('img');
    expect(out).toContain('<rect/>');
  });

  it('drops animations that would set a link to a script URL', () => {
    const out = sanitizeSvg(
      '<svg><a><set attributeName="href" to="javascript:alert(1)"/><animate attributeName="xlink:href" values="javascript:alert(1)"/><animate attributeName="opacity" values="0;1"/></a></svg>'
    );
    expect(out).not.toContain('javascript');
    expect(out).toContain('attributeName="opacity"');
  });
});

describe('cleanSvgMarkup', () => {
  it('inlines <style> rules and strips foreignObject', () => {
    const out = cleanSvgMarkup('<svg viewBox="0 0 4 4"><style>.a{fill:red}</style><rect class="a"/><foreignObject><div>x</div></foreignObject></svg>');
    expect(out).not.toContain('<style');
    expect(out).not.toContain('foreignObject');
    expect(out).toContain('style="fill:red"');
  });

  it('leaves clean markup as it is, so files can be cleaned again on load', () => {
    const samples = [
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M5 12h14"/><circle cx="12" cy="12" r="3"/></svg>',
      '<svg width="40" height="20"><defs><linearGradient id="g"><stop offset="0" stop-color="#fff"/></linearGradient></defs><rect width="40" height="20" fill="url(#g)"/><text x="2" y="14"> Hi  there </text></svg>',
      '<svg viewBox="0 0 10 10" data-x="1" class="a"><style>.a{fill:red}</style><title>t</title><g class="a"><use href="#p"/></g></svg>',
    ];
    for (const raw of samples) {
      const once = cleanSvgMarkup(raw);
      expect(cleanSvgMarkup(once)).toBe(once);
    }
  });
});

describe('scopeSvgIds', () => {
  it('keeps `$` sequences in ids literal', () => {
    const out = scopeSvgIds('<svg><path id="a$`b"/><use href="#a$`b"/></svg>', '_1_');
    expect(out).toBe('<svg><path id="_1_a$`b"/><use href="#_1_a$`b"/></svg>');
  });
});

describe('globMatcher', () => {
  it('matches anchored, case-insensitive `*` globs', () => {
    expect(globMatcher('--color-*').test('--Color-Brand')).toBe(true);
    expect(globMatcher('*brand*').test('--color-brand-500')).toBe(true);
    expect(globMatcher('a*b*c').test('abc')).toBe(true);
    expect(globMatcher('a*b*c').test('acb')).toBe(false);
    expect(globMatcher('ab*ba').test('aba')).toBe(false);
    expect(globMatcher('exact').test('exact!')).toBe(false);
    expect(globMatcher('*').test('')).toBe(true);
    expect(globMatcher('Line*two').test('Line one\nline two')).toBe(true);
  });

  it('stays fast on patterns that make a backtracking RegExp explode', () => {
    const pattern = `${'*a'.repeat(30)}*b`;
    const start = performance.now();
    expect(globMatcher(pattern).test('a'.repeat(5000))).toBe(false);
    expect(performance.now() - start).toBeLessThan(100);
  });
});
