// Local fal stub: npm run fal:stub [-- 8787 --slow] (or MGE_FAL_STUB_SLOW=1)
// Then: MGE_FAL_QUEUE_URL=http://127.0.0.1:8787 MGE_FAL_API_URL=http://127.0.0.1:8787 MGE_FAL_REST_URL=http://127.0.0.1:8787 MGE_CONFIG_DIR=<tmp> npm run dev
// Enter any key except bad-key. Outputs use public samples via the normal importer.

import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { MODELS } from '../src/core/generationRoutes';

const slow = process.argv.includes('--slow') || process.env.MGE_FAL_STUB_SLOW === '1';
const port = Number(process.argv.slice(2).find((arg) => arg !== '--slow') ?? 8787);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Supply a port from 1 to 65535.');
const base = `http://127.0.0.1:${port}`;
const image = 'https://v3b.fal.media/files/b/0a8691af/9Se_1_VX1wzTjjTOpWbs9_bb39c2eb-1a41-4749-b1d0-cf134abc8bbf.png';
const audio = 'https://storage.googleapis.com/falserverless/example_outputs/elevenlabs/music_generated.mp3';
const video = 'https://storage.googleapis.com/falserverless/example_outputs/veo3-i2v-output.mp4';
const videoEndpoints = new Set(Object.values(MODELS).flatMap((m) => Object.entries(m.endpoints).filter(([job]) => job.startsWith('video.')).map(([, endpoint]) => endpoint)));
const requests = new Map<string, { endpoint: string; input: Record<string, unknown>; polls: number; submittedAt: number; cancelled: boolean }>();
const server = createServer(async (req, res) => {
  const send = (status: number, body: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  try {
    const url = new URL(req.url ?? '/', base);
    if (req.headers.authorization === 'Key bad-key') return send(401, { detail: 'fal did not accept this key.' });
    if (url.pathname === '/models/pricing' && req.method === 'GET') {
      const endpoints = (url.searchParams.get('endpoint_id') ?? '').split(',');
      return send(200, { prices: endpoints.flatMap((endpoint) => {
        const model = Object.values(MODELS).find((m) => Object.values(m.endpoints).includes(endpoint));
        if (!model && endpoint !== 'fal-ai/flux/dev') return [];
        return [{ endpoint_id: endpoint, unit_price: model?.price.reserve ? 0.5 : model?.price.usd ?? 0.025, unit: model?.price.unit ?? 'units', currency: 'USD' }];
      }) });
    }
    if (url.pathname === '/models/billing-events') return send(403, { detail: 'Billing access is unavailable in the local stub.' });
    if (url.pathname === '/storage/upload/initiate' && req.method === 'POST') {
      req.resume();
      const id = randomUUID();
      return send(200, { upload_url: `${base}/uploads/${id}`, file_url: image });
    }
    if (url.pathname.startsWith('/uploads/') && req.method === 'PUT') { req.resume(); return send(200, {}); }
    const match = /^\/requests\/([^/]+)(?:\/(status|cancel))?$/.exec(url.pathname);
    if (match) {
      const job = requests.get(match[1]);
      if (!job) return send(404, { detail: 'Unknown request.' });
      if (match[2] === 'cancel' && req.method === 'PUT') { job.cancelled = true; return send(200, {}); }
      if (job.cancelled) return send(409, { detail: 'Request cancelled.' });
      if (match[2] === 'status') {
        const status = slow ? Date.now() - job.submittedAt < 20_000 ? 'IN_PROGRESS' : 'COMPLETED'
          : ['IN_QUEUE', 'IN_PROGRESS', 'COMPLETED'][Math.min(job.polls++, 2)];
        return send(200, { status, ...(status === 'IN_QUEUE' ? { queue_position: 1 } : {}) });
      }
      return send(200, videoEndpoints.has(job.endpoint)
        ? { video: { url: video, content_type: 'video/mp4' }, seed: 7 }
        : job.endpoint.includes('image') || job.endpoint.includes('seedream') || job.endpoint.includes('flux')
        ? { images: Array.from({ length: Math.max(1, Math.min(4, Number(job.input.num_images) || 1)) }, () => ({ url: image, width: 1024, height: 1024 })), seed: 42 }
        : job.endpoint.includes('tts') && typeof job.input.text === 'string'
        // Eleven v4 with timestamps: one entry per word, 0.35 s each.
        ? { audio: { url: audio }, timestamps: job.input.text.split(/\s+/).filter(Boolean).map((word, i) => ({ word, start: i * 0.35, end: (i + 1) * 0.35 })) }
        : { audio: { url: audio } });
    }
    if (req.method === 'POST') {
      let text = '';
      for await (const chunk of req) {
        text += String(chunk);
        if (text.length > 20 * 1024 * 1024) return send(413, { detail: 'Request too large.' });
      }
      const input = JSON.parse(text || '{}') as Record<string, unknown>;
      const id = randomUUID();
      requests.set(id, { endpoint: url.pathname.slice(1), input, polls: 0, submittedAt: Date.now(), cancelled: false });
      // Keep the helper bounded during long local verification sessions.
      if (requests.size > 5000) requests.delete(requests.keys().next().value!);
      return send(200, { request_id: id, status_url: `${base}/requests/${id}/status`, response_url: `${base}/requests/${id}`, cancel_url: `${base}/requests/${id}/cancel` });
    }
    send(404, { detail: 'Unknown stub route.' });
  } catch { send(400, { detail: 'Invalid stub request.' }); }
});
server.listen(port, '127.0.0.1', () => console.log(`fal stub listening at ${base}`));
