// Claude Code: the turn's arguments (Auto-apply → auto permission mode), the
// fail-closed init gate (with init events captured from real `claude -p` runs,
// machine paths removed), the session details taken from init, and a whole
// turn against a fake `claude`.

import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkInitTools, claudeArgs, claudePermissionMode, createClaudeProvider, invokedSkill, mcpServerOf, sessionInfo } from './claude';
import type { AgentEvent } from './types';

const fixture = (name: string) => readFile(join(__dirname, '__fixtures__', name), 'utf8');
const flagValues = (argv: string[], flag: string) => {
  const i = argv.indexOf(flag);
  if (i < 0) return [];
  const out: string[] = [];
  for (let j = i + 1; j < argv.length && !argv[j].startsWith('--'); j++) out.push(argv[j]);
  return out;
};

describe('turn arguments', () => {
  const base = { mcpConfig: '{"mcpServers":{}}', instructions: 'INSTRUCTIONS', publicDir: '/editor/public', protectedPaths: ['/c', '/r/.mge/dev.log'] };
  const turn = { prompt: 'hi', model: 'haiku', sessionId: null };

  // The full toolset, like Claude Code in a terminal; no server is denied, asked or special-cased.
  it('the full toolset and every MCP server; only the editor’s own tools are pre-allowed', () => {
    const argv = claudeArgs(turn, base);
    expect(argv).not.toContain('--strict-mcp-config');
    expect(argv).not.toContain('--tools');
    expect(argv).not.toContain('--disallowedTools');
    expect(flagValues(argv, '--allowedTools')).toEqual(['mcp__motion-editor__*']);
    expect(flagValues(argv, '--add-dir')).toEqual(['/editor/public']);
    expect(argv[argv.indexOf('--permission-prompt-tool') + 1]).toBe('mcp__motion-editor__editor_permission_prompt');
    expect(argv[argv.indexOf('--append-system-prompt') + 1]).toBe('INSTRUCTIONS');
  });

  it('denies protected paths and keychain commands through merged settings in manual, auto, and resumed turns', () => {
    for (const autoApply of [false, true]) {
      const argv = claudeArgs({ ...turn, autoApply, sessionId: 'existing' }, base);
      expect(argv.filter(arg => arg === '--settings')).toHaveLength(1);
      // A project .claude/settings.json in the shared workspace (another agent could write one) is never loaded.
      expect(argv[argv.indexOf('--setting-sources') + 1]).toBe('user');
      expect(JSON.parse(argv[argv.indexOf('--settings') + 1])).toEqual({ permissions: { deny: [
        'Read(//c)', 'Edit(//c)', 'Read(//c/**)', 'Edit(//c/**)',
        'Read(//r/.mge/dev.log)', 'Edit(//r/.mge/dev.log)', 'Read(//r/.mge/dev.log/**)', 'Edit(//r/.mge/dev.log/**)',
        'Bash(*/c*)', 'Bash(*/r/.mge/dev.log*)', 'Bash(*.config/motion-editor*)', 'Bash(*secret-tool*)', 'Bash(*find-generic-password*)',
      ] } });
      expect(argv.slice(-2)).toEqual(['--resume', 'existing']);
    }
  });

  // The permission mode is set on the command line, so a user's defaultMode can't break every turn.
  it('always passes --permission-mode default', () => {
    const argv = claudeArgs(turn, base);
    expect(argv[argv.indexOf('--permission-mode') + 1]).toBe('default');
    expect(argv.filter((a) => a === '--permission-mode')).toHaveLength(1);
  });

  // Auto-apply on: Claude Code's own auto mode. Never a mode or flag that skips permissions, and the
  // editor's permission prompt stays so ask rules still reach the user.
  it('Auto-apply off (or not given) passes default, on passes auto; the prompt tool and allowlist never change', () => {
    for (const [autoApply, mode] of [[undefined, 'default'], [false, 'default'], [true, 'auto']] as const) {
      const argv = claudeArgs({ ...turn, autoApply }, base);
      expect(argv[argv.indexOf('--permission-mode') + 1]).toBe(mode);
      expect(argv.filter((a) => a === '--permission-mode')).toHaveLength(1);
      expect(argv[argv.indexOf('--permission-prompt-tool') + 1]).toBe('mcp__motion-editor__editor_permission_prompt');
      expect(flagValues(argv, '--allowedTools')).toEqual(['mcp__motion-editor__*']);
      expect(argv.join(' ')).not.toMatch(/bypassPermissions|dangerously|skip-permissions|dontAsk|acceptEdits/);
    }
    expect([claudePermissionMode(true), claudePermissionMode(false), claudePermissionMode(undefined)]).toEqual(['auto', 'default', 'default']);
  });
});

