// New video, in the chat. On an untouched project with no conversation yet,
// the chat's empty state is the brief: a headline, a tip and example prompts
// (BriefEmptyState), and the composer grows a row of optional settings
// (BriefChips: Length, Format, Outline first). Sending it asks the agent for
// an outline (createFlow.draftOutline). While the agent drafts, a quiet status
// line sits under the messages (DraftingStatus); the outline then arrives as a
// card in the conversation (OutlineCard) to edit, expand, decline or approve,
// with the choice of how it then builds (review each scene, or build it all).

import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { aspectOf, formatSeconds, LENGTH_RANGE, outlineSeconds } from '../core/outline';
import { providerLabel, useChat } from './chat';
import { declineOutline, expandOutline, openFormat, requestComposerFocus, setBrief, setOutlineFirst, stopDrafting, useCreate } from './createFlow';
import { Icon } from './icons';
import { ApproveButton, BuildModeChoice, OutlineReview, type SceneState } from './OutlineReview';
import { useProposals } from './proposals';
import { useEditor } from './store';
import { useChatDraft } from './takes';

const EXAMPLES = [
  'A 30-second launch video for our scheduling app, for founders on LinkedIn',
  'Turn these three screenshots into a product walkthrough',
  'An animated chart of Q3 growth for the all-hands',
];

/** The agent answering in the chat now. */
const useAgentName = () => useChat((s) => providerLabel(s.providers, s.provider));

/** Focus the composer when New video asks for it (each request once, even if the chat mounts later). */
let focused = 0;
export function useComposerFocus(ref: RefObject<HTMLTextAreaElement | null>) {
  const nonce = useCreate((s) => s.composerFocus);
  useEffect(() => {
    if (nonce <= focused || !ref.current) return;
    focused = nonce;
    ref.current.focus();
  }, [nonce, ref]);
}

/** The chat's empty state on a blank project: what to write, with examples to start from. */
export function BriefEmptyState() {
  const pick = (text: string) => {
    useChatDraft.setState({ draft: text });
    requestComposerFocus();
  };
  return (
    <li className="c-brief" data-testid="chat-brief">
      <strong className="c-brief-title">What’s the video?</strong>
      <span className="c-brief-tip">Say who will watch it, where it plays, and roughly how long. Drop in a logo, screenshots or a music track.</span>
      <div className="c-examples" role="group" aria-label="Examples">
        {EXAMPLES.map((e, i) => (
          <button key={e} className="c-example" data-testid={`chat-example-${i}`} onClick={() => pick(e)}>
            {e}
          </button>
        ))}
      </div>
    </li>
  );
}

/** Target length: a chip that opens a slider. */
function LengthChip() {
  const seconds = useCreate((s) => s.brief.targetSeconds);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [open]);
  return (
    <div className="c-brief-pop-anchor" ref={ref}>
      <button className={`c-brief-chip ${open ? 'open' : ''}`} aria-expanded={open} aria-haspopup="dialog" title="Roughly how long the video runs" data-testid="brief-length" onClick={() => setOpen(!open)}>
        <span className="c-brief-chip-key">Length</span>
        <b className="tabular">{seconds} s</b>
        <Icon name="down" size={12} />
      </button>
      {open && (
        <div
          className="c-brief-pop"
          role="dialog"
          aria-label="Target length"
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Escape' || e.key === 'Enter') setOpen(false);
          }}
        >
          <div className="c-brief-pop-head">
            <span>Target length</span>
            <output className="tabular">{seconds} s</output>
          </div>
          <input
            type="range"
            className="c-brief-range"
            min={LENGTH_RANGE.min}
            max={LENGTH_RANGE.max}
            step={5}
            value={seconds}
            autoFocus
            aria-label="Target length in seconds"
            data-testid="brief-length-range"
            onChange={(e) => setBrief({ targetSeconds: Number(e.target.value) })}
          />
          <div className="c-brief-scale fine" aria-hidden>
            <span>{LENGTH_RANGE.min} s</span>
            <span>{LENGTH_RANGE.max} s</span>
          </div>
        </div>
      )}
    </div>
  );
}

/** The settings a brief can carry besides its words; all optional. */
export function BriefChips() {
  // The aspect alone, as in the mockup; the frame rate shows when it is not the usual 30.
  const format = useEditor((s) => {
    const p = s.doc.project;
    return `${aspectOf(p.width, p.height) ?? `${p.width}×${p.height}`}${p.fps === 30 ? '' : ` · ${p.fps} fps`}`;
  });
  const formatTitle = useEditor((s) => `Size and frame rate of this video: ${s.doc.project.width}×${s.doc.project.height}, ${s.doc.project.fps} fps`);
  const outlineFirst = useCreate((s) => s.outlineFirst);
  const agent = useAgentName();
  return (
    <div className="c-brief-chips" role="group" aria-label="Video settings">
      <LengthChip />
      <button className="c-brief-chip" title={formatTitle} data-testid="brief-format" onClick={openFormat}>
        <span className="c-brief-chip-key">Format</span>
        <b className="tabular">{format}</b>
        <Icon name="down" size={12} />
      </button>
      <button
        className={`c-brief-chip toggle ${outlineFirst ? 'on' : ''}`}
        aria-pressed={outlineFirst}
        data-testid="brief-outline-first"
        title={outlineFirst ? `On: ${agent} drafts an outline here for you to edit and approve before anything is built. Turn off to have it build the video straight away.` : `Off: ${agent} builds the whole video straight away. Turn on to approve an outline first.`}
        onClick={() => setOutlineFirst(!outlineFirst)}
      >
        <span className="c-brief-check" aria-hidden>
          {outlineFirst && <Icon name="check" size={12} />}
        </span>
        Outline first
      </button>
    </div>
  );
}

