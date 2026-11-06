// Exercise the CLI stub without opening a loopback socket.
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MODELS } from '../../src/core/generationRoutes';

const capture = vi.hoisted(() => ({ handler: undefined as unknown as (req: any, res: any) => Promise<void> }));
vi.mock('node:http', () => ({ createServer: (handler: typeof capture.handler) => {
  capture.handler = handler;
  return { listen: vi.fn() };
} }));
const argv = process.argv;
afterEach(() => { process.argv = argv; vi.unstubAllEnvs(); vi.restoreAllMocks(); });
async function request(path: string, method = 'GET', body?: unknown) {
  const req = Object.assign(Readable.from(body === undefined ? [] : [JSON.stringify(body)]), { url: path, method, headers: {} });
  let status = 0;
  let value: any;
  await capture.handler(req, { writeHead: (code: number) => { status = code; }, end: (text: string) => { value = JSON.parse(text); } });
  expect(status).toBe(200);
  return value;
}
describe('video fal stub', () => {
  it('returns the audio sample for a scored-music composition plan', async () => {
    vi.resetModules();
    process.argv = ['node', 'fal-stub.ts', '8787'];
    await import('../../scripts/fal-stub');
    const endpoint = Object.values(MODELS).find((model) => model.endpoints['music.scored'])!.endpoints['music.scored'];
    const handle = await request(`/${endpoint}`, 'POST', { composition_plan: { chunks: [{ text: '[Intro]', duration_ms: 3000, positive_styles: ['instrumental'] }] } });
    expect(await request(new URL(handle.response_url).pathname)).toEqual({ audio: { url: 'https://storage.googleapis.com/falserverless/example_outputs/elevenlabs/music_generated.mp3' } });
  });

  it.each(['arg', 'env'])('returns video results and stays in progress for 20 seconds with slow %s', async (mode) => {
    vi.resetModules();
    process.argv = ['node', 'fal-stub.ts', '8787', ...(mode === 'arg' ? ['--slow'] : [])];
    vi.stubEnv('MGE_FAL_STUB_SLOW', mode === 'env' ? '1' : '0');
    const clock = vi.spyOn(Date, 'now').mockReturnValue(100_000);
    await import('../../scripts/fal-stub');
    const endpoints = [...new Set(Object.values(MODELS).flatMap((model) => Object.entries(model.endpoints).filter(([job]) => job.startsWith('video.')).map(([, endpoint]) => endpoint)))];
    expect(endpoints.length).toBeGreaterThan(0);
    for (const endpoint of endpoints) {
      clock.mockReturnValue(100_000);
      const handle = await request(`/${endpoint}`, 'POST', { prompt: 'A kite' });
      const statusPath = new URL(handle.status_url).pathname;
      expect(await request(statusPath)).toMatchObject({ status: 'IN_PROGRESS' });
      clock.mockReturnValue(119_999);
      expect(await request(statusPath)).toMatchObject({ status: 'IN_PROGRESS' });
      clock.mockReturnValue(120_000);
      expect(await request(statusPath)).toMatchObject({ status: 'COMPLETED' });
      expect(await request(new URL(handle.response_url).pathname)).toEqual({ video: { url: 'https://storage.googleapis.com/falserverless/example_outputs/veo3-i2v-output.mp4', content_type: 'video/mp4' }, seed: 7 });
    }
  });
});