describe('init gate', () => {
  it('accepts the real init of a full-toolset turn and of a strict turn', async () => {
    const full = JSON.parse(await fixture('claude-init-full.json'));
    expect(full.tools).toEqual(expect.arrayContaining(['Bash', 'WebSearch', 'WebFetch', 'Skill', 'Edit', 'mcp__claude_ai_Slack__slack_send_message']));
    expect(checkInitTools(full)).toEqual({ ok: true });
    expect(checkInitTools(JSON.parse(await fixture('claude-init-strict.json')))).toEqual({ ok: true });
  });

  // The gate fails closed on a malformed init.
  it('refuses non-string tools, a missing tool list, a missing permission mode, and any mode but "default"', async () => {
    const init = JSON.parse(await fixture('claude-init-full.json'));
    expect(checkInitTools({ tools: ['Read'] }).ok).toBe(false);
    expect(checkInitTools({ tools: [{ name: 'Bash' }], permissionMode: 'default' }).ok).toBe(false);
    expect(checkInitTools({ ...init, tools: [...init.tools, 7] }).ok).toBe(false);
    expect(checkInitTools({ ...init, tools: 'Read' }).ok).toBe(false);
    expect(checkInitTools({ permissionMode: 'default' }).ok).toBe(false);
    expect(checkInitTools({ ...init, permissionMode: undefined }).ok).toBe(false);
    expect(checkInitTools({ ...init, permissionMode: null }).ok).toBe(false);
    expect(checkInitTools({ ...init, permissionMode: 'bypassPermissions' })).toEqual({ ok: false, message: expect.stringContaining('bypassPermissions') });
    expect(checkInitTools({ ...init, permissionMode: 'auto' }).ok).toBe(false);
  });

  // Claude Code starts in Manual ("default") when auto mode isn't available: that is not what Auto-apply asked for.
  it('with Auto-apply on, accepts only auto; Manual, a missing mode or any other mode stops the turn and says what to do', async () => {
    const init = JSON.parse(await fixture('claude-init-full.json'));
    expect(checkInitTools({ ...init, permissionMode: 'auto' }, 'auto')).toEqual({ ok: true });
    const fellBack = checkInitTools(init, 'auto');
    if (fellBack.ok) throw new Error('expected the gate to refuse');
    expect(fellBack.message).toContain('asked Claude Code for auto mode, but it started with permission mode “default”');
    expect(fellBack.message).toContain('nothing ran');
    expect(fellBack.message).toContain('Turn Auto-apply off');
    for (const permissionMode of [undefined, null, 'bypassPermissions', 'acceptEdits', 'dontAsk', 'plan']) expect(checkInitTools({ ...init, permissionMode }, 'auto').ok).toBe(false);
    expect(checkInitTools({ ...init, permissionMode: 'auto', tools: 'Read' }, 'auto').ok).toBe(false);
  });
});

