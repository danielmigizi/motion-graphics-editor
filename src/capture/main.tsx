// Preview-capture page (capture.html): renders the SAME MainComposition with
// the editor's preview Player at the project's size in CSS px, paused at one
// frame, no controls — used by scripts/verify-export.ts for pixel comparison
// against the exported MP4.
//
//   /capture.html?job=<renderJobId>&frame=<n>   → snapshot from /api/renders/:id/project
//   /capture.html?project=<id>&frame=<n>        → /api/projects/:id
//
// When the frame is painted and fonts + images are loaded:
//   document.body.dataset.ready = '1'; window.__captureReady = true
// On failure: document.body.dataset.ready = 'error' and dataset.error = message.

import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MainComposition } from '../composition/MainComposition';
import type { MainCompositionProps } from '../composition/types';
import { projectDurationInFrames } from '../core/timing';
import type { Project, ProjectFile } from '../core/types';
import { Player, type PlayerRef } from '../runtime';

declare global {
  interface Window {
    __captureReady?: boolean;
    __captureError?: string;
  }
}

const params = new URLSearchParams(window.location.search);
const requestedFrame = Math.max(0, Math.floor(Number(params.get('frame') ?? 0)) || 0);

async function loadProject(): Promise<Project> {
  const job = params.get('job');
  const projectId = params.get('project');
  if (job) {
    const res = await fetch(`/api/renders/${encodeURIComponent(job)}/project`);
    if (!res.ok) throw new Error(`GET /api/renders/${job}/project → ${res.status}`);
    return (await res.json()) as Project;
  }
  if (projectId) {
    const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}`);
    if (!res.ok) throw new Error(`GET /api/projects/${projectId} → ${res.status}`);
    return ((await res.json()) as ProjectFile).project;
  }
  throw new Error('Pass ?job=<renderJobId>&frame=<n> or ?project=<id>&frame=<n>');
}

function fail(message: string) {
  window.__captureError = message;
  document.body.dataset.error = message;
  document.body.dataset.ready = 'error';
  console.error(`[capture] ${message}`);
}

const nextPaint = () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function mediaSettled(): boolean {
  for (const img of Array.from(document.images)) {
    if (!img.complete) return false;
  }
  for (const v of Array.from(document.querySelectorAll('video'))) {
    if (v.readyState < 2) return false;
  }
  return document.fonts.status === 'loaded';
}

async function decodeImages() {
  await Promise.all(Array.from(document.images).map((img) => (img.complete && img.naturalWidth === 0 ? Promise.resolve() : img.decode().catch(() => undefined))));
}

const Capture: React.FC<{ project: Project }> = ({ project }) => {
  const ref = useRef<PlayerRef>(null);
  const buffering = useRef(false);
  const total = Math.max(1, projectDurationInFrames(project));
  const frame = Math.min(requestedFrame, total - 1);
  const inputProps: MainCompositionProps = { project, assetBaseUrl: '/' };

  useEffect(() => {
    let cancelled = false;
    const player = ref.current;
    if (!player) return fail('Player did not mount');
    const onWaiting = () => (buffering.current = true);
    const onResume = () => (buffering.current = false);
    player.addEventListener('waiting', onWaiting);
    player.addEventListener('resume', onResume);

    (async () => {
      player.pause();
      player.seekTo(frame);
      const deadline = performance.now() + 30_000;
      let stableChecks = 0;
      // Require several consecutive settled checks: fonts and images can start
      // loading only after the first layout of the frame.
      while (!cancelled && stableChecks < 3) {
        await nextPaint();
        await document.fonts.ready;
        await decodeImages();
        const settled = !buffering.current && !player.isBuffering?.() && player.getCurrentFrame() === frame && !player.isPlaying() && mediaSettled();
        stableChecks = settled ? stableChecks + 1 : 0;
        if (performance.now() > deadline) {
          return fail(`Timed out waiting for frame ${frame} to settle (buffering=${buffering.current}, frame=${player.getCurrentFrame()}, fonts=${document.fonts.status})`);
        }
        if (!settled) await sleep(50);
      }
      if (cancelled) return;
      await nextPaint();
      document.body.dataset.frame = String(frame);
      document.body.dataset.ready = '1';
      window.__captureReady = true;
    })().catch((err) => fail(err instanceof Error ? err.message : String(err)));

    return () => {
      cancelled = true;
      player.removeEventListener('waiting', onWaiting);
      player.removeEventListener('resume', onResume);
    };
  }, [frame]);

  return (
    <Player
      ref={ref}
      component={MainComposition}
      inputProps={inputProps}
      durationInFrames={total}
      fps={project.fps}
      compositionWidth={project.width}
      compositionHeight={project.height}
      initialFrame={frame}
      autoPlay={false}
      clickToPlay={false}
      style={{ width: project.width, height: project.height, display: 'block' }}
    />
  );
};

const root = createRoot(document.getElementById('root')!);
loadProject()
  .then((project) => root.render(<Capture project={project} />))
  .catch((err) => fail(err instanceof Error ? err.message : String(err)));