/** Under the messages while the agent drafts the outline, or when it finished without one. */
export function DraftingStatus() {
  const step = useCreate((s) => s.step);
  const noOutline = useCreate((s) => s.noOutline);
  const busy = useChat((s) => s.busy);
  const agent = useAgentName();
  if (step !== 'drafting') return null;
  if (noOutline) {
    return (
      <li className="notice warn" data-testid="chat-no-outline">
        {agent} finished without proposing an outline. Answer it here, or send the brief again.
      </li>
    );
  }
  return (
    <li className="c-status" data-testid="chat-drafting">
      <span className="c-status-text">{agent} is drafting the outline… it opens here for your review.</span>
      {busy && (
        <button className="btn small" data-testid="chat-drafting-stop" onClick={() => void stopDrafting()}>
          Stop
        </button>
      )}
    </li>
  );
}

/** The pending outline, in the conversation. Hidden while it is expanded into the dialog. */
export function OutlineCard() {
  const outline = useCreate((s) => (s.status === 'pending' ? s.outline : null));
  const expanded = useCreate((s) => s.dialog === 'review');
  const agent = useCreate((s) => s.agent);
  const approving = useCreate((s) => s.approving);
  if (!outline || expanded) return null;
  return (
    <li className="c-outline" data-testid="chat-outline-card" title={agent ? `From ${agent}` : undefined}>
      <div className="c-eyebrow c-outline-eyebrow">Proposes an outline</div>
      <OutlineReview variant="card" />
      <div className="c-outline-build">
        <BuildModeChoice />
      </div>
      <div className="c-outline-actions">
        <button className="btn ghost small" data-testid="outline-expand" title="Review it in a wider window, with what each scene shows and notes for the agent" onClick={expandOutline}>
          Expand
        </button>
        <span className="c-spacer" />
        <button className="btn small" data-testid="outline-decline" disabled={approving} onClick={declineOutline}>
          Decline
        </button>
        <ApproveButton small />
      </div>
    </li>
  );
}

/**
 * The approved outline, kept in the conversation as a compact card: each
 * scene's state in the open project, built (has content), proposed (a pending
 * proposal changes it) or still empty. Read-only; the scene strip edits.
 */
export function ApprovedOutlineCard() {
  const outline = useCreate((s) => (s.status === 'approved' ? s.outline : null));
  const scenes = useEditor((s) => s.doc.project.scenes);
  const proposal = useProposals((s) => s.proposal);
  const proposed = useMemo(() => {
    const ids = new Set<string>();
    for (const t of proposal?.patch.targets ?? []) if ('sceneId' in t && t.sceneId) ids.add(t.sceneId);
    return ids;
  }, [proposal]);
  if (!outline) return null;
  // Approving made one scene per item, in order; match by name first in case they were reordered since.
  const stateOf = (name: string, i: number): SceneState => {
    const scene = scenes.find((s) => s.name === name) ?? scenes[i];
    if (!scene) return 'pending';
    if (proposed.has(scene.id)) return 'proposed';
    return scene.elements.length > 0 ? 'built' : 'pending';
  };
  return (
    <li className="c-outline approved" data-testid="chat-outline-approved">
      <div className="c-outline-head">
        <span className="c-badge ok">Approved</span>
        <strong className="c-outline-title">{outline.title}</strong>
        <span className="c-outline-meta tabular">
          {outline.scenes.length} scene{outline.scenes.length === 1 ? '' : 's'} · {formatSeconds(outlineSeconds(outline))}
        </span>
      </div>
      <ol className="c-outline-rows">
        {outline.scenes.map((s, i) => {
          const state = stateOf(s.name, i);
          return (
            <li key={s.id} className="c-outline-row" data-state={state}>
              <span className={`ol-dot ${state}`} title={STATE_TEXT[state]} aria-label={STATE_TEXT[state]} />
              <span className="c-outline-name">{s.name}</span>
              <span className="c-outline-dur tabular">{formatSeconds(s.durationSeconds)}</span>
              {s.purpose && <span className="c-outline-purpose">{s.purpose}</span>}
            </li>
          );
        })}
      </ol>
    </li>
  );
}

const STATE_TEXT: Record<SceneState, string> = { built: 'Built', proposed: 'Proposed, waiting for your review', pending: 'Not built yet' };
