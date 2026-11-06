// Session details in the chat: what a session reported at start is never
// shown as use, use is counted only within the same agent and session, what an
// agent does not report says so (never "none"), a mode the editor only set is
// told from one the agent reported, and Auto-apply's permissions are described
// per agent and per message. Also: a cancelled permission request clears its card.

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AgentProviderId, ChatMessage, ChatPart, ChatSessionInfo } from '../core/api-contract';
import { sentWithOtherAutoApply } from './chat';
import { AutoApplyNotice, autoApplyTitle } from './ChatPanel';
import { permissionModeLabel, permissionSourceLabel, serversByStatus, sessionView, type SessionView } from './chatSession';
import { askPermission, cancelPermission, usePermissions } from './permissions';
import { SessionDetailsBody } from './SessionDetails';

const info = (sessionId: string, over: Partial<ChatSessionInfo> = {}): ChatSessionInfo => ({
  sessionId,
  model: 'claude-opus-5-5',
  permissionMode: 'default',
  tools: ['Bash', 'Read', 'Skill'],
  mcpServers: [
    { name: 'claude.ai Slack', status: 'connected', tools: 19 },
    { name: 'motion-editor', status: 'connected', tools: 18 },
    { name: 'claude.ai Meetings', status: 'needs-auth', tools: 0 },
  ],
  skills: ['motion-video', 'pr-package'],
  ...over,
});
const tool = (name: string, meta: { skill?: string; mcpServer?: string; mcpTool?: string } = {}): ChatPart => ({ type: 'tool', name, label: name, ...meta });
/** What the Cursor provider keeps: the mode it set, no catalogs, no skill use. */
const cursorInfo = (sessionId: string, over: Partial<ChatSessionInfo> = {}): ChatSessionInfo => ({ sessionId, model: 'composer-2.5[fast=false]', permissionMode: 'cursor-manual', permissionSource: 'configured', skillUsageReported: false, tools: [], ...over });
const user = (id: string, over: Partial<ChatMessage> = {}): ChatMessage => ({ id, role: 'user', at: 0, status: 'done', text: 'hi', ...over });
const reply = (id: string, over: Partial<ChatMessage> = {}): ChatMessage => ({ id, role: 'assistant', at: 0, status: 'done', provider: 'claude', model: '', parts: [], ...over });

const slack = tool('mcp__claude_ai_Slack__slack_send_message', { mcpServer: 'claude.ai Slack' });
const editor = tool('mcp__motion-editor__editor_get_context', { mcpServer: 'motion-editor' });
const skill = tool('Skill', { skill: 'pr-package' });

