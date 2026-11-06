// Start server/index.ts on 5618, then npx tsx scripts/render-cancel-smoke.ts.
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RenderJob } from '../src/core/api-contract';
import { sampleProject } from '../src/sample/sampleProject';

const rootDir = fileURLToPath(new URL('..', import.meta.url));
const server = 'http://127.0.0.1:5618';
const getJson = async (path: string, init?: RequestInit): Promise<RenderJob> => {
  const response = await fetch(`${server}${path}`, init);
  if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`);
  return response.json();
};
const job = await getJson('/api/renders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project: sampleProject }) });
let cancelled = false;
try {
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    const current = await getJson(`/api/renders/${job.id}`);
    if (current.status === 'rendering' && current.renderedFrames > 0) {
      const result = await getJson(`/api/renders/${job.id}/cancel`, { method: 'POST' });
      cancelled = result.status === 'cancelled';
      const noMp4 = !existsSync(join(rootDir, 'renders', `${job.id}.mp4`));
      const persisted = await getJson(`/api/renders/${job.id}`);
      if (!cancelled || !noMp4 || persisted.status !== 'cancelled') throw new Error('Cancellation did not remove the MP4 and retain cancelled status.');
      const evidence = { jobId: job.id, before: current, after: persisted, noMp4 };
      await writeFile(join(rootDir, 'renders/render-cancel-smoke.json'), JSON.stringify(evidence, null, 2));
      console.log(JSON.stringify(evidence, null, 2));
      break;
    }
    if (['done', 'failed', 'cancelled', 'interrupted'].includes(current.status)) throw new Error(`Render reached ${current.status} before cancellation: ${current.error ?? ''}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!cancelled) throw new Error('Timed out waiting for rendering frames.');
} finally {
  if (!cancelled) await getJson(`/api/renders/${job.id}/cancel`, { method: 'POST' }).catch(() => undefined);
}
