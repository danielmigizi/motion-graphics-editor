// "AI revisions": queue edit requests, copy a prompt for a coding agent, and
// review the agent's structured patch: a pasted patch becomes a proposal shown
// in the review over the stage (Current / Proposed), applied or cancelled there.

import { useEffect, useMemo, useState } from 'react';
import type { BridgeError } from '../core/api-contract';
import { parsePatch } from '../core/patch';
import { describeProposal } from '../core/proposal';
import { buildAgentPrompt } from '../core/prompt';
import { formatTimecode } from '../core/timing';
import { Section } from './fields';
import { useAgentLink } from './agentBridge';
import { Icon } from './icons';
import { PASTED_BY, useProposals } from './proposals';
import { useCurrentScene, useEditor } from './store';

const EXPLAIN: Partial<Record<BridgeError['code'], string>> = {
  STALE: 'The document changed after the prompt was copied. Reconcile re-applies the patch on the current revision, and only works if nothing it targets has changed since.',
  LOCKED: 'The patch touches an approved scene. Unlock the scene first, or ask the agent to leave it alone.',
  OUT_OF_SCOPE: 'The patch edits something outside the requested targets, so it was rejected as a whole.',
  INVALID: 'A command in the patch is not valid for this project.',
  PROTOCOL: 'The pasted text is not a valid mge.patch/1 document.',
  PROJECT_MISMATCH: 'The patch was written for a different project.',
};