describe('session details from init', () => {
  it('keeps model, mode, session id, skills, MCP servers with status and tool counts, and built-in tool names; no paths', async () => {
    const init = JSON.parse(await fixture('claude-init-full.json'));
    const info = sessionInfo({
      ...init,
      cwd: '/Users/someone/secret-project',
      plugins: [{ name: 'design', path: '/Users/someone/.claude/plugins/design' }],
      skills: ['motion-video', 'review-kit:code-review'],
    });
    expect(info).toMatchObject({ sessionId: init.session_id, model: 'claude-haiku-5-5', permissionMode: 'default', skills: ['motion-video', 'review-kit:code-review'] });
    expect(info.tools).toEqual(init.tools.filter((t: string) => !t.startsWith('mcp__')));
    expect(info.tools).toContain('Skill');
    expect(info.mcpServers).toContainEqual({ name: 'claude.ai Slack', status: 'connected', tools: 19 });
    expect(info.mcpServers).toContainEqual({ name: 'claude.ai Notes', status: 'connected', tools: 17 });
    expect(info.mcpServers).toContainEqual({ name: 'motion-editor', status: 'connected', tools: 18 });
    expect(info.mcpServers).toContainEqual({ name: 'claude.ai Meetings', status: 'needs-auth', tools: 0 });
    expect(info.mcpServers).toContainEqual({ name: 'plugin:design:google calendar', status: 'failed', tools: 0 });
    // Every reported tool is accounted for once: by name, or in its server's count.
    expect(info.tools.length + info.mcpServers!.reduce((n, s) => n + (s.tools ?? 0), 0)).toBe(init.tools.length);
    expect(JSON.stringify(info)).not.toMatch(/\/Users|secret-project|apiKeySource|claude_code_version/);
  });

  it('leaves out what the CLI did not report, instead of guessing (no skills list is not "no skills")', () => {
    expect(sessionInfo({ type: 'system', subtype: 'init', tools: ['Read', 'Skill'], permissionMode: 'default' })).toEqual({ permissionMode: 'default', tools: ['Read', 'Skill'] });
    expect(sessionInfo({ tools: [], skills: [], mcp_servers: [] })).toEqual({ tools: [], skills: [], mcpServers: [] });
    expect(sessionInfo({ tools: [], skills: [{ name: 'pr-package', path: '/x' }, 7, ''], mcp_servers: [{ name: 'linear' }, { status: 'connected' }] })).toEqual({ tools: [], skills: ['pr-package'], mcpServers: [{ name: 'linear', status: 'unknown', tools: 0 }] });
  });

  it('names the server of an MCP tool with the canonical prefix (claude.ai connectors, plugins), and the skill of a Skill call', () => {
    const servers = ['claude.ai Slack', 'plugin:design:figma', 'motion-editor', 'a', 'a__b'];
    expect(mcpServerOf('mcp__claude_ai_Slack__slack_send_message', servers)).toBe('claude.ai Slack');
    expect(mcpServerOf('mcp__plugin_design_figma__get_file', servers)).toBe('plugin:design:figma');
    expect(mcpServerOf('mcp__motion-editor__editor_get_context', servers)).toBe('motion-editor');
    expect(mcpServerOf('mcp__a__b__tool', servers)).toBe('a__b');
    expect(mcpServerOf('mcp__claude_ai_Notion__search', servers)).toBeUndefined();
    expect(mcpServerOf('Bash', servers)).toBeUndefined();
    expect(invokedSkill('Skill', { skill: 'pr-package', args: 'x'.repeat(5000) })).toBe('pr-package');
    expect(invokedSkill('Skill', { skill: '/review' })).toBe('review');
    expect(invokedSkill('Skill', {})).toBeUndefined();
    expect(invokedSkill('Skill', null)).toBeUndefined();
    expect(invokedSkill('Bash', { skill: 'pr-package' })).toBeUndefined();
  });
});

