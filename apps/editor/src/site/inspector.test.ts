import { describe, expect, it } from 'vitest';
import type { SiteElementInfo } from '@openpaper/core';
import { elementLabel, isInspectorMessage, normalizeSiteUrl, rebase, sameSiteProxyUrl } from './inspector.ts';

const el = (over: Partial<SiteElementInfo>): SiteElementInfo => ({
  selector: 'div',
  tag: 'div',
  classes: [],
  text: '',
  html: '<div></div>',
  rect: { x: 0, y: 0, width: 10, height: 10 },
  attributes: {},
  styles: {},
  ancestors: [],
  ...over,
});

describe('live site helpers', () => {
  it('names clicked elements for the chat', () => {
    expect(elementLabel([el({ tag: 'a', text: '  Get\n started ' })])).toBe('“Get started” link');
    expect(elementLabel([el({ tag: 'h2', text: 'Pricing' })])).toBe('“Pricing” heading');
    expect(elementLabel([el({ text: 'A long paragraph of marketing copy that goes on', components: ['PricingCard'] })])).toBe('<PricingCard>');
    expect(elementLabel([el({ id: 'hero' })])).toBe('div#hero');
    expect(elementLabel([el({ tag: 'section', classes: ['features', 'dark'] })])).toBe('section.features');
    expect(elementLabel([el({}), el({})])).toBe('2 elements');
  });

  it('maps pages between the proxy and the site', () => {
    expect(rebase('http://127.0.0.1:41000/pricing?plan=pro#faq', 'http://127.0.0.1:41000', 'http://localhost:5173/')).toBe(
      'http://localhost:5173/pricing?plan=pro#faq'
    );
    expect(rebase('https://example.com/x', 'http://127.0.0.1:41000', 'http://localhost:5173/')).toBe('https://example.com/x');
  });

  it('frames the proxy under the editor’s own host name', () => {
    expect(sameSiteProxyUrl('http://127.0.0.1:41000/', 'localhost')).toBe('http://localhost:41000/');
    expect(sameSiteProxyUrl('http://127.0.0.1:41000/app', '127.0.0.1')).toBe('http://127.0.0.1:41000/app');
  });

  it('accepts addresses the way people paste them', () => {
    expect(normalizeSiteUrl('localhost:3000')).toBe('http://localhost:3000/');
    expect(normalizeSiteUrl(' http://127.0.0.1:5173/app ')).toBe('http://127.0.0.1:5173/app');
    expect(normalizeSiteUrl('ftp://files.local')).toBeNull();
    expect(normalizeSiteUrl('')).toBeNull();
  });

  it('only trusts inspector-shaped messages', () => {
    expect(isInspectorMessage({ source: 'openpaper-inspector', type: 'ready', url: 'x', title: '' })).toBe(true);
    expect(isInspectorMessage({ source: 'other', type: 'ready' })).toBe(false);
    expect(isInspectorMessage('hello')).toBe(false);
  });
});
