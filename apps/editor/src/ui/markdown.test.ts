import { describe, expect, it } from 'vitest';
import { parseInline, parseMarkdown, safeHref } from './markdown.ts';

const text = (t: string) => ({ type: 'text', text: t });

describe('parseInline', () => {
  it('parses bold, italic, strikethrough and code', () => {
    expect(parseInline('a **b** *c* ~~d~~ `e`')).toEqual([
      text('a '),
      { type: 'strong', children: [text('b')] },
      text(' '),
      { type: 'em', children: [text('c')] },
      text(' '),
      { type: 'del', children: [text('d')] },
      text(' '),
      { type: 'code', text: 'e' },
    ]);
    expect(parseInline('***both***')).toEqual([{ type: 'strong', children: [{ type: 'em', children: [text('both')] }] }]);
    expect(parseInline('__bold__ _it_')).toEqual([{ type: 'strong', children: [text('bold')] }, text(' '), { type: 'em', children: [text('it')] }]);
  });

  it('nests emphasis', () => {
    expect(parseInline('**x *y* z**')).toEqual([{ type: 'strong', children: [text('x '), { type: 'em', children: [text('y')] }, text(' z')] }]);
    expect(parseInline('*a **b** c*')).toEqual([{ type: 'em', children: [text('a '), { type: 'strong', children: [text('b')] }, text(' c')] }]);
  });

  it('leaves unclosed or spaced markers alone (streaming, arithmetic, snake_case)', () => {
    expect(parseInline('**Home / Tas')).toEqual([text('**Home / Tas')]);
    expect(parseInline('2 * 3 * 4')).toEqual([text('2 * 3 * 4')]);
    expect(parseInline('snake_case_name')).toEqual([text('snake_case_name')]);
    expect(parseInline('`open')).toEqual([text('`open')]);
    expect(parseInline('~5px')).toEqual([text('~5px')]);
  });

  it('does not parse markup inside code spans', () => {
    expect(parseInline('`**x**` and ``a ` b``')).toEqual([{ type: 'code', text: '**x**' }, text(' and '), { type: 'code', text: 'a ` b' }]);
    expect(parseInline('**see `a**b`**')).toEqual([{ type: 'strong', children: [text('see '), { type: 'code', text: 'a**b' }] }]);
  });

  it('parses links and bare URLs', () => {
    expect(parseInline('[Paper](https://paper.design) and https://x.com/a.')).toEqual([
      { type: 'link', href: 'https://paper.design', children: [text('Paper')] },
      text(' and '),
      { type: 'link', href: 'https://x.com/a', children: [text('https://x.com/a')] },
      text('.'),
    ]);
    expect(parseInline('[1] not a link')).toEqual([text('[1] not a link')]);
  });

  it('handles escapes and line breaks', () => {
    expect(parseInline('\\*not em\\*')).toEqual([text('*not em*')]);
    expect(parseInline('a\nb')).toEqual([text('a'), { type: 'br' }, text('b')]);
  });
});

describe('parseMarkdown', () => {
  it('parses the agent reply from the bug report', () => {
    const blocks = parseMarkdown(
      [
        'Hi! I can see the **Home / Tasks** frame selected.',
        '',
        '- **Review it** and suggest fixes',
        '- **Add or redesign a section**, like the task list',
        '',
        'Tell me what you have in mind.',
      ].join('\n'),
    );
    expect(blocks.map((b) => b.type)).toEqual(['paragraph', 'list', 'paragraph']);
    expect(blocks[1]).toMatchObject({
      type: 'list',
      ordered: false,
      items: [
        [{ type: 'paragraph', children: [{ type: 'strong', children: [text('Review it')] }, text(' and suggest fixes')] }],
        [{ type: 'paragraph', children: [{ type: 'strong' }, text(', like the task list')] }],
      ],
    });
  });

  it('parses headings, rules, quotes and fenced code', () => {
    expect(parseMarkdown('## Plan ##\n---\n> quoted\n> more\n```css\na { color: red; }\n```')).toEqual([
      { type: 'heading', level: 2, children: [text('Plan')] },
      { type: 'hr' },
      { type: 'quote', children: [{ type: 'paragraph', children: [text('quoted'), { type: 'br' }, text('more')] }] },
      { type: 'code', lang: 'css', text: 'a { color: red; }' },
    ]);
    expect(parseMarkdown('#hashtag')).toEqual([{ type: 'paragraph', children: [text('#hashtag')] }]);
  });

  it('runs an unclosed fence to the end while streaming', () => {
    expect(parseMarkdown('```\nconst a = 1;\n**b**')).toEqual([{ type: 'code', lang: '', text: 'const a = 1;\n**b**' }]);
  });

  it('parses ordered, nested and loose lists', () => {
    const list = parseMarkdown('3. one\n   - a\n   - b\n4. two\n\n5. three\ncontinued')[0];
    if (list?.type !== 'list') throw new Error('expected a list');
    expect(list).toMatchObject({ ordered: true, start: 3 });
    expect(list.items).toHaveLength(3);
    expect(list.items[0]).toMatchObject([{ type: 'paragraph' }, { type: 'list', ordered: false, items: [[{ type: 'paragraph' }], [{ type: 'paragraph' }]] }]);
    expect(list.items[2]).toEqual([{ type: 'paragraph', children: [text('three'), { type: 'br' }, text('continued')] }]);
  });

  it('starts a new list when the marker type changes', () => {
    expect(parseMarkdown('1. a\n- b').map((b) => b.type === 'list' && b.ordered)).toEqual([true, false]);
  });

  it('parses tables with alignment', () => {
    expect(parseMarkdown('| Token | Value |\n|:--|--:|\n| `bg` | #000 |\n| fg')).toEqual([
      {
        type: 'table',
        align: ['left', 'right'],
        head: [[text('Token')], [text('Value')]],
        rows: [
          [[{ type: 'code', text: 'bg' }], [text('#000')]],
          [[text('fg')], []],
        ],
      },
    ]);
    expect(parseMarkdown('a | b\n---').map((b) => b.type)).toEqual(['paragraph', 'hr']);
  });
});

describe('safeHref', () => {
  it('allows only web and mail links', () => {
    expect(safeHref('https://a.com')).toBe('https://a.com');
    expect(safeHref('mailto:a@b.c')).toBe('mailto:a@b.c');
    expect(safeHref('javascript:alert(1)')).toBeNull();
    expect(safeHref('/relative')).toBeNull();
  });
});
