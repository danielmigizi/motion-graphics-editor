// The tool rail's Audio popover (ToolRail.tsx): import an audio file, or pick
// from the built-in sound effects (src/core/sfx.ts, previewable). Either
// lands in one undo step as a clip anchored to the scene under the playhead;
// a built-in effect is timed so its peak lands on the playhead. A music bed
// for the whole video is set in Settings; new music, voice-over or sound is
// made in the Generate tab.

import { useState } from 'react';
import { newId } from '../core/ids';
import { SFX, SFX_IDS, sfxCommands, sfxSrc, type SfxId } from '../core/sfx';
import { locateFrame } from '../core/timing';
import type { AudioClip } from '../core/types';
import { newAsset, uploadAsset } from './assets';
import { AudioPlayButton, stopPreview } from './AudioPreview';
import { guardLocked } from './editActions';
import { openGenerate, useGenerate } from './generateStore';
import { Icon } from './icons';
import { useEditor } from './store';

/** Add a built-in effect at the playhead. One undo step. */
export function insertSoundEffect(id: SfxId): boolean {
  const st = useEditor.getState();
  const project = st.doc.project;
  const loc = locateFrame(project, st.playhead);
  if (!loc || loc.scene.locked) return false;
  // Whooshes and risers build up to their peak: start them early so the peak is on the playhead.
  const lead = Math.round((SFX[id].leadFrames * project.fps) / 30);
  const commands = sfxCommands(project, id, loc.scene.id, loc.frameInScene - lead, newId('aud'));
  const label = `Add sound effect “${SFX[id].name}”`;
  return st.run({ type: 'batch', label, commands }, label);
}

/** Upload an audio file and start it at the playhead, anchored to the scene there. One undo step (the asset and its clip). */
export async function importAudioAtPlayhead(): Promise<boolean> {
  const st = useEditor.getState();
  const at = locateFrame(st.doc.project, st.playhead);
  if (!at || guardLocked(at.scene)) return false;
  // The upload must land in the document it started from.
  const session = st.docSession;
  const fields = await uploadAsset(['audio']);
  if (!fields) return false;
  const now = useEditor.getState();
  if (now.docSession !== session) {
    now.toast({ tone: 'info', message: `“${fields.name}” was uploaded, but another project is open now, so it was not added.` });
    return false;
  }
  const loc = locateFrame(now.doc.project, now.playhead);
  if (!loc || guardLocked(loc.scene)) return false;
  const asset = newAsset(fields);
  const clip: AudioClip = {
    id: newId('aud'),
    assetId: asset.id,
    name: asset.name,
    sceneId: loc.scene.id,
    startFrame: loc.frameInScene,
    trimStartFrames: 0,
    durationInFrames: asset.durationInFrames ?? now.doc.project.fps,
    volume: 0.8,
    fadeInFrames: 0,
    fadeOutFrames: 0,
  };
  const label = `Add audio “${asset.name}”`;
  return now.run({ type: 'batch', label, commands: [{ type: 'addAsset', asset }, { type: 'addAudioClip', clip }] }, label);
}

export function AudioMenu({ onDone }: { onDone: () => void }) {
  const scene = useEditor((s) => locateFrame(s.doc.project, s.playhead)?.scene ?? null);
  const [uploading, setUploading] = useState(false);
  const editable = !!scene && !scene.locked;
  return (
    <div className="ins-section" role="group" aria-label="Audio">
      <p className="ins-note">{scene ? (scene.locked ? `“${scene.name}” is approved — unlock it to add sound.` : `Into “${scene.name}”, at the playhead.`) : 'Add a scene first.'}</p>
      <button
        className="ins-item"
        data-testid="audio-import"
        disabled={!editable || uploading}
        title="Upload a WAV, MP3, M4A, AAC or OGG file and start it at the playhead"
        onClick={() => {
          setUploading(true);
          void importAudioAtPlayhead().then((ok) => {
            setUploading(false);
            if (ok) onDone();
          });
        }}
      >
        <Icon name="upload" />
        <span className="ins-item-label">{uploading ? 'Uploading…' : 'Import audio…'}</span>
      </button>
      <button
        className="ins-item"
        data-testid="audio-generate"
        title="Open the Generate tab. Takes land in Assets › Generated for you to pick."
        onClick={() => {
          // Stay on the sound kind already chosen there; otherwise start on music.
          const mode = useGenerate.getState().draft.mode;
          openGenerate({ mode: mode === 'image' ? 'music' : mode });
          onDone();
        }}
      >
        <Icon name="sparkles" />
        <span className="ins-item-label">Generate music, voice or sound…</span>
      </button>
      <span className="ins-kind-label ins-sub">Built-in sound effects</span>
      <ul className="ins-sfx">
        {SFX_IDS.map((id) => (
          <li key={id} className="ins-sfx-row">
            <AudioPlayButton src={sfxSrc(id)} name={SFX[id].name} testId={`audio-sfx-play-${id}`} />
            <button
              className="ins-sfx-add"
              data-testid={`audio-sfx-${id}`}
              disabled={!editable}
              title={`${SFX[id].use} · ${SFX[id].seconds} s · peaks on the playhead`}
              onClick={() => {
                if (!insertSoundEffect(id)) return;
                stopPreview();
                onDone();
              }}
            >
              <span className="ins-name">{SFX[id].name}</span>
              <span className="ins-desc">{SFX[id].use}</span>
            </button>
          </li>
        ))}
      </ul>
      <p className="ins-foot fine">Generated in-house, free to use (CC0). Each is an ordinary clip: trim, move or change its volume in the timeline.</p>
    </div>
  );
}
