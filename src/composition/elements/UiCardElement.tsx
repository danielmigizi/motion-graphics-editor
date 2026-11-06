import React from 'react';
import { easeOutCubic, fontStack, progress, prop, tint, type ElementRenderer } from './shared';

/** Frames after the card appears before the first row starts, between rows, and per row. */
const ROW_DELAY = 12;
const ROW_STEP = 7;
const ROW_DURATION = 14;
const METRIC_DURATION = 26;

/** Count a leading number up during the build-in ("92%" → "0%" … "92%"); non-numeric values are returned as-is. */
function countUp(value: string, t: number): string {
  const m = /^([^\d]*)(\d+(?:\.\d+)?)(.*)$/.exec(value);
  if (!m || t >= 1) return value;
  const decimals = m[2].includes('.') ? m[2].split('.')[1].length : 0;
  const n = Number(m[2]) * t;
  return `${m[1]}${n.toFixed(decimals)}${m[3]}`;
}

export const UiCardElement: ElementRenderer = ({ element, localFrame, width, height }) => {
  const title = prop<string>(element, 'uiCard', 'title');
  const subtitle = prop<string>(element, 'uiCard', 'subtitle');
  const metricLabel = prop<string>(element, 'uiCard', 'metricLabel');
  const metricValue = prop<string>(element, 'uiCard', 'metricValue');
  const items = prop<string>(element, 'uiCard', 'items')
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  const accent = prop<string>(element, 'uiCard', 'accentColor');
  const background = prop<string>(element, 'uiCard', 'background');
  const textColor = prop<string>(element, 'uiCard', 'textColor');
  const radius = Math.max(0, prop<number>(element, 'uiCard', 'cornerRadius'));
  const stagger = prop<string>(element, 'uiCard', 'buildIn') === 'stagger';

  // Typography and spacing scale with the card's size (designed at 620 × 420).
  const u = Math.max(0.3, Math.min(width / 620, height / 420));
  const pad = 34 * u;
  const metricT = stagger ? easeOutCubic(progress(localFrame, 4, METRIC_DURATION)) : 1;

  return (
    <div
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        boxSizing: 'border-box',
        overflow: 'hidden',
        borderRadius: radius,
        background,
        border: `${Math.max(1, u)}px solid ${tint(textColor, 10)}`,
        boxShadow: `0 ${40 * u}px ${100 * u}px rgba(2, 6, 23, 0.5)`,
        color: textColor,
        fontFamily: fontStack('Inter'),
        padding: pad,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* Accent wash in the top-right corner. */}
      <div
        style={{
          position: 'absolute',
          right: -160 * u,
          top: -200 * u,
          width: 440 * u,
          height: 440 * u,
          borderRadius: '50%',
          background: `radial-gradient(closest-side, ${tint(accent, 22)}, transparent)`,
          pointerEvents: 'none',
        }}
      />
      <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: 6 * u }}>
        <div style={{ fontSize: 26 * u, fontWeight: 600, letterSpacing: -0.2 * u, lineHeight: 1.15 }}>{title}</div>
        {subtitle ? (
          <div style={{ fontSize: 17 * u, fontWeight: 400, color: tint(textColor, 58), lineHeight: 1.3 }}>{subtitle}</div>
        ) : null}
      </div>

      <div style={{ position: 'relative', marginTop: 26 * u, display: 'flex', flexDirection: 'column', gap: 8 * u }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9 * u, fontSize: 15 * u, fontWeight: 500, color: tint(textColor, 62) }}>
          <span style={{ width: 8 * u, height: 8 * u, borderRadius: 2.5 * u, background: accent, flex: 'none' }} />
          {metricLabel}
        </div>
        <div
          style={{
            fontFamily: fontStack('Space Grotesk'),
            fontSize: 60 * u,
            fontWeight: 600,
            letterSpacing: -1.2 * u,
            lineHeight: 1,
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {countUp(metricValue, metricT)}
        </div>
      </div>

      <div style={{ position: 'relative', marginTop: 24 * u, display: 'flex', flexDirection: 'column' }}>
        {items.map((item, i) => {
          const t = stagger ? easeOutCubic(progress(localFrame, ROW_DELAY + i * ROW_STEP, ROW_DURATION)) : 1;
          const markerT = stagger ? easeOutCubic(progress(localFrame, ROW_DELAY + i * ROW_STEP + 4, ROW_DURATION)) : 1;
          return (
            <div
              key={i}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 14 * u,
                padding: `${13 * u}px 0`,
                borderTop: `${Math.max(1, u)}px solid ${tint(textColor, 9)}`,
                fontSize: 19 * u,
                fontWeight: 500,
                lineHeight: 1.25,
                opacity: t,
                transform: `translateY(${(1 - t) * 12 * u}px)`,
              }}
            >
              <span
                style={{
                  width: 9 * u,
                  height: 9 * u,
                  borderRadius: 2.5 * u,
                  background: accent,
                  flex: 'none',
                  transform: `scale(${markerT})`,
                  boxShadow: `0 0 ${12 * u}px ${tint(accent, 55)}`,
                }}
              />
              <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{item}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
};
