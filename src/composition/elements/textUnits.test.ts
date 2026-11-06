import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { element } from '../../core/__fixtures__/schema2Project';
import { TextElement } from './TextElement';
import { graphemes, revealSlots, splitLines, splitWords } from './textUnits';

const renderText = (props: Record<string, unknown>, localFrame: number) => {
  const el = element('t', 'text', { props: { ...element('t', 'text').props, ...props } });
  return renderToStaticMarkup(createElement(TextElement, { element: el, localFrame, width: 900, height: 160, assets: {}, assetBaseUrl: '/', fps: 30 }));
};

describe('unit splitting', () => {
  it('splits words into grapheme clusters and keeps whitespace runs', () => {
    expect(splitWords('Hi  there\nyou')).toEqual([
      { kind: 'word', chars: ['H', 'i'] },
      { kind: 'space', text: '  ' },
      { kind: 'word', chars: ['t', 'h', 'e', 'r', 'e'] },
      { kind: 'space', text: '\n' },
      { kind: 'word', chars: ['y', 'o', 'u'] },
    ]);
    expect(graphemes('é👍🏽a')).toEqual(['é', '👍🏽', 'a']);
    expect(splitWords('')).toEqual([]);
  });

  it('splits lines on explicit newlines only, without a phantom trailing line', () => {
    expect(splitLines('one\n\nthree')).toEqual(['one', '', 'three']);
    expect(splitLines('one\ntwo\n')).toEqual(['one', 'two']);
    expect(splitLines('a very long line that would soft-wrap')).toEqual(['a very long line that would soft-wrap']);
  });

  it.each([
    ['forward', 5, [0, 1, 2, 3, 4]],
    ['reverse', 5, [4, 3, 2, 1, 0]],
    ['center', 5, [2, 1, 0, 1, 2]],
    ['edges', 5, [0, 1, 2, 1, 0]],
    ['center', 4, [1, 0, 0, 1]],
    ['edges', 4, [0, 1, 1, 0]],
    ['center', 1, [0]],
    ['edges', 0, []],
  ] as const)('orders %s over %i units', (order, n, slots) => {
    expect(revealSlots(n, order)).toEqual(slots);
  });
});

describe('TextElement reveals', () => {
  it.each(['none', 'fadeUp', 'typewriter', 'wordStagger'])('%s ignores the per-unit props (existing documents render as before)', (reveal) => {
    for (const frame of [0, 4, 11, 40]) {
      const legacy = renderText({ reveal, text: 'Ship the brief', revealStagger: undefined, revealOrder: undefined, revealEasing: undefined }, frame);
      expect(renderText({ reveal, text: 'Ship the brief', revealStagger: 9, revealOrder: 'center', revealEasing: 'linear' }, frame)).toBe(legacy);
    }
  });

  it('staggers characters (not whitespace) in reveal order with the reveal easing', () => {
    const html = renderText({ reveal: 'charStagger', text: 'ab c', revealDurationInFrames: 10, revealStagger: 5, revealOrder: 'reverse', revealEasing: 'linear' }, 5);
    // reverse: c starts at 0, b at 5, a at 10 → at frame 5: c 0.5, b 0, a 0.
    expect(html).toContain('<span style="display:inline-block;white-space:nowrap"><span style="display:inline-block;opacity:0">a</span><span style="display:inline-block;opacity:0">b</span></span> <span');
    expect(html).toContain('<span style="display:inline-block;opacity:0.5">c</span>');
  });

  it('renders each unit reveal to its settled state once done', () => {
    for (const reveal of ['charStagger', 'charFadeUp', 'scaleIn', 'blurIn']) {
      const html = renderText({ reveal, text: 'ab', revealDurationInFrames: 6, revealStagger: 2, revealEasing: 'easeOut' }, 8);
      expect(html).not.toMatch(/opacity:0\.|blur\(|scale\(0/);
    }
    expect(renderText({ reveal: 'blurIn', text: 'ab', revealDurationInFrames: 10, revealStagger: 0, revealEasing: 'linear', fontSize: 100 }, 5)).toContain('opacity:0.5;filter:blur(10px)');
    expect(renderText({ reveal: 'scaleIn', text: 'a', revealDurationInFrames: 10, revealEasing: 'linear' }, 5)).toContain('opacity:0.5;transform:scale(0.5)');
  });

  it('reveals lines split on explicit newlines, keeping empty lines', () => {
    const html = renderText({ reveal: 'lineStagger', text: 'one\n\nthree', revealDurationInFrames: 10, revealStagger: 10, revealEasing: 'linear', fontSize: 100 }, 10);
    expect(html).toContain('<div style="opacity:1;transform:translateY(0px)">one</div><div style="opacity:0;transform:translateY(35px)">​</div><div style="opacity:0;transform:translateY(35px)">three</div>');
  });
});
