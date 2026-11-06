// The outline an agent proposed, for the user to shape before anything is
// built: rename, reorder, retime, delete and add scenes, leave notes for the
// agent, and see the total against the target length. It shows as a card in
// the chat (variant "card", BriefComposer.tsx) and, expanded, in a wide dialog
// (NewVideoDialog.tsx). Approve fills the open blank project, or creates a new
// one (createFlow.ts); Decline only records the answer. Beside Approve, a
// two-way choice says how the build lands (BuildModeChoice): it is the chat's
// Auto-apply switch, worded by its effect here.

import { useRef, type KeyboardEvent } from 'react';
import { isUntouched } from '../core/newProject';
import { addOutlineScene, formatSeconds, lengthVerdict, moveOutlineScene, OUTLINE_LIMITS, outlineSeconds, removeOutlineScene, updateOutlineScene } from '../core/outline';
import { TEMPLATES, type TemplateId } from '../core/templates';
import type { OutlineScene } from '../core/api-contract';
import { approveOutline, declineOutline, editOutline, useCreate } from './createFlow';
import { CommitNumber, CommitText } from './fields';
import { Icon } from './icons';
import { useProposals } from './proposals';
import { useEditor } from './store';

const hintLabel = (hint: string) => (hint in TEMPLATES ? TEMPLATES[hint as TemplateId].label : hint);

/** A scene of an outline in the project: built, proposed (waiting for review) or not built yet. */
export type SceneState = 'built' | 'proposed' | 'pending';

/**
 * One outline scene. `compact` (the chat card) keeps name, length and purpose
 * and leaves what it shows, the notes and template hints to the expanded dialog.
 */
export function SceneRow({ scene, index, count, agent, compact = false }: { scene: OutlineScene; index: number; count: number; agent: string; compact?: boolean }) {
  const update = (changes: Partial<Omit<OutlineScene, 'id'>>) => editOutline((o) => updateOutlineScene(o, scene.id, changes));
  return (
    <li className="ol-row" data-testid={`outline-scene-${index}`} style={{ ['--scene-accent' as string]: `var(--scene-accent-${index % 4})` }}>
      {compact ? (
        // Nothing is built before approval: every scene starts as a hollow dot.
        <span className="ol-dot pending" title="Not built yet" aria-hidden />
      ) : (
        <span className="ol-index tabular" aria-hidden>
          {index + 1}
        </span>
      )}
      <div className="ol-main">
        <div className="ol-line">
          <CommitText className="ol-name" value={scene.name} maxLength={80} testId={`outline-name-${index}`} onCommit={(v) => v.trim() && update({ name: v.trim() })} />
          <span className="ol-duration" title="Length in seconds">
            <CommitNumber value={scene.durationSeconds} min={OUTLINE_LIMITS.minSeconds} max={OUTLINE_LIMITS.maxSeconds} step={0.5} unit="s" testId={`outline-duration-${index}`} onCommit={(v) => update({ durationSeconds: v })} />
          </span>
          <span className="ol-tools">
            <button className="icon-btn small" title="Move up" aria-label={`Move “${scene.name}” up`} disabled={index === 0} onClick={() => editOutline((o) => moveOutlineScene(o, scene.id, index - 1))}>
              <Icon name="up" size={14} />
            </button>
            <button className="icon-btn small" title="Move down" aria-label={`Move “${scene.name}” down`} disabled={index === count - 1} onClick={() => editOutline((o) => moveOutlineScene(o, scene.id, index + 1))}>
              <Icon name="down" size={14} />
            </button>
            <button className="icon-btn small" title="Delete scene" aria-label={`Delete “${scene.name}”`} data-testid={`outline-delete-${index}`} disabled={count === 1} onClick={() => editOutline((o) => removeOutlineScene(o, scene.id))}>
              <Icon name="trash" size={14} />
            </button>
          </span>
        </div>
        <CommitText className="ol-purpose" value={scene.purpose} maxLength={500} placeholder="What this scene has to do" onCommit={(v) => update({ purpose: v })} />
        {!compact && (
          <div className="ol-details">
            <label className="ol-detail">
              <span className="ol-detail-label">On screen</span>
              <CommitText value={scene.onScreenText ?? ''} maxLength={500} placeholder="Exact words, if any" onCommit={(v) => update({ onScreenText: v || undefined })} />
            </label>
            <label className="ol-detail">
              <span className="ol-detail-label">Visuals</span>
              <CommitText value={scene.visuals ?? ''} maxLength={800} placeholder="What we see" onCommit={(v) => update({ visuals: v || undefined })} />
            </label>
            <label className="ol-detail ol-notes">
              <span className="ol-detail-label">Notes</span>
              <CommitText value={scene.notes ?? ''} maxLength={500} placeholder={`For ${agent}`} testId={`outline-notes-${index}`} onCommit={(v) => update({ notes: v || undefined })} />
            </label>
          </div>
        )}
        {!compact && scene.templateHints?.length ? (
          <div className="ol-hints" aria-label="Suggested templates">
            {scene.templateHints.map((h) => (
              <span key={h} className="ol-hint">
                {hintLabel(h)}
              </span>
            ))}
          </div>
        ) : null}
      </div>
    </li>
  );
}

