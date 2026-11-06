// The export render page (render.html, built by Vite into .engine-bundle/ and
// driven by server/engine in headless Chrome). It hosts MainComposition or the
// contact sheet at an exact frame: load() mounts it and reports the
// declared sounds; seek(frame) shows a frame and resolves once every font,
// image and video frame of it is ready (the readiness registry has drained),
// with what the frame's videos play for the export audio mix.

import React, { useState } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { ContactSheet } from '../composition/ContactSheet';
import { MainComposition } from '../composition/MainComposition';
import type { AudioRegistry, MediaReports, RegisteredAudio, VideoFrames, VideoReport } from '../runtime/hostContext';
import { NATIVE_MEDIA } from '../runtime/media';
import { Readiness } from '../runtime/readiness';
import { RuntimeRoot } from '../runtime/RuntimeRoot';
import type { FrameMedia, PlannedAudio, RenderInput, RenderPageApi } from './protocol';

const RENDER_ENV = { isRendering: true, isPlayer: false };
const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

const readiness = new Readiness();
const sounds = new Map<string, RegisteredAudio>();
const audio: AudioRegistry = {
  register(a) {
    sounds.set(a.key, a);
    return () => void (sounds.get(a.key) === a && sounds.delete(a.key));
  },
};
const live = new Map<string, () => VideoReport | null>();
const reports: MediaReports = {
  add(key, read) {
    live.set(key, read);
    return () => void (live.get(key) === read && live.delete(key));
  },
};

let setFrame: (f: number) => void = () => undefined;
let root: Root | null = null;

const Host: React.FC<{ input: RenderInput; videoFrames: VideoFrames }> = ({ input, videoFrames }) => {
  const [frame, set] = useState(0);
  setFrame = set;
  const config = { width: input.width, height: input.height, fps: input.fps, durationInFrames: input.durationInFrames };
  return (
    // A fixed-size stage with a full-bleed flex column inside: the layout every
    // composition is written against.
    <div style={{ width: input.width, height: input.height, display: 'flex', backgroundColor: 'transparent' }}>
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, width: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}>
        <RuntimeRoot frame={frame} config={config} environment={RENDER_ENV} delay={readiness} media={NATIVE_MEDIA} audio={audio} videoFrames={videoFrames} reports={reports}>
          {input.composition === 'main' ? <MainComposition {...input.props} /> : <ContactSheet {...input.props} />}
        </RuntimeRoot>
      </div>
    </div>
  );
};

/**
 * Wait until the frame is complete: nothing pending in the readiness registry
 * (fonts, images, video frames take handles in the frame's layout effects),
 * fonts loaded, and the page has produced a frame with the new DOM. Without
 * that animation frame a screenshot can occasionally return the previous
 * compositor frame (an animation one frame behind).
 */
async function settle(): Promise<void> {
  do {
    await readiness.settled(60_000);
    await document.fonts.ready;
    await nextFrame();
  } while (readiness.busy || document.fonts.status !== 'loaded');
}

const api: RenderPageApi = {
  async load(input) {
    const videoFrames: VideoFrames = {
      lookup(src) {
        const index = input.videoFrames[src];
        return index ? { pts: index.pts, url: (i) => `${index.urlPrefix}${i + 1}.${index.ext}` } : null;
      },
    };
    // A warm page is reused for the next still: replace what it shows.
    if (root) flushSync(() => root!.unmount());
    root = createRoot(document.getElementById('root')!);
    flushSync(() => root!.render(<Host input={input} videoFrames={videoFrames} />));
    await nextFrame();
    await settle();
    const planned: PlannedAudio[] = [...sounds.values()].map((s) => ({
      key: s.key,
      src: s.src,
      from: s.from,
      durationInFrames: s.durationInFrames,
      trimBefore: s.trimBefore,
      volumes: Array.from({ length: s.durationInFrames }, (_, f) => s.volume(f)),
    }));
    return { audio: planned };
  },
  async seek(frame) {
    flushSync(() => setFrame(frame));
    await settle();
    const videos: FrameMedia['videos'] = [];
    for (const [key, read] of live) {
      const r = read();
      if (r) videos.push({ key, ...r });
    }
    return { videos };
  },
};

window.__mge = api;
window.__mgeReady = true;
