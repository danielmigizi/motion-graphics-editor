// The one composition used by the preview <Player>, the capture page and the
// MP4 export. Deterministic: everything below is a pure function of the
// current frame and the props, hosted by src/runtime (the Player and the
// export render page).

import React from 'react';
import { FullFrame, TimeSpan, useFrame, useCompositionConfig } from '../runtime';
import { EASINGS } from '../core/animation';
import { sceneStartFrames } from '../core/timing';
import type { Asset, ID, NestedComposition, Scene, SceneTransition } from '../core/types';
import { AudioTrack } from './AudioTrack';
import { ElementTree } from './ElementTree';
import { FontsReady } from './fonts';
import type { MainCompositionProps } from './types';

/**
 * Style for a scene's entrance transition at a scene-relative frame. Entrance
 * transitions play over the scene's first N frames; scenes never overlap
 * (see docs/transitions.md).
 */
export function sceneTransitionStyle(transition: SceneTransition, frameInScene: number): React.CSSProperties {
  const d = transition.durationInFrames;
  if (transition.type === 'none' || d <= 0 || frameInScene >= d) return {};
  const t = Math.max(0, Math.min(1, frameInScene / d));
  switch (transition.type) {
    case 'fade':
      return { opacity: t };
    case 'slide':
      return { transform: `translateX(${(1 - EASINGS.easeOut(t)) * 100}%)` };
    case 'wipe':
      return { clipPath: `inset(0 ${(1 - EASINGS.easeInOut(t)) * 100}% 0 0)` };
    case 'zoom':
      return { opacity: t, transform: `scale(${1.08 - 0.08 * EASINGS.easeOut(t)})` };
    case 'blur':
      return { opacity: t, filter: `blur(${24 * (1 - EASINGS.easeOut(t))}px)` };
    default:
      return {};
  }
}

const SceneView: React.FC<{
  scene: Scene;
  assets: Record<ID, Asset>;
  compositions: Record<ID, NestedComposition>;
  assetBaseUrl: string;
  width: number;
  height: number;
}> = ({ scene, assets, compositions, assetBaseUrl, width, height }) => {
  const frame = useFrame();
  const { fps } = useCompositionConfig();
  return (
    <FullFrame
      data-scene-id={scene.id}
      style={{ background: scene.backgroundColor, overflow: 'hidden', ...sceneTransitionStyle(scene.transitionIn, frame) }}
    >
      <ElementTree elements={scene.elements} frame={frame} width={width} height={height} ctx={{ assets, assetBaseUrl, fps, compositions, depth: 0 }} />
    </FullFrame>
  );
};

export const MainComposition: React.FC<MainCompositionProps> = ({ project, assetBaseUrl }) => {
  const starts = sceneStartFrames(project);
  return (
    <FontsReady>
      <FullFrame style={{ background: project.backgroundColor, overflow: 'hidden' }}>
        {project.scenes.map((scene, i) =>
          scene.durationInFrames > 0 ? (
            <TimeSpan key={scene.id} from={starts[i]} durationInFrames={scene.durationInFrames} name={scene.name}>
              <SceneView width={project.width} height={project.height} scene={scene} assets={project.assets} compositions={project.compositions} assetBaseUrl={assetBaseUrl} />
            </TimeSpan>
          ) : null,
        )}
        <AudioTrack project={project} assetBaseUrl={assetBaseUrl} />
      </FullFrame>
    </FontsReady>
  );
};
