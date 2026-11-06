// Render a project through a running local server.
//
//   npx tsx scripts/render-project.ts <projectFile.json|--sample> [--out path] [--port n]
//
// Accepts a ProjectFile ({ format: 'mge.project/1', project, ... }) or a bare
// Project JSON. Prints progress lines, then the output path. Exits non-zero
// when the job fails.

import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { RenderJob, StartRenderRequest } from '../src/core/api-contract';
import { DEFAULT_SERVER_PORT } from '../src/core/api-contract';
import type { Project } from '../src/core/types';

interface Args {
  input?: string;
  sample: boolean;
  out?: string;
  port: number;
  simulateFailureAtProgress?: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { sample: false, port: Number(process.env.MGE_SERVER_PORT ?? DEFAULT_SERVER_PORT) };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--sample') args.sample = true;
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--port') args.port = Number(argv[++i]);
    else if (a === '--simulate-failure') args.simulateFailureAtProgress = Number(argv[++i]);
    else if (a === '-h' || a === '--help') usage(0);
    else if (a.startsWith('--')) usage(2, `Unknown option ${a}`);
    else args.input = a;
  }
  if (!args.sample && !args.input) usage(2, 'Pass a project file or --sample.');
  if (!Number.isInteger(args.port) || args.port <= 0) usage(2, 'Invalid --port.');
  return args;
}

function usage(code: number, msg?: string): never {
  if (msg) console.error(msg);
  console.error('Usage: npx tsx scripts/render-project.ts <projectFile.json|--sample> [--out path] [--port n] [--simulate-failure 0..1]');
  process.exit(code);
}

async function loadProject(args: Args): Promise<Project> {
  if (args.sample) return (await import('../src/sample/sampleProject')).sampleProject;
  const json = JSON.parse(await readFile(resolve(args.input!), 'utf8')) as { format?: string; project?: Project } & Partial<Project>;
  return json.format === 'mge.project/1' && json.project ? json.project : (json as Project);
}

async function api<T>(base: string, path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(base + path, init);
  } catch (err) {
    throw new Error(`Cannot reach the server at ${base} (${(err as Error).message}). Start it with: MGE_SERVER_PORT=<port> npm run dev:server`);
  }
  const body = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) {
    const e = (body as { error?: { message?: string } } | null)?.error;
    throw new Error(`${init?.method ?? 'GET'} ${path} → ${res.status}: ${e?.message ?? JSON.stringify(body)}`);
  }
  return body as T;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const base = `http://localhost:${args.port}`;
  const project = await loadProject(args);
  const req: StartRenderRequest = { project, ...(args.simulateFailureAtProgress !== undefined ? { simulateFailureAtProgress: args.simulateFailureAtProgress } : {}) };
  let job = await api<RenderJob>(base, '/api/renders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(req) });
  console.log(`job ${job.id} queued — project ${job.projectId} rev ${job.projectRevision}, ${job.totalFrames} frames`);

  let lastLine = '';
  let misses = 0;
  const started = Date.now();
  while (job.status !== 'done' && job.status !== 'failed') {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      job = await api<RenderJob>(base, `/api/renders/${job.id}`);
      misses = 0;
    } catch (err) {
      // The server can be briefly unresponsive (e.g. first-run browser unzip); tolerate a few misses.
      if (++misses > 30) throw err;
      continue;
    }
    const line = `${job.status.padEnd(9)} ${(job.progress * 100).toFixed(0).padStart(3)}%  rendered ${job.renderedFrames}/${job.totalFrames}  encoded ${job.encodedFrames}/${job.totalFrames}`;
    if (line !== lastLine) {
      console.log(`[${((Date.now() - started) / 1000).toFixed(0).padStart(4)}s] ${line}`);
      lastLine = line;
    }
  }

  if (job.status === 'failed') {
    console.error(`FAILED job ${job.id}: ${job.error}`);
    console.error(`retry with: curl -X POST ${base}/api/renders/${job.id}/retry`);
    process.exit(1);
  }

  let output = job.outputPath!;
  if (args.out) {
    const dest = resolve(args.out);
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(output, dest);
    output = dest;
  }
  console.log(`done job ${job.id} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  console.log(`output: ${output}`);
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
