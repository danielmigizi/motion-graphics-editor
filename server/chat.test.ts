// Editor chat: the manager with scripted providers (agent choice, sessions,
// transcripts on switching), the chat routes, and the Claude Code provider
// against a stand-in `claude` executable.

import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AgentProviderId, ChatEvent, ChatMessage, ChatSessionInfo, ChatState, ProposalSummary, ProviderInfo } from '../src/core/api-contract';
import { createClaudeProvider } from './agents/claude';
import { ProviderRegistry } from './agents/registry';
import { editorMcpServer } from './agents/shared';
import { writeCursorWorkspace } from './agents/cursor';
import type { AgentEvent, AgentProvider, AgentTurn } from './agents/types';
import { createApp } from './app';
import { EditorSession } from './session';
import { ChatManager, toolLabel } from './chat';
import { createProjectStore } from './projects';
import { RenderManager } from './renders';

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mge-chat-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A provider whose turns are scripted, and which can be held open until released. */
function scripted() {
  const turns: AgentTurn[] = [];
  let release: (() => void) | null = null;
  const provider: AgentProvider = {
    id: 'claude',
    label: 'Fake',
    resumesAcrossModels: true,
    status: async () => ({ id: 'claude', label: 'Fake', available: true, detail: 'test', models: [{ id: '', label: 'Default' }] }),
    async *run(turn): AsyncIterable<AgentEvent> {
      turns.push(turn);
      yield { type: 'session', sessionId: 'sess_1' };
      yield { type: 'text', text: 'Looking' };
      yield { type: 'tool', name: 'mcp__motion-editor__editor_apply_patch', input: { summary: 'Bluer background' } };
      await new Promise<void>((resolve) => {
        release = resolve;
        turn.signal.addEventListener('abort', () => resolve());
      });
      if (turn.signal.aborted) return;
      yield { type: 'text', text: 'Done.' };
      yield { type: 'done', isError: false };
    },
  };
  return { provider, turns, release: () => release?.() };
}

/** A provider that answers at once, echoing which agent replied; sessions are `<id>_s<n>`. */
function instant(id: AgentProviderId, opts: { available?: boolean; resumesAcrossModels?: boolean; models?: string[] } = {}) {
  const turns: AgentTurn[] = [];
  let sessions = 0;
  const provider: AgentProvider = {
    id,
    label: `Agent ${id}`,
    resumesAcrossModels: opts.resumesAcrossModels ?? true,
    status: async (): Promise<ProviderInfo> => ({
      id,
      label: `Agent ${id}`,
      available: opts.available ?? true,
      detail: opts.available === false ? `${id} is not signed in` : 'ok',
      models: [{ id: '', label: 'Default' }, ...(opts.models ?? []).map((m) => ({ id: m, label: m }))],
    }),
    async *run(turn): AsyncIterable<AgentEvent> {
      turns.push(turn);
      yield { type: 'session', sessionId: turn.sessionId ?? `${id}_s${++sessions}` };
      yield { type: 'text', text: `${id} reply ${turns.length}` };
      yield { type: 'done', isError: false };
    },
  };
  return { provider, turns };
}

const registry = (...providers: AgentProvider[]) => new ProviderRegistry(providers, 0);
const settle = () => new Promise((r) => setTimeout(r, 20));
async function idle(chat: ChatManager, projectId: string) {
  for (let i = 0; i < 100 && (await chat.state(projectId)).busy; i++) await settle();
  await settle();
}

