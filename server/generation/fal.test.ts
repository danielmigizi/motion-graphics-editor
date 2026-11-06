// Injected HTTP responses exercise fal without network access or real keys.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFalClient, FalError, type FalQueueHandle } from './fal';

const KEY = 'fal_SENTINEL_1234567890abcdef';
const handle: FalQueueHandle = {
  requestId: 'request-1',
  statusUrl: 'https://queue.fal.run/custom/status',
  responseUrl: 'https://queue.fal.run/custom/result',
  cancelUrl: 'https://queue.fal.run/custom/cancel',
};
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
function setup(respond: (url: string, init: RequestInit, index: number) => Response | Promise<Response>, env: NodeJS.ProcessEnv = {}) {
  const calls: { url: string; init: RequestInit; headers: Headers }[] = [];
  const key = vi.fn(async (): Promise<string | null> => KEY);
  const fetchFn: typeof fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init, headers: new Headers(init.headers) });
    return respond(String(url), init, calls.length - 1);
  };
  const client = createFalClient({ key, fetch: fetchFn, env });
  return { client, calls, key };
}

afterEach(() => vi.restoreAllMocks());

describe('fal queue', () => {
  it('submits the full endpoint with auth, filtered tags, input and default lifecycle', async () => {
    const { client, calls } = setup(() => json({ request_id: 'request-1', status_url: handle.statusUrl, response_url: handle.responseUrl, cancel_url: handle.cancelUrl }));
    expect(await client.submit('openai/gpt-image-2.5/flare/text-to-image', { prompt: 'a tree' }, {
      tags: { project_id: 'project-1', job: 'image.generate:v1', Bad: 'value', bad_value: 'with spaces', injection: 'value,other=x', empty: '', ['a'.repeat(65)]: 'value', too_long: 'a'.repeat(257) },
    })).toEqual(handle);
    const call = calls[0];
    expect(call.url).toBe('https://queue.fal.run/openai/gpt-image-2.5/flare/text-to-image');
    expect(call.init.method).toBe('POST');
    expect(call.headers.get('Authorization')).toBe(`Key ${KEY}`);
    expect(call.headers.get('X-Fal-Tags')).toBe('project_id=project-1,job=image.generate:v1');
    expect(JSON.parse(call.headers.get('X-Fal-Object-Lifecycle-Preference')!)).toEqual({ expiration_duration_seconds: 3600 });
    expect(JSON.parse(String(call.init.body))).toEqual({ prompt: 'a tree' });
    expect(call.init.signal).toBeInstanceOf(AbortSignal);
  });

  it('caps valid tags at ten and honours an explicit expiry', async () => {
    const { client, calls } = setup(() => json({ request_id: 'request-1' }));
    await client.submit('owner/app/subpath', {}, { tags: Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`tag_${i}`, `v${i}`])), expirySeconds: 90 });
    expect(calls[0].headers.get('X-Fal-Tags')?.split(',')).toHaveLength(10);
    expect(calls[0].headers.get('X-Fal-Tags')).not.toContain('tag_10');
    expect(JSON.parse(calls[0].headers.get('X-Fal-Object-Lifecycle-Preference')!)).toEqual({ expiration_duration_seconds: 90 });
  });

  it('builds fallback URLs using only owner/app and preserves supplied URLs individually', async () => {
    const { client } = setup(() => json({ request_id: 'request-1', status_url: handle.statusUrl }));
    expect(await client.submit('/owner/app/deeper/endpoint/', {}, { tags: {} })).toEqual({
      requestId: 'request-1', statusUrl: handle.statusUrl,
      responseUrl: 'https://queue.fal.run/owner/app/requests/request-1',
      cancelUrl: 'https://queue.fal.run/owner/app/requests/request-1/cancel',
    });
  });

  it('uses returned URLs for status, result and cancel and reads a changed key', async () => {
    const { client, calls, key } = setup((_url, _init, index) => [
      json({ status: 'IN_QUEUE', queue_position: 3 }, 202),
      json({ status: 'COMPLETED', metrics: { inference_time: 1.25 } }),
      json({ images: [{ url: 'https://cdn.example/output.png' }] }),
      json({}),
    ][index]);
    expect(await client.status(handle)).toMatchObject({ status: 'IN_QUEUE', queuePosition: 3 });
    key.mockResolvedValue('replacement-key');
    expect(await client.status(handle)).toMatchObject({ status: 'COMPLETED', inferenceSeconds: 1.25 });
    expect(await client.result(handle)).toEqual({ images: [{ url: 'https://cdn.example/output.png' }] });
    expect(await client.cancel(handle)).toBe(true);
    expect(calls.map((call) => call.url)).toEqual([handle.statusUrl, handle.statusUrl, handle.responseUrl, handle.cancelUrl]);
    expect(calls[3].init.method).toBe('PUT');
    expect(calls[0].headers.get('Authorization')).toBe(`Key ${KEY}`);
    expect(calls[1].headers.get('Authorization')).toBe('Key replacement-key');
    expect(key).toHaveBeenCalledTimes(4);
  });

  it('passes an external abort signal through the combined timeout signal', async () => {
    const abort = new AbortController();
    const { client, calls } = setup(() => { abort.abort(); return json({}); });
    await client.result(handle, abort.signal);
    expect(calls[0].init.signal?.aborted).toBe(true);
  });

  it.each([400, 404, 409])('ignores cancel HTTP %i', async (status) => {
    const { client } = setup(() => json({ detail: 'already finished' }, status));
    await expect(client.cancel(handle)).resolves.toBe(false);
  });

  it('reports an expired request clearly', async () => {
    const { client } = setup(() => json({ detail: 'not found' }, 404));
    await expect(client.status(handle)).rejects.toMatchObject({ status: 404, kind: 'provider_error', message: 'fal no longer knows this request' });
  });
});

