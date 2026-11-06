import React from 'react';
import { GradientDefs, pathSpec, svgPaint, useSvgId, type ElementRenderer } from './shared';

/**
 * Bézier path in the element box (viewBox = box, so nodes are box pixels and
 * the stroke may overhang the box). Trim draws the stroke as one dash of a
 * pattern with period 1 over `pathLength={1}`, which also covers the
 * wrap-around past the end; the fill is never trimmed.
 */
export const PathElement: ElementRenderer = ({ element, width, height }) => {
  const spec = pathSpec(element);
  const id = useSvgId(element);
  const fillId = `${id}-fill`;
  const strokeId = `${id}-stroke`;
  const dash = spec.stroke && spec.trim.visible ? spec.trim : undefined;

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ display: 'block', overflow: 'visible' }}>
      <GradientDefs paints={[{ id: fillId, paint: spec.fill }, { id: strokeId, paint: spec.stroke }]} width={width} height={height} />
      <path
        d={spec.d}
        fill={svgPaint(spec.fill, fillId)}
        stroke={svgPaint(spec.stroke, strokeId)}
        strokeWidth={spec.stroke ? spec.strokeWidth : undefined}
        strokeLinecap={spec.stroke ? (spec.lineCap as React.SVGAttributes<SVGPathElement>['strokeLinecap']) : undefined}
        strokeLinejoin={spec.stroke ? (spec.lineJoin as React.SVGAttributes<SVGPathElement>['strokeLinejoin']) : undefined}
        pathLength={dash?.dashArray ? 1 : undefined}
        strokeDasharray={dash?.dashArray}
        strokeDashoffset={dash?.dashOffset}
      />
    </svg>
  );
};