describe('sessionView', () => {
  it('nothing before the first reply; agents that report nothing, and Claude Code replies without details, say why', () => {
    expect(sessionView([])).toEqual({ kind: 'none' });
    expect(sessionView([user('u1')])).toEqual({ kind: 'none' });
    expect(sessionView([reply('a1', { provider: 'opencode', parts: [tool('mcp__claude_ai_Slack__x')] })])).toEqual({ kind: 'unreported', provider: 'opencode' });
    // Codex and Cursor keep details now: their replies from before that are older, not "doesn't report".
    expect(sessionView([reply('a1', { provider: 'codex', parts: [tool('mcp__motion_editor__editor_get_context')] })])).toEqual({ kind: 'missing', provider: 'codex', why: 'older' });
    expect(sessionView([reply('a1', { provider: 'cursor', status: 'running' })])).toEqual({ kind: 'missing', provider: 'cursor', why: 'starting' });
    expect(sessionView([reply('a1', { provider: 'cursor', status: 'error', error: 'Cursor Agent is signed out.' })])).toEqual({ kind: 'missing', provider: 'cursor', why: 'stopped' });
    expect(sessionView([reply('a1', { status: 'running' })])).toEqual({ kind: 'missing', provider: 'claude', why: 'starting' });
    expect(sessionView([reply('a1', { status: 'error', error: 'Auto-apply is on…' })])).toEqual({ kind: 'missing', provider: 'claude', why: 'stopped' });
    // Saved before the editor kept session details (also before agent choice: no provider).
    expect(sessionView([reply('a1', { provider: undefined, parts: [slack] })])).toEqual({ kind: 'missing', provider: 'claude', why: 'older' });
  });

  it('available is not used: listed skills, the Skill tool and connected servers count for nothing until a step uses them', () => {
    const view = sessionView([user('u1'), reply('a1', { session: info('s1'), parts: [{ type: 'text', text: 'Done.' }, tool('Bash')] })]);
    expect(view).toMatchObject({ kind: 'session', replies: 1, skills: [], servers: [] });
  });

  it('counts use over every reply of the latest session only: not other sessions, not other agents', () => {
    const messages = [
      reply('a1', { session: info('s1'), parts: [skill, slack, slack] }),
      reply('a2', { session: info('s2'), parts: [tool('Skill', { skill: 'other-session' }), editor] }),
      // Another agent, even one claiming the same session id, never counts.
      reply('a3', { provider: 'codex', session: info('s1'), parts: [tool('Skill', { skill: 'codex-leak' })] }),
      // An older Claude Code reply without details is not part of any session.
      reply('a4', { parts: [tool('Skill', { skill: 'no-details' })] }),
      reply('a5', { session: info('s1', { permissionMode: 'auto' }), parts: [skill, editor, tool('mcp__claude_ai_Notion__search')] }),
    ];
    const view = sessionView(messages) as Extract<SessionView, { kind: 'session' }>;
    expect(view.kind).toBe('session');
    expect(view.info.permissionMode).toBe('auto');
    expect(view.replies).toBe(2);
    expect(view.skills).toEqual([{ name: 'pr-package', calls: 2 }]);
    expect(view.servers).toEqual([
      { name: 'claude.ai Slack', calls: 2, tools: ['slack_send_message'], reported: true },
      { name: 'claude_ai_Notion', calls: 1, tools: ['search'], reported: false },
      { name: 'motion-editor', calls: 1, tools: ['editor_get_context'], reported: true },
    ]);
    // The other session, on its own.
    expect(sessionView(messages.slice(0, 2))).toMatchObject({ replies: 1, skills: [{ name: 'other-session', calls: 1 }], servers: [{ name: 'motion-editor', calls: 1 }] });
  });

  it('a reply whose session id was not reported counts only itself', () => {
    const view = sessionView([reply('a1', { session: info('s1'), parts: [skill] }), reply('a2', { session: { tools: [] }, parts: [editor] })]);
    expect(view).toMatchObject({ kind: 'session', replies: 1, skills: [], servers: [{ name: 'motion-editor', calls: 1 }] });
  });

  it('takes the MCP tool name the agent reported, not one cut from the step name', () => {
    // Cursor's own step name is "<server>-<tool>"; Codex keeps raw server names with any characters.
    const view = sessionView([
      reply('a1', {
        provider: 'cursor',
        session: cursorInfo('c1'),
        parts: [tool('motion-editor-editor_get_context', { mcpServer: 'motion-editor', mcpTool: 'editor_get_context' }), tool('mcp__raw-server_name__tool__x', { mcpServer: 'raw-server_name', mcpTool: 'tool__x' })],
      }),
      // The same session id from another agent never counts.
      reply('a2', { provider: 'codex', session: { ...cursorInfo('c1'), permissionMode: 'codex-manual' }, parts: [tool('mcp__other__x', { mcpServer: 'other', mcpTool: 'x' })] }),
      reply('a3', { provider: 'cursor', session: cursorInfo('c1'), parts: [tool('mcp__raw-server_name__tool__x', { mcpServer: 'raw-server_name', mcpTool: 'tool__x' })] }),
    ]);
    expect(view).toMatchObject({
      kind: 'session',
      provider: 'cursor',
      replies: 2,
      skills: [],
      servers: [
        { name: 'raw-server_name', calls: 2, tools: ['tool__x'], reported: true },
        { name: 'motion-editor', calls: 1, tools: ['editor_get_context'], reported: true },
      ],
    });
  });
});

