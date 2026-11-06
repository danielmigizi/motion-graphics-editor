import { EventEmitter } from 'node:events';
import type { Response } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditorBridge } from './bridge';

const bridges: EditorBridge[] = [];
function connected(heartbeatMs?: number) {
  const bridge = new EditorBridge({ heartbeatMs });
  const stream = Object.assign(new EventEmitter(), {
    status: vi.fn(), setHeader: vi.fn(), flushHeaders: vi.fn(), write: vi.fn(), end: vi.fn(),
  });
  bridge.connect(stream as unknown as Response);
  bridges.push(bridge);
  return { bridge, stream };
}
afterEach(() => { bridges.splice(0).forEach((b) => b.close()); vi.useRealTimers(); });
const request = { type: 'askPermission' as const, requestId: 'r', agent: 'Cursor', action: 'Replace a project' };

describe('per-command bridge waits', () => {
  it('keeps ordinary commands at 20 seconds', async () => {
    vi.useFakeTimers();
    const { bridge } = connected();
    const done = vi.fn();
    const reply = bridge.send({ type: 'save' }).then(done);
    await vi.advanceTimersByTimeAsync(19999);
    expect(done).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await reply;
    expect(done).toHaveBeenCalledWith(expect.objectContaining({ ok: false, error: expect.objectContaining({ code: 'TIMEOUT' }) }));
  });

  it.each([[undefined, 120000], [45000, 45000], [900000, 300000]])('uses %s ms for permission (bounded wait %s)', async (timeoutMs, expected) => {
    vi.useFakeTimers();
    const { bridge } = connected();
    const done = vi.fn();
    const reply = bridge.send({ ...request, timeoutMs }).then(done);
    await vi.advanceTimersByTimeAsync(expected - 1);
    expect(done).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await reply;
    expect(done).toHaveBeenCalledWith({ ok: true, message: 'timeout' });
  });

  it('accepts a permission decision after the ordinary 20-second limit', async () => {
    vi.useFakeTimers();
    const { bridge, stream } = connected();
    const reply = bridge.send(request);
    const command = stream.write.mock.calls.find(([data]) => String(data).startsWith('event: command'))![0];
    const { id } = JSON.parse(String(command).split('data: ')[1]);
    await vi.advanceTimersByTimeAsync(30000);
    expect(bridge.reply(id, { ok: true, message: 'allowed' })).toBe(true);
    expect(await reply).toEqual({ ok: true, message: 'allowed' });
  });
});


it.each([undefined, 37])('emits observable SSE ping events at heartbeat interval %s', async (heartbeatMs) => {
  vi.useFakeTimers();
  const { bridge, stream } = connected(heartbeatMs);
  stream.write.mockClear();
  await vi.advanceTimersByTimeAsync((heartbeatMs ?? 10000) - 1);
  expect(stream.write).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(stream.write).toHaveBeenCalledWith('event: ping\ndata: {}\n\n');
  bridge.close();
  stream.write.mockClear();
  await vi.advanceTimersByTimeAsync(heartbeatMs ?? 10000);
  expect(stream.write).not.toHaveBeenCalled();
});