describe('a whole turn against a fake claude', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mge-claude-'));
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  /** A fake `claude -p`: records argv, prints `init` and, unless killed, finishes after 3 s. */
  const fake = async (name: string, init: object) => {
    const bin = join(dir, name);
    const log = join(dir, `${name}.argv.json`);
    await writeFile(
      bin,
      `#!/usr/bin/env node
const fs = require('fs');
const a = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify(a));
console.log(JSON.stringify(${JSON.stringify(init)}));
setTimeout(() => { fs.writeFileSync(${JSON.stringify(log)} + '.ran', 'model ran'); console.log(JSON.stringify({ type: 'result', is_error: false, session_id: 's1' })); }, 3000);
`,
    );
    await chmod(bin, 0o755);
    return { bin, argv: async () => JSON.parse(await readFile(log, 'utf8')) as string[], ran: () => readFile(`${log}.ran`, 'utf8').then(() => true, () => false) };
  };
  const run = async (bin: string, autoApply?: boolean) => {
    const provider = createClaudeProvider({ rootDir: dir, serverPort: 1, webPort: 2, bin });
    const events: AgentEvent[] = [];
    const started = Date.now();
    for await (const e of provider.run({ prompt: 'hi', sessionId: null, model: '', autoApply, images: [], workspace: dir, signal: new AbortController().signal })) events.push(e);
    return { events, ms: Date.now() - started };
  };

  it('kills the turn at init when the permission mode would not ask; the model never runs', async () => {
    const init = JSON.parse(await fixture('claude-init-full.json'));
    const f = await fake('claude-leaky', { ...init, permissionMode: 'bypassPermissions' });
    const { events, ms } = await run(f.bin);
    expect(events.at(-1)).toMatchObject({ type: 'done', isError: true, error: expect.stringContaining('bypassPermissions') });
    expect(events.some((e) => e.type === 'session')).toBe(false);
    expect(ms).toBeLessThan(2500);
    await new Promise((r) => setTimeout(r, 3200));
    expect(await f.ran()).toBe(false);
  }, 10000);

  it('a full-toolset init runs normally in the workspace folder', async () => {
    const f = await fake('claude-full', JSON.parse(await fixture('claude-init-full.json')));
    const { events } = await run(f.bin);
    expect(events.some((e) => e.type === 'tool')).toBe(false);
    expect(events.at(-1)).toEqual({ type: 'done', isError: false });
    expect(flagValues(await f.argv(), '--add-dir')).toEqual([join(dir, 'public')]);
    expect(await f.argv()).not.toContain('--disallowedTools');
  }, 10000);

  it('Auto-apply on: runs in auto mode when Claude Code starts in it, and reports the session details', async () => {
    const init = JSON.parse(await fixture('claude-init-full.json'));
    const f = await fake('claude-auto', { ...init, permissionMode: 'auto' });
    const { events } = await run(f.bin, true);
    expect(events.at(-1)).toEqual({ type: 'done', isError: false });
    const argv = await f.argv();
    expect(argv[argv.indexOf('--permission-mode') + 1]).toBe('auto');
    expect(argv[argv.indexOf('--permission-prompt-tool') + 1]).toBe('mcp__motion-editor__editor_permission_prompt');
    const info = events.find((e) => e.type === 'session-info');
    expect(info).toMatchObject({ type: 'session-info', info: { sessionId: init.session_id, permissionMode: 'auto', model: 'claude-haiku-5-5' } });
  }, 10000);

  it('Auto-apply on: kills the turn at init when Claude Code fell back to Manual (auto mode unavailable); the model never runs', async () => {
    const init = JSON.parse(await fixture('claude-init-full.json'));
    const f = await fake('claude-auto-fallback', init);
    const { events, ms } = await run(f.bin, true);
    expect(events.at(-1)).toMatchObject({ type: 'done', isError: true, error: expect.stringContaining('asked Claude Code for auto mode') });
    expect(events.some((e) => e.type === 'session' || e.type === 'session-info')).toBe(false);
    const argv = await f.argv();
    expect(argv[argv.indexOf('--permission-mode') + 1]).toBe('auto');
    expect(ms).toBeLessThan(2500);
    await new Promise((r) => setTimeout(r, 3200));
    expect(await f.ran()).toBe(false);
  }, 10000);

  it('kills the turn at init when the permission mode is missing', async () => {
    const strict = JSON.parse(await fixture('claude-init-strict.json'));
    const f = await fake('claude-nomode', { ...strict, permissionMode: undefined });
    const { events, ms } = await run(f.bin);
    expect(events.at(-1)).toMatchObject({ type: 'done', isError: true, error: expect.stringContaining('permission mode') });
    expect(events.some((e) => e.type === 'session')).toBe(false);
    expect(ms).toBeLessThan(2500);
  }, 10000);

  /** A fake `claude -p` that prints `lines` (JSON events) and exits. */
  const scripted = async (name: string, lines: object[]) => {
    const bin = join(dir, name);
    await writeFile(bin, `#!/usr/bin/env node
for (const l of ${JSON.stringify(lines)}) console.log(JSON.stringify(l));
`);
    await chmod(bin, 0o755);
    return bin;
  };

  it('kills the turn on any model activity before a valid init (no init at all, or activity first)', async () => {
    const strict = JSON.parse(await fixture('claude-init-strict.json'));
    const bashUse = { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'rm -rf ~' } }] } };
    const ok = { type: 'result', subtype: 'success', is_error: false, session_id: 's1' };
    for (const [name, lines] of [
      ['claude-noinit', [bashUse, ok]],
      ['claude-onlyresult', [ok]],
      ['claude-streamfirst', [{ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } } }, strict, ok]],
      ['claude-assistantfirst', [bashUse, strict, ok]],
      ['claude-userfirst', [{ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: 'y' }] } }, strict, ok]],
      ['claude-ratelimit-then-activity', [{ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } }, bashUse, strict, ok]],
    ] as const) {
      const { events } = await run(await scripted(name, [...lines]));
      expect(events.at(-1)).toMatchObject({ type: 'done', isError: true, error: expect.stringContaining('before') });
      expect(events.some((e) => e.type === 'tool' && e.name === 'Bash')).toBe(false);
      expect(events.some((e) => e.type === 'text')).toBe(false);
    }
  }, 20000);

  it('ignores other system events before init, and reports a CLI error that arrives before init', async () => {
    const strict = JSON.parse(await fixture('claude-init-strict.json'));
    const { events } = await run(await scripted('claude-hook-first', [{ type: 'system', subtype: 'hook_response', output: 'x' }, strict, { type: 'result', subtype: 'success', is_error: false, session_id: 's1' }]));
    expect(events.at(-1)).toEqual({ type: 'done', isError: false });
    // Harmless or unknown events before init are ignored.
    const rl = await run(await scripted('claude-ratelimit-first', [{ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } }, { type: 'some_future_event' }, strict, { type: 'result', subtype: 'success', is_error: false, session_id: 's1' }]));
    expect(rl.events.at(-1)).toEqual({ type: 'done', isError: false });
    const failed = await run(await scripted('claude-early-error', [{ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Not logged in · Please run /login' }]));
    expect(failed.events.at(-1)).toMatchObject({ type: 'done', isError: true, error: expect.stringContaining('signed out') });
  }, 10000);

  it('tags tool steps with the skill a Skill call invoked and the reported MCP server a tool belongs to', async () => {
    const init = {
      type: 'system',
      subtype: 'init',
      session_id: 's_tools',
      tools: ['Bash', 'Skill', 'mcp__claude_ai_Slack__slack_send_message', 'mcp__plugin_design_figma__get_file', 'mcp__motion-editor__editor_get_context'],
      mcp_servers: [{ name: 'claude.ai Slack', status: 'connected' }, { name: 'plugin:design:figma', status: 'connected' }, { name: 'motion-editor', status: 'connected' }],
      permissionMode: 'default',
    };
    const use = (name: string, input: object) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } });
    const { events } = await run(
      await scripted('claude-tools', [
        init,
        use('Skill', { skill: 'pr-package' }),
        use('mcp__claude_ai_Slack__slack_send_message', { text: 'hi' }),
        use('mcp__plugin_design_figma__get_file', {}),
        use('mcp__motion-editor__editor_get_context', {}),
        use('Bash', { command: 'ls' }),
        { type: 'result', subtype: 'success', is_error: false, session_id: 's_tools' },
      ]),
    );
    expect(events.filter((e) => e.type === 'tool')).toEqual([
      { type: 'tool', name: 'Skill', input: { skill: 'pr-package' }, skill: 'pr-package' },
      { type: 'tool', name: 'mcp__claude_ai_Slack__slack_send_message', input: { text: 'hi' }, mcpServer: 'claude.ai Slack' },
      { type: 'tool', name: 'mcp__plugin_design_figma__get_file', input: {}, mcpServer: 'plugin:design:figma' },
      { type: 'tool', name: 'mcp__motion-editor__editor_get_context', input: {}, mcpServer: 'motion-editor' },
      { type: 'tool', name: 'Bash', input: { command: 'ls' } },
    ]);
    expect(events.find((e) => e.type === 'session-info')).toEqual({
      type: 'session-info',
      info: { sessionId: 's_tools', permissionMode: 'default', tools: ['Bash', 'Skill'], mcpServers: [{ name: 'claude.ai Slack', status: 'connected', tools: 1 }, { name: 'plugin:design:figma', status: 'connected', tools: 1 }, { name: 'motion-editor', status: 'connected', tools: 1 }] },
    });
  }, 10000);
});