export function AiPanel() {
  const project = useEditor((s) => s.doc.project);
  const requests = useEditor((s) => s.requests);
  const selection = useEditor((s) => s.selection);
  const playhead = useEditor((s) => s.playhead);
  const scene = useCurrentScene();
  const element = scene?.elements.find((e) => e.id === selection.elementId) ?? null;
  const [instruction, setInstruction] = useState('');
  const [prompt, setPrompt] = useState<{ text: string; revision: number } | null>(null);
  const [patchText, setPatchText] = useState('');
  const [error, setError] = useState<BridgeError | null>(null);
  /** The proposal made from the pasted text, while it waits for review. */
  const [proposalId, setProposalId] = useState<string | null>(null);
  const mine = useProposals((s) => (proposalId && s.proposal?.id === proposalId ? s.proposal : null));
  const mineCheck = useProposals((s) => (mine ? s.check : null));
  const reviewing = useProposals((s) => s.open);
  const outcome = useProposals((s) => (proposalId ? s.log.find((l) => l.id === proposalId) : undefined));
  const [copied, setCopied] = useState(false);
  const agentLinked = useAgentLink((s) => s.status === 'connected');

  const names = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of project.scenes) {
      m.set(s.id, s.name);
      for (const e of s.elements) m.set(e.id, e.name);
    }
    return m;
  }, [project]);

  const add = () => {
    if (useEditor.getState().addRequest(instruction)) setInstruction('');
  };

  const copyPrompt = async () => {
    const text = buildAgentPrompt(project, requests);
    setPrompt({ text, revision: project.revision });
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      useEditor.getState().toast({ tone: 'info', message: 'Clipboard access was blocked — copy the prompt from the box below.' });
    }
  };

  // Once the user decides in the review, the panel is ready for the next patch.
  useEffect(() => {
    if (!outcome) return;
    if (outcome.status === 'applied') setPatchText('');
    if (outcome.status !== 'stale') setProposalId(null);
  }, [outcome]);

  const preview = (reconcile: boolean) => {
    const parsed = parsePatch(patchText);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    // The review renders it; nothing changes until Apply there.
    const r = useProposals.getState().propose(parsed.patch, { agent: PASTED_BY, source: 'paste', reconcile });
    if (!r.ok) {
      setError(r.error);
      return;
    }
    setError(null);
    setProposalId(r.summary.id);
    useProposals.getState().openReview();
  };

  const inReview = mineCheck?.status === 'ready' ? mineCheck : null;
  const headline = useMemo(() => (inReview ? describeProposal(inReview.diff, inReview.candidate).headline : null), [inReview]);

  return (
    <div className="panel-scroll" data-testid="ai-panel">
      <Section title="Request a revision">
        <p className="fine">
          Target: <strong>{element ? `${scene?.name} › ${element.name}` : scene ? `Scene “${scene.name}”` : '—'}</strong> at {formatTimecode(playhead, project.fps)} (f {playhead})
        </p>
        <textarea
          className="input"
          rows={3}
          placeholder={element ? `e.g. Make “${element.name}” enter from the left` : 'e.g. Tighten this scene to 5 seconds'}
          value={instruction}
          data-testid="ai-request-input"
          onChange={(e) => setInstruction(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) add();
          }}
        />
        <div className="btn-row">
          <button className="btn" data-testid="ai-request-add" disabled={!instruction.trim() || !scene} onClick={add}>
            Add request
          </button>
          <span className="fine">⌘↩ to add</span>
        </div>
      </Section>

      <Section title={`Queued requests (${requests.length})`}>
        {requests.length === 0 && <p className="fine">Select an element or scene, describe the change, and add it here. Requests are batched into one prompt.</p>}
        {agentLinked && (
          <p className="fine" data-testid="ai-agent-hint">
            Claude Code sees these requests live. Ask it to “handle my queued requests”; its changes land here as undoable steps and clear the matching requests.
          </p>
        )}
        <ul className="req-list" data-testid="ai-request-list">
          {requests.map((r) => (
            <li key={r.id} data-testid={`ai-request-${r.id}`}>
              <div className="req-target">
                {names.get(r.sceneId) ?? r.sceneId}
                {r.elementId && <> › {names.get(r.elementId) ?? r.elementId}</>}
                <span className="req-ids">
                  {r.sceneId}
                  {r.elementId && ` / ${r.elementId}`} · f {r.frame}
                </span>
              </div>
              <div className="req-text">{r.instruction}</div>
              <button className="mini-btn icon-only" title="Remove request" onClick={() => useEditor.getState().removeRequest(r.id)}>
                <Icon name="close" size={12} />
              </button>
            </li>
          ))}
        </ul>
        <div className="btn-row">
          <button className="btn primary" data-testid="ai-copy-prompt" disabled={!requests.length} onClick={copyPrompt}>
            {copied ? 'Copied' : 'Copy prompt for Claude'}
          </button>
        </div>
        {prompt && (
          <div className="prompt-out">
            <div className="fine">
              Base revision <strong>r{prompt.revision}</strong>
              {prompt.revision !== project.revision && <span className="warn-text"> · document is now r{project.revision}; a patch may come back stale</span>}
            </div>
            <textarea className="input mono-ish" readOnly rows={6} value={prompt.text} data-testid="ai-prompt-output" onFocus={(e) => e.target.select()} />
          </div>
        )}
      </Section>

      <Section title="Apply patch">
        <textarea
          className="input"
          rows={5}
          placeholder="Paste the agent’s reply (mge.patch/1 JSON, fenced or raw)"
          value={patchText}
          data-testid="ai-patch-input"
          onChange={(e) => {
            setPatchText(e.target.value);
            setError(null);
          }}
        />
        <div className="btn-row">
          <button className="btn" data-testid="ai-preview" disabled={!patchText.trim()} onClick={() => preview(false)}>
            Preview changes
          </button>
          <span className="fine">Opens over the stage to compare and play</span>
        </div>
        {error && (
          <div className="notice error" data-testid="ai-patch-error">
            <div className="notice-title">
              <span className="code">{error.code}</span> {error.message}
            </div>
            {error.path && <div className="fine">at {error.path}</div>}
            {error.hint && <div className="fine">{error.hint}</div>}
            {EXPLAIN[error.code] && <div className="fine">{EXPLAIN[error.code]}</div>}
            {error.code === 'STALE' && (
              <button className="btn small" data-testid="ai-reconcile" onClick={() => preview(true)}>
                Reconcile
              </button>
            )}
          </div>
        )}
        {mine && (
          <div className={`notice ${inReview ? '' : 'warn'} patch-preview`} data-testid="ai-patch-preview">
            <div className="notice-title">{mine.patch.summary}</div>
            <div className="fine">{inReview ? `${headline} · based on r${mine.patch.baseRevision}` : 'Out of date: something it changes was edited since. Copy a fresh prompt.'}</div>
            {!reviewing && (
              <button className="btn small" data-testid="ai-open-review" onClick={() => useProposals.getState().openReview()}>
                {inReview ? 'Review' : 'See why'}
              </button>
            )}
          </div>
        )}
      </Section>
    </div>
  );
}