describe('ChatManager', () => {
  it('runs a turn, streams the reply, queues the next message and resumes the session', async () => {
    const s = scripted();
    const events: ChatEvent[] = [];
    const chat = new ChatManager({ chatsDir: join(dir, 'a'), publicDir: '/pub', providers: registry(s.provider), emit: (e) => events.push(e) });

    await chat.send('prj_x', { text: 'Make the background blue', context: { sceneId: 'scn_fuel', frame: 150, label: 'Scene “The fuel”' } });
    await settle();
    expect((await chat.state('prj_x')).busy).toBe(true);
    await chat.send('prj_x', { text: 'And the text white' });
    let st = await chat.state('prj_x');
    expect(st.messages.map((m) => [m.role, m.status])).toEqual([
      ['user', 'done'],
      ['assistant', 'running'],
      ['user', 'queued'],
    ]);

    s.release();
    await settle();
    await settle();
    st = await chat.state('prj_x');
    const first = st.messages[1];
    expect(first.status).toBe('done');
    expect(first.parts).toEqual([
      { type: 'text', text: 'Looking' },
      { type: 'tool', name: 'mcp__motion-editor__editor_apply_patch', label: 'Editing: Bluer background' },
      { type: 'text', text: 'Done.' },
    ]);
    expect(first).toMatchObject({ provider: 'claude', model: '' });
    // The queued message started on its own, continuing the same agent session.
    expect(s.turns).toHaveLength(2);
    expect(s.turns[0].sessionId).toBeNull();
    expect(s.turns[1].sessionId).toBe('sess_1');
    expect(s.turns[0].prompt).toContain('pointing at "Scene “The fuel”" (scene scn_fuel) at frame 150');
    // Same agent, nothing missed: no transcript.
    expect(s.turns[1].prompt).not.toContain('[Earlier in this conversation]');
    expect(events.some((e) => e.message.id === first.id && e.message.status === 'done')).toBe(true);
    s.release();
    await settle();
  });

  it('stops the running turn and drops queued messages', async () => {
    const s = scripted();
    const chat = new ChatManager({ chatsDir: join(dir, 'b'), publicDir: '/pub', providers: registry(s.provider), emit: () => undefined });
    await chat.send('prj_y', { text: 'one' });
    await settle();
    await chat.send('prj_y', { text: 'two' });
    await chat.cancel('prj_y');
    await settle();
    const st = await chat.state('prj_y');
    expect(st.busy).toBe(false);
    expect(st.messages.map((m) => m.status)).toEqual(['done', 'cancelled', 'cancelled']);
    expect(s.turns).toHaveLength(1);
  });

  it('does not accept a late native approval after the owning turn has stopped', async () => {
    const s = scripted();
    let decide: ((value: boolean) => void) | undefined;
    const chat = new ChatManager({ chatsDir: join(dir, 'native-late'), publicDir: '/pub', providers: registry(s.provider), emit: () => undefined,
      askPermission: () => new Promise(resolve => { decide = resolve; }),
    });
    await chat.send('prj_native_late', { text: 'one' });
    await settle();
    const approval = s.turns[0].askPermission!('Run a command');
    expect(decide).toBeTypeOf('function');
    await chat.cancel('prj_native_late');
    decide!(true);
    expect(await approval).toBe(false);
  });

  it('keeps a natively completed reply done when Stop only cancels its metadata wait', async () => {
    const s = instant('codex');
    let completed = false;
    s.provider.run = async function* (turn) {
      yield { type: 'text', text: 'Finished reply.' };
      completed = true;
      await new Promise<void>(resolve => turn.signal.addEventListener('abort', () => resolve(), { once: true }));
      yield { type: 'done', isError: false, nativeCompleted: true };
    };
    const chat = new ChatManager({ chatsDir: join(dir, 'native-metadata-stop'), publicDir: '/pub', providers: registry(s.provider), emit: () => undefined });
    await chat.send('prj_native_metadata', { text: 'one' });
    await settle();
    expect(completed).toBe(true);
    await chat.cancel('prj_native_metadata');
    await idle(chat, 'prj_native_metadata');
    expect((await chat.state('prj_native_metadata')).messages[1]).toMatchObject({ status: 'done', parts: [{ type: 'text', text: 'Finished reply.' }] });
  });

  it('closes native approval scope when a turn finishes normally', async () => {
    const s = instant('codex');
    let asks = 0;
    const chat = new ChatManager({ chatsDir: join(dir, 'native-finished'), publicDir: '/pub', providers: registry(s.provider), emit: () => undefined,
      askPermission: async () => { asks++; return true; },
    });
    await chat.send('prj_native_finished', { text: 'one' });
    await idle(chat, 'prj_native_finished');
    expect(s.turns[0].signal.aborted).toBe(true);
    expect(await s.turns[0].askPermission!('Late command')).toBe(false);
    expect(asks).toBe(0);
  });

  it('keeps Cursor’s print and ACP sessions separate while carrying conversation context between them', async () => {
    const cursor = instant('cursor');
    const chat = new ChatManager({ chatsDir: join(dir, 'cursor-modes'), publicDir: '/pub', providers: registry(cursor.provider), emit: () => undefined });
    await chat.send('prj_cursor_modes', { text: 'First automatic message', autoApply: true });
    await idle(chat, 'prj_cursor_modes');
    await chat.send('prj_cursor_modes', { text: 'Manual follow-up', autoApply: false });
    await idle(chat, 'prj_cursor_modes');
    await chat.send('prj_cursor_modes', { text: 'Automatic again', autoApply: true });
    await idle(chat, 'prj_cursor_modes');
    expect(cursor.turns.map(t => t.sessionId)).toEqual([null, null, 'cursor_s1']);
    expect(cursor.turns[1].prompt).toContain('First automatic message');
    expect(cursor.turns[2].prompt).toContain('Manual follow-up');
    // Both native stores survive a server restart.
    const reopened = new ChatManager({ chatsDir: join(dir, 'cursor-modes'), publicDir: '/pub', providers: registry(cursor.provider), emit: () => undefined });
    await reopened.send('prj_cursor_modes', { text: 'Manual again', autoApply: false });
    await idle(reopened, 'prj_cursor_modes');
    expect(cursor.turns[3].sessionId).toBe('cursor_s2');
    expect(cursor.turns[3].prompt).toContain('Automatic again');
  });

  it('persists conversations and marks interrupted turns after a restart', async () => {
    const s = scripted();
    const chatsDir = join(dir, 'c');
    const chat = new ChatManager({ chatsDir, publicDir: '/pub', providers: registry(s.provider), emit: () => undefined });
    await chat.send('prj_z', { text: 'hello' });
    await vi.waitFor(async () => {
      const saved = JSON.parse(await readFile(join(chatsDir, 'prj_z.json'), 'utf8'));
      expect(saved.messages[1]?.status).toBe('running');
    });
    const restarted = new ChatManager({ chatsDir, publicDir: '/pub', providers: registry(s.provider), emit: () => undefined });
    const st = await restarted.state('prj_z');
    expect(st.messages[1].status).toBe('error');
    expect(st.messages[1].error).toMatch(/Interrupted/);
    await chat.cancel('prj_z');
  });

  it('puts attachments in the prompt with their file path and a ready asset object, and passes images', async () => {
    const a = instant('claude');
    const chat = new ChatManager({ chatsDir: join(dir, 'd'), publicDir: '/repo/public', providers: registry(a.provider), emit: () => undefined, fps: () => 30 });
    const prompt = chat.buildPrompt('prj_a', {
      id: 'm1',
      role: 'user',
      at: 0,
      status: 'queued',
      text: 'Use this music',
      attachments: [{ src: 'assets/uploads/u_1.mp3', name: 'bed.mp3', mimeType: 'audio/mpeg', kind: 'audio', durationSeconds: 12 }],
    });
    expect(prompt).toContain('"bed.mp3" (audio) at /repo/public/assets/uploads/u_1.mp3');
    expect(prompt).toMatch(/"kind":"audio".*"durationInFrames":360/);

    await chat.send('prj_a', {
      text: 'Use these',
      attachments: [
        { src: 'assets/uploads/u_2.png', name: 'shot.png', mimeType: 'image/png', kind: 'image' },
        { src: 'assets/uploads/u_3.svg', name: 'logo.svg', mimeType: 'image/svg+xml', kind: 'svg' },
      ],
    });
    await idle(chat, 'prj_a');
    expect(a.turns[0].images).toEqual(['/repo/public/assets/uploads/u_2.png']);
  });

  it('labels tool steps in plain words, whatever the CLI calls them', () => {
    expect(toolLabel('mcp__motion-editor__editor_render_frame', { frames: [10, 60] })).toBe('Looking at frames 10, 60');
    expect(toolLabel('mcp__motion-editor__editor_critique', {})).toBe('Critiquing motion');
    expect(toolLabel('mcp__motion_editor__editor_apply_patch', { summary: 'Warmer title' })).toBe('Editing: Warmer title'); // Codex
    expect(toolLabel('mcp__motion_editor__editor_propose_patch', { summary: 'Warmer title' })).toBe('Proposing an edit: Warmer title');
    expect(toolLabel('motion-editor-editor_proposal_status', {})).toBe('Checking your proposal');
    expect(toolLabel('motion-editor-editor_get_context', {})).toBe('Checking what you are looking at'); // Cursor
    expect(toolLabel('Read', {})).toBe('Reading a file');
    // The full toolset, in the user's words.
    expect(toolLabel('Bash', { command: 'ls' })).toBe('Running a command');
    expect(toolLabel('WebSearch', { query: 'ffmpeg release' })).toBe('Searching the web for “ffmpeg release”');
    expect(toolLabel('Skill', { skill: 'pr-package' })).toBe('Using the skill “pr-package”');
    expect(toolLabel('mcp__claude_ai_Slack__slack_send_message', {})).toBe('Slack: slack send message');
    expect(toolLabel('shell', {})).toBe('Running a command');
    expect(toolLabel('command_execution', {})).toBe('Running a command');
    expect(toolLabel('webSearch', {})).toBe('Searching the web'); // Cursor
    expect(toolLabel('webFetch', {})).toBe('Reading a web page');
    expect(toolLabel('web_search', {})).toBe('Searching the web'); // Codex
  });

  it('Auto-apply goes with each message: a queued message keeps the switch as it was when sent; no flag is off', async () => {
    const s = scripted();
    const chatsDir = join(dir, 'auto');
    const chat = new ChatManager({ chatsDir, publicDir: '/pub', providers: registry(s.provider), emit: () => undefined });
    await chat.send('prj_auto', { text: 'one', autoApply: true });
    await settle();
    await chat.send('prj_auto', { text: 'two', autoApply: false });
    await chat.send('prj_auto', { text: 'three' });
    expect((await chat.state('prj_auto')).messages.filter((m) => m.role === 'user').map((m) => [m.text, m.status, m.autoApply])).toEqual([
      ['one', 'done', true],
      ['two', 'queued', false],
      ['three', 'queued', false],
    ]);
    for (let i = 0; i < 3; i++) {
      s.release();
      await settle();
    }
    await idle(chat, 'prj_auto');
    expect(s.turns.map((t) => t.autoApply)).toEqual([true, false, false]);
    const saved = JSON.parse(await readFile(join(chatsDir, 'prj_auto.json'), 'utf8')) as { messages: ChatMessage[] };
    expect(saved.messages.filter((m) => m.role === 'user').map((m) => m.autoApply)).toEqual([true, false, false]);
  });

  it('keeps the reported session and each step’s skill or MCP server on the reply: streamed, then restored after a restart', async () => {
    const info: ChatSessionInfo = { sessionId: 'sess_info', model: 'claude-opus-5-5', permissionMode: 'auto', tools: ['Bash', 'Skill'], mcpServers: [{ name: 'claude.ai Slack', status: 'connected', tools: 19 }], skills: ['pr-package'] };
    const provider: AgentProvider = {
      ...instant('claude').provider,
      async *run(): AsyncIterable<AgentEvent> {
        yield { type: 'session', sessionId: 'sess_info' };
        yield { type: 'session-info', info };
        yield { type: 'tool', name: 'Skill', input: { skill: 'pr-package' }, skill: 'pr-package' };
        yield { type: 'tool', name: 'mcp__claude_ai_Slack__slack_send_message', input: { text: 'x' }, mcpServer: 'claude.ai Slack' };
        yield { type: 'text', text: 'Posted.' };
        yield { type: 'done', isError: false };
      },
    };
    const events: ChatEvent[] = [];
    const chatsDir = join(dir, 'session-info');
    const chat = new ChatManager({ chatsDir, publicDir: '/pub', providers: registry(provider), emit: (e) => events.push(e) });
    await chat.send('prj_info', { text: 'Post it', autoApply: true });
    await idle(chat, 'prj_info');
    const reply = (await chat.state('prj_info')).messages[1];
    expect(reply.session).toEqual(info);
    expect(reply.parts).toEqual([
      { type: 'tool', name: 'Skill', label: 'Using the skill “pr-package”', skill: 'pr-package' },
      { type: 'tool', name: 'mcp__claude_ai_Slack__slack_send_message', label: 'Slack: slack send message', mcpServer: 'claude.ai Slack' },
      { type: 'text', text: 'Posted.' },
    ]);
    // Sent to the editor as soon as the agent reported it, while the reply was still running.
    expect(events.some((e) => e.message.id === reply.id && e.message.status === 'running' && e.message.session?.sessionId === 'sess_info')).toBe(true);
    const restarted = new ChatManager({ chatsDir, publicDir: '/pub', providers: registry(provider), emit: () => undefined });
    expect((await restarted.state('prj_info')).messages[1]).toMatchObject({ session: info, parts: reply.parts });
  });
});