describe('labels', () => {
  it('groups reported MCP servers by status, connected first', () => {
    const groups = serversByStatus([
      { name: 'claude.ai Meetings', status: 'needs-auth', tools: 0 },
      { name: 'claude.ai Slack', status: 'connected', tools: 19 },
      { name: 'plugin:design:gmail', status: 'failed', tools: 0 },
      { name: 'motion-editor', status: 'connected', tools: 18 },
      { name: 'odd', status: 'weird', tools: 0 },
    ]);
    expect(groups).toEqual([
      { status: 'connected', label: 'Connected', names: ['claude.ai Slack', 'motion-editor'] },
      { status: 'needs-auth', label: 'Needs sign-in', names: ['claude.ai Meetings'] },
      { status: 'failed', label: 'Failed', names: ['plugin:design:gmail'] },
      { status: 'weird', label: 'weird', names: ['odd'] },
    ]);
  });

  it('names permission modes in plain words', () => {
    expect([permissionModeLabel('default'), permissionModeLabel('auto'), permissionModeLabel(undefined), permissionModeLabel('plan')]).toEqual([
      'Manual: asks you first',
      'Auto: a safety check reviews actions',
      'Not reported',
      'plan',
    ]);
    expect(['codex-manual', 'codex-auto-review', 'cursor-manual', 'cursor-auto-review'].map(permissionModeLabel)).toEqual([
      'Manual: asks you first',
      'Auto-review: Codex’s reviewer checks actions',
      'Manual: asks you first',
      'Auto-review: Cursor checks actions itself',
    ]);
  });

  it('tells a mode the agent reported from one the editor only set', () => {
    expect(permissionSourceLabel(cursorInfo('c1'), 'Cursor Agent')).toBe('Set by the editor; Cursor Agent doesn’t report it');
    expect(permissionSourceLabel({ tools: [], permissionMode: 'codex-auto-review', permissionSource: 'reported' }, 'Codex')).toBe('Reported by Codex');
    // Claude Code replies carry no source: its init event reports the mode.
    expect(permissionSourceLabel(info('s1'), 'Claude Code')).toBe('Reported by Claude Code');
    expect(permissionSourceLabel({ tools: [] }, 'Claude Code')).toBeNull();
  });
});

describe('the session panel', () => {
  const body = (view: Exclude<SessionView, { kind: 'none' }>, agent = 'Claude Code') => renderToStaticMarkup(createElement(SessionDetailsBody, { view, agent }));

  it('shows used and available apart, and says when the CLI did not report a list', () => {
    const html = body(sessionView([reply('a1', { session: info('s1', { skills: undefined }), parts: [slack] })]) as Exclude<SessionView, { kind: 'none' }>);
    expect(html).toContain('Used in this session · 1 reply');
    expect(html).toContain('None invoked');
    expect(html).toContain('claude.ai Slack<span class="c-session-count"> · 1 call</span>');
    expect(html).toContain('Not reported by Claude Code');
    expect(html).toContain('Connected (2):');
    expect(html).toContain('motion-editor (this editor)');
    expect(html).toContain('Manual: asks you first');
    expect(html).toContain('motion-video workflow in its instructions; only a Skill call counts as using a skill');
  });

  it('lists reported skills as available only', () => {
    const html = body(sessionView([reply('a1', { session: info('s1') })]) as Exclude<SessionView, { kind: 'none' }>);
    expect(html).toContain('motion-video, pr-package');
    expect(html).toContain('None invoked');
    expect(html).toContain('No MCP tools called');
  });

  it('does not label an unmatched MCP tool as built-in when the reported server list is incomplete', () => {
    const html = body(sessionView([reply('a1', { session: info('s1', { tools: ['Read', 'mcp__unreported__search'], mcpServers: [] }) })]) as Exclude<SessionView, { kind: 'none' }>);
    expect(html).toContain('Other reported tools (2)');
    expect(html).toContain('mcp__unreported__search');
    expect(html).not.toContain('Built-in tools');
  });

  it('is honest about agents and replies without details', () => {
    expect(body({ kind: 'unreported', provider: 'opencode' }, 'OpenCode')).toContain('OpenCode doesn’t report its skills or MCP servers');
    expect(body({ kind: 'missing', provider: 'claude', why: 'older' })).toContain('from before the editor kept session details');
    expect(body({ kind: 'missing', provider: 'codex', why: 'older' }, 'Codex')).toContain('from before the editor kept session details');
    expect(body({ kind: 'missing', provider: 'claude', why: 'stopped' })).toContain('stopped before it reported its session');
    expect(body({ kind: 'missing', provider: 'cursor', why: 'starting' }, 'Cursor Agent')).toContain('Waiting for Cursor Agent to report its session');
  });

  it('Claude Code’s mode is reported; its skill use counts', () => {
    const html = body(sessionView([reply('a1', { session: info('s1', { permissionMode: 'auto' }) })]) as Exclude<SessionView, { kind: 'none' }>);
    expect(html).toContain('Auto: a safety check reviews actions');
    expect(html).toContain('Reported by Claude Code');
    expect(html).not.toContain('Set by the editor');
    expect(html).not.toContain('Not reported by Claude Code</span></dd>');
  });

  it('Cursor: the mode the editor set, skill use and catalogs not reported, MCP calls it named still shown', () => {
    const used = sessionView([reply('a1', { provider: 'cursor', session: cursorInfo('c1', { permissionMode: 'cursor-auto-review' }), parts: [tool('mcp__slack__send', { mcpServer: 'slack', mcpTool: 'send' })] })]);
    const html = body(used as Exclude<SessionView, { kind: 'none' }>, 'Cursor Agent');
    expect(html).toContain('Auto-review: Cursor checks actions itself');
    expect(html).toContain('Set by the editor; Cursor Agent doesn’t report it');
    expect(html).toContain('composer-2.5[fast=false]');
    // Skill use is unknown, not "none".
    expect(html).not.toContain('None invoked');
    expect(html).toContain('Not reported by Cursor Agent');
    expect(html).toContain('doesn’t report which skills it invokes');
    expect(html).not.toContain('only a Skill call counts');
    // An observed call is shown though no server list was reported; it is not flagged as missing from one.
    expect(html).toContain('slack<span class="c-session-count"> · 1 call</span>');
    expect(html).not.toContain('not in the reported list');
    expect(html).not.toContain('Other reported tools');

    // Nothing seen, nothing listed: "None seen", never "No MCP tools called".
    const quiet = body(sessionView([reply('a1', { provider: 'cursor', session: cursorInfo('c1') })]) as Exclude<SessionView, { kind: 'none' }>, 'Cursor Agent');
    expect(quiet).toContain('Manual: asks you first');
    expect(quiet).toContain('None seen');
    expect(quiet).not.toContain('No MCP tools called');
    expect(quiet).not.toContain('None listed');
  });

  it('Codex: a reported mode and the catalogs it listed', () => {
    const session: ChatSessionInfo = { sessionId: 't1', model: 'gpt-6.1-sol', permissionMode: 'codex-auto-review', permissionSource: 'reported', skillUsageReported: false, tools: [], skills: ['enabled-skill'], mcpServers: [{ name: 'motion-editor', status: 'connected', tools: 18 }] };
    const html = body(sessionView([reply('a1', { provider: 'codex', session, parts: [tool('mcp__motion-editor__editor_get_context', { mcpServer: 'motion-editor', mcpTool: 'editor_get_context' })] })]) as Exclude<SessionView, { kind: 'none' }>, 'Codex');
    expect(html).toContain('Auto-review: Codex’s reviewer checks actions');
    expect(html).toContain('Reported by Codex');
    expect(html).toContain('enabled-skill');
    expect(html).toContain('Connected (1):');
    expect(html).toContain('motion-editor (this editor)<span class="c-session-count"> · 1 call</span>');
    expect(html).toContain('Not reported by Codex');
    expect(html).not.toContain('None invoked');
  });
});

