// Each cell runs the same scene Sequences at its requested global frame.
import React from 'react';
import { HoldFrame } from '../runtime';
import { formatTimecode, locateFrame } from '../core/timing';
import { MainComposition } from './MainComposition';
import { contactSheetLayout } from './contact-sheet-layout';
import type { MainCompositionProps } from './types';

export interface ContactSheetProps extends MainCompositionProps {
  frames: number[];
  columns: number;
  labels: boolean;
  scale?: number;
}

export const ContactSheet: React.FC<ContactSheetProps> = (props) => {
  const { project, assetBaseUrl, frames, labels } = props;
  const layout = contactSheetLayout(props);
  return (
    <div style={{ display: 'grid', gridTemplateColumns: `repeat(${layout.columns}, ${layout.cellWidth}px)`, background: '#111827', color: '#fff', width: layout.width, height: layout.height }}>
      {frames.map((frame, index) => (
        <div key={`${frame}-${index}`}>
          <div style={{ position: 'relative', width: layout.cellWidth, height: layout.cellHeight, overflow: 'hidden' }}>
            <div style={{ position: 'absolute', width: project.width, height: project.height, transform: `scale(${layout.scale})`, transformOrigin: 'top left' }}>
              <HoldFrame frame={frame}>
                <MainComposition project={project} assetBaseUrl={assetBaseUrl} />
              </HoldFrame>
            </div>
          </div>
          {labels && <div style={{ height: layout.captionHeight, padding: '0 10px', display: 'flex', alignItems: 'center', font: '14px Inter, sans-serif', whiteSpace: 'nowrap', overflow: 'hidden' }}>
            f{frame} · {formatTimecode(frame, project.fps)} · {locateFrame(project, frame)?.scene.name}
          </div>}
        </div>
      ))}
    </div>
  );
};