describe('fal errors and redaction', () => {
  it.each([
    [401, 'auth', 'rejected_key'], [403, 'auth', 'rejected_key'],
    [422, 'rejected_input', 'content_policy_violation'], [429, 'provider_error', 'rate_limited'],
    [500, 'provider_error', 'runner_server_error'], [499, 'provider_error', 'cancelled'],
  ])('maps HTTP %i to %s', async (status, kind, falType) => {
    const { client } = setup(() => json({ detail: [{ msg: 'plain reason' }], error_type: status === 429 || status === 499 ? 'ignored' : falType }, status as number));
    await expect(client.result(handle)).rejects.toBeInstanceOf(FalError);
    await expect(client.result(handle)).rejects.toMatchObject({ status, kind, falType, message: 'plain reason' });
  });

  it('redacts a 401 body echoing the key and any Key token, then caps text at 300', async () => {
    const { client } = setup(() => json({ detail: `Rejected ${KEY}; Authorization: Key another-secret ${'x'.repeat(500)}`, error_type: KEY }, 401));
    const error = await client.result(handle).catch((error: FalError) => error) as FalError;
    expect(error.message).not.toContain(KEY);
    expect(error.message).not.toContain('another-secret');
    expect(error.message).toContain('[redacted]');
    expect(error.message).toHaveLength(300);
    expect(error.falType).toBe('[redacted]');
  });

  it('redacts thrown network errors', async () => {
    const { client } = setup(() => { throw new Error(`Socket failed for ${KEY} and Key alternate-secret`); });
    await expect(client.result(handle)).rejects.toMatchObject({ kind: 'network', message: 'Socket failed for [redacted] and [redacted]' });
  });

  it('redacts a transport that throws FalError directly', async () => {
    const { client } = setup(() => { throw new FalError(`Transport echoed ${KEY}`, { kind: 'network', falType: KEY }); });
    await expect(client.result(handle)).rejects.toMatchObject({ kind: 'network', message: 'Transport echoed [redacted]', falType: '[redacted]' });
  });

  it('redacts status error fields and successful HTTP model errors', async () => {
    const { client } = setup((_url, _init, index) => index === 0
      ? json({ status: 'COMPLETED', error: `bad ${KEY}`, error_type: `Key secret` })
      : json({ error: `bad ${KEY}`, error_type: 'content_policy_violation' }));
    expect(await client.status(handle)).toMatchObject({ error: 'bad [redacted]', errorType: '[redacted]' });
    await expect(client.result(handle)).rejects.toMatchObject({ kind: 'rejected_input', message: 'bad [redacted]' });
  });

  it('maps timeout rejection and uses a 30-second API timeout', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(AbortSignal.abort(new DOMException(`Timed out ${KEY}`, 'TimeoutError')));
    const { client } = setup((_url, init) => { throw init.signal!.reason; });
    await expect(client.result(handle)).rejects.toMatchObject({ kind: 'timeout', message: 'Timed out [redacted]' });
    expect(timeout).toHaveBeenCalledWith(30_000);
  });

  it('classifies an external timeout signal', async () => {
    const signal = AbortSignal.abort(new DOMException('deadline', 'TimeoutError'));
    const { client } = setup((_url, init) => { throw init.signal!.reason; });
    await expect(client.status(handle, signal)).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('requires a key without making an HTTP request', async () => {
    const { client, calls, key } = setup(() => json({}));
    key.mockResolvedValue(null);
    await expect(client.result(handle)).rejects.toMatchObject({ kind: 'auth', message: 'No fal key is set. Add one in Settings › Generation.' });
    expect(calls).toHaveLength(0);
  });
});

describe('fal pricing and billing', () => {
  it('chunks pricing requests at 50 endpoints and skips absent or malformed prices', async () => {
    const endpoints = Array.from({ length: 101 }, (_, i) => `owner/model-${i}`);
    const { client, calls } = setup((url) => json({ prices: [
      { endpoint_id: new URL(url).searchParams.get('endpoint_id')!.split(',')[0], unit_price: 0.05, unit: 'image', currency: 'USD' },
      { endpoint_id: 'bad', unit_price: '0.5', unit: 'image', currency: 'USD' },
    ] }));
    const prices = await client.pricing(endpoints);
    expect(calls.map((call) => new URL(call.url).searchParams.get('endpoint_id')!.split(',').length)).toEqual([50, 50, 1]);
    expect(calls[0].url).toContain('https://api.fal.ai/v1/models/pricing?');
    expect(Object.keys(prices)).toEqual([endpoints[0], endpoints[50], endpoints[100]]);
    expect(prices[endpoints[0]]).toEqual({ unitPrice: 0.05, unit: 'image', currency: 'USD' });
    expect(await client.pricing([])).toEqual({});
    expect(calls).toHaveLength(3);
  });

  it('follows billing cursors and parses all list, endpoint, cost and timestamp variants', async () => {
    const start = new Date('2026-10-21T00:00:00Z');
    const end = new Date('2026-10-21T01:00:00Z');
    const { client, calls } = setup((_url, _init, index) => [
      json({ items: [{ request_id: 'r1', endpoint_id: 'a', cost_total: 0.12, timestamp: 't1' }, { request_id: 'bad', cost_total: 1 }], next_cursor: 'page 2' }),
      json({ billing_events: [{ request_id: 'r2', endpoint: 'b', cost_estimate_nano_usd: 50_000_000, created_at: 't2' }], next_cursor: 'page3' }),
      json({ data: [{ request_id: 'r3', endpoint_id: 'c', cost_total: 0 }, null, { request_id: 'bad', endpoint: 'a', cost_total: '1' }, { request_id: 'bad', endpoint: 'a', cost_total: -1 }] }),
    ][index]);
    expect(await client.billingEvents({ endpoints: ['a', 'b'], start, end })).toEqual([
      { requestId: 'r1', endpointId: 'a', costUsd: 0.12, at: 't1' },
      { requestId: 'r2', endpointId: 'b', costUsd: 0.05, at: 't2' },
      { requestId: 'r3', endpointId: 'c', costUsd: 0 },
    ]);
    const params = new URL(calls[0].url).searchParams;
    expect(params.get('endpoint_id')).toBe('a,b');
    expect(params.get('start')).toBe(start.toISOString());
    expect(params.get('end')).toBe(end.toISOString());
    expect(new URL(calls[1].url).searchParams.get('cursor')).toBe('page 2');
    expect(new URL(calls[2].url).searchParams.get('cursor')).toBe('page3');
  });

  it('caps billing pagination at ten pages', async () => {
    const { client, calls } = setup(() => json({ items: [], next_cursor: 'more' }));
    expect(await client.billingEvents({ endpoints: [], start: new Date(0), end: new Date() })).toEqual([]);
    expect(calls).toHaveLength(10);
  });

  it('preserves HTTP 403 when billing permission is missing', async () => {
    const { client } = setup(() => json({ detail: 'Billing permission required.' }, 403));
    await expect(client.billingEvents({ endpoints: ['a'], start: new Date(0), end: new Date() })).rejects.toMatchObject({ status: 403, kind: 'auth' });
  });
});

describe('fal storage and key testing', () => {
  it('initiates storage with auth and uploads bytes without auth, with a 120-second timeout', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const { client, calls } = setup((_url, _init, index) => index === 0
      ? json({ upload_url: 'https://storage.example/presigned', file_url: 'https://cdn.example/file' })
      : new Response(null));
    expect(await client.upload(Buffer.from('bytes'), 'test.png', 'image/png')).toBe('https://cdn.example/file');
    expect(calls[0].url).toBe('https://rest.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3');
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].headers.get('Authorization')).toBe(`Key ${KEY}`);
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ file_name: 'test.png', content_type: 'image/png' });
    expect(JSON.parse(calls[0].headers.get('X-Fal-Object-Lifecycle-Preference')!)).toEqual({ expiration_duration_seconds: 86400 });
    expect(JSON.parse(calls[0].headers.get('X-Fal-Object-Lifecycle')!)).toEqual({ expiration_duration_seconds: 86400 });
    expect(calls[1].url).toBe('https://storage.example/presigned');
    expect(calls[1].init.method).toBe('PUT');
    expect(calls[1].headers.has('Authorization')).toBe(false);
    expect(calls[1].headers.get('Content-Type')).toBe('image/png');
    expect(Buffer.from(calls[1].init.body as Uint8Array).toString()).toBe('bytes');
    expect(timeout.mock.calls.map(([ms]) => ms)).toEqual([30_000, 120_000]);
  });

  it.each([[200, true], [403, false], [500, null], [401, null]])('tests key validity and billing HTTP %i', async (billingStatus, billing) => {
    const { client, calls } = setup((_url, _init, index) => index === 0 ? json({ prices: [] }) : json({ items: [] }, billingStatus as number));
    expect(await client.testKey()).toEqual({ valid: true, billing });
    expect(calls[0].url).toContain('/models/pricing?');
    const params = new URL(calls[1].url).searchParams;
    expect(new Date(params.get('end')!).getTime() - new Date(params.get('start')!).getTime()).toBe(60_000);
  });

  it.each([401, 403])('returns invalid when pricing rejects the key with HTTP %i', async (status) => {
    const { client, calls } = setup(() => json({ detail: `Rejected ${KEY}` }, status));
    expect(await client.testKey()).toEqual({ valid: false, billing: null, error: 'Rejected [redacted]' });
    expect(calls).toHaveLength(1);
  });

  it('returns unknown billing on a transport failure and propagates pricing failures', async () => {
    const { client } = setup((_url, _init, index) => { if (index === 0) return json({ prices: [] }); throw new Error('offline'); });
    expect(await client.testKey()).toEqual({ valid: true, billing: null });
    const broken = setup(() => json({ detail: 'unavailable' }, 503));
    await expect(broken.client.testKey()).rejects.toMatchObject({ status: 503, kind: 'provider_error' });
  });
});

