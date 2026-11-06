// Agent replies: the Markdown subset the chat panel renders, and model search.

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { modelMatches, parseInline, parseMarkdown } from './chat';
import { ChatMarkdown } from './ChatPanel';

const html = (text: string) => renderToStaticMarkup(createElement(ChatMarkdown, { text }));

describe('parseInline', () => {
  it('reads bold, italic and code', () => {
    expect(parseInline('a **b** *c* `d`')).toEqual([
      { type: 'text', text: 'a ' },
      { type: 'strong', children: [{ type: 'text', text: 'b' }] },
      { type: 'text', text: ' ' },
      { type: 'em', children: [{ type: 'text', text: 'c' }] },
      { type: 'text', text: ' ' },
      { type: 'code', text: 'd' },
    ]);
  });

  it('nests emphasis and handles ***both***', () => {
    expect(parseInline('*a **b** c*')).toEqual([
      { type: 'em', children: [{ type: 'text', text: 'a ' }, { type: 'strong', children: [{ type: 'text', text: 'b' }] }, { type: 'text', text: ' c' }] },
    ]);
    expect(parseInline('***x***')).toEqual([{ type: 'strong', children: [{ type: 'em', children: [{ type: 'text', text: 'x' }] }] }]);
    expect(parseInline('__b__ and _i_')).toEqual([
      { type: 'strong', children: [{ type: 'text', text: 'b' }] },
      { type: 'text', text: ' and ' },
      { type: 'em', children: [{ type: 'text', text: 'i' }] },
    ]);
  });

  it('leaves everything else as plain text', () => {
    for (const s of ['logo_v2_final.png', '2 * 3 * 4', '**not closed', 'a ** b ** c', '`unclosed', '[link](https://x.y)', '<b>tag</b>']) {
      expect(parseInline(s)).toEqual([{ type: 'text', text: s }]);
    }
    expect(parseInline('\\*literal\\*')).toEqual([{ type: 'text', text: '*literal*' }]);
  });

  it('does not close emphasis inside a code span', () => {
    expect(parseInline('*see `a*b`*')).toEqual([{ type: 'em', children: [{ type: 'text', text: 'see ' }, { type: 'code', text: 'a*b' }] }]);
    expect(parseInline('`` `x` ``')).toEqual([{ type: 'code', text: '`x`' }]);
  });
});

describe('parseMarkdown', () => {
  it('splits paragraphs on blank lines and keeps single newlines as breaks', () => {
    expect(parseMarkdown('One\ntwo\n\nThree')).toEqual([
      { type: 'paragraph', content: [{ type: 'text', text: 'One' }, { type: 'br' }, { type: 'text', text: 'two' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'Three' }] },
    ]);
  });

  it('reads the numbered "1. **Label:** …" lists agents write, straight after a lead-in line', () => {
    const blocks = parseMarkdown('Done. I changed:\n1. **Photo:** swapped in the van\n2. **Title:** now 96 px\n\nAnything else?');
    expect(blocks.map((b) => b.type)).toEqual(['paragraph', 'list', 'paragraph']);
    const list = blocks[1];
    expect(list).toMatchObject({ type: 'list', ordered: true, start: 1 });
    if (list.type !== 'list') throw new Error('not a list');
    expect(list.items).toHaveLength(2);
    expect(list.items[0].content).toEqual([{ type: 'strong', children: [{ type: 'text', text: 'Photo:' }] }, { type: 'text', text: ' swapped in the van' }]);
  });

  it('keeps a loose list together, nests indented lists and joins continuation lines', () => {
    const [list, ...rest] = parseMarkdown('3. first\n   more of first\n\n4. second\n   - a\n   - b\n5. third');
    expect(rest).toEqual([]);
    if (list.type !== 'list') throw new Error('not a list');
    expect(list.start).toBe(3);
    expect(list.items.map((i) => i.content)).toEqual([
      [{ type: 'text', text: 'first' }, { type: 'br' }, { type: 'text', text: 'more of first' }],
      [{ type: 'text', text: 'second' }],
      [{ type: 'text', text: 'third' }],
    ]);
    expect(list.items[1].children).toMatchObject([{ type: 'list', ordered: false, items: [{ content: [{ type: 'text', text: 'a' }] }, { content: [{ type: 'text', text: 'b' }] }] }]);
  });

  it('starts a new list when the marker kind changes', () => {
    expect(parseMarkdown('- a\n- b\n1. c').map((b) => (b.type === 'list' ? (b.ordered ? 'ol' : 'ul') : b.type))).toEqual(['ul', 'ol']);
  });

  it('reads headings, rules and fenced code (whose content is never parsed)', () => {
    expect(parseMarkdown('## Summary\n---\n```json\n{ "a": "**b**" }\n```')).toEqual([
      { type: 'heading', content: [{ type: 'text', text: 'Summary' }] },
      { type: 'rule' },
      { type: 'code', text: '{ "a": "**b**" }' },
    ]);
  });
});

describe('ChatMarkdown', () => {
  it('renders lists and emphasis as elements', () => {
    expect(html('Changes:\n1. **Photo:** *new*\n2. `logo.svg`')).toBe(
      '<div class="c-text c-md"><p>Changes:</p><ol><li><strong>Photo:</strong> <em>new</em></li><li><code>logo.svg</code></li></ol></div>',
    );
    expect(html('4. four\n5. five')).toContain('<ol start="4">');
  });

  it('never turns reply text into HTML', () => {
    const out = html('<img src=x onerror=alert(1)> **<script>x</script>**\n```\n<b>raw</b>\n```');
    expect(out).not.toMatch(/<img|<script|<b>/);
    expect(out).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(out).toContain('<strong>&lt;script&gt;x&lt;/script&gt;</strong>');
    expect(out).toContain('<pre><code>&lt;b&gt;raw&lt;/b&gt;</code></pre>');
  });
});

describe('modelMatches', () => {
  const m = { id: 'claude-4.5-sonnet-thinking', label: 'Claude 4.5 Sonnet (Thinking)' };
  it('matches every word against label or id, ignoring case', () => {
    expect(modelMatches(m, '')).toBe(true);
    expect(modelMatches(m, 'sonnet THINK')).toBe(true);
    expect(modelMatches(m, '4.5-sonnet')).toBe(true);
    expect(modelMatches(m, 'sonnet opus')).toBe(false);
  });
});
