import { describe, expect, it } from 'vitest';
import { cssUrls, cssVarRefs, normalizeStyleValue, parseInlineStyle, styleMapToCss, toCamelCase, toKebabCase } from './css.ts';

describe('css helpers', () => {
  it('expands the font shorthand', () => {
    expect(parseInlineStyle('font: 700 44px/52px Inter, sans-serif')).toEqual({ fontStyle: 'normal', fontWeight: '700', fontSize: '44px', lineHeight: '52px', fontFamily: 'Inter, sans-serif' });
    // What the shorthand leaves out is reset, even after a longhand.
    expect(parseInlineStyle('font-weight: 700; line-height: 2; font: 16px Inter')).toEqual({ fontWeight: '400', lineHeight: 'normal', fontStyle: 'normal', fontSize: '16px', fontFamily: 'Inter' });
    expect(parseInlineStyle('font: italic bold 12px / 1.5 "Helvetica Neue", Arial; font-size: 14px')).toEqual({
      fontStyle: 'italic',
      fontWeight: '700',
      fontSize: '14px',
      lineHeight: '1.5',
      fontFamily: '"Helvetica Neue", Arial',
    });
    expect(parseInlineStyle('font: caption')).toEqual({ font: 'caption' });
  });

  it('converts property names both ways', () => {
    expect(toCamelCase('background-color')).toBe('backgroundColor');
    expect(toCamelCase('-webkit-line-clamp')).toBe('WebkitLineClamp');
    expect(toCamelCase('--color-primary')).toBe('--color-primary');
    expect(toKebabCase('backgroundColor')).toBe('background-color');
    expect(toKebabCase('WebkitLineClamp')).toBe('-webkit-line-clamp');
    expect(toKebabCase('--x')).toBe('--x');
  });

  it('parses inline styles with tricky values', () => {
    const s = parseInlineStyle(
      'color: red; background-image: url("a;b.png"); font-family: "Inter", sans-serif; padding: 4px 8px !important; --brand: #fff; /* c */ gap:2px'
    );
    expect(s).toEqual({
      color: 'red',
      backgroundImage: 'url("a;b.png")',
      fontFamily: '"Inter", sans-serif',
      padding: '4px 8px',
      '--brand': '#fff',
      gap: '2px',
    });
  });

  it('normalizes values', () => {
    expect(normalizeStyleValue('width', 10)).toBe('10px');
    expect(normalizeStyleValue('opacity', 0.4)).toBe('0.4');
    expect(normalizeStyleValue('fontWeight', 600)).toBe('600');
    expect(normalizeStyleValue('width', '')).toBeNull();
    expect(normalizeStyleValue('width', null)).toBeNull();
    expect(normalizeStyleValue('color', 'red !important')).toBe('red');
  });

  it('serializes and extracts references', () => {
    expect(styleMapToCss({ backgroundColor: 'red', '--x': '1' })).toBe('background-color: red; --x: 1;');
    expect(cssVarRefs('color-mix(var(--a) 40%, var(--b))')).toEqual(['--a', '--b']);
    expect(cssUrls('url("x.png"), url(y.png)')).toEqual(['x.png', 'y.png']);
  });
});
