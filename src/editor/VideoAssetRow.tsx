// Video assets: the preview-proxy state a video asset shows in the Assets
// library ("Preparing preview…"), its length as the library writes it, and
// Insert → Video…. Kept apart from AssetsPanel.tsx so other lanes can grow
// that panel independently.

import { sceneStartFrame } from '../core/timing';
import type { Asset } from '../core/types';
import { newAsset, uploadAsset } from './assets';
import { guardLocked } from './editActions';
import { useEditor } from './store';
import { insertVideoCommands } from './videoEdits';
import { previewState, useVideoProxyStatus } from './videoProxies';

/** "0:42" / "1:05:03" style length. */
export function formatClipLength(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** A video asset's preview proxy, in a line under its figures: "Preparing preview…", ready, or why not. */
export function VideoPreviewState({ asset }: { asset: Asset }) {
  const status = useVideoProxyStatus((s) => s.bySrc[asset.src]);
  const preview = previewState(asset, status);
  return (
    <div className={`video-preview-state ${preview.kind}`} data-testid={`video-preview-state-${asset.id}`}>
      {preview.kind === 'preparing' && <span className="video-spinner" aria-hidden />}
      {preview.text}
    </div>
  );
}

/**
 * Insert → Video…: pick a file, upload it (streamed), and add the asset plus
 * a video element at the playhead of the current scene as ONE undo step.
 */
export async function insertVideoFromFile(): Promise<boolean> {
  const st = useEditor.getState();
  const scene = st.doc.project.scenes.find((s) => s.id === st.selection.sceneId);
  if (!scene || guardLocked(scene)) return false;
  // Scene ids are only unique within a project: the upload must land in the document it started from.
  const session = st.docSession;
  const projectId = st.doc.project.id;
  const fields = await uploadAsset(['video']);
  if (!fields) return false;
  const now = useEditor.getState();
  if (now.docSession !== session || now.doc.project.id !== projectId) {
    now.toast({ tone: 'info', message: `“${fields.name}” was uploaded, but another project is open now, so it was not inserted.` });
    return false;
  }
  const project = now.doc.project;
  const target = project.scenes.find((s) => s.id === scene.id);
  if (!target || target.locked) return false;
  const asset = newAsset(fields);
  const frameInScene = now.playhead - sceneStartFrame(project, target.id);
  const { element, command } = insertVideoCommands(project, target, asset, frameInScene >= 0 && frameInScene < target.durationInFrames ? frameInScene : 0);
  if (!now.run(command, `Insert video ${asset.name}`)) return false;
  useEditor.getState().selectElement(target.id, element.id);
  return true;
}
