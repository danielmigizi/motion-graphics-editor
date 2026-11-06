// Time containers: TimeSpan re-bases the frame for its children and only
// mounts them inside [from, from + durationInFrames); HoldFrame pins it.

import React, { useContext, useMemo } from 'react';
import { TimelineContext } from './context';

export const FullFrame = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(({ style, ...rest }, ref) => (
  <div
    ref={ref}
    {...rest}
    style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, width: '100%', height: '100%', display: 'flex', flexDirection: 'column', ...style }}
  />
));
FullFrame.displayName = 'FullFrame';

export const TimeSpan: React.FC<{
  from?: number;
  durationInFrames?: number;
  /** 'none' adds no wrapper; the default wraps children in an FullFrame. */
  layout?: 'absolute-fill' | 'none';
  name?: string;
  style?: React.CSSProperties;
  children?: React.ReactNode;
}> = ({ from = 0, durationInFrames = Infinity, layout = 'absolute-fill', name, style, children }) => {
  const parent = useContext(TimelineContext);
  const offset = parent.offset + from;
  const local = parent.frame - offset;
  const value = useMemo(() => ({ frame: parent.frame, offset }), [parent.frame, offset]);
  if (local < 0 || local >= durationInFrames) return null;
  const content = <TimelineContext.Provider value={value}>{children}</TimelineContext.Provider>;
  return layout === 'none' ? content : <FullFrame data-sequence={name} style={style}>{content}</FullFrame>;
};

/** Children see `frame` as their current frame, whatever the host plays. */
export const HoldFrame: React.FC<{ frame: number; children?: React.ReactNode }> = ({ frame, children }) => {
  const parent = useContext(TimelineContext);
  const value = useMemo(() => ({ frame: parent.offset + frame, offset: parent.offset }), [parent.offset, frame]);
  return <TimelineContext.Provider value={value}>{children}</TimelineContext.Provider>;
};
