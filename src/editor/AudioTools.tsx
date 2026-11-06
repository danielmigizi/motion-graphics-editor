// Inspector › Project audio, for a music bed: "Duck under voice" writes a
// volume envelope that dips the bed under the voice-over clips
// (src/core/audioDucking.ts) — an ordinary, undoable clip change, drawn on the
// timeline waveform — and Clear removes it.

import { useState } from 'react';
import { duckUnder, likelyVoiceClips } from '../core/audioDucking';
import type { AudioClip } from '../core/types';
import { useEditor } from './store';

const DEPTHS = [6, 9, 12, 18];

export function DuckControl({ clip }: { clip: AudioClip }) {
  const project = useEditor((s) => s.doc.project);
  const run = useEditor((s) => s.run);
  const [depth, setDepth] = useState(12);
  const voices = likelyVoiceClips(project, clip.id);
  const points = clip.volumeEnvelope?.length ?? 0;

  const duck = () => {
    const r = duckUnder(project, clip.id, voices.map((v) => v.id), { dropDb: depth });
    if (!r.ok) {
      useEditor.getState().toast({ tone: 'info', message: r.message });
      return;
    }
    run(r.command, `Duck “${clip.name}” under voice (−${depth} dB)`);
  };

  return (
    <div className="duck-row" data-testid={`duck-${clip.id}`}>
      <button
        className="mini-btn"
        disabled={voices.length === 0}
        data-testid={`duck-apply-${clip.id}`}
        title={voices.length ? `Dip this clip under ${voices.map((v) => `“${v.name}”`).join(', ')}` : 'No voice-over clips: add clips named “Voice…” or “VO…”'}
        onClick={duck}
      >
        Duck under voice
      </button>
      <select className="input select duck-depth" value={depth} aria-label="Duck depth" onChange={(e) => setDepth(Number(e.target.value))}>
        {DEPTHS.map((d) => (
          <option key={d} value={d}>
            −{d} dB
          </option>
        ))}
      </select>
      {points > 0 && (
        <>
          <span className="fine duck-points">Envelope · {points} points</span>
          <button className="mini-btn" data-testid={`duck-clear-${clip.id}`} title="Remove the volume envelope" onClick={() => run({ type: 'updateAudioClip', clipId: clip.id, changes: { volumeEnvelope: [] } }, `Clear “${clip.name}” envelope`)}>
            Clear
          </button>
        </>
      )}
    </div>
  );
}
