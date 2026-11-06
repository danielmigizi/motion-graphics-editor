// Injectable fal HTTP client: queue requests, pricing, billing and uploads.
// Provider and transport error text is redacted before it leaves this module.

/** A fal or transport failure, safe to display in generation status. */
export class FalError extends Error {
  /** A failure reported by the model, rather than the HTTP transport. */
  readonly verdict: boolean;
  readonly status?: number;
  readonly falType?: string;
  readonly kind: 'auth' | 'rejected_input' | 'provider_error' | 'timeout' | 'network';
  constructor(message: string, opts: { kind: FalError['kind']; status?: number; falType?: string; verdict?: boolean }) {
    super(message);
    this.name = 'FalError';
    this.kind = opts.kind;
    this.status = opts.status;
    this.verdict = opts.verdict ?? false;
    this.falType = opts.falType;
  }
}

export interface FalQueueHandle { requestId: string; statusUrl: string; responseUrl: string; cancelUrl: string }
export interface FalQueueStatus { status: 'IN_QUEUE' | 'IN_PROGRESS' | 'COMPLETED'; queuePosition?: number; error?: string; errorType?: string; inferenceSeconds?: number }
export interface FalBillingEvent { requestId: string; endpointId: string; costUsd: number; at?: string }

export interface FalClient {
  submit(endpoint: string, input: Record<string, unknown>, opts: { tags: Record<string, string>; expirySeconds?: number; signal?: AbortSignal }): Promise<FalQueueHandle>;
  status(handle: FalQueueHandle, signal?: AbortSignal): Promise<FalQueueStatus>;
  /** The model output; model failures throw FalError. */
  result(handle: FalQueueHandle, signal?: AbortSignal): Promise<unknown>;
  /** True only when fal accepted the cancellation with a 2xx response. */
  cancel(handle: FalQueueHandle): Promise<boolean>;
  /** Prices in chunks of at most 50 endpoints; missing endpoints stay absent. */
  pricing(endpoints: string[]): Promise<Record<string, { unitPrice: number; unit: string; currency: string }>>;
  /** Billing events, following next_cursor for at most ten pages. */
  billingEvents(opts: { endpoints: string[]; start: Date; end: Date }): Promise<FalBillingEvent[]>;
  /** Initiate a storage upload, then PUT bytes without an Authorization header. */
  upload(bytes: Buffer, fileName: string, contentType: string): Promise<string>;
  /** Test model access, then whether the key can read billing events. */
  testKey(): Promise<{ valid: boolean; billing: boolean | null; error?: string }>;
}

function record(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
}

function string(raw: unknown): string | undefined {
  return typeof raw === 'string' && raw ? raw : undefined;
}

function number(raw: unknown): number | undefined {
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined;
}

