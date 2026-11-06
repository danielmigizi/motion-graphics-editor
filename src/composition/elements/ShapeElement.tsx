import React from 'react';
import { GradientDefs, shapeSpec, svgPaint, useSvgId, type ElementRenderer } from './shared';

export const ShapeElement: ElementRenderer = ({ element, width, height }) => {
  const spec = shapeSpec(element, width, height);
  const id = useSvgId(element);
  const fillId = `${id}-fill`;
  const strokeId = `${id}-stroke`;
  const common = {
    fill: svgPaint(spec.fill, fillId),
    stroke: svgPaint(spec.stroke, strokeId),
    strokeWidth: spec.strokeWidth,
  };
  const g = spec.geometry;

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ display: 'block', overflow: 'visible' }}>
      <GradientDefs paints={[{ id: fillId, paint: spec.fill }, { id: strokeId, paint: spec.stroke }]} width={width} height={height} />
      {g.kind === 'ellipse' ? (
        <ellipse cx={g.cx} cy={g.cy} rx={g.rx} ry={g.ry} {...common} />
      ) : (
        <rect x={g.x} y={g.y} width={g.width} height={g.height} rx={g.rx} {...common} />
      )}
    </svg>
  );
};
