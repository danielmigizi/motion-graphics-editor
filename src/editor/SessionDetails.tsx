// "Session" in the chat head: a small disclosure with what the agent's session
// started with (model, permission mode and whether the agent reported it or
// the editor set it, skills, MCP servers) and, kept apart, what the session
// used (skills invoked, MCP tools called). Derived from the conversation's
// replies (chatSession.ts), so it survives a reload. What an agent does not
// report says so, never "none".

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { EDITOR_MCP_SERVER } from '../core/generation';
import { providerLabel, useChat } from './chat';
import { Icon } from './icons';
import { permissionModeLabel, permissionSourceLabel, serversByStatus, type SessionView } from './chatSession';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const serverName = (name: string) => (name === EDITOR_MCP_SERVER ? `${name} (this editor)` : name);

function Row({ term, children }: { term: string; children: ReactNode }) {
  return (
    <>
      <dt>{term}</dt>
      <dd>{children}</dd>
    </>
  );
}

const None = ({ children }: { children: ReactNode }) => <span className="c-session-none">{children}</span>;

/** The panel's content for one view (exported for tests). */
export function SessionDetailsBody({ view, agent }: { view: Exclude<SessionView, { kind: 'none' }>; agent: string }) {
  if (view.kind === 'unreported') {
    return <p className="c-session-note">{agent} doesn’t report its skills or MCP servers to the editor. Its tool steps are listed under each reply.</p>;
  }
  if (view.kind === 'missing') {
    return (
      <p className="c-session-note">
        {view.why === 'starting'
          ? `Waiting for ${agent} to report its session…`
          : view.why === 'stopped'
            ? `${agent} stopped before it reported its session, so this reply has no details.`
            : 'This reply is from before the editor kept session details. Your next message will show them.'}
      </p>
    );
  }
  const { info, skills, servers, replies } = view;
  const groups = info.mcpServers ? serversByStatus(info.mcpServers) : null;
  const source = permissionSourceLabel(info, agent);
  // Absent on Claude Code replies: it reports Skill calls.
  const skillUse = info.skillUsageReported !== false;
  return (
    <>
      <dl className="c-session-grid">
        <Row term="Model">{info.model ?? <None>Not reported</None>}</Row>
        <Row term="Permissions">
          {permissionModeLabel(info.permissionMode)}
          {source && <span className="c-session-source" data-source={info.permissionSource ?? 'reported'}>{source}</span>}
        </Row>
        <Row term="Session">{info.sessionId ? <span title={info.sessionId}>{info.sessionId.slice(0, 8)}…</span> : <None>Not reported</None>}</Row>
      </dl>

      <section className="c-session-section" data-testid="session-used">
        <h3 className="c-session-kicker">Used in this session · {plural(replies, 'reply', 'replies')}</h3>
        <dl className="c-session-grid">
          <Row term="Skills">
            {skills.length ? (
              <ul className="c-session-list">
                {skills.map((s) => (
                  <li key={s.name}>
                    {s.name}
                    {s.calls > 1 && <span className="c-session-count"> ×{s.calls}</span>}
                  </li>
                ))}
              </ul>
            ) : skillUse ? (
              <None>None invoked</None>
            ) : (
              <None>Not reported by {agent}</None>
            )}
          </Row>
          <Row term="MCP">
            {servers.length ? (
              <ul className="c-session-list">
                {servers.map((s) => (
                  <li key={`${s.reported}:${s.name}`} title={s.tools.join(', ')}>
                    {serverName(s.name)}
                    <span className="c-session-count"> · {plural(s.calls, 'call')}</span>
                    {!s.reported && groups !== null && <span className="c-session-none"> (not in the reported list)</span>}
                  </li>
                ))}
              </ul>
            ) : groups === null ? (
              // Without a server list, a call the agent did not name as MCP may still have been one.
              <None>None seen</None>
            ) : (
              <None>No MCP tools called</None>
            )}
          </Row>
        </dl>
      </section>

      <section className="c-session-section" data-testid="session-available">
        <h3 className="c-session-kicker">Available when it started</h3>
        <dl className="c-session-grid">
          <Row term="Skills">
            {info.skills === undefined ? <None>Not reported by {agent}</None> : info.skills.length ? <span className="c-session-names">{info.skills.join(', ')}</span> : <None>None listed</None>}
          </Row>
          <Row term="MCP">
            {groups === null ? (
              <None>Not reported by {agent}</None>
            ) : groups.length ? (
              <ul className="c-session-list">
                {groups.map((g) => (
                  <li key={g.status} className={`c-session-status ${g.status}`}>
                    <span className="c-session-status-label">
                      {g.label} ({g.names.length}):
                    </span>{' '}
                    <span className="c-session-names">{g.names.map(serverName).join(', ')}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <None>None listed</None>
            )}
          </Row>
        </dl>
        {info.tools.length > 0 && (
          <details className="c-session-tools">
            <summary>
              Other reported tools ({info.tools.length})
            </summary>
            <span className="c-session-names">{info.tools.join(', ')}</span>
          </details>
        )}
      </section>

      <p className="c-session-note">
        {skillUse
          ? `Available is what ${agent} listed at start, not what it used. The editor gives it the motion-video workflow in its instructions; only a Skill call counts as using a skill.`
          : `Available is what ${agent} listed, not what it used. ${agent} doesn’t report which skills it invokes, so none are counted; the motion-video workflow in the editor’s instructions is not a skill call.`}
      </p>
    </>
  );
}

/** The head's "Session" button and its panel. Mount it only once the conversation has a reply. */
export function SessionDetails({ view }: { view: Exclude<SessionView, { kind: 'none' }> }) {
  const agent = useChat((s) => providerLabel(s.providers, view.provider));
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [open]);

  return (
    <div
      className="c-session"
      ref={ref}
      onKeyDown={(e) => {
        if (!open) return;
        e.stopPropagation(); // Escape and arrows are editor shortcuts too
        if (e.key !== 'Escape') return;
        setOpen(false);
        buttonRef.current?.focus();
      }}
    >
      <button
        ref={buttonRef}
        className="btn ghost small c-session-btn"
        aria-expanded={open}
        aria-controls={panelId}
        data-testid="chat-session"
        title={`Model, permissions, skills and MCP servers in this ${agent} session`}
        onClick={() => setOpen(!open)}
      >
        Session
        <Icon name={open ? 'up' : 'down'} size={11} />
      </button>
      {open && (
        <div className="c-session-panel" id={panelId} role="region" aria-label={`${agent} session`} data-testid="chat-session-panel">
          <div className="c-session-title">{agent} session</div>
          <SessionDetailsBody view={view} agent={agent} />
        </div>
      )}
    </div>
  );
}