describe('chat proposal updates', () => {
  const proposal = (over: Partial<ProposalSummary> = {}): ProposalSummary => ({
    id: 'p_1', projectId: 'prj_proposals', agent: 'Agent claude', source: 'mcp', summary: 'Warmer title',
    baseRevision: 13, status: 'pending', createdAt: 1000, ...over,
  });

  it('includes only this agent/project outcomes once and persists the cutoff across restarts', async () => {
    const agent = instant('claude', { models: ['other'] });
    const other = instant('codex');
    const proposals = [
      proposal({ id: 'applied', status: 'applied', revision: 14, decidedAt: 2000 }),
      proposal({ id: 'cancelled', status: 'cancelled', summary: 'Blue title', decidedAt: 3000 }),
      proposal({ id: 'stale', status: 'stale', summary: 'Larger title', reason: 'The target changed.', decidedAt: 4000 }),
      proposal({ id: 'replaced', status: 'replaced', summary: 'First title', reason: 'Newer edit.', decidedAt: 5000 }),
      proposal({ id: 'pending', summary: 'Pending title' }),
      proposal({ id: 'other_agent', agent: 'Agent codex', summary: 'Other agent edit' }),
      proposal({ id: 'other_project', projectId: 'prj_elsewhere', summary: 'Other project edit' }),
    ];
    const opts = { chatsDir: join(dir, 'proposals'), publicDir: '/pub', providers: registry(agent.provider, other.provider), emit: () => undefined, proposalLog: () => proposals };
    const chat = new ChatManager(opts);
    await chat.send('prj_proposals', { text: 'Continue' });
    await idle(chat, 'prj_proposals');
    const prompt = agent.turns[0].prompt;
    expect(prompt).toMatch(/^\[Your proposals since your last turn\]/);
    for (const line of ['"Warmer title": applied by the user as r14', '"Blue title": declined by the user (cancelled)', '"Larger title": stale — The target changed.', '"First title": replaced — Newer edit.', '"Pending title": still waiting for the user\'s review']) expect(prompt).toContain(line);
    expect(prompt).not.toContain('Other agent edit');
    expect(prompt).not.toContain('Other project edit');
    await chat.send('prj_proposals', { text: 'And next?' });
    await idle(chat, 'prj_proposals');
    expect(agent.turns[1].prompt).not.toContain('[Your proposals since your last turn]');

    const restarted = new ChatManager(opts);
    await restarted.setSettings('prj_proposals', { provider: 'claude', model: 'other' });
    await restarted.send('prj_proposals', { text: 'After restart' });
    await idle(restarted, 'prj_proposals');
    expect(agent.turns[2].prompt).not.toContain('[Your proposals since your last turn]');
    await restarted.setSettings('prj_proposals', { provider: 'codex', model: '' });
    await restarted.send('prj_proposals', { text: 'Your turn' });
    await idle(restarted, 'prj_proposals');
    expect(other.turns[0].prompt).toContain('"Other agent edit": still waiting');
  });

  it('reports a proposal created during a turn and its later decision on the next turns', async () => {
    const agent = scripted();
    const proposals: ProposalSummary[] = [];
    const chat = new ChatManager({ chatsDir: join(dir, 'proposal-during-turn'), publicDir: '/pub', providers: registry(agent.provider), emit: () => undefined, proposalLog: () => proposals });
    await chat.send('prj_proposals', { text: 'Propose a title' });
    await settle();
    expect(agent.turns[0].prompt).not.toContain('[Your proposals since your last turn]');
    proposals.push(proposal({ agent: 'Fake', createdAt: Date.now() }));
    agent.release();
    await idle(chat, 'prj_proposals');
    await chat.send('prj_proposals', { text: 'What happened?' });
    await settle();
    expect(agent.turns[1].prompt).toContain('still waiting for the user\'s review');
    proposals[0] = { ...proposals[0], status: 'applied', revision: 14, decidedAt: Date.now() };
    agent.release();
    await idle(chat, 'prj_proposals');
    await chat.send('prj_proposals', { text: 'Continue' });
    await settle();
    expect(agent.turns[2].prompt).toContain('applied by the user as r14');
    expect(agent.turns[2].prompt).not.toContain('still waiting');
    agent.release();
    await idle(chat, 'prj_proposals');
  });
});