describe('fal base overrides', () => {
  it('honours loopback HTTP overrides for all three bases', async () => {
    const env = { MGE_FAL_QUEUE_URL: 'http://127.0.0.1:9999', MGE_FAL_API_URL: 'http://localhost:9998/', MGE_FAL_REST_URL: 'http://127.0.0.1:9997' };
    const { client, calls } = setup((url) => url.includes('/storage/upload/initiate')
      ? json({ upload_url: 'http://127.0.0.1:9997/put', file_url: 'file-url' })
      : json({ request_id: 'request-1', prices: [] }), env);
    await client.submit('owner/app', {}, { tags: {} });
    await client.pricing(['owner/app']);
    await client.upload(Buffer.from('x'), 'x', 'text/plain');
    expect(calls.map((call) => new URL(call.url).origin)).toEqual(['http://127.0.0.1:9999', 'http://localhost:9998', 'http://127.0.0.1:9997', 'http://127.0.0.1:9997']);
  });

  it.each(['https://evil.example', 'http://localhost:9999@evil.example', 'http://127.0.0.1:9999/evil', 'http://127.0.0.1:99999', 'http://localhost:0'])('ignores unsafe override %s with one warning', async (override) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { client, calls } = setup(() => json({ request_id: 'r', prices: [] }), {
      MGE_FAL_QUEUE_URL: override, MGE_FAL_API_URL: override, MGE_FAL_REST_URL: override,
    });
    await client.submit('owner/app', {}, { tags: {} });
    await client.pricing(['owner/app']);
    expect(calls[0].url).toBe('https://queue.fal.run/owner/app');
    expect(calls[1].url).toContain('https://api.fal.ai/v1/models/pricing?');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(KEY);
  });
});


describe('HTTP outcome evidence', () => {
  it('retains a submission HTTP refusal even when reading its body fails', async () => {
    const { client } = setup(() => {
      const response = new Response(null, { status: 503 });
      response.text = async () => { throw new Error('body disconnected'); };
      return response;
    });
    await expect(client.submit('owner/model', {}, { tags: {} })).rejects.toMatchObject({ status: 503, verdict: false });
  });
  it('accepts a 2xx cancellation without depending on its response body', async () => {
    const { client } = setup(() => {
      const response = new Response(null, { status: 202 });
      response.text = async () => { throw new Error('body disconnected'); };
      return response;
    });
    expect(await client.cancel(handle)).toBe(true);
  });
  it('recognizes a provider failure verdict even without a queue status field', async () => {
    const { client } = setup(() => json({ error_type: 'runner_server_error' }));
    expect(await client.status(handle)).toMatchObject({ status: 'COMPLETED', errorType: 'runner_server_error' });
    await expect(client.result(handle)).rejects.toMatchObject({ kind: 'provider_error', verdict: true });
  });
});
