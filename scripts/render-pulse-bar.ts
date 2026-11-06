// Render Pulse house-bar contact sheets (after + before) for visual review.
//   npx tsx scripts/render-pulse-bar.ts [--out docs/golden]

import { mkdir } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createNativeRenderer } from '../server/engine/renderer';
import { validateProject } from '../src/core/validate';
import { pulseReference, pulseReferenceBefore } from '../src/sample/golden/pulseReference';
import { GOLDEN_EXAMPLES } from '../src/sample/golden';

const rootDir = fileURLToPath(new URL('..', import.meta.url));
const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};

const KIT = 183;
const range = (from: number, step: number, count: number) => Array.from({ length: count }, (_, i) => from + i * step);

async function main() {
  const app = express();
  app.use(express.static(join(rootDir, 'public')));
  const server = await new Promise<ReturnType<typeof app.listen>>((done) => {
    const s = app.listen(0, '127.0.0.1', () => done(s));
  });
  const port = (server.address() as AddressInfo).port;
  const renderer = createNativeRenderer({ rootDir, serverPort: port, log: (m) => console.log(`[render] ${m}`) });
  const outDir = resolve(arg('out') ?? join(rootDir, 'docs', 'golden'));
  await mkdir(outDir, { recursive: true });

  const after = pulseReference();
  const before = pulseReferenceBefore();
  for (const [name, project] of [['pulse-reference', after], ['pulse-reference-before', before]] as const) {
    const valid = validateProject(project);
    if (!valid.ok) throw new Error(`${name}: ${valid.error.message} at ${valid.error.path}`);
  }

  const overview = GOLDEN_EXAMPLES.find((g) => g.id === 'pulse-reference')!;
  await renderer.renderContactSheet({ project: after, frames: overview.frames, columns: 6, scale: 0.25, outputPath: join(outDir, 'pulse-reference.png') });
  await renderer.renderContactSheet({ project: before, frames: overview.frames, columns: 6, scale: 0.25, outputPath: join(outDir, 'pulse-reference-before.png') });
  await renderer.renderContactSheet({ project: after, frames: range(0, 2, 24), columns: 6, scale: 0.35, outputPath: join(outDir, 'pulse-reference-kit-strip.png') });
  await renderer.renderContactSheet({ project: after, frames: range(KIT + 2, 2, 24), columns: 6, scale: 0.35, outputPath: join(outDir, 'pulse-reference-end-strip.png') });
  console.log(`wrote Pulse sheets to ${outDir}`);
  await renderer.close();
  server.close();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
