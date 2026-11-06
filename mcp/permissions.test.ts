import { describe, expect, it, vi } from 'vitest';
import type { BridgeCommand, BridgeReply, EditorStateResponse } from '../src/core/api-contract';
import { fixtureProject } from '../src/core/__fixtures__/fixtureProject';
import { contextFor } from '../server/testing/fakeEditor';
import { createDocState } from '../src/core/history';
import { createHandlers, type ToolResult } from './tools';
import { LocalApiError, LocalEditor } from './local';
const textOf = (r: ToolResult) => (r.content[0] as { text: string }).text;
function setup(decision: 'allowed' | 'denied' | 'timeout', dirty = true) {
  const local = new LocalEditor({ rootDir: '/tmp', serverPort: 1, webPort: 2, openBrowser: false });
  const state: EditorStateResponse = { connected: true, context: contextFor(createDocState(fixtureProject), { dirty }), project: fixtureProject, updatedAt: null };
  vi.spyOn(local, 'state').mockResolvedValue(state);
  vi.spyOn(local, 'ensureRunning').mockResolvedValue({ started: [], logPath: '/tmp/unused' });
  const command = vi.spyOn(local, 'command').mockImplementation(async (c: BridgeCommand): Promise<BridgeReply> => c.type === 'askPermission' ? { ok: true, message: decision } : { ok: true, revision: 2, projectId: fixtureProject.id });
  const request = vi.spyOn(local, 'request').mockImplementation(async (method) => {
    if (method === 'GET') throw new LocalApiError(404, 'missing', null);
    return { ok: true } as never;
  });
  return { h: createHandlers(local), command, request, local, state };
}

describe('MCP permission relay', () => {
  it.each(['denied', 'timeout'] as const)('asks before writing with discardUnsaved and does nothing on %s', async (decision) => {
    const { h, command, request } = setup(decision);
    const r = await h.editor_write_project({ project: structuredClone(fixtureProject) as never, discardUnsaved: true });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('The user declined:');
    expect(command.mock.calls.map(([c]) => c.type)).toEqual(['askPermission']);
    expect(request.mock.calls.some(([method]) => method === 'PUT')).toBe(false);
  });

  it('writes only after permission is allowed', async () => {
    const { h, command, request } = setup('allowed');
    expect((await h.editor_write_project({ project: structuredClone(fixtureProject) as never, discardUnsaved: true })).isError).toBeUndefined();
    expect(command.mock.calls.map(([c]) => c.type)).toEqual(['askPermission', 'openProject']);
    expect(command.mock.invocationCallOrder[0]).toBeLessThan(request.mock.invocationCallOrder[1]);
  });

  it('asks when overwrite is set even without unsaved changes', async () => {
    const { h, command, request } = setup('denied', false);
    await h.editor_write_project({ project: structuredClone(fixtureProject) as never, overwrite: true });
    expect(command).toHaveBeenCalledWith(expect.objectContaining({ type: 'askPermission', action: expect.stringContaining('Overwrite saved project') }));
    expect(request.mock.calls.some(([method]) => method === 'PUT')).toBe(false);
  });

  it('asks before opening a project that would discard unsaved changes', async () => {
    const { h, command } = setup('denied');
    expect((await h.editor_open({ projectId: 'other', discardUnsaved: true })).isError).toBe(true);
    expect(command.mock.calls.map(([c]) => c.type)).toEqual(['askPermission']);
  });

  it('sends discardUnsaved to openProject after allow', async () => {
    const { h, command } = setup('allowed');
    await h.editor_open({ projectId: 'other', discardUnsaved: true });
    expect(command.mock.calls.map(([c]) => c.type)).toEqual(['askPermission', 'openProject']);
    expect(command.mock.calls[1][0]).toMatchObject({ discardUnsaved: true });
  });

  it('preserves the unflagged open path', async () => {
    const { h, command } = setup('denied');
    await h.editor_open({ projectId: 'other' });
    expect(command.mock.calls.map(([c]) => c.type)).toEqual(['openProject']);
  });

  it('does not authorise discarding new edits when the clean editor changes after the state read', async () => {
    const { h, command } = setup('denied', false);
    await h.editor_open({ projectId: 'other', discardUnsaved: true });
    expect(command.mock.calls.map(([c]) => c.type)).toEqual(['openProject']);
    expect(command.mock.calls[0][0]).toMatchObject({ discardUnsaved: false });
  });

  it('stops a write if the user opens another document while permission waits', async () => {
    const { h, local, command, request, state } = setup('allowed');
    const initial = structuredClone(state);
    vi.mocked(local.state).mockResolvedValueOnce(initial).mockResolvedValue({ ...state, context: { ...state.context!, docSession: 'another-session' } });
    const r = await h.editor_write_project({ project: structuredClone(fixtureProject) as never, discardUnsaved: true });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('document changed while permission was waiting');
    expect(command.mock.calls.map(([c]) => c.type)).toEqual(['askPermission']);
    expect(request.mock.calls.some(([method]) => method === 'PUT')).toBe(false);
  });

  it.each(['allowed', 'denied', 'timeout'] as const)('returns Claude permission JSON for %s', async (decision) => {
    const { h, command } = setup(decision);
    const input = { file_path: '/tmp/example.txt', nested: { preserved: true } };
    const r = await h.editor_permission_prompt({ tool_name: 'Read', input, tool_use_id: 'call_1' });
    expect(r.isError).toBeUndefined();
    const json = JSON.parse(textOf(r));
    expect(json).toEqual(decision === 'allowed' ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: expect.stringContaining('The user declined:') });
    expect(command.mock.calls[0][0]).toMatchObject({ type: 'askPermission', action: 'Read file “/tmp/example.txt”' });
  });

  // Every MCP server's tool is the user's to approve on the ordinary card; no server is special-cased.
  it('asks on the ordinary card for any MCP server tool and never calls the server first', async () => {
    const { h, command, request } = setup('allowed');
    for (const tool_name of ['mcp__claude_ai_Slack__slack_send_message', 'mcp__claude_ai_Studio__studio_generate_media']) {
      const r = await h.editor_permission_prompt({ tool_name, input: { text: 'hi' }, tool_use_id: 'toolu_1' });
      expect(JSON.parse(textOf(r))).toEqual({ behavior: 'allow', updatedInput: { text: 'hi' } });
    }
    expect(command.mock.calls.map(([c]) => (c as { action?: string }).action)).toEqual(['Use “slack_send_message” from the MCP server claude_ai_Slack', 'Use “studio_generate_media” from the MCP server claude_ai_Studio']);
    expect(request).not.toHaveBeenCalled();
  });
});
