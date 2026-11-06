// Chat with the user's coding agent, inside the editor. Messages carry what
// the user is pointing at; references can be attached or dropped in. The
// agent's edits arrive as proposals to review (a card under the conversation),
// or land at once while Auto-apply is on.

import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { AgentProviderId, ChatAttachment, ChatContext, ChatMessage, ModelOption, ProviderInfo } from '../core/api-contract';
import { describeProposal } from '../core/proposal';
import { formatTimecode } from '../core/timing';
import { handleShellShortcut } from './actions';
import { api, errorText } from './api';
import {
  attributedMessages,
  cancelChat,
  currentContext,
  followOpenProject,
  heldBanner,
  loadProviders,
  modelLabel,
  modelMatches,
  parseMarkdown,
  providerLabel,
  providerStatus,
  resetChat,
  sendChat,
  sentWithOtherAutoApply,
  setChatSettings,
  useChat,
  type MdBlock,
  type MdInline,
} from './chat';
import { sessionView } from './chatSession';
import { SessionDetails } from './SessionDetails';
import { isUntouched } from '../core/newProject';
import { ApprovedOutlineCard, BriefChips, BriefEmptyState, DraftingStatus, OutlineCard, useComposerFocus } from './BriefComposer';
import { AgentStatus } from './AgentStatus';
import { ConnectAgents } from './ConnectAgents';
import { briefRoles, draftOutline, useCreate } from './createFlow';
import { useChatDraft } from './takes';
import { useLayout } from './layout';
import { Icon } from './icons';
import { PermissionPrompt } from './PermissionPrompt';
import { byYou, useProposals, whose } from './proposals';
import { useEditor } from './store';
import './chat.css';

const ACCEPT = 'image/png,image/jpeg,image/webp,image/gif,image/svg+xml,audio/*,.png,.jpg,.jpeg,.webp,.gif,.svg,.wav,.mp3,.m4a,.aac,.ogg';

function AttachmentChip({ a, tag, onRemove }: { a: ChatAttachment; tag?: string; onRemove?: () => void }) {
  return (
    <span className="c-attach" title={a.name}>
      {a.kind === 'audio' ? <span className="c-attach-icon"><Icon name="music" size={14} /></span> : <img src={`/${a.src}`} alt="" />}
      <span className="c-attach-name">{a.name}</span>
      {tag && <span className="c-attach-tag">{tag}</span>}
      {onRemove && (
        <button className="icon-btn small" aria-label={`Remove ${a.name}`} onClick={onRemove}>
          <Icon name="close" size={10} />
        </button>
      )}
    </span>
  );
}

function ContextChip({ ctx, fps, onRemove }: { ctx: ChatContext; fps: number; onRemove?: () => void }) {
  return (
    <span className="c-context" title="What you were pointing at">
      <Icon name="mapPin" size={12} /> {ctx.label} · {formatTimecode(ctx.frame, fps)}
      {onRemove && (
        <button className="icon-btn small" aria-label="Don’t include" onClick={onRemove}>
          <Icon name="close" size={10} />
        </button>
      )}
    </span>
  );
}

const STATUS_TEXT = { available: 'Ready', 'signed-out': 'Not signed in', missing: 'Not installed', unsupported: 'Unavailable' } as const;

/** Agents with more models than this get a search field and a scrolling list. */
const LONG_MODEL_LIST = 12;

