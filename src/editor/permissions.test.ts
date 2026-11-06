import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleBridgeCommand } from './agentBridge';
import { usePermissions } from './permissions';

const request = { type: 'askPermission' as const, requestId: 'permission-1', agent: 'Codex', action: 'Replace the open project', timeoutMs: 1000 };
afterEach(() => { usePermissions.getState().decide('denied'); vi.useRealTimers(); });

describe('permission relay in the editor', () => {
  it.each(['allowed', 'denied'] as const)('returns %s when the user decides', async (decision) => {
    const reply = handleBridgeCommand(request);
    expect(usePermissions.getState().pending).toMatchObject(request);
    usePermissions.getState().decide(decision);
    expect(await reply).toEqual({ ok: true, message: decision });
    expect(usePermissions.getState().pending).toBeNull();
  });

  it('times out and clears the card', async () => {
    vi.useFakeTimers();
    const reply = handleBridgeCommand(request);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await reply).toEqual({ ok: true, message: 'timeout' });
    expect(usePermissions.getState().pending).toBeNull();
  });

  it('denies a second request without replacing the waiting card', async () => {
    const first = handleBridgeCommand(request);
    expect(await handleBridgeCommand({ ...request, requestId: 'permission-2' })).toEqual({ ok: true, message: 'denied', reason: 'another request is waiting' });
    expect(usePermissions.getState().pending?.requestId).toBe('permission-1');
    usePermissions.getState().decide('allowed');
    expect(await first).toEqual({ ok: true, message: 'allowed' });
  });

  it('rejects a late allow even if a throttled browser has not fired its timer', async () => {
    vi.useFakeTimers();
    const reply = handleBridgeCommand(request);
    vi.setSystemTime(Date.now() + 1001);
    usePermissions.getState().decide('allowed');
    expect(await reply).toEqual({ ok: true, message: 'timeout' });
  });
});

it('denies a second event-stream request while the first awaits the user', async () => {
  const { startAgentBridge } = await import('./agentBridge');
  const listeners = new Map<string, (event: { data: string }) => void>();
  class FakeEventSource {
    addEventListener(name: string, handler: (event: { data: string }) => void) { listeners.set(name, handler); }
    close() {}
  }
  vi.stubGlobal('EventSource', FakeEventSource);
  const posts = vi.fn(async () => new Response('{}', { status: 200 }));
  vi.stubGlobal('fetch', posts);
  const stop = startAgentBridge();
  try {
    listeners.get('command')!({ data: JSON.stringify({ id: 'first', command: request }) });
    listeners.get('command')!({ data: JSON.stringify({ id: 'second', command: { ...request, requestId: 'permission-2' } }) });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(posts).toHaveBeenCalledWith('/api/editor/replies/second', expect.objectContaining({ body: JSON.stringify({ ok: true, message: 'denied', reason: 'another request is waiting' }) }));
    expect(usePermissions.getState().pending?.requestId).toBe('permission-1');
    usePermissions.getState().decide('allowed');
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(posts).toHaveBeenCalledWith('/api/editor/replies/first', expect.objectContaining({ body: JSON.stringify({ ok: true, message: 'allowed' }) }));
  } finally {
    stop();
    vi.unstubAllGlobals();
  }
});
