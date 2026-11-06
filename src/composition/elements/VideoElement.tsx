// Video element: plays a video asset inside the element box with the host's
// <Video>: the Player keeps a <video> element on its clock, and the exporter
// shows the exact decoded source frame.
//
// Timing: a <TimeSpan> re-bases the clock so the <Video> sees the element's
// own local frame, whatever produced it (scene, group, instance — looping or
// not). The source time at local frame f is
// (trimStartFrames + f × playbackRate) / fps, wrapped to the trimmed source with
// `loop` (src/core/video.ts). A 1 ms bias keeps a request that lands exactly on
// a frame boundary from resolving to the previous frame (float rounding).
//
// Source: the preview (Player, capture page, thumbnails) prefers the file's
// lightweight proxy when the server has one (src/composition/previewProxies.ts,
// kept outside the document); rendering always reads the original `src`.
//
// Audio: the element's soundtrack plays with it (volume × the animated volume
// track, `muted` silences it) and is mixed into exports, anchored to wherever
// the element plays. The volume track is in element time, so a looping source
// keeps following it instead of restarting it on every loop of the file.

import React, { useState } from 'react';
import { TimeSpan, useFrame, useEnvironment, useMedia } from '../../runtime';
import { evaluatePropertyTrack } from '../../core/animation';
import { resolveAssetUrl } from '../../core/timing';
import type { Element } from '../../core/types';
import { videoProps } from '../../core/video';
import { usePreviewProxies, videoPreviewSrc } from '../previewProxies';
import { findAsset, MissingAsset, type ElementRenderer } from './shared';

/** Seconds added to every requested source time; far below one frame at any supported rate. */
export const VIDEO_TIME_BIAS_SECONDS = 0.001;

/** Element volume at element-local frame `f`: the animated volume track when there is one, else the prop. */
export function videoVolumeAt(element: Element, f: number): number {
  const v = Number(element.propTracks?.some((t) => t.key === 'props.volume') ? evaluatePropertyTrack(element, 'props.volume', f) : element.props.volume);
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1;
}

/**
 * Preview: a file that cannot be loaded shows the missing-asset placeholder
 * instead of taking the Player down. Rendering never swallows the error: an
 * export must not ship a blank video.
 */
class VideoErrorBoundary extends React.Component<{ rendering: boolean; resetKey: string; fallback: React.ReactNode; children: React.ReactNode }, { error: Error | null; key: string }> {
  state = { error: null as Error | null, key: this.props.resetKey };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  static getDerivedStateFromProps(props: { resetKey: string }, state: { error: Error | null; key: string }) {
    return props.resetKey !== state.key ? { error: null, key: props.resetKey } : null;
  }
  render() {
    if (this.state.error) {
      if (this.props.rendering) throw this.state.error;
      return this.props.fallback;
    }
    return this.props.children;
  }
}

export const VideoElement: ElementRenderer = ({ element, localFrame, width, height, assets, assetBaseUrl, fps }) => {
  const frame = useFrame();
  const { isRendering } = useEnvironment();
  const { Video } = useMedia();
  // Preview only: a file that fails to load (missing, undecodable) becomes the placeholder.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  // Re-render when a preview proxy becomes ready.
  usePreviewProxies();
  const v = videoProps(element);
  const asset = findAsset(assets, v.assetId, ['video']);
  if (!asset) return <MissingAsset width={width} height={height} radius={v.cornerRadius} />;
  const src = resolveAssetUrl(assetBaseUrl, videoPreviewSrc(asset, isRendering));
  const fallback = <MissingAsset width={width} height={height} radius={v.cornerRadius} />;
  if (!isRendering && failedSrc === src) return <div style={{ width: '100%', height: '100%' }}>{fallback}</div>;
  const onError = isRendering ? undefined : () => setFailedSrc(src);
  return (
    <div data-video-src={asset.src} style={{ width: '100%', height: '100%', borderRadius: v.cornerRadius, overflow: 'hidden' }}>
      <VideoErrorBoundary rendering={isRendering} resetKey={src} fallback={fallback}>
        {/* Re-base the clock: inside, useFrame() is the element's local frame. */}
        <TimeSpan from={frame - localFrame} durationInFrames={Math.max(1, element.durationInFrames)} layout="none" name={`Video: ${element.name}`}>
          <Video
            src={src}
            trimBefore={v.trimStartFrames + VIDEO_TIME_BIAS_SECONDS * fps}
            playbackRate={v.playbackRate}
            loop={v.loop}
            durationInFrames={Math.max(1, element.durationInFrames)}
            sourceDurationInFrames={asset.durationInFrames}
            muted={v.muted}
            volume={(f: number) => videoVolumeAt(element, f)}
            objectFit={v.fit}
            onError={onError}
            style={{ display: 'block', width: '100%', height: '100%' }}
          />
        </TimeSpan>
      </VideoErrorBoundary>
    </div>
  );
};
