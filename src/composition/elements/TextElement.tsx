import React from 'react';
import { easingFn } from '../../core/animation';
import type { Easing } from '../../core/types';
import { clamp01, easeOut, fontStack, fontStretchFor, progress, prop, type ElementRenderer } from './shared';
import { revealSlots, splitLines, splitWords } from './textUnits';

type Reveal = 'none' | 'fadeUp' | 'typewriter' | 'wordStagger' | UnitReveal;

/**
 * Per-unit reveals (schemaVersion 2). Each unit animates for
 * revealDurationInFrames; unit starts are revealStagger frames apart in
 * revealOrder; revealEasing shapes every unit. Units: characters (whitespace
 * is not a unit), or lines split on explicit newlines for lineStagger.
 * fadeUp / typewriter / wordStagger ignore these props and keep their
 * original code paths, so existing documents render exactly as before.
 */
type UnitReveal = 'charStagger' | 'lineStagger' | 'charFadeUp' | 'scaleIn' | 'blurIn';
const UNIT_REVEALS: readonly string[] = ['charStagger', 'lineStagger', 'charFadeUp', 'scaleIn', 'blurIn'];

/** Blur at the start of blurIn, as a fraction of the font size. */
const BLUR_IN_EM = 0.2;

function unitStyle(reveal: UnitReveal, p: number, rise: number, fontSize: number): React.CSSProperties {
  const opacity = clamp01(p);
  switch (reveal) {
    case 'charStagger':
      return { opacity };
    case 'scaleIn':
      return { opacity, transform: `scale(${Math.max(0, p)})` };
    case 'blurIn':
      return opacity < 1 ? { opacity, filter: `blur(${(1 - opacity) * fontSize * BLUR_IN_EM}px)` } : {};
    default:
      // charFadeUp, lineStagger
      return { opacity, transform: `translateY(${(1 - p) * rise}px)` };
  }
}

/** Fraction of the reveal each word spends animating in wordStagger (the rest is stagger offset). */
const WORD_SHARE = 0.55;

export const TextElement: ElementRenderer = ({ element, localFrame }) => {
  const text = prop<string>(element, 'text', 'text');
  const fontFamily = prop<string>(element, 'text', 'fontFamily');
  const fontSize = prop<number>(element, 'text', 'fontSize');
  const fontWeight = prop<number>(element, 'text', 'fontWeight');
  const color = prop<string>(element, 'text', 'color');
  const align = prop<string>(element, 'text', 'align');
  const lineHeight = prop<number>(element, 'text', 'lineHeight');
  const letterSpacing = prop<number>(element, 'text', 'letterSpacing');
  const reveal = prop<string>(element, 'text', 'reveal') as Reveal;
  const duration = Math.max(0, Math.round(prop<number>(element, 'text', 'revealDurationInFrames')));

  const rise = fontSize * 0.35;
  let content: React.ReactNode = text;
  let blockStyle: React.CSSProperties = {};

  if (reveal === 'fadeUp') {
    const t = easeOut(progress(localFrame, 0, duration));
    blockStyle = { opacity: t, transform: `translateY(${(1 - t) * rise}px)` };
  } else if (reveal === 'typewriter') {
    const chars = Array.from(text);
    const t = progress(localFrame, 0, duration);
    const shown = Math.round(t * chars.length);
    const typing = t < 1;
    // Caret stays solid while typing, then blinks for a second before leaving.
    const after = localFrame - duration;
    const caretOn = typing || (after < 30 && Math.floor(after / 8) % 2 === 0);
    content = (
      <>
        {chars.slice(0, shown).join('')}
        {caretOn ? (
          <span style={{ position: 'relative', display: 'inline-block', width: 0 }}>
            <span
              style={{
                position: 'absolute',
                left: '0.04em',
                top: '-0.82em',
                width: '0.07em',
                height: '0.96em',
                background: color,
              }}
            />
          </span>
        ) : null}
        {/* Unrevealed characters keep their space so wrapping never jumps. */}
        <span style={{ opacity: 0 }}>{chars.slice(shown).join('')}</span>
      </>
    );
  } else if (reveal === 'wordStagger') {
    const tokens = text.split(/(\s+)/);
    const words = tokens.filter((tk) => tk !== '' && !/^\s+$/.test(tk)).length;
    const wordDur = words <= 1 ? duration : duration * WORD_SHARE;
    const step = words <= 1 ? 0 : (duration - wordDur) / (words - 1);
    let index = 0;
    content = tokens.map((tk, i) => {
      if (tk === '' || /^\s+$/.test(tk)) return tk;
      const t = easeOut(progress(localFrame, index * step, wordDur));
      index++;
      return (
        <span
          key={i}
          style={{
            display: 'inline-block',
            opacity: clamp01(t),
            transform: `translateY(${(1 - t) * rise}px)`,
          }}
        >
          {tk}
        </span>
      );
    });
  } else if (UNIT_REVEALS.includes(reveal)) {
    const unitReveal = reveal as UnitReveal;
    const stagger = Math.max(0, prop<number>(element, 'text', 'revealStagger'));
    const order = prop<string>(element, 'text', 'revealOrder');
    const ease = easingFn(prop<string>(element, 'text', 'revealEasing') as Easing);
    const at = (slot: number) => ease(progress(localFrame, slot * stagger, duration));
    if (unitReveal === 'lineStagger') {
      const lines = splitLines(text);
      const slots = revealSlots(lines.length, order);
      // A zero-width space keeps an empty line's height, as in the unsplit text.
      content = lines.map((line, i) => (
        <div key={i} style={unitStyle(unitReveal, at(slots[i]), rise, fontSize)}>
          {line === '' ? '\u200B' : line}
        </div>
      ));
    } else {
      const tokens = splitWords(text);
      const slots = revealSlots(tokens.reduce((sum, tk) => sum + (tk.kind === 'word' ? tk.chars.length : 0), 0), order);
      let unit = 0;
      // Words are unbreakable inline blocks so line breaks fall only at whitespace, as in the unsplit text.
      // Each character is its own box, so kerning between characters is not applied (same in preview and export).
      content = tokens.map((tk, i) =>
        tk.kind === 'space' ? (
          tk.text
        ) : (
          <span key={i} style={{ display: 'inline-block', whiteSpace: 'nowrap' }}>
            {tk.chars.map((ch, j) => (
              <span key={j} style={{ display: 'inline-block', ...unitStyle(unitReveal, at(slots[unit++]), rise, fontSize) }}>
                {ch}
              </span>
            ))}
          </span>
        ),
      );
    }
  }

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        fontFamily: fontStack(fontFamily),
        fontStretch: fontStretchFor(fontFamily),
        fontSize,
        fontWeight,
        color,
        textAlign: align as React.CSSProperties['textAlign'],
        lineHeight,
        letterSpacing,
        whiteSpace: 'pre-wrap',
        overflowWrap: 'break-word',
        fontKerning: 'normal',
      }}
    >
      <div style={blockStyle}>{content}</div>
    </div>
  );
};