function redact(text: string, key: string): string {
  return (key ? text.split(key).join('[redacted]') : text).replace(/\bKey\s+[^\s"'<>]+/gi, '[redacted]').slice(0, 300);
}

function errorMessage(body: unknown): string | undefined {
  if (typeof body === 'string') return body;
  const obj = record(body);
  const detail = obj.detail;
  return (Array.isArray(detail) ? string(record(detail[0]).msg) : string(detail))
    ?? string(obj.message) ?? string(obj.error);
}

function httpError(status: number, body: unknown, key: string): FalError {
  const obj = record(body);
  const kind = status === 401 || status === 403 ? 'auth' : status === 422 ? 'rejected_input' : 'provider_error';
  const falType = status === 499 ? 'cancelled' : status === 429 ? 'rate_limited' : string(obj.error_type) ?? string(obj.type);
  return new FalError(redact(errorMessage(body) || `fal request failed (HTTP ${status}).`, key), {
    status, kind, falType: falType ? redact(falType, key) : undefined,
  });
}

function base(env: NodeJS.ProcessEnv, name: string, fallback: string, warn: () => void): string {
  const override = env[name];
  if (!override) return fallback;
  const match = /^http:\/\/(?:127\.0\.0\.1|localhost):([0-9]+)\/?$/.exec(override);
  const port = Number(match?.[1]);
  if (match && port >= 1 && port <= 65535) return override.replace(/\/$/, '');
  warn();
  return fallback;
}

/** Create a client that reads the current key for every authenticated request. */
export function createFalClient(opts: {
  key: () => Promise<string | null>;
  fetch?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}): FalClient {
  const fetchFn = opts.fetch ?? fetch;
  const env = opts.env ?? process.env;
  let warned = false;
  const warn = () => {
    if (!warned) console.warn('Ignoring fal URL overrides that are not local HTTP stub addresses.');
    warned = true;
  };
  const queue = base(env, 'MGE_FAL_QUEUE_URL', 'https://queue.fal.run', warn);
  const api = base(env, 'MGE_FAL_API_URL', 'https://api.fal.ai/v1', warn);
  const rest = base(env, 'MGE_FAL_REST_URL', 'https://rest.fal.ai', warn);

  async function request(url: string, init: RequestInit = {}, options: {
    signal?: AbortSignal; uploadKey?: string; ignore?: number[]; headersOnly?: boolean;
  } = {}): Promise<{ body: unknown; key: string; accepted: boolean }> {
    let key: string;
    try {
      key = options.uploadKey ?? await opts.key() ?? '';
    } catch {
      throw new FalError('Could not read the fal key.', { kind: 'auth' });
    }
    if (!key) throw new FalError('No fal key is set. Add one in Settings › Generation.', { kind: 'auth' });
    const headers = new Headers(init.headers);
    if (options.uploadKey === undefined) headers.set('Authorization', `Key ${key}`);
    const timeout = AbortSignal.timeout(options.uploadKey === undefined ? 30_000 : 120_000);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    try {
      const res = await fetchFn(url, { ...init, headers, signal, redirect: 'error' });
      if (options.headersOnly && res.ok) return { body: null, key, accepted: true };
      if (options.ignore?.includes(res.status)) return { body: null, key, accepted: false };
      const text = await res.text().catch((err) => { if (!res.ok) throw httpError(res.status, null, key); throw err; });
      let body: unknown;
      try { body = text ? JSON.parse(text) : null; } catch { body = text; }
      if (!res.ok) throw httpError(res.status, body, key);
      return { body, key, accepted: res.ok };
    } catch (error) {
      if (error instanceof FalError) throw new FalError(redact(error.message, key), {
        kind: error.kind, status: error.status, verdict: error.verdict, falType: error.falType ? redact(error.falType, key) : undefined,
      });
      const isTimeout = timeout.aborted || record(error).name === 'TimeoutError' || record(signal.reason).name === 'TimeoutError';
      throw new FalError(redact(error instanceof Error ? error.message : 'Could not reach fal.', key), { kind: isTimeout ? 'timeout' : 'network' });
    }
  }

  const client: FalClient = {
    async submit(endpoint, input, options) {
      const path = endpoint.replace(/^\/+|\/+$/g, '');
      const tags = Object.entries(options.tags)
        .filter(([key, value]) => /^[a-z0-9_]{1,64}$/.test(key) && /^[A-Za-z0-9._:-]{1,256}$/.test(value))
        .slice(0, 10).map(([key, value]) => `${key}=${value}`).join(',');
      const { body } = await request(`${queue}/${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Fal-Tags': tags,
          'X-Fal-Object-Lifecycle-Preference': JSON.stringify({ expiration_duration_seconds: options.expirySeconds ?? 3600 }),
        },
        body: JSON.stringify(input),
      }, { signal: options.signal });
      const obj = record(body);
      const requestId = string(obj.request_id);
      if (!requestId) throw new FalError('fal did not return a request id.', { kind: 'provider_error' });
      const fallback = `${queue}/${path.split('/').slice(0, 2).join('/')}/requests/${encodeURIComponent(requestId)}`;
      return {
        requestId,
        statusUrl: string(obj.status_url) ?? `${fallback}/status`,
        responseUrl: string(obj.response_url) ?? fallback,
        cancelUrl: string(obj.cancel_url) ?? `${fallback}/cancel`,
      };
    },
    async status(handle, signal) {
      let response;
      try {
        response = await request(handle.statusUrl, {}, { signal });
      } catch (error) {
        if (error instanceof FalError && error.status === 404) throw new FalError('fal no longer knows this request', { kind: 'provider_error', status: 404 });
        throw error;
      }
      const { body, key } = response;
      const obj = record(body);
      if (obj.error || obj.error_type) return {
        status: 'COMPLETED', error: redact(string(obj.error) ?? 'fal could not complete the request.', key),
        errorType: string(obj.error_type) ? redact(String(obj.error_type), key) : undefined,
      };
      if (obj.status !== 'IN_QUEUE' && obj.status !== 'IN_PROGRESS' && obj.status !== 'COMPLETED') {
        throw new FalError('fal returned an unknown queue status.', { kind: 'provider_error' });
      }
      const error = string(obj.error);
      const errorType = string(obj.error_type);
      return {
        status: obj.status,
        queuePosition: number(obj.queue_position),
        error: error ? redact(error, key) : undefined,
        errorType: errorType ? redact(errorType, key) : undefined,
        inferenceSeconds: number(record(obj.metrics).inference_time),
      };
    },
    async result(handle, signal) {
      const { body, key } = await request(handle.responseUrl, {}, { signal });
      const obj = record(body);
      if (obj.error || obj.error_type) {
        const error = httpError(obj.error_type === 'content_policy_violation' ? 422 : 500, body, key);
        throw new FalError(error.message, { kind: error.kind, falType: error.falType, verdict: true });
      }
      return body;
    },
    async cancel(handle) {
      try {
        return (await request(handle.cancelUrl, { method: 'PUT' }, { ignore: [400, 404, 409], headersOnly: true })).accepted;
      } catch { return false; }
    },
    async pricing(endpoints) {
      const prices: Awaited<ReturnType<FalClient['pricing']>> = {};
      for (let i = 0; i < endpoints.length; i += 50) {
        const params = new URLSearchParams({ endpoint_id: endpoints.slice(i, i + 50).join(',') });
        const { body } = await request(`${api}/models/pricing?${params}`);
        const rows = record(body).prices;
        if (!Array.isArray(rows)) continue;
        for (const row of rows) {
          const obj = record(row);
          const id = string(obj.endpoint_id);
          const price = number(obj.unit_price);
          const unit = string(obj.unit);
          const currency = string(obj.currency);
          if (id && price !== undefined && price >= 0 && unit && currency) {
            Object.defineProperty(prices, id, { value: { unitPrice: price, unit, currency }, enumerable: true, configurable: true, writable: true });
          }
        }
      }
      return prices;
    },
    async billingEvents(options) {
      const events: FalBillingEvent[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 10; page++) {
        const params = new URLSearchParams({ endpoint_id: options.endpoints.join(','), start: options.start.toISOString(), end: options.end.toISOString() });
        if (cursor) params.set('cursor', cursor);
        const { body } = await request(`${api}/models/billing-events?${params}`);
        const obj = record(body);
        const rows = [obj.items, obj.billing_events, obj.data].find(Array.isArray);
        for (const row of rows ?? []) {
          const item = record(row);
          const requestId = string(item.request_id);
          const endpointId = string(item.endpoint_id) ?? string(item.endpoint);
          const nano = number(item.cost_estimate_nano_usd);
          const costUsd = number(item.cost_total) ?? (nano === undefined ? undefined : nano / 1e9);
          const at = string(item.timestamp) ?? string(item.created_at);
          if (requestId && endpointId && costUsd !== undefined && costUsd >= 0) events.push({ requestId, endpointId, costUsd, ...(at ? { at } : {}) });
        }
        cursor = string(obj.next_cursor);
        if (!cursor) break;
      }
      return events;
    },
    async upload(bytes, fileName, contentType) {
      const { body, key } = await request(`${rest}/storage/upload/initiate?storage_type=fal-cdn-v3`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Fal-Object-Lifecycle': JSON.stringify({ expiration_duration_seconds: 86400 }),
          'X-Fal-Object-Lifecycle-Preference': JSON.stringify({ expiration_duration_seconds: 86400 }),
        },
        body: JSON.stringify({ file_name: fileName, content_type: contentType }),
      });
      const obj = record(body);
      const uploadUrl = string(obj.upload_url);
      const fileUrl = string(obj.file_url);
      if (!uploadUrl || !fileUrl) throw new FalError('fal did not return storage upload URLs.', { kind: 'provider_error' });
      await request(uploadUrl, { method: 'PUT', headers: { 'Content-Type': contentType }, body: new Uint8Array(bytes) }, { uploadKey: key });
      return fileUrl;
    },
    async testKey() {
      const endpoint = 'fal-ai/flux/dev';
      try {
        await client.pricing([endpoint]);
      } catch (error) {
        if (error instanceof FalError && (error.status === 401 || error.status === 403)) return { valid: false, billing: null, error: error.message };
        throw error;
      }
      try {
        const end = new Date();
        await client.billingEvents({ endpoints: [endpoint], start: new Date(end.getTime() - 60_000), end });
        return { valid: true, billing: true };
      } catch (error) {
        return { valid: true, billing: error instanceof FalError && error.status === 403 ? false : null };
      }
    },
  };
  return client;
}