/** Which agent and model answer: a compact button that opens a menu grouped by agent. */
function AgentPicker() {
  const providers = useChat((s) => s.providers);
  const provider = useChat((s) => s.provider);
  const model = useChat((s) => s.model);
  const busy = useChat((s) => s.busy);
  const switching = useChat((s) => s.switching);
  const [open, setOpen] = useState(false);
  const [queries, setQueries] = useState<Partial<Record<AgentProviderId, string>>>({});
  const ref = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const name = providerLabel(providers, provider);
  const current = providers.find((p) => p.id === provider);
  const locked = busy || switching;

  // A turn starting while the menu is open closes it: the agent can't change mid-turn.
  useEffect(() => {
    if (locked) setOpen(false);
  }, [locked]);

  useEffect(() => {
    if (!open) {
      setQueries({});
      return;
    }
    void loadProviders();
    const close = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [open]);

  // Keep the menu inside the window: it scrolls rather than running off the bottom.
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!open || !menu) return;
    const fit = () => {
      menu.style.maxHeight = `${Math.max(180, window.innerHeight - menu.getBoundingClientRect().top - 12)}px`;
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [open]);

  // Model rows and the search fields of long lists, in reading order.
  const items = () => Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"], .c-menu-search input') ?? []);

  // Focus the checked model on open, and again if a refreshed list removed the focused one.
  useEffect(() => {
    if (!open || menuRef.current?.contains(document.activeElement)) return;
    const list = items();
    (list.find((el) => el.getAttribute('aria-checked') === 'true') ?? list[0] ?? menuRef.current)?.focus();
  }, [open, providers]);

  const close = () => {
    setOpen(false);
    buttonRef.current?.focus();
  };

  const pick = (id: AgentProviderId, modelId: string) => {
    close();
    void setChatSettings(id, modelId);
  };

  const onMenuKey = (e: KeyboardEvent) => {
    e.stopPropagation(); // arrows, Space and Escape are editor shortcuts too
    const list = items();
    const active = document.activeElement as HTMLElement;
    const i = list.indexOf(active);
    const search = active.tagName === 'INPUT' ? (active as HTMLInputElement) : null;
    const go = (j: number) => {
      e.preventDefault();
      list[(j + list.length) % list.length]?.focus();
    };
    switch (e.key) {
      case 'ArrowDown':
        return go(i + 1);
      case 'ArrowUp':
        return go(i < 0 ? list.length - 1 : i - 1);
      case 'Home':
        return search ? undefined : go(0);
      case 'End':
        return search ? undefined : go(list.length - 1);
      case 'Enter': {
        // Enter in a search field picks its first match.
        if (!search?.value.trim()) return;
        e.preventDefault();
        search.closest('.c-menu-group')?.querySelector<HTMLButtonElement>('[role="menuitemradio"]:not([data-pinned])')?.click();
        return;
      }
      case 'Escape':
        e.preventDefault();
        if (search?.value) return setQueries((q) => ({ ...q, [search.dataset.provider!]: '' }));
        return close();
      case 'Tab':
        return setOpen(false);
    }
    // Typing on a model row of a long list searches it (focus moves before the key lands).
    if (!search && e.key.length === 1 && e.key !== ' ' && !e.metaKey && !e.ctrlKey && !e.altKey) {
      active.closest('.c-menu-group')?.querySelector<HTMLInputElement>('.c-menu-search input')?.focus();
    }
  };

  const modelItem = (p: ProviderInfo, m: ModelOption, pinned = false) => {
    const on = p.id === provider && m.id === model;
    return (
      <button
        key={m.id}
        role="menuitemradio"
        aria-checked={on}
        className="c-menu-item"
        data-pinned={pinned || undefined}
        data-testid={`chat-model-${p.id}-${m.id || 'default'}`}
        onClick={() => pick(p.id, m.id)}
      >
        <span className="c-check">{on && <Icon name="check" size={12} />}</span>
        <span className="c-menu-item-label">{m.label}</span>
      </button>
    );
  };

  /** A long list: search field, the current model pinned on top, the rest scrolling. */
  const longList = (p: ProviderInfo, models: ModelOption[]) => {
    const query = queries[p.id] ?? '';
    const pinned = p.id === provider ? models.find((m) => m.id === model) : undefined;
    const rest = models.filter((m) => m !== pinned && modelMatches(m, query.trim()));
    return (
      <>
        <label className="c-menu-search">
          <Icon name="search" size={12} />
          <input
            type="text"
            value={query}
            placeholder={`Search ${models.length} models`}
            aria-label={`Search ${p.label} models`}
            spellCheck={false}
            autoComplete="off"
            data-provider={p.id}
            data-testid={`chat-model-search-${p.id}`}
            onChange={(e) => setQueries((q) => ({ ...q, [p.id]: e.target.value }))}
          />
        </label>
        <div className="c-menu-models" role="none">
          {pinned && modelItem(p, pinned, true)}
          {rest.map((m) => modelItem(p, m))}
          {rest.length === 0 && <div className="c-menu-none">No other model matches “{query.trim()}”</div>}
        </div>
      </>
    );
  };

  const title = busy ? `${name} is working — wait for it to finish (or stop it) to switch` : switching ? 'Switching…' : `Choose the agent and model · uses your ${name} subscription`;

  return (
    <div className="c-picker" ref={ref}>
      <button
        ref={buttonRef}
        className="c-picker-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-disabled={locked || undefined}
        title={title}
        data-testid="chat-picker"
        onClick={() => !locked && setOpen(!open)}
        onKeyDown={(e) => {
          if (locked || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return;
          e.preventDefault();
          e.stopPropagation();
          setOpen(true);
        }}
      >
        <span className={`c-dot ${current ? providerStatus(current) : ''} ${busy ? 'busy' : ''}`} aria-hidden />
        <span className="c-picker-name">{name}</span>
        <span className="c-picker-model">· {modelLabel(providers, provider, model)}</span>
        <Icon name="down" size={11} />
      </button>
      {open && (
        <div className="c-menu" role="menu" aria-label="Agent and model" ref={menuRef} tabIndex={-1} data-testid="chat-picker-menu" onKeyDown={onMenuKey}>
          {providers.length === 0 && <div className="c-menu-empty">Checking which agents are signed in…</div>}
          {providers.map((p) => {
            const status = providerStatus(p);
            const models = p.models.length ? p.models : [{ id: '', label: 'Default' }];
            return (
              <div key={p.id} className={`c-menu-group ${status}`} role="group" aria-label={p.label} data-testid={`chat-agent-${p.id}`}>
                <div className="c-menu-agent" role={status === 'available' ? 'presentation' : 'menuitem'} aria-disabled={status !== 'available' || undefined}>
                  <span className={`c-dot ${status}`} aria-hidden />
                  <span className="c-menu-agent-name">{p.label}</span>
                  {status !== 'available' && <span className="c-menu-status">{STATUS_TEXT[status]}</span>}
                </div>
                {p.detail && <div className="c-menu-detail">{p.detail}</div>}
                {status === 'available' && (models.length > LONG_MODEL_LIST ? longList(p, models) : models.map((m) => modelItem(p, m)))}
              </div>
            );
          })}
          <div className="c-menu-foot">Switching agents carries a short summary of the conversation over. Each agent uses your own subscription.</div>
        </div>
      )}
    </div>
  );
}

function MdInlines({ nodes }: { nodes: MdInline[] }) {
  return nodes.map((n, i) => {
    switch (n.type) {
      case 'text':
        return <Fragment key={i}>{n.text}</Fragment>;
      case 'code':
        return <code key={i}>{n.text}</code>;
      case 'br':
        return <br key={i} />;
      case 'strong':
        return (
          <strong key={i}>
            <MdInlines nodes={n.children} />
          </strong>
        );
      case 'em':
        return (
          <em key={i}>
            <MdInlines nodes={n.children} />
          </em>
        );
    }
  });
}

function MdBlocks({ blocks }: { blocks: MdBlock[] }) {
  return blocks.map((b, i) => {
    switch (b.type) {
      case 'paragraph':
        return (
          <p key={i}>
            <MdInlines nodes={b.content} />
          </p>
        );
      case 'heading':
        return (
          <p key={i} className="c-md-h">
            <MdInlines nodes={b.content} />
          </p>
        );
      case 'code':
        return (
          <pre key={i}>
            <code>{b.text}</code>
          </pre>
        );
      case 'rule':
        return <hr key={i} />;
      case 'list': {
        const items = b.items.map((it, j) => (
          <li key={j}>
            <MdInlines nodes={it.content} />
            {it.children.length > 0 && <MdBlocks blocks={it.children} />}
          </li>
        ));
        return b.ordered ? (
          <ol key={i} start={b.start === 1 ? undefined : b.start}>
            {items}
          </ol>
        ) : (
          <ul key={i}>{items}</ul>
        );
      }
    }
  });
}

/** An agent's reply text: a small Markdown subset, built as React nodes (never HTML). */
export function ChatMarkdown({ text }: { text: string }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return (
    <div className="c-text c-md">
      <MdBlocks blocks={blocks} />
    </div>
  );
}

/** One of the editor's own long prompts, reduced to what the user would recognise. */
export interface EditorRequest {
  /** "Brief", "Build request" or "Approved outline". */
  label: string;
  /** The brief's words, or the outline's title and scene count. */
  summary: string;
}

/** The brief's own words inside an editor prompt (core/outline.ts briefLines). */
function briefText(text: string): string {
  // The brief can run over several lines; it ends where the next field or a blank line starts.
  const m = /(?:^|\n)Brief: ([\s\S]*?)(?=\n(?:Audience|Tone|Target length|Format): |\n\n|$)/.exec(text);
  return m ? m[1].trim() : '';
}

/**
 * The editor writes three long prompts on the user's behalf (core/outline.ts):
 * the outline request, the direct build request and the approved outline. The
 * chat shows them as a compact card; the message itself is unchanged.
 */
export function editorRequest(text: string | undefined): EditorRequest | null {
  if (!text) return null;
  // Only the editor's own requests fold: each carries the tool instruction the editor writes, which a person's message does not.
  if (text.startsWith('Plan a new video from this brief') && text.includes('Call the `editor_propose_outline` tool once with')) return { label: 'Brief', summary: briefText(text) };
  if ((text.startsWith('Build this video now') || (text.startsWith('Brief: ') && text.includes('\nBuild this video now'))) && text.includes('Write the whole draft with `editor_write_project` using `overwrite: true`')) return { label: 'Build request', summary: briefText(text) };
  const approved = /^I approved the outline "([\s\S]*?)"\. The editor (?:created|filled)[\s\S]*?(\d+) empty scenes?/.exec(text);
  if (approved && text.includes('Build the approved outline scene by scene; use `editor_propose_patch` per scene')) {
    const n = Number(approved[2]);
    return { label: 'Approved outline', summary: `${approved[1]} · ${n} scene${n === 1 ? '' : 's'}` };
  }
  return null;
}

/** The user's message, or one of the editor's prompts as a compact card with the full text behind a disclosure. */
function UserMessage({ m, fps, agent }: { m: ChatMessage; fps: number; agent: string }) {
  const request = useMemo(() => editorRequest(m.text), [m.text]);
  const [full, setFull] = useState(false);
  return (
    <li className={`c-msg c-user ${request ? 'c-request' : ''} ${m.status === 'queued' ? 'queued' : ''} ${m.status === 'cancelled' ? 'cancelled' : ''}`} data-request={request?.label}>
      {m.context && <ContextChip ctx={m.context} fps={fps} />}
      {request ? (
        <>
          <span className="c-request-label">{request.label}</span>
          {request.summary && <div className="c-text c-request-summary">{request.summary}</div>}
          <button className="c-disclose" aria-expanded={full} onClick={() => setFull(!full)}>
            {full ? 'Hide full request' : 'Show full request'}
            <Icon name={full ? 'up' : 'down'} size={11} />
          </button>
          {full && <div className="c-text c-request-full">{m.text}</div>}
        </>
      ) : (
        m.text && <div className="c-text">{m.text}</div>
      )}
      {m.attachments && m.attachments.length > 0 && (
        <div className="c-attach-row">
          {m.attachments.map((a) => (
            <AttachmentChip key={a.src} a={a} />
          ))}
        </div>
      )}
      {m.status === 'queued' && <div className="c-user-note">Waiting for {agent} to finish…</div>}
      {m.status === 'cancelled' && <div className="c-user-note">Not sent (stopped)</div>}
    </li>
  );
}

/** An earlier turn's tool steps, folded away (the latest turn's are in the status line). */
function StepsDisclosure({ steps }: { steps: string[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="c-steps">
      <button className="c-disclose" aria-expanded={open} onClick={() => setOpen(!open)}>
        {steps.length} step{steps.length === 1 ? '' : 's'}
        <Icon name={open ? 'up' : 'down'} size={11} />
      </button>
      {open && (
        <ol className="c-step-list">
          {steps.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ol>
      )}
    </div>
  );
}

/** One message in the conversation. `by` names the agent above a reply; `latest` marks the newest reply. */
export function ChatMessageRow({ m, fps, agent, by, latest }: { m: ChatMessage; fps: number; agent: string; by: string; latest: boolean }) {
  if (m.role === 'user') return <UserMessage m={m} fps={fps} agent={agent} />;
  const parts = m.parts ?? [];
  const texts = parts.flatMap((p) => (p.type === 'text' && p.text.trim() ? [p.text] : []));
  const steps = parts.flatMap((p) => (p.type === 'tool' ? [p.label] : []));
  // The latest turn shows its progress and steps in the status line, not as an empty reply.
  if (texts.length === 0 && latest && (m.status === 'running' || m.status === 'done')) return null;
  return (
    <li className={`c-msg c-agent ${m.status}`}>
      <div className="c-by">{by}</div>
      {texts.map((t, i) => (
        <ChatMarkdown key={i} text={t} />
      ))}
      {!latest && steps.length > 0 && <StepsDisclosure steps={steps} />}
      {m.status === 'error' && <div className="c-error">{m.error ?? 'Something went wrong.'}</div>}
      {m.status === 'cancelled' && <div className="c-stopped">Stopped.</div>}
    </li>
  );
}

/** The proposal waiting for the user: who, what, and a way into the review. */
function ProposalCard() {
  const proposal = useProposals((s) => s.proposal);
  const check = useProposals((s) => s.check);
  const open = useProposals((s) => s.open);
  const replaced = useProposals((s) => s.replaced);
  const headline = useMemo(() => (check?.status === 'ready' ? describeProposal(check.diff, check.candidate).headline : null), [check]);
  // A pasted patch or a generated take is the user's own; its review is enough.
  if (!proposal || !check || byYou(proposal.agent)) return null;
  const stale = check.status !== 'ready';
  return (
    <li className={`c-proposal ${stale ? 'stale' : ''}`} data-testid="chat-proposal-card" data-status={check.status}>
      <div className="c-proposal-kicker">{stale ? `${whose(proposal.agent)} is out of date` : `${proposal.agent} proposes`}</div>
      <div className="c-proposal-title">{proposal.patch.summary}</div>
      <div className="c-proposal-detail">
        {stale ? 'It can no longer be applied: something it changes was edited since.' : headline}
        {!stale && replaced && <> · replaced the earlier one</>}
      </div>
      <div className="c-proposal-actions">
        {/* While the review is open: the same control, quiet, as an "In review" tag. */}
        <button className={open ? 'c-tag' : `btn small ${stale ? '' : 'primary'}`} data-testid="chat-proposal-review" disabled={open} onClick={() => useProposals.getState().openReview()}>
          {open ? 'In review' : stale ? 'See why' : 'Review proposal'}
        </button>
        {!stale && <span className="c-proposal-hint">Nothing changes until you apply it.</span>}
      </div>
    </li>
  );
}

/**
 * What Auto-apply also switches in an agent's own permissions, for the agents
 * where it does: each message runs with the switch as it was when sent (on:
 * the agent's native automatic check; off: it asks you in the editor). OpenCode
 * keeps its own fixed permissions; for them the switch only decides
 * whether edits wait for review.
 */
interface NativeReview {
  /** How a message runs with Auto-apply on: "in Claude Code’s auto mode". */
  runs: string;
  /** The same once the agent is named: "in its auto mode". */
  runsIts: string;
  /** "Auto mode" starts with your next message. */
  starts: string;
  /** Messages already sent "stay in auto mode". */
  stays: string;
  /** What decides instead of asking you. */
  instead: string;
}

const NATIVE_REVIEW: Partial<Record<AgentProviderId, NativeReview>> = {
  claude: { runs: 'in Claude Code’s auto mode', runsIts: 'in its auto mode', starts: 'Auto mode', stays: 'stay in auto mode', instead: 'a safety check reviews its actions instead of asking you (some may still ask)' },
  codex: { runs: 'with Codex’s automatic reviewer', runsIts: 'with its automatic reviewer', starts: 'Automatic review', stays: 'keep the automatic reviewer', instead: 'the reviewer approves or declines its actions instead of asking you' },
  cursor: { runs: 'with Cursor’s Auto-review', runsIts: 'with its Auto-review', starts: 'Auto-review', stays: 'keep Auto-review', instead: 'Cursor’s own check decides on its actions instead of asking you' },
};

/**
 * The switch's tooltip. With Claude Code, Codex and Cursor it also sets the
 * permissions of the messages sent from then on (their automatic check on,
 * asking you first off).
 */
export function autoApplyTitle(on: boolean, agent: string | undefined, provider?: AgentProviderId): string {
  const edits = agent ? `${agent}’s edits` : 'Agent edits';
  const native = provider && NATIVE_REVIEW[provider];
  if (native) {
    return on
      ? `${edits} apply immediately, and messages you send run ${native.runs}. Turn off to review each edit and have it ask before acting, from your next message.`
      : `${edits} wait for your review, and ${agent ?? 'the agent'} asks before acting. Turn on to apply edits immediately and run ${native.runsIts}, from your next message.`;
  }
  return on ? `${edits} apply immediately. Turn off to review each edit first.` : `${edits} wait for your review. Turn on to apply them immediately.`;
}

/** Auto-apply: agent edits land at once instead of waiting for review (and, where the agent has one, its automatic check). */
function AutoApplySwitch({ agent, provider }: { agent?: string; provider?: AgentProviderId }) {
  const on = useProposals((s) => s.autoApply);
  return (
    <button
      className={`c-switch ${on ? 'on' : ''}`}
      role="switch"
      aria-checked={on}
      data-testid="auto-apply-switch"
      title={autoApplyTitle(on, agent, provider)}
      onClick={() => useProposals.getState().setAutoApply(!on)}
    >
      <span className="c-switch-track" aria-hidden>
        <span className="c-switch-knob" />
      </span>
      Auto-apply
    </button>
  );
}

/**
 * Above the composer while Auto-apply is on. For agents whose permissions it
 * switches (NATIVE_REVIEW) it also says when a reply in progress (or a waiting
 * message) still runs with the switch as it was when sent (`sentWith`, from
 * sentWithOtherAutoApply): the permissions change only from the next message,
 * while edits follow the switch at once.
 */
export function AutoApplyNotice({ on, agent, provider, sentWith }: { on: boolean; agent: string; provider: AgentProviderId; sentWith: boolean | null }) {
  const native = NATIVE_REVIEW[provider];
  const next =
    native && sentWith !== null
      ? sentWith
        ? `From your next message ${agent} asks before acting. Messages already sent ${native.stays}.`
        : `${native.starts} starts with your next message. Messages already sent still ask you first.`
      : null;
  if (!on && !next) return null;
  return (
    <div className="c-autoapply" data-testid={on ? 'auto-apply-on' : undefined}>
      {on && <span className="c-autoapply-tag">Auto-apply on</span>}
      <span className="c-autoapply-text">
        {on &&
          (native
            ? `${agent}’s edits apply immediately, without review, and messages you send run ${native.runsIts}: ${native.instead}.`
            : `${agent}’s edits apply immediately, without review.`)}
        {next && (
          <span className="c-autoapply-next" data-testid="auto-apply-next">
            {next}
          </span>
        )}
      </span>
    </div>
  );
}

export function ChatPanel() {
  const chat = useChat();
  const { messages, busy, providers, provider, loaded } = chat;
  // Another project opened mid-turn: this conversation stayed on its own project.
  const banner = heldBanner(chat);
  const fps = useEditor((s) => s.doc.project.fps);
  const autoApply = useProposals((s) => s.autoApply);
  const proposalId = useProposals((s) => s.proposal?.id);
  // Re-render the context chip as the selection and playhead move.
  useEditor((s) => s.selection);
  useEditor((s) => s.playhead);
  const [text, setText] = useState('');
  // "More like this" on a generated take (TakesPanel) writes a draft here.
  const draft = useChatDraft((s) => s.draft);
  useEffect(() => {
    if (draft === null) return;
    setText(draft);
    useChatDraft.setState({ draft: null });
  }, [draft]);
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [uploading, setUploading] = useState(0);
  const [withContext, setWithContext] = useState(true);
  const [dragging, setDragging] = useState(false);
  const listRef = useRef<HTMLUListElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const ctx = currentContext();
  // A blank project with no conversation yet: the composer is the new video's brief.
  const untouched = useEditor((s) => isUntouched(s.doc.project));
  const outlinePending = useCreate((s) => s.status === 'pending' && !!s.outline);
  const briefMode = loaded && messages.length === 0 && untouched && !outlinePending;
  const outlineFirst = useCreate((s) => s.outlineFirst);
  const createStep = useCreate((s) => `${s.step}/${s.status}/${s.noOutline}/${s.dialog}`);
  const [sending, setSending] = useState(false);
  useComposerFocus(inputRef);

  // A new selection means a new thing to point at.
  const selKey = useEditor((s) => `${s.selection.sceneId}/${s.selection.elementId}`);
  useEffect(() => setWithContext(true), [selKey]);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, proposalId, createStep]);

  const upload = async (files: FileList | File[]) => {
    for (const f of Array.from(files)) {
      setUploading((n) => n + 1);
      try {
        const a = await api.uploadAsset(f);
        setAttachments((prev) => [...prev, a]);
      } catch (e) {
        useEditor.getState().toast({ tone: 'error', message: `Could not attach ${f.name}: ${errorText(e).message}` });
      } finally {
        setUploading((n) => n - 1);
      }
    }
  };

  const send = async () => {
    if (briefMode) {
      if (!text.trim() || sending || uploading > 0) return;
      setSending(true);
      try {
        if (await draftOutline({ text, attachments, outlineFirst })) {
          setText('');
          setAttachments([]);
        }
      } finally {
        setSending(false);
      }
      return;
    }
    if (!text.trim() && attachments.length === 0) return;
    if (await sendChat(text, attachments, withContext ? ctx : undefined)) {
      setText('');
      setAttachments([]);
    }
  };

  const agent = providerLabel(providers, provider);
  const sentWith = useMemo(() => sentWithOtherAutoApply(messages, autoApply), [messages, autoApply]);
  const session = useMemo(() => sessionView(messages), [messages]);
  const info = providers.find((p) => p.id === provider);
  const unavailable = info && !info.available ? info : null;
  const attributed = useMemo(() => attributedMessages(messages), [messages]);
  // The latest reply's steps live in the status line; earlier replies fold theirs.
  const latestReply = useMemo(() => [...messages].reverse().find((m) => m.role === 'assistant')?.id, [messages]);
  // An approved outline stays in the conversation, just before the message that handed it over.
  const approvedOutline = useCreate((s) => (s.status === 'approved' && s.outline ? s.outline.title : null));
  const approvedProject = useCreate((s) => s.projectId);
  const projectId = useEditor((s) => s.doc.project.id);
  const approvedBefore = useMemo(() => {
    if (!approvedOutline || approvedProject !== projectId) return undefined;
    return [...messages].reverse().find((m) => m.role === 'user' && m.text?.startsWith(`I approved the outline "${approvedOutline}"`))?.id;
  }, [messages, approvedOutline, approvedProject, projectId]);
  const roles = useMemo(() => briefRoles(attachments), [attachments]);

  return (
    <div
      className={`c-panel ${dragging ? 'dragging' : ''}`}
      data-testid="chat-panel"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(e) => e.currentTarget === e.target && setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        if (e.dataTransfer.files.length) void upload(e.dataTransfer.files);
      }}
    >
      <div className="c-head">
        <AgentPicker />
        <div className="c-head-actions">
          {/* Unmounted by New chat, so a fresh conversation starts with it closed. */}
          {messages.length > 0 && session.kind !== 'none' && <SessionDetails view={session} />}
          {messages.length > 0 && (
            <button className="btn ghost small c-new-chat" data-testid="chat-new" onClick={() => void resetChat()} title="Start a fresh conversation (the video is not changed)">
              New chat
            </button>
          )}
          <button className="icon-btn c-hide" data-testid="chat-hide" title="Hide the chat" aria-label="Hide the chat" onClick={() => useLayout.getState().setChatOpen(false)}>
            <Icon name="close" />
          </button>
        </div>
      </div>

      {banner && (
        <div className="c-held" role="status" data-testid="chat-held">
          <span>{banner.text}</span>
          <button className="btn small" data-testid="chat-follow-project" onClick={followOpenProject}>
            {banner.action}
          </button>
        </div>
      )}
      <ul className="c-list" ref={listRef} data-testid="chat-messages">
        {briefMode && <BriefEmptyState />}
        {loaded && messages.length === 0 && !untouched && (
          <li className="c-empty">
            <strong>Ask {agent} to change anything.</strong>
            <span>Click something in the preview to point at it, or drop in reference images and music.</span>
            <span className="fine">e.g. “Make the bottle bounce in” · “Use this logo instead” · “Tighten the intro to 2 seconds”</span>
          </li>
        )}
        {messages.map((m) => (
          <Fragment key={m.id}>
            {m.id === approvedBefore && <ApprovedOutlineCard />}
            <ChatMessageRow
              m={m}
              fps={fps}
              agent={agent}
              latest={m.id === latestReply}
              by={
                m.provider
                  ? attributed.has(m.id)
                    ? `${providerLabel(providers, m.provider)} · ${modelLabel(providers, m.provider, m.model)}`
                    : providerLabel(providers, m.provider)
                  : agent
              }
            />
          </Fragment>
        ))}
        <DraftingStatus />
        <OutlineCard />
        <ProposalCard />
      </ul>
      <AgentStatus />

      <PermissionPrompt />
      {unavailable ? (
        <>
          <div className="c-unavailable" data-testid="chat-unavailable">
            <strong>{agent} isn’t ready</strong>
            <span>{unavailable.detail}</span>
            <span className="c-unavailable-hint">Fix that and check again below, or pick another agent in the menu above.</span>
          </div>
          <ConnectAgents compact />
          {/* An agent in a terminal still edits through the editor, so the switch stays. */}
          <div className="c-switch-row">
            <AutoApplySwitch />
          </div>
        </>
      ) : (
        <div className={`c-composer ${briefMode ? 'brief' : ''}`}>
          <AutoApplyNotice on={autoApply} agent={agent} provider={provider} sentWith={sentWith} />
          {briefMode && <BriefChips />}
          <div className="c-box">
            {ctx && withContext && !briefMode && (
              <div className="c-chips">
                <ContextChip ctx={ctx} fps={fps} onRemove={() => setWithContext(false)} />
              </div>
            )}
            {attachments.length > 0 || uploading > 0 ? (
              <div className="c-attach-row">
                {attachments.map((a, i) => (
                  <AttachmentChip key={a.src} a={a} tag={briefMode ? (i === roles.music ? 'Music bed' : i === roles.logo ? 'Logo' : undefined) : undefined} onRemove={() => setAttachments((prev) => prev.filter((_, j) => j !== i))} />
                ))}
                {uploading > 0 && <span className="fine">Uploading…</span>}
              </div>
            ) : null}
            <textarea
              ref={inputRef}
              className="input"
              rows={2}
              value={text}
              placeholder={briefMode ? 'Describe the video… (Enter to send)' : busy ? `${agent} is working… (your message will wait its turn)` : `Ask ${agent}… (Enter to send)`}
              data-testid="chat-input"
              onChange={(e) => setText(e.target.value)}
              onPaste={(e) => {
                if (e.clipboardData.files.length) {
                  e.preventDefault();
                  void upload(e.clipboardData.files);
                }
              }}
              onKeyDown={(e) => {
                e.stopPropagation();
                // ⌘J closes the chat and ⌘K opens the palette from the composer too (actions.ts).
                if (handleShellShortcut(e.nativeEvent)) return;
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            <div className="c-actions">
              <button className="icon-btn" title="Attach images or audio" aria-label="Attach" data-testid="chat-attach" onClick={() => fileRef.current?.click()}>
                <Icon name="paperclip" size={16} />
              </button>
              <input
                ref={fileRef}
                type="file"
                accept={ACCEPT}
                multiple
                hidden
                data-testid="chat-file"
                onChange={(e) => {
                  if (e.target.files?.length) void upload(e.target.files);
                  e.target.value = '';
                }}
              />
              <AutoApplySwitch agent={agent} provider={provider} />
              <span className="c-spacer" />
              {busy && (
                <button className="btn c-stop" data-testid="chat-stop" title={`Stop ${agent}`} onClick={() => void cancelChat()}>
                  <Icon name="stop" size={12} />
                  Stop
                </button>
              )}
              <button
                className="btn primary c-send"
                aria-label="Send"
                data-testid="chat-send"
                title={briefMode && !text.trim() ? 'Describe the video first' : `Runs on your own ${agent} subscription`}
                disabled={briefMode ? !text.trim() || uploading > 0 || sending : (!text.trim() && attachments.length === 0) || uploading > 0}
                onClick={() => void send()}
              >
                <Icon name="send" size={13} />
              </button>
            </div>
          </div>
        </div>
      )}
      {dragging && <div className="c-drop">Drop to attach</div>}
    </div>
  );
}