describe('MCP model configuration', () => {
  it('includes known model credit and omits an empty model', async () => {
    const opts = { rootDir: dir, serverPort: 7001, webPort: 7000 };
    expect(editorMcpServer(opts, 'Codex', 'gpt-test').env).toMatchObject({ MGE_AGENT_LABEL: 'Codex', MGE_AGENT_MODEL: 'gpt-test' });
    expect(editorMcpServer(opts, 'Codex', '').env).not.toHaveProperty('MGE_AGENT_MODEL');
    const workspace = join(dir, 'cursor-model');
    writeCursorWorkspace(workspace, opts, 'composer-test');
    const config = JSON.parse(await readFile(join(workspace, '.cursor', 'mcp.json'), 'utf8'));
    expect(config.mcpServers['motion-editor'].env.MGE_AGENT_MODEL).toBe('composer-test');
  });
});

describe('ChatManager agent choice', () => {
  it('defaults to the first available agent (Claude Code first) with its default model', async () => {
    const chat = new ChatManager({ chatsDir: join(dir, 'e'), publicDir: '/pub', providers: registry(instant('claude', { available: false }).provider, instant('codex').provider), emit: () => undefined });
    expect(await chat.state('prj_e')).toMatchObject({ provider: 'codex', model: '' });
    const both = new ChatManager({ chatsDir: join(dir, 'e2'), publicDir: '/pub', providers: registry(instant('claude').provider, instant('codex').provider), emit: () => undefined });
    expect(await both.state('prj_e')).toMatchObject({ provider: 'claude', model: '' });
  });

  it('validates settings: unknown agent, unavailable agent, unknown model, busy', async () => {
    const s = scripted();
    const chat = new ChatManager({
      chatsDir: join(dir, 'f'),
      publicDir: '/pub',
      providers: registry(s.provider, instant('codex', { models: ['gpt-x'] }).provider, instant('cursor', { available: false }).provider),
      emit: () => undefined,
    });
    expect(await chat.setSettings('prj_f', { provider: 'gemini', model: '' })).toMatchObject({ ok: false, status: 400, error: { code: 'INVALID', path: 'provider' } });
    expect(await chat.setSettings('prj_f', { provider: 'cursor', model: '' })).toMatchObject({ ok: false, status: 400, error: { message: 'Agent cursor isn\'t available: cursor is not signed in' } });
    expect(await chat.setSettings('prj_f', { provider: 'codex', model: 'gpt-nope' })).toMatchObject({ ok: false, status: 400, error: { path: 'model' } });

    await chat.send('prj_f', { text: 'hold' });
    await settle();
    expect(await chat.setSettings('prj_f', { provider: 'codex', model: 'gpt-x' })).toMatchObject({ ok: false, status: 409 });
    s.release();
    await idle(chat, 'prj_f');

    const r = await chat.setSettings('prj_f', { provider: 'codex', model: 'gpt-x' });
    expect(r).toMatchObject({ ok: true, state: { provider: 'codex', model: 'gpt-x', busy: false } });
    // Persisted with the conversation.
    const restarted = new ChatManager({ chatsDir: join(dir, 'f'), publicDir: '/pub', providers: registry(s.provider, instant('codex', { models: ['gpt-x'] }).provider), emit: () => undefined });
    expect(await restarted.state('prj_f')).toMatchObject({ provider: 'codex', model: 'gpt-x' });
  });

  it('gives a newly picked agent a transcript, records who answered, and keeps each agent’s session', async () => {
    const claude = instant('claude');
    const codex = instant('codex', { models: ['gpt-x'] });
    const chat = new ChatManager({ chatsDir: join(dir, 'g'), publicDir: '/pub', providers: registry(claude.provider, codex.provider), emit: () => undefined });

    await chat.send('prj_g', { text: 'Make a launch video' });
    await idle(chat, 'prj_g');
    await chat.setSettings('prj_g', { provider: 'codex', model: 'gpt-x' });
    await chat.send('prj_g', { text: 'Now make it shorter' });
    await idle(chat, 'prj_g');

    // Codex starts fresh, with what was said before it joined.
    expect(codex.turns[0].sessionId).toBeNull();
    expect(codex.turns[0].model).toBe('gpt-x');
    expect(codex.turns[0].prompt).toMatch(/^\[Earlier in this conversation\]\nUser: Make a launch video\nAgent claude: claude reply 1\n\[End of earlier messages\]\n\nNow make it shorter\n/);
    let st = await chat.state('prj_g');
    expect(st.messages.filter((m) => m.role === 'assistant').map((m) => [m.provider, m.model])).toEqual([
      ['claude', ''],
      ['codex', 'gpt-x'],
    ]);

    // Back to Claude Code: its own session, plus only what it missed.
    await chat.setSettings('prj_g', { provider: 'claude', model: '' });
    await chat.send('prj_g', { text: 'Add music' });
    await idle(chat, 'prj_g');
    expect(claude.turns[1].sessionId).toBe('claude_s1');
    expect(claude.turns[1].prompt).not.toContain('Make a launch video');
    expect(claude.turns[1].prompt).toMatch(/^\[Earlier in this conversation\]\nUser: Now make it shorter\nAgent codex: codex reply 1\n\[End of earlier messages\]\n\nAdd music\n/);

    // And Codex resumes its session the same way.
    await chat.setSettings('prj_g', { provider: 'codex', model: 'gpt-x' });
    await chat.send('prj_g', { text: 'Thanks' });
    await idle(chat, 'prj_g');
    expect(codex.turns[1].sessionId).toBe('codex_s1');
    expect(codex.turns[1].prompt).toContain('User: Add music\nAgent claude: claude reply 2');
    st = await chat.state('prj_g');
    expect(st.messages).toHaveLength(8);
  });

  it('keeps the session across a model change only when the CLI supports it', async () => {
    const fixed = instant('codex', { resumesAcrossModels: false, models: ['m1', 'm2'] });
    const chat = new ChatManager({ chatsDir: join(dir, 'h'), publicDir: '/pub', providers: registry(fixed.provider), emit: () => undefined });
    await chat.setSettings('prj_h', { provider: 'codex', model: 'm1' });
    await chat.send('prj_h', { text: 'one' });
    await idle(chat, 'prj_h');
    await chat.setSettings('prj_h', { provider: 'codex', model: 'm2' });
    await chat.send('prj_h', { text: 'two' });
    await idle(chat, 'prj_h');
    expect(fixed.turns[1].sessionId).toBeNull();
    expect(fixed.turns[1].prompt).toContain('User: one\nAgent codex: codex reply 1');

    const flexible = instant('claude', { models: ['m1', 'm2'] });
    const chat2 = new ChatManager({ chatsDir: join(dir, 'h2'), publicDir: '/pub', providers: registry(flexible.provider), emit: () => undefined });
    await chat2.setSettings('prj_h', { provider: 'claude', model: 'm1' });
    await chat2.send('prj_h', { text: 'one' });
    await idle(chat2, 'prj_h');
    await chat2.setSettings('prj_h', { provider: 'claude', model: 'm2' });
    await chat2.send('prj_h', { text: 'two' });
    await idle(chat2, 'prj_h');
    expect(flexible.turns[1]).toMatchObject({ sessionId: 'claude_s1', model: 'm2' });
    expect(flexible.turns[1].prompt).not.toContain('[Earlier in this conversation]');
  });

  it('opens conversations saved before agent choice as a Claude Code session', async () => {
    const chatsDir = join(dir, 'i');
    await mkdir(chatsDir, { recursive: true });
    const old = { projectId: 'prj_i', sessionId: 'sess_old', messages: [{ id: 'msg_1', role: 'user', at: 0, status: 'done', text: 'hi' }, { id: 'msg_1_r', role: 'assistant', at: 1, status: 'done', parts: [{ type: 'text', text: 'hello' }] }] };
    await writeFile(join(chatsDir, 'prj_i.json'), JSON.stringify(old));
    const claude = instant('claude');
    const chat = new ChatManager({ chatsDir, publicDir: '/pub', providers: registry(claude.provider), emit: () => undefined });
    expect(await chat.state('prj_i')).toMatchObject({ provider: 'claude', model: '' });
    await chat.send('prj_i', { text: 'again' });
    await idle(chat, 'prj_i');
    // That session ran in the repo, not the project's workspace: a fresh one starts with the transcript.
    expect(claude.turns[0].sessionId).toBeNull();
    expect(claude.turns[0].prompt).toContain('[Earlier in this conversation]');
    expect(claude.turns[0].prompt).toContain('hello');
  });

  it('runs every turn in the project\'s workspace folder and resumes only sessions from that folder', async () => {
    const workspacesDir = join(dir, 'ws');
    const claude = instant('claude');
    const chat = new ChatManager({ chatsDir: join(dir, 'w'), publicDir: '/pub', workspacesDir, providers: registry(claude.provider), emit: () => undefined });
    await chat.send('prj_w', { text: 'one' });
    await idle(chat, 'prj_w');
    await chat.send('prj_w', { text: 'two' });
    await idle(chat, 'prj_w');
    expect(claude.turns.map((t) => t.workspace)).toEqual([join(workspacesDir, 'prj_w'), join(workspacesDir, 'prj_w')]);
    expect((await stat(join(workspacesDir, 'prj_w'))).isDirectory()).toBe(true);
    expect(claude.turns[1].sessionId).toBe('claude_s1');
    // The same conversation opened with another workspaces folder starts over in the new folder.
    const moved = instant('claude');
    const chat2 = new ChatManager({ chatsDir: join(dir, 'w'), publicDir: '/pub', workspacesDir: join(dir, 'ws2'), providers: registry(moved.provider), emit: () => undefined });
    await chat2.send('prj_w', { text: 'three' });
    await idle(chat2, 'prj_w');
    expect(moved.turns[0]).toMatchObject({ sessionId: null, workspace: join(dir, 'ws2', 'prj_w') });
  });

  it('reset keeps the chosen agent and model but forgets sessions', async () => {
    const codex = instant('codex', { models: ['gpt-x'] });
    const chat = new ChatManager({ chatsDir: join(dir, 'j'), publicDir: '/pub', providers: registry(instant('claude').provider, codex.provider), emit: () => undefined });
    await chat.setSettings('prj_j', { provider: 'codex', model: 'gpt-x' });
    await chat.send('prj_j', { text: 'one' });
    await idle(chat, 'prj_j');
    expect(await chat.reset('prj_j')).toMatchObject({ provider: 'codex', model: 'gpt-x', messages: [] });
    await chat.send('prj_j', { text: 'two' });
    await idle(chat, 'prj_j');
    expect(codex.turns[1].sessionId).toBeNull();
  });

  /** A provider whose status check waits until `open()`, holding the turn while the agent is picked. */
  function slowToPick() {
    const claude = instant('claude');
    let open = () => undefined as void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    const provider: AgentProvider = { ...claude.provider, status: async () => (await gate, claude.provider.status()) };
    return { provider, turns: claude.turns, open: () => open() };
  }

  it('a reset while the agent is being picked never starts the old turn or touches the fresh conversation', async () => {
    const p = slowToPick();
    const events: ChatEvent[] = [];
    const chat = new ChatManager({ chatsDir: join(dir, 'm'), publicDir: '/pub', providers: registry(p.provider), emit: (e) => events.push(e) });
    await chat.send('prj_m', { text: 'old request' });
    await settle();
    // The provider's status is still pending; reset reports a quiet, empty conversation.
    const sent = events.length;
    const reset = chat.reset('prj_m');
    p.open();
    expect(await reset).toMatchObject({ busy: false, messages: [] });
    await idle(chat, 'prj_m');
    expect(p.turns).toHaveLength(0);
    expect((await chat.state('prj_m')).messages).toEqual([]);
    expect(events.slice(sent)).toEqual([]);

    // The next message starts a new session with no trace of the old request.
    await chat.send('prj_m', { text: 'new request' });
    await idle(chat, 'prj_m');
    expect(p.turns).toHaveLength(1);
    expect(p.turns[0]).toMatchObject({ sessionId: null });
    expect(p.turns[0].prompt).not.toContain('old request');
    expect((await chat.state('prj_m')).messages.map((m) => [m.role, m.status])).toEqual([
      ['user', 'done'],
      ['assistant', 'done'],
    ]);
  });

  it('stop while the agent is being picked cancels the reply without starting the agent', async () => {
    const p = slowToPick();
    const chat = new ChatManager({ chatsDir: join(dir, 'n'), publicDir: '/pub', providers: registry(p.provider), emit: () => undefined });
    await chat.send('prj_n', { text: 'one' });
    await settle();
    const cancel = chat.cancel('prj_n');
    p.open();
    await cancel;
    await idle(chat, 'prj_n');
    expect(p.turns).toHaveLength(0);
    expect((await chat.state('prj_n')).messages.map((m) => [m.role, m.status])).toEqual([
      ['user', 'done'],
      ['assistant', 'cancelled'],
    ]);
  });

  it('a reset mid-turn keeps the old reply out of the fresh conversation', async () => {
    const s = scripted();
    const events: ChatEvent[] = [];
    const chat = new ChatManager({ chatsDir: join(dir, 'o'), publicDir: '/pub', providers: registry(s.provider), emit: (e) => events.push(e) });
    await chat.send('prj_o', { text: 'one' });
    await settle();
    const sent = events.length;
    expect(await chat.reset('prj_o')).toMatchObject({ busy: false, messages: [] });
    await idle(chat, 'prj_o');
    expect((await chat.state('prj_o')).messages).toEqual([]);
    expect(events.slice(sent)).toEqual([]);
    await chat.send('prj_o', { text: 'two' });
    await settle();
    expect(s.turns[1].sessionId).toBeNull();
    s.release();
    await idle(chat, 'prj_o');
  });
});