/** Scene lengths as one bar, with the target length marked. */
export function LengthMeter({ scenes, target }: { scenes: OutlineScene[]; target: number }) {
  const total = scenes.reduce((n, s) => n + s.durationSeconds, 0);
  // Headroom past the longer of the two keeps the target mark inside the bar.
  const span = Math.max(total, target) * 1.06;
  const verdict = lengthVerdict(total, target);
  return (
    <div className="ol-meter" data-status={verdict.status} data-testid="outline-meter">
      <div className="ol-bar" aria-hidden>
        {scenes.map((s, i) => (
          <span key={s.id} className="ol-seg" style={{ width: `${(s.durationSeconds / span) * 100}%`, background: `var(--scene-accent-${i % 4})` }} title={`${s.name} · ${formatSeconds(s.durationSeconds)}`} />
        ))}
        <span className="ol-target" style={{ left: `${(target / span) * 100}%` }} />
      </div>
      <div className="ol-meter-text">
        <strong className="tabular">{formatSeconds(total)}</strong>
        <span className="fine">
          of {target} s · <span className="ol-verdict">{verdict.text}</span>
        </span>
      </div>
    </div>
  );
}

/** The editable outline: title, length meter, scene rows and "Add scene". */
export function OutlineReview({ variant = 'dialog' }: { variant?: 'dialog' | 'card' }) {
  const outline = useCreate((s) => s.outline);
  const target = useCreate((s) => s.targetSeconds);
  const agent = useCreate((s) => s.agent ?? 'the agent');
  if (!outline) return null;
  return (
    <div className={variant === 'card' ? 'ol-review ol-compact' : 'cv-body ol-review'} data-testid="outline-review">
      <div className="ol-head">
        <CommitText className="ol-title" value={outline.title} maxLength={120} testId="outline-title" onCommit={(v) => v.trim() && editOutline((o) => ({ ...o, title: v.trim() }))} />
        <LengthMeter scenes={outline.scenes} target={target} />
      </div>
      <ol className="ol-list">
        {outline.scenes.map((s, i) => (
          <SceneRow key={s.id} scene={s} index={i} count={outline.scenes.length} agent={agent} compact={variant === 'card'} />
        ))}
      </ol>
      <button className="ol-add" data-testid="outline-add" disabled={outline.scenes.length >= OUTLINE_LIMITS.maxScenes} onClick={() => editOutline((o) => addOutlineScene(o).outline)}>
        <Icon name="plus" size={14} /> Add scene
      </button>
    </div>
  );
}

/** What approving does: fill the open blank project, or create a new one beside the open work. */
export function useApproveTarget(): 'fill' | 'create' {
  return useEditor((s) => (isUntouched(s.doc.project) ? 'fill' : 'create'));
}

