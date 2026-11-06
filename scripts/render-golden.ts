// Render the golden example projects (src/sample/golden) to contact sheets
// with the export renderer (server/engine), for docs/golden/*.png and visual
// review.
//
//   npx tsx scripts/render-golden.ts                 # docs/golden/<id>.png for every golden project
//   npx tsx scripts/render-golden.ts --only saas-launch [--frames 120,300 --columns 2 --out renders/golden]
//   npx tsx scripts/render-golden.ts --templates --out renders/templates [--aspect 9:16] [--pack editorial] [--phase motion] [--bare] [--template kineticTitle]
//
// --templates renders every template on its own scene (settled frame, or a
// mid-motion frame with --phase motion) in one sheet per aspect, styled by
// --pack (default snappy-saas; "none" for no style); --bare drops the sample
// logo and screenshot so the asset-free fallbacks show; --template renders an
// eight-frame motion strip of one template.
//
// Serves public/ itself on a free port, so no editor server is needed. Sheets
// larger than 400 KB are re-encoded with a 256-colour palette (ffmpeg from
// server/media-tools).

import { spawnSync } from 'node:child_process';
import { mkdir, rename, stat } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { mediaTool } from '../server/media-tools';
import { createNativeRenderer } from '../server/engine/renderer';
import { applyCommand } from '../src/core/commands';
import { STYLE_PACKS, type StylePackId } from '../src/core/style';
import { buildTemplate, TEMPLATE_IDS, TEMPLATES } from '../src/core/templates';
import { sceneStartFrames } from '../src/core/timing';
import type { Project, Scene } from '../src/core/types';
import { validateProject } from '../src/core/validate';
import { GOLDEN_EXAMPLES } from '../src/sample/golden';
import { sampleProject } from '../src/sample/sampleProject';

const rootDir = fileURLToPath(new URL('..', import.meta.url));
const MAX_BYTES = 400 * 1024;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

/** One scene per template, inserted at frame 0 and styled by `pack`. */
function templateSheetProject(width: number, height: number, packId: StylePackId | 'none', bare: boolean): Project {
  const pack = packId === 'none' ? undefined : STYLE_PACKS[packId];
  const background = pack?.colors.background ?? '#0B0D17';
  let project: Project = {
    ...structuredClone(sampleProject),
    id: 'prj_template_sheet',
    name: 'Relay',
    width,
    height,
    backgroundColor: background,
    scenes: TEMPLATE_IDS.map((id): Scene => ({ id: `scn_${id}`, name: TEMPLATES[id].label, durationInFrames: Math.round(TEMPLATES[id].seconds * 30), backgroundColor: background, locked: false, transitionIn: { type: 'none', durationInFrames: 0 }, elements: [] })),
    audio: [],
    markers: [],
    ...(pack ? { style: pack } : {}),
  };
  if (bare) project.assets = {};
  let n = 0;
  for (const id of TEMPLATE_IDS) {
    const built = buildTemplate(id, {}, { sceneId: `scn_${id}`, at: 0, project, newId: () => `el_${id}_${++n}` });
    if (!built.ok) throw new Error(`${id}: ${built.message}`);
    const r = applyCommand(project, { type: 'batch', label: built.label, commands: built.commands }, { source: 'user' });
    if (!r.ok) throw new Error(`${id}: ${r.error.message} at ${r.error.path}`);
    project = r.project;
  }
  return project;
}

