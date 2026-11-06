import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RenderJob, RenderStatus } from '../src/core/api-contract';
import { projectDurationInFrames } from '../src/core/timing';
import { sampleProject } from '../src/sample/sampleProject';
import * as projectFiles from './projects';
import { RenderConflictError, RenderManager, type Renderer } from './renders';

/** Fake renderer: bundling, then 10 rendering/encoding steps; honours the abort signal. */
function mockRenderer(seen?: RenderStatus[]): Renderer {
  return async ({ project, onProgress, signal }) => {
    const total = projectDurationInFrames(project);
    onProgress({ stage: 'bundling', progress: 0.05 });
    seen?.push('bundling');
    for (let i = 1; i <= 10; i++) {
      await new Promise((r) => setTimeout(r, 1));
      if (signal.aborted) throw new Error('Render cancelled by cancelSignal');
      const frac = i / 10;
      const stage = i < 8 ? 'rendering' : 'encoding';
      if (seen && seen[seen.length - 1] !== stage) seen.push(stage);
      onProgress({ stage, progress: 0.1 + 0.9 * frac, renderedFrames: Math.round(total * frac), encodedFrames: Math.round(total * frac * 0.9) });
    }
  };
}

describe('RenderManager', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mge-renders-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('runs a job queued → bundling → rendering → encoding → done and stores the snapshot', async () => {
    const seen: RenderStatus[] = [];
    const statuses = new Set<RenderStatus>();
    const mgr = new RenderManager({ rendersDir: dir, renderer: mockRenderer(seen) });
    const job = await mgr.start(sampleProject);
    expect(job.status).toBe('queued');
    expect(job.totalFrames).toBe(projectDurationInFrames(sampleProject));
    expect(job.projectRevision).toBe(sampleProject.revision);
    const poll = setInterval(() => statuses.add(mgr.get(job.id)!.status), 0);
    await mgr.whenIdle();
    clearInterval(poll);
    expect(seen).toEqual(['bundling', 'rendering', 'encoding']);
    expect([...statuses]).toContain('rendering');
    const done = mgr.get(job.id)!;
    expect(done).toMatchObject({ status: 'done', progress: 1, outputUrl: `/renders/${job.id}.mp4`, renderedFrames: done.totalFrames });
    expect(done.finishedAt).toBeTruthy();
    expect(JSON.parse(await readFile(join(dir, `${job.id}.json`), 'utf8'))).toEqual(sampleProject);
  });

  it('writes credits.txt beside the MP4 when the snapshot has Openverse audio', async () => {
    const project = structuredClone(sampleProject);
    project.assets.ast_music = {
      ...project.assets.ast_music,
      provenance: {
        source: 'openverse',
        provider: 'openverse',
        license: { spdxOrCc: 'by', attribution: '"Bed" by Ada is licensed under CC BY 4.0.', creator: 'Ada', openverseId: '11111111-1111-4111-8111-111111111111' },
      },
    };
    const mgr = new RenderManager({ rendersDir: dir, renderer: mockRenderer() });
    const job = await mgr.start(project);
    await mgr.whenIdle();
    expect(mgr.get(job.id)!.status).toBe('done');
    const credits = await readFile(join(dir, `${job.id}.credits.txt`), 'utf8');
    expect(credits).toContain('"Bed" by Ada is licensed under CC BY 4.0.');
    expect(credits).toContain('Made with Openverse');
  });

  it('simulated failure → failed → retry (from snapshot, no hook) → done', async () => {
    const mgr = new RenderManager({ rendersDir: dir, renderer: mockRenderer() });
    const editable = structuredClone(sampleProject);
    const job = await mgr.start(editable, { simulateFailureAtProgress: 0.5 });
    // Mutating the editable project after start must not affect the render.
    editable.name = 'changed after start';
    await mgr.whenIdle();
    const failed = mgr.get(job.id)!;
    expect(failed.status).toBe('failed');
    expect(failed.error).toMatch(/^Simulated render failure at \d+%$/);
    expect(Number(/(\d+)%/.exec(failed.error!)![1])).toBeGreaterThan(50);
    expect(failed.outputUrl).toBeUndefined();

    const retry = (await mgr.retry(job.id))!;
    expect(retry.retryOf).toBe(job.id);
    expect(retry.id).not.toBe(job.id);
    await mgr.whenIdle();
    expect(mgr.get(retry.id)!.status).toBe('done');
    expect((await mgr.getSnapshot(retry.id))!.name).toBe(sampleProject.name);
    expect(mgr.list().map((j) => j.id)).toEqual(expect.arrayContaining([job.id, retry.id]));
  });

  it('runs one job at a time; others queue', async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    const inner = mockRenderer();
    // Hold the first job open until we have asserted the second is queued.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    const renderer: Renderer = async (args) => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      if (calls++ === 0) await gate;
      await inner(args);
      concurrent--;
    };
    const mgr = new RenderManager({ rendersDir: dir, renderer });
    const a = await mgr.start(sampleProject);
    const b = await mgr.start(sampleProject);
    await new Promise((r) => setTimeout(r, 2));
    expect(mgr.get(b.id)!.status).toBe('queued');
    release();
    await mgr.whenIdle();
    expect(maxConcurrent).toBe(1);
    expect(mgr.get(a.id)!.status).toBe('done');
    expect(mgr.get(b.id)!.status).toBe('done');
  });

  it('reports renderer errors as concise messages', async () => {
    const mgr = new RenderManager({
      rendersDir: dir,
      renderer: async () => {
        throw new Error('Boom: asset 404\n    at stack line');
      },
    });
    const job = await mgr.start(sampleProject);
    await mgr.whenIdle();
    expect(mgr.get(job.id)).toMatchObject({ status: 'failed', error: 'Boom: asset 404' });
  });

  it('retry of an unknown job returns undefined', async () => {
    const mgr = new RenderManager({ rendersDir: dir, renderer: mockRenderer() });
    expect(await mgr.retry('r_nope')).toBeUndefined();
  });
  it('cancels a queued job without invoking the renderer', async () => {
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const calls: string[] = [];
    const mgr = new RenderManager({ rendersDir: dir, renderer: async ({ jobId }) => { calls.push(jobId); entered(); await gate; } });
    const running = await mgr.start(sampleProject);
    await started;
    const queued = await mgr.start(sampleProject);
    expect((await mgr.cancel(queued.id))?.status).toBe('cancelled');
    release();
    await mgr.whenIdle();
    expect(calls).toEqual([running.id]);
    expect(JSON.parse(await readFile(join(dir, `${queued.id}.job.json`), 'utf8')).status).toBe('cancelled');
    await expect(mgr.cancel(queued.id)).rejects.toBeInstanceOf(RenderConflictError);
    expect(await mgr.cancel('missing')).toBeUndefined();
  });

  it('aborts a running job, ignores late progress, and deletes partial output', async () => {
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let aborted = false;
    const mgr = new RenderManager({ rendersDir: dir, renderer: async ({ outputPath, signal, onProgress }) => {
      await writeFile(outputPath, 'partial');
      onProgress({ stage: 'rendering', progress: 0.2 });
      entered();
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true }));
      onProgress({ stage: 'encoding', progress: 1 });
      // Even a renderer that resolves after abort cannot complete the job.
      await writeFile(outputPath, 'late partial');
    } });
    const job = await mgr.start(sampleProject);
    await started;
    expect((await mgr.cancel(job.id))?.status).toBe('cancelled');
    await mgr.whenIdle();
    expect(aborted).toBe(true);
    expect(await readdir(dir)).not.toContain(`${job.id}.mp4`);
    const restored = new RenderManager({ rendersDir: dir, renderer: mockRenderer() });
    await restored.load();
    expect(restored.get(job.id)).toMatchObject({ status: 'cancelled', finishedAt: expect.any(String) });
    expect((await restored.retry(job.id))?.retryOf).toBe(job.id);
    await restored.whenIdle();
  });

  it('round-trips terminal records and classifies every unfinished stage as interrupted', async () => {
    const mgr = new RenderManager({ rendersDir: dir, renderer: async () => undefined });
    const job = await mgr.start(sampleProject);
    await mgr.whenIdle();
    const done = mgr.get(job.id)!;
    const states: RenderStatus[] = ['queued', 'bundling', 'rendering', 'encoding', 'done', 'failed', 'cancelled', 'interrupted'];
    for (const status of states) {
      await writeFile(join(dir, `${status}.job.json`), JSON.stringify({ ...done, id: status, status }));
      await writeFile(join(dir, `${status}.json`), JSON.stringify({ ...sampleProject, name: 'Recorded checkpoint' }));
    }
    await writeFile(join(dir, 'done.mp4'), 'video');
    const loaded = new RenderManager({ rendersDir: dir, renderer: async () => undefined });
    await loaded.load();
    for (const status of states.slice(0, 4)) {
      expect(loaded.get(status)).toMatchObject({ status: 'interrupted', error: 'The server stopped before this render finished.', finishedAt: expect.any(String) });
      expect(JSON.parse(await readFile(join(dir, `${status}.job.json`), 'utf8')).status).toBe('interrupted');
    }
    for (const status of states.slice(4)) expect(loaded.get(status)?.status).toBe(status);
    expect(loaded.get(job.id)).toMatchObject({ status: 'failed', error: 'Output file is missing' });
    await expect(loaded.retry('done')).rejects.toBeInstanceOf(RenderConflictError);
  });

  it('retries an interrupted render using its disk snapshot', async () => {
    const mgr = new RenderManager({ rendersDir: dir, renderer: mockRenderer() });
    const project = structuredClone(sampleProject);
    project.name = 'Checkpoint before restart';
    const job = await mgr.start(project);
    await mgr.whenIdle();
    await writeFile(join(dir, `${job.id}.job.json`), JSON.stringify({ ...mgr.get(job.id), status: 'rendering' }));
    let seenName = '';
    const restored = new RenderManager({ rendersDir: dir, renderer: async ({ project }) => { seenName = project.name; } });
    await restored.load();
    const retry = (await restored.retry(job.id))!;
    await restored.whenIdle();
    expect(seenName).toBe('Checkpoint before restart');
    expect(retry.retryOf).toBe(job.id);
    expect(restored.get(job.id)?.status).toBe('interrupted');
    expect(restored.get(retry.id)?.status).toBe('done');
  });

  it('keeps the newest 50 records on load without deleting videos', async () => {
    const mgr = new RenderManager({ rendersDir: dir, renderer: mockRenderer() });
    const job = await mgr.start(sampleProject);
    await mgr.whenIdle();
    const base = mgr.get(job.id)!;
    await rm(join(dir, `${job.id}.job.json`));
    for (let index = 0; index < 53; index++) {
      const record: RenderJob = { ...base, id: `record_${index}`, status: 'failed', createdAt: new Date(index * 1000).toISOString() };
      await writeFile(join(dir, `${record.id}.job.json`), JSON.stringify(record));
      await writeFile(join(dir, `${record.id}.mp4`), 'keep me');
    }
    const restored = new RenderManager({ rendersDir: dir, renderer: mockRenderer() });
    await restored.load();
    expect(restored.list()).toHaveLength(50);
    expect(restored.list()[0].id).toBe('record_52');
    expect(restored.get('record_2')).toBeUndefined();
    expect((await readdir(dir)).filter((name) => name.endsWith('.job.json'))).toHaveLength(50);
    expect((await readdir(dir)).filter((name) => name.endsWith('.mp4'))).toHaveLength(53);
  });

  it('freezes hashed asset bytes and detects subsequent source edits', async () => {
    const publicDir = join(dir, 'public');
    await mkdir(publicDir);
    await writeFile(join(publicDir, 'logo.svg'), 'original bytes');
    const project = structuredClone(sampleProject);
    project.assets = { ast_logo: { ...project.assets.ast_logo, src: 'logo.svg' } };
    let frozen = '';
    const mgr = new RenderManager({ rendersDir: dir, publicDir, renderer: async ({ project }) => {
      await writeFile(join(publicDir, 'logo.svg'), 'edited bytes');
      frozen = await readFile(join(dir, project.assets.ast_logo.src.replace(/^renders\//, '')), 'utf8');
    } });
    const job = await mgr.start(project);
    await mgr.whenIdle();
    expect(frozen).toBe('original bytes');
    const verified = await mgr.getManifest(job.id, true);
    expect(verified).toMatchObject({ changedAssets: ['ast_logo'], manifest: { format: 'mge.manifest/1', assets: [{ bytes: 14, missing: false, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }] } });
    expect(mgr.get(job.id)).toMatchObject({ projectHash: expect.stringMatching(/^[a-f0-9]{64}$/), manifestUrl: `/renders/${job.id}.manifest.json`, rendererVersion: expect.any(String) });
    expect((await mgr.getSnapshot(job.id))?.assets.ast_logo.src).toBe('logo.svg');
  });

  it('cancels during bundle preparation before the renderer is invoked', async () => {
    let calls = 0;
    const mgr = new RenderManager({ rendersDir: dir, renderer: async () => { calls++; } });
    const job = await mgr.start(sampleProject);
    await mgr.cancel(job.id);
    await mgr.whenIdle();
    expect(calls).toBe(0);
    expect(mgr.get(job.id)?.status).toBe('cancelled');
  });

  it('throttles progress writes to one second while persisting every status change', async () => {
    let clock = 1000;
    const records: RenderJob[] = [];
    const original = projectFiles.writeFileAtomic;
    const date = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const writer = vi.spyOn(projectFiles, 'writeFileAtomic').mockImplementation(async (path, json) => {
      if (path.endsWith('.job.json')) records.push(JSON.parse(json));
      await original(path, json);
    });
    try {
      const mgr = new RenderManager({ rendersDir: dir, renderer: async ({ onProgress }) => {
        onProgress({ stage: 'rendering', progress: 0.2 });
        onProgress({ stage: 'rendering', progress: 0.3 });
        clock = 1999;
        onProgress({ stage: 'rendering', progress: 0.4 });
        clock = 2000;
        onProgress({ stage: 'rendering', progress: 0.5 });
        clock = 2001;
        onProgress({ stage: 'encoding', progress: 0.6 });
      } });
      const job = await mgr.start(sampleProject);
      await mgr.whenIdle();
      expect(records.filter((record) => record.status === 'rendering').map((record) => record.progress)).toEqual([0.2, 0.5]);
      expect(records.map((record) => record.status)).toEqual(['queued', 'bundling', 'bundling', 'rendering', 'rendering', 'encoding', 'done']);
      expect(JSON.parse(await readFile(join(dir, `${job.id}.job.json`), 'utf8')).status).toBe('done');
    } finally {
      writer.mockRestore();
      date.mockRestore();
    }
  });

  it.each([
    ['webm-1080', 'webm'], ['prores-1080', 'mov'], ['gif-480', 'gif'],
  ] as const)('persists %s outputs and manifests with the correct extension after restart', async (preset, ext) => {
    const renderer: Renderer = async ({ outputPath, preset: actualPreset }) => {
      expect(actualPreset).toBe(preset);
      await writeFile(outputPath, 'encoded output');
    };
    const mgr = new RenderManager({ rendersDir: dir, renderer });
    const job = await mgr.start(sampleProject, { preset });
    await mgr.whenIdle();
    const done = mgr.get(job.id)!;
    expect(done).toMatchObject({ status: 'done', preset, outputUrl: `/renders/${job.id}.${ext}`, totalFrames: Math.ceil(projectDurationInFrames(sampleProject) / (preset === 'gif-480' ? 2 : 1)) });
    expect(await mgr.getManifest(job.id)).toMatchObject({ preset });
    const restored = new RenderManager({ rendersDir: dir, renderer });
    await restored.load();
    expect(restored.get(job.id)).toEqual(done);
  });

  it('keeps the GIF preset on retry and deletes GIF partials on failure', async () => {
    let calls = 0;
    const mgr = new RenderManager({ rendersDir: dir, renderer: async ({ outputPath, preset }) => {
      expect(preset).toBe('gif-480');
      await writeFile(outputPath, 'partial');
      if (calls++ === 0) throw new Error('failed GIF');
    } });
    const job = await mgr.start(sampleProject, { preset: 'gif-480' });
    await mgr.whenIdle();
    expect(await readdir(dir)).not.toContain(`${job.id}.gif`);
    const retry = (await mgr.retry(job.id))!;
    expect(retry.preset).toBe('gif-480');
    await mgr.whenIdle();
    expect(mgr.get(retry.id)).toMatchObject({ status: 'done', outputUrl: `/renders/${retry.id}.gif` });
  });

});


it('does not enqueue a job cancelled during its initial persistence write', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mge-cancel-start-'));
  const original = projectFiles.writeFileAtomic;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const startedWrite = new Promise<void>(resolve => { entered = resolve; });
  let blocked = false;
  const spy = vi.spyOn(projectFiles, 'writeFileAtomic').mockImplementation(async (path, data) => {
    if (path.endsWith('.job.json') && !blocked) { blocked = true; entered(); await gate; }
    await original(path, data);
  });
  const renderer = vi.fn<Renderer>(async () => undefined);
  const mgr = new RenderManager({ rendersDir: dir, renderer });
  try {
    const starting = mgr.start(sampleProject);
    await startedWrite;
    const id = mgr.list()[0].id;
    const cancelling = mgr.cancel(id);
    release();
    const [startResult, cancelResult] = await Promise.all([starting, cancelling]);
    await mgr.whenIdle();
    expect(renderer).not.toHaveBeenCalled();
    expect(startResult.status).toBe('cancelled');
    expect(cancelResult?.status).toBe('cancelled');
    expect(JSON.parse(await readFile(join(dir, `${id}.job.json`), 'utf8')).status).toBe('cancelled');
  } finally { release(); spy.mockRestore(); await mgr.whenIdle(); await rm(dir, { recursive: true, force: true }); }
});


it('persists the actual bundle identity supplied by the renderer', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mge-bundle-manifest-'));
  const mgr = new RenderManager({ rendersDir: dir, renderer: async ({ onCompositionHash }) => {
    await onCompositionHash?.('cached-bundle-code');
  } });
  try {
    const job = await mgr.start(sampleProject);
    await mgr.whenIdle();
    const manifest = await mgr.getManifest(job.id);
    expect(manifest && 'code' in manifest && manifest.code.compositionHash).toBe('cached-bundle-code');
  } finally { await mgr.whenIdle(); await rm(dir, { recursive: true, force: true }); }
});
