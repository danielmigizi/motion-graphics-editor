// One <Audio> per project audio clip, from the host: the Player schedules it
// on its AudioContext clock and the exporter mixes it. Timing is in project
// frames: the clip starts at audioClipStartFrame(), skips trimStartFrames of the
// source, plays for durationInFrames, and its gain is volume × fades × the
// clip's volume envelope (ducking). clipVolumeAt is the single gain function:
// the timelines draw waveforms with it and verify-export reasons with it.

import React from 'react';
import { envelopeAt } from '../core/audioDucking';
import { audioClipStartFrame, resolveAssetUrl } from '../core/timing';
import type { AudioClip, Project } from '../core/types';
import { usePreviewProxies, videoPreviewSrc } from './previewProxies';
import { useEnvironment, useMedia } from '../runtime';

/**
 * Gain at a clip-relative frame: volume × linear fade-in × linear fade-out ×
 * volume envelope (linear between points, ends held), clamped to 0..1.
 */
export function clipVolumeAt(clip: AudioClip, frame: number): number {
  const fadeIn = clip.fadeInFrames > 0 ? Math.min(1, Math.max(0, frame / clip.fadeInFrames)) : 1;
  const fadeOut =
    clip.fadeOutFrames > 0 ? Math.min(1, Math.max(0, (clip.durationInFrames - frame) / clip.fadeOutFrames)) : 1;
  const v = clip.volume * Math.min(fadeIn, fadeOut) * envelopeAt(clip.volumeEnvelope, frame);
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export const AudioTrack: React.FC<{ project: Project; assetBaseUrl: string }> = ({ project, assetBaseUrl }) => {
  const { isRendering } = useEnvironment();
  const { Audio } = useMedia();
  // Re-render when a preview proxy becomes ready.
  usePreviewProxies();
  return (
    <>
      {project.audio.map((clip) => {
        const asset = project.assets[clip.assetId];
        // A clip may play a video file's soundtrack (detached video audio); the preview reads its lighter proxy when ready.
        if (!asset || (asset.kind !== 'audio' && asset.kind !== 'video') || clip.durationInFrames <= 0) return null;
        const src = asset.kind === 'video' ? videoPreviewSrc(asset, isRendering) : asset.src;
        return (
          <Audio
            key={clip.id}
            src={resolveAssetUrl(assetBaseUrl, src)}
            from={audioClipStartFrame(project, clip)}
            durationInFrames={clip.durationInFrames}
            trimBefore={Math.max(0, clip.trimStartFrames)}
            volume={(f) => clipVolumeAt(clip, f)}
            name={`Audio: ${clip.name}`}
          />
        );
      })}
    </>
  );
};