/** Keep committed sheets small: palette-quantise when over the limit. */
async function shrink(path: string): Promise<number> {
  let size = (await stat(path)).size;
  if (size <= MAX_BYTES) return size;
  const { cmd, env, cwd } = mediaTool('ffmpeg');
  const tmp = `${path}.q.png`;
  const r = spawnSync(cmd, ['-y', '-loglevel', 'error', '-i', path, '-vf', 'split[a][b];[a]palettegen=max_colors=256:stats_mode=full[p];[b][p]paletteuse=dither=sierra2_4a', tmp], { env, cwd });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr.toString()}`);
  await rename(tmp, path);
  size = (await stat(path)).size;
  return size;
}

async function main() {
  const app = express();
  app.use(express.static(join(rootDir, 'public')));
  const server = await new Promise<ReturnType<typeof app.listen>>((done) => {
    const s = app.listen(0, '127.0.0.1', () => done(s));
  });
  const port = (server.address() as AddressInfo).port;
  const renderer = createNativeRenderer({ rootDir, serverPort: port, log: (m) => console.log(`[render] ${m}`) });
  try {
    if (flag('templates')) {
      const [w, h] = (arg('aspect') ?? '16:9') === '9:16' ? [1080, 1920] : [1920, 1080];
      const packId = (arg('pack') ?? 'snappy-saas') as StylePackId | 'none';
      const project = templateSheetProject(w, h, packId, flag('bare'));
      const valid = validateProject(project);
      if (!valid.ok) throw new Error(`template sheet invalid at ${valid.error.path}: ${valid.error.message}`);
      const starts = sceneStartFrames(project);
      const motion = arg('phase') === 'motion';
      const outDir = resolve(arg('out') ?? join(rootDir, 'renders', 'templates'));
      await mkdir(outDir, { recursive: true });
      const suffix = `${w}x${h}-${packId}${flag('bare') ? '-bare' : ''}`;
      const one = arg('template');
      if (one) {
        // A motion strip: eight moments across one template.
        const i = TEMPLATE_IDS.indexOf(one as (typeof TEMPLATE_IDS)[number]);
        if (i < 0) throw new Error(`Unknown template ${one}`);
        const length = project.scenes[i].durationInFrames;
        const picked = arg('frames')?.split(',').map(Number);
        const frames = picked?.length ? picked.map((f) => starts[i] + f) : [0.04, 0.1, 0.16, 0.22, 0.3, 0.4, 0.6, 0.97].map((f) => starts[i] + Math.round(f * (length - 1)));
        const out = join(outDir, `${one}-${suffix}${picked ? `-f${picked.join('_')}` : ''}.png`);
        await renderer.renderContactSheet({ project, frames, columns: Number(arg('columns') ?? (w > h ? 4 : 8)), outputPath: out });
        console.log(`${out}  frames ${frames.map((f) => f - starts[i]).join(', ')}`);
        return;
      }
      const frames = project.scenes.map((s, i) => starts[i] + (motion ? Math.round(s.durationInFrames * 0.22) : s.durationInFrames - 6));
      const out = join(outDir, `templates-${suffix}${motion ? '-motion' : ''}.png`);
      await renderer.renderContactSheet({ project, frames, columns: w > h ? 4 : 7, outputPath: out });
      console.log(`${out}  (${TEMPLATE_IDS.length} templates)`);
      return;
    }
    const only = arg('only');
    const outDir = resolve(arg('out') ?? join(rootDir, 'docs', 'golden'));
    for (const golden of GOLDEN_EXAMPLES.filter((g) => !only || g.id === only)) {
      const valid = validateProject(golden.project);
      if (!valid.ok) throw new Error(`${golden.id} is invalid at ${valid.error.path}: ${valid.error.message}`);
      const picked = arg('frames')?.split(',').map(Number);
      const out = join(outDir, picked ? `${golden.id}-f${picked.join('_')}.png` : `${golden.id}.png`);
      await mkdir(dirname(out), { recursive: true });
      await renderer.renderContactSheet({ project: golden.project, frames: picked ?? golden.frames, columns: picked ? Number(arg('columns') ?? 2) : golden.columns, scale: picked ? 0.5 : 0.25, outputPath: out });
      const size = await shrink(out);
      console.log(`${out}  ${Math.round(size / 1024)} KB, frames ${(picked ?? golden.frames).join(", ")}`);
    }
  } finally {
    await renderer.close();
    server.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
