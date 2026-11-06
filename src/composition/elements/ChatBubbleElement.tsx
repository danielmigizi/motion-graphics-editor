import React from 'react';
import { easeOutCubic, fontStack, progress, prop, tint, type ElementRenderer } from './shared';

const DOT_PERIOD = 18;
const DOT_OFFSET = 4;
const TEXT_IN = 8;

export const ChatBubbleElement: ElementRenderer = ({ element, localFrame }) => {
  const text = prop<string>(element, 'chatBubble', 'text');
  const isUser = prop<string>(element, 'chatBubble', 'sender') === 'user';
  const senderName = prop<string>(element, 'chatBubble', 'senderName');
  const bubbleColor = prop<string>(element, 'chatBubble', 'bubbleColor');
  const textColor = prop<string>(element, 'chatBubble', 'textColor');
  const fontSize = prop<number>(element, 'chatBubble', 'fontSize');
  const typing = prop<boolean>(element, 'chatBubble', 'typing');
  const typingFrames = Math.max(0, Math.round(prop<number>(element, 'chatBubble', 'typingDurationInFrames')));

  const showDots = typing && localFrame < typingFrames;
  const textT = typing ? easeOutCubic(progress(localFrame + 1, typingFrames, TEXT_IN)) : 1;
  const big = '0.9em';
  const small = '0.24em';

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: isUser ? 'flex-end' : 'flex-start',
        fontFamily: fontStack('Inter'),
        fontSize,
      }}
    >
      {senderName ? (
        <div
          style={{
            fontSize: Math.max(12, Math.round(fontSize * 0.5)),
            fontWeight: 600,
            color: tint(textColor, 60),
            margin: isUser ? '0 0.9em 0.45em 0' : '0 0 0.45em 0.9em',
            lineHeight: 1.2,
          }}
        >
          {senderName}
        </div>
      ) : null}
      <div
        style={{
          maxWidth: '100%',
          boxSizing: 'border-box',
          background: bubbleColor,
          color: textColor,
          padding: '0.5em 0.8em',
          borderRadius: isUser ? `${big} ${big} ${small} ${big}` : `${big} ${big} ${big} ${small}`,
          lineHeight: 1.35,
          fontWeight: 500,
          whiteSpace: 'pre-wrap',
          overflowWrap: 'break-word',
          boxShadow: '0 0.4em 1.2em rgba(2, 6, 23, 0.35)',
          // Grow out of the tail corner as the message replaces the typing dots.
          transform: !showDots && textT < 1 ? `scale(${0.9 + 0.1 * textT})` : undefined,
          transformOrigin: isUser ? '100% 100%' : '0% 100%',
        }}
      >
        {showDots ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.22em', height: '1.35em', padding: '0 0.1em' }}>
            {[0, 1, 2].map((i) => {
              const a = 0.5 + 0.5 * Math.sin((2 * Math.PI * (localFrame - i * DOT_OFFSET)) / DOT_PERIOD);
              return (
                <span
                  key={i}
                  style={{
                    width: '0.3em',
                    height: '0.3em',
                    borderRadius: '50%',
                    background: textColor,
                    opacity: 0.35 + 0.65 * a,
                    transform: `translateY(${-0.12 * a}em)`,
                  }}
                />
              );
            })}
          </div>
        ) : (
          <div style={{ opacity: textT, transform: `translateY(${(1 - textT) * 0.25}em)` }}>{text}</div>
        )}
      </div>
    </div>
  );
};