describe('chat routes', () => {
  const session = new EditorSession({ token: 'chat-test' });
  const credentials = session.claim('chat-test')!;
  const cookie = `${session.cookieName}=${credentials.sessionId}`;
  const tabSecret = credentials.tabSecret;
  let server: Server;
  let base: string;
  let release: () => void;

  beforeAll(async () => {
    const s = scripted();
    release = s.release;
    const providers = registry(s.provider, instant('codex', { models: ['gpt-x'] }).provider, instant('opencode', { available: false }).provider);
    const root = join(dir, 'routes');
    const app = createApp({
      session,
      publicDir: join(root, 'public'),
      rendersDir: join(root, 'renders'),
      projects: createProjectStore(join(root, 'projects')),
      renders: new RenderManager({ rendersDir: join(root, 'renders'), renderer: async () => undefined }),
      chat: new ChatManager({ chatsDir: join(root, 'chats'), publicDir: join(root, 'public'), providers, emit: () => undefined }),
      chatProviders: () => providers.list(),
    });
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    release();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie, 'X-MGE-Tab': tabSecret }, body: JSON.stringify(body) });

  it('lists all providers, available or not', async () => {
    const list = (await (await fetch(`${base}/api/chat/providers`)).json()) as ProviderInfo[];
    expect(list.map((p) => [p.id, p.available])).toEqual([
      ['claude', true],
      ['codex', true],
      ['opencode', false],
    ]);
  });

  it('POST settings: 200 with the chat state, 400 when invalid or unavailable, 409 while a turn runs', async () => {
    const ok = await post('/api/chat/prj_r/settings', { provider: 'codex', model: 'gpt-x' });
    expect(ok.status).toBe(200);
    expect((await ok.json()) as ChatState).toMatchObject({ projectId: 'prj_r', provider: 'codex', model: 'gpt-x', busy: false, messages: [] });

    expect((await post('/api/chat/prj_r/settings', { provider: 'codex' })).status).toBe(400);
    const unavailable = await post('/api/chat/prj_r/settings', { provider: 'opencode', model: '' });
    expect(unavailable.status).toBe(400);
    expect(((await unavailable.json()) as { error: { message: string } }).error.message).toMatch(/isn't available/);

    await post('/api/chat/prj_r/settings', { provider: 'claude', model: '' });
    await post('/api/chat/prj_r/messages', { text: 'hold on' });
    await settle();
    const busy = await post('/api/chat/prj_r/settings', { provider: 'codex', model: '' });
    expect(busy.status).toBe(409);
    expect(((await busy.json()) as { error: { message: string } }).error.message).toMatch(/Wait for the current reply/);
  });

  it('POST messages keeps Auto-apply on the message only when it is exactly true', async () => {
    await post('/api/chat/prj_auto_route/settings', { provider: 'codex', model: '' });
    const send = async (body: object) => (await (await post('/api/chat/prj_auto_route/messages', body)).json()) as ChatMessage;
    const sent = [await send({ text: 'one', autoApply: true }), await send({ text: 'two', autoApply: 'yes' }), await send({ text: 'three' })];
    expect(sent.map((m) => m.autoApply)).toEqual([true, false, false]);
  });
});