describe('Auto-apply and Claude Code’s permission mode', () => {
  it('finds a running or waiting message sent with the other setting (the server names a reply <id>_r)', () => {
    const running = [user('u1', { autoApply: true }), reply('u1_r', { status: 'running' })];
    expect(sentWithOtherAutoApply(running, false)).toBe(true);
    expect(sentWithOtherAutoApply(running, true)).toBeNull();
    // Older messages have no flag: off.
    expect(sentWithOtherAutoApply([user('u1'), reply('u1_r', { status: 'running' })], true)).toBe(false);
    expect(sentWithOtherAutoApply([user('u1', { autoApply: true }), reply('u1_r', { status: 'running' }), user('u2', { status: 'queued', autoApply: false })], true)).toBe(false);
    // Nothing running or waiting: the switch applies to the next message anyway.
    expect(sentWithOtherAutoApply([user('u1', { autoApply: true }), reply('u1_r')], false)).toBeNull();
  });

  const LABELS: Record<AgentProviderId, string> = { claude: 'Claude Code', codex: 'Codex', cursor: 'Cursor Agent', opencode: 'OpenCode' };
  const notice = (on: boolean, provider: AgentProviderId, sentWith: boolean | null) => renderToStaticMarkup(createElement(AutoApplyNotice, { on, agent: LABELS[provider], provider, sentWith }));

  it('says what Auto-apply does with Claude Code, and when a change only starts with the next message', () => {
    expect(notice(false, 'claude', null)).toBe('');
    expect(notice(true, 'claude', null)).toContain('messages you send run in its auto mode: a safety check reviews its actions instead of asking you (some may still ask).');
    expect(notice(true, 'claude', false)).toContain('Auto mode starts with your next message. Messages already sent still ask you first.');
    expect(notice(false, 'claude', true)).toContain('From your next message Claude Code asks before acting. Messages already sent stay in auto mode.');
    expect(notice(false, 'claude', true)).not.toContain('Auto-apply on');
    expect(autoApplyTitle(true, 'Claude Code', 'claude')).toBe(
      'Claude Code’s edits apply immediately, and messages you send run in Claude Code’s auto mode. Turn off to review each edit and have it ask before acting, from your next message.',
    );
    expect(autoApplyTitle(false, 'Claude Code', 'claude')).toBe(
      'Claude Code’s edits wait for your review, and Claude Code asks before acting. Turn on to apply edits immediately and run in its auto mode, from your next message.',
    );
  });

  it('Codex and Cursor: their native automatic check when on, your Allow/Deny when off, from the next message', () => {
    expect(notice(true, 'codex', null)).toContain('Codex’s edits apply immediately, without review, and messages you send run with its automatic reviewer: the reviewer approves or declines its actions instead of asking you.');
    expect(notice(true, 'codex', false)).toContain('Automatic review starts with your next message. Messages already sent still ask you first.');
    expect(notice(false, 'codex', true)).toContain('From your next message Codex asks before acting. Messages already sent keep the automatic reviewer.');
    expect(notice(true, 'cursor', null)).toContain('Cursor Agent’s edits apply immediately, without review, and messages you send run with its Auto-review: Cursor’s own check decides on its actions instead of asking you.');
    expect(notice(true, 'cursor', false)).toContain('Auto-review starts with your next message.');
    expect(notice(false, 'cursor', true)).toContain('From your next message Cursor Agent asks before acting. Messages already sent keep Auto-review.');
    // No claim borrowed from another agent's mode.
    for (const p of ['codex', 'cursor'] as const) expect(notice(true, p, null)).not.toMatch(/auto mode|some may still ask/);
    expect(autoApplyTitle(true, 'Codex', 'codex')).toContain('messages you send run with Codex’s automatic reviewer');
    expect(autoApplyTitle(false, 'Cursor Agent', 'cursor')).toBe(
      'Cursor Agent’s edits wait for your review, and Cursor Agent asks before acting. Turn on to apply edits immediately and run with its Auto-review, from your next message.',
    );
  });

  it('OpenCode keeps its own permissions: the switch only decides whether edits wait for review', () => {
    for (const p of ['opencode'] as const) {
      expect(notice(true, p, null)).toContain(`${LABELS[p]}’s edits apply immediately, without review.`);
      expect(notice(true, p, null)).not.toMatch(/messages you send|auto mode|Auto-review|reviewer/);
      // No permissions to change from the next message.
      expect(notice(false, p, true)).toBe('');
      expect(notice(true, p, false)).not.toContain('next message');
    }
    expect(autoApplyTitle(true, 'OpenCode', 'opencode')).toBe('OpenCode’s edits apply immediately. Turn off to review each edit first.');
    expect(autoApplyTitle(false, 'OpenCode', 'opencode')).toBe('OpenCode’s edits wait for your review. Turn on to apply them immediately.');
    // No agent known (it isn't ready): edits only.
    expect(autoApplyTitle(true, undefined)).toBe('Agent edits apply immediately. Turn off to review each edit first.');
  });
});

describe('a cancelled permission request', () => {
  const request = { type: 'askPermission' as const, requestId: 'perm-1', agent: 'Cursor Agent', action: 'Run a terminal command: `ls`', timeoutMs: 60000 };

  it('clears its card and answers denied; another request’s card stays', async () => {
    const reply = askPermission(request);
    cancelPermission('perm-other');
    expect(usePermissions.getState().pending?.requestId).toBe('perm-1');
    cancelPermission('perm-1');
    expect(usePermissions.getState().pending).toBeNull();
    expect(await reply).toEqual({ ok: true, message: 'denied', reason: 'cancelled' });
    // Late or repeated cancels, and a later decision, change nothing.
    cancelPermission('perm-1');
    usePermissions.getState().decide('allowed');
    expect(usePermissions.getState().pending).toBeNull();
    // The next request is shown as usual.
    const next = askPermission({ ...request, requestId: 'perm-2' });
    expect(usePermissions.getState().pending?.requestId).toBe('perm-2');
    usePermissions.getState().decide('denied');
    expect(await next).toEqual({ ok: true, message: 'denied' });
  });
});