/** "From Claude Code · 3 scenes, 30 s". */
export function outlineMeta(agent: string | null, scenes: number, seconds: number): string {
  return `${agent ? `From ${agent} · ` : ''}${scenes} scene${scenes === 1 ? '' : 's'}, ${formatSeconds(seconds)}`;
}

/**
 * How the approved outline gets built: the chat's Auto-apply switch, worded by
 * what it does here. Off, the agent proposes one scene at a time and waits for
 * each decision; on, it builds every scene straight through and the user
 * iterates afterwards. Choosing here flips the switch in the composer too.
 */
export function BuildModeChoice() {
  const on = useProposals((s) => s.autoApply);
  const agent = useCreate((s) => s.agent ?? 'the agent');
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const choose = (all: boolean, focus = false) => {
    useProposals.getState().setAutoApply(all);
    if (focus) buttons.current[all ? 1 : 0]?.focus();
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const next = ({ ArrowRight: !on, ArrowLeft: !on, Home: false, End: true } as Record<string, boolean>)[e.key];
    if (next === undefined) return;
    // Arrows here choose; they must not move the playhead or nudge the selection.
    e.preventDefault();
    e.stopPropagation();
    choose(next, true);
  };
  const options = [
    { all: false, label: 'Review each scene', testId: 'outline-build-review', title: `${agent} proposes one scene at a time; you apply or cancel each before it builds the next (Auto-apply off).` },
    { all: true, label: 'Build it all', testId: 'outline-build-all', title: `${agent} builds every scene without stopping; each lands as it is built and you iterate afterwards (Auto-apply on).` },
  ];
  return (
    <div className="ins-seg ol-build" role="radiogroup" aria-label="How to build" data-testid="outline-build-mode" onKeyDown={onKey}>
      {options.map((o, i) => (
        <button
          key={o.label}
          ref={(el) => {
            buttons.current[i] = el;
          }}
          type="button"
          role="radio"
          aria-checked={o.all === on}
          tabIndex={o.all === on ? 0 : -1}
          className={o.all === on ? 'on' : ''}
          title={o.title}
          data-testid={o.testId}
          onClick={() => choose(o.all)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Approve & build: the primary action of the card and the dialog. */
export function ApproveButton({ small = false }: { small?: boolean }) {
  const outline = useCreate((s) => s.outline);
  const approving = useCreate((s) => s.approving);
  const autoApply = useProposals((s) => s.autoApply);
  const target = useApproveTarget();
  const then = autoApply ? 'build every scene straight through' : 'build it one scene at a time for your review';
  return (
    <button
      className={`btn primary ${small ? 'small' : ''}`}
      data-testid="outline-approve"
      disabled={approving || !outline?.scenes.length}
      onClick={() => void approveOutline()}
      title={target === 'fill' ? `Fill this project with one empty scene per outline item, then have the agent ${then}` : `Create a new project with one empty scene per outline item, then have the agent ${then}`}
    >
      {approving ? (target === 'fill' ? 'Filling…' : 'Creating…') : 'Approve & build'}
    </button>
  );
}

/** The expanded dialog's footer. */
export function OutlineFooter() {
  const outline = useCreate((s) => s.outline);
  const agent = useCreate((s) => s.agent);
  const approving = useCreate((s) => s.approving);
  const target = useApproveTarget();
  // Filling uses the open project's format; a new project gets the brief's.
  const open = useEditor((s) => `${s.doc.project.width}×${s.doc.project.height}, ${s.doc.project.fps} fps`);
  const brief = useCreate((s) => `${s.brief.width}×${s.brief.height}, ${s.brief.fps} fps`);
  const format = target === 'fill' ? open : brief;
  if (!outline) return null;
  return (
    <footer className="cv-foot">
      <span className="fine ol-foot-meta tabular">
        {outlineMeta(agent, outline.scenes.length, outlineSeconds(outline))} · {target === 'fill' ? 'this project' : 'a new project'} at {format}
      </span>
      <span className="cv-spacer" />
      <BuildModeChoice />
      <button className="btn" data-testid="outline-decline" disabled={approving} onClick={declineOutline}>
        Decline
      </button>
      <ApproveButton />
    </footer>
  );
}