describe('Claude Code provider', () => {
  it('runs claude -p with only the editor tools, resumes sessions, passes the model and never passes an API key', async () => {
    const fake = join(dir, 'claude');
    const argsFile = join(dir, 'args.json');
    await writeFile(
      fake,
      `#!/usr/bin/env node
const fs = require('fs');
fs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify({ argv: process.argv.slice(2), apiKey: process.env.ANTHROPIC_API_KEY ?? null, cwd: process.cwd() }));
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
out({ type: 'system', subtype: 'init', session_id: 'sess_9', tools: ['Read', 'mcp__motion-editor__editor_get_context'], permissionMode: 'default' });
out({ type: 'stream_event', event: { type: 'message_start' } });
out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hi ' } } });
out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'there' } } });
out({ type: 'assistant', message: { content: [{ type: 'text', text: 'Hi there' }, { type: 'tool_use', name: 'mcp__motion-editor__editor_get_context', input: {} }] } });
out({ type: 'result', subtype: 'success', is_error: false, session_id: 'sess_9', result: 'Hi there' });
`,
    );
    await chmod(fake, 0o755);
    const prevKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-should-not-leak';
    try {
      const provider = createClaudeProvider({ rootDir: dir, serverPort: 7001, webPort: 7000, bin: fake });
      const events: AgentEvent[] = [];
      for await (const e of provider.run({ prompt: 'hello', sessionId: 'sess_prev', model: 'sonnet', images: [], workspace: dir, signal: new AbortController().signal })) events.push(e);
      expect(events).toEqual([
        { type: 'session', sessionId: 'sess_9' },
        // No mcp_servers in this init: every tool is listed by name, none is credited to a server.
        { type: 'session-info', info: { sessionId: 'sess_9', permissionMode: 'default', tools: ['Read', 'mcp__motion-editor__editor_get_context'] } },
        { type: 'text', text: 'Hi ' },
        { type: 'text', text: 'there' },
        { type: 'tool', name: 'mcp__motion-editor__editor_get_context', input: {} },
        { type: 'session', sessionId: 'sess_9' },
        { type: 'done', isError: false },
      ]);
      const seen = JSON.parse(await readFile(argsFile, 'utf8')) as { argv: string[]; apiKey: string | null };
      expect(seen.apiKey).toBeNull();
      const a = seen.argv;
      expect(a.slice(0, 2)).toEqual(['-p', 'hello']);
      // The full toolset; only the editor's tools are pre-allowed, and nothing is denied.
      expect(a).not.toContain('--strict-mcp-config');
      expect(a).not.toContain('--tools');
      expect(a[a.indexOf('--allowedTools') + 1]).toBe('mcp__motion-editor__*');
      expect(a).not.toContain('--disallowedTools');
      expect(a[a.indexOf('--resume') + 1]).toBe('sess_prev');
      expect(a[a.indexOf('--model') + 1]).toBe('sonnet');
      // No Auto-apply on the turn: Claude Code asks first.
      expect(a[a.indexOf('--permission-mode') + 1]).toBe('default');
      expect(a[a.indexOf('--append-system-prompt') + 1]).toContain('motion graphics editor');
      expect(JSON.parse(a[a.indexOf('--mcp-config') + 1]).mcpServers['motion-editor'].env).toMatchObject({ MGE_SERVER_PORT: '7001', MGE_WEB_PORT: '7000' });
    } finally {
      if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prevKey;
    }
  });

  it('reports a missing claude executable as unavailable, and lists its models', async () => {
    const provider = createClaudeProvider({ rootDir: dir, serverPort: 1, webPort: 2, bin: join(dir, 'nope') });
    const st = await provider.status();
    expect(st).toMatchObject({ available: false, detail: expect.stringContaining('not installed') });
    expect(st.models.map((m) => m.id)).toEqual(['', 'opus', 'sonnet', 'haiku', 'claude-fable-5-1']);
  });
});
