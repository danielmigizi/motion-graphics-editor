// Render the cut-card picker previews: a small muted MP4 loop and a JPEG
// poster per card, in the card's own look, with the export renderer
// (server/engine). Unchanged cards (same built project, composition code and
// size) are skipped, so re-running after a catalog edit only renders what
// changed.
//
//   npx tsx scripts/render-cut-cards.ts [--only id,id] [--force] [--scale 0.25]
//
// Writes public/cut-previews/<card id>.mp4|.jpg and manifest.json.

import { createHash } from 'node:crypto';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { cutDraftProject } from '../src/core/cutCards';
import { CUT_CARDS } from '../src/core/cutCatalog';
import { compositionHash } from '../server/manifest';
import { createNativeRenderer } from '../server/engine/renderer';

export const CUT_PREVIEW_FORMAT = 'mge.cut-previews/1';

interface PreviewEntry {
  beat: string;
  seconds: number;
  hash: string;
  video: string;
  poster: string;
}

interface Manifest {
  format: typeof CUT_PREVIEW_FORMAT;
  width: number;
  height: number;
  cards: Record<string, PreviewEntry>;
}

function parseArgs(argv: string[]) {
  const args = { only: null as Set<string> | null, force: false, scale: 0.25 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--only') args.only = new Set(argv[++i].split(',').map((s) => s.trim()).filter(Boolean));
    else if (a === '--force') args.force = true;
    else if (a === '--scale') args.scale = Number(argv[++i]);
    else {
      console.error('Usage: npx tsx scripts/render-cut-cards.ts [--only id,id] [--force] [--scale 0.25]');
      process.exit(2);
    }
  }
  if (!(args.scale > 0 && args.scale <= 1)) throw new Error('--scale must be in (0, 1].');
  return args;
}

const exists = (path: string) => access(path).then(() => true, () => false);

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const rootDir = resolve(import.meta.dirname, '..');
  const outDir = join(rootDir, 'public', 'cut-previews');
  await mkdir(outDir, { recursive: true });
  const manifestPath = join(outDir, 'manifest.json');
  const previous = (await readFile(manifestPath, 'utf8').then((t) => JSON.parse(t) as Manifest, () => null));
  const unknown = [...(args.only ?? [])].filter((id) => !CUT_CARDS.some((c) => c.id === id));
  if (unknown.length) throw new Error(`Unknown card ids: ${unknown.join(', ')}`);

  const code = await compositionHash(rootDir);
  const renderer = createNativeRenderer({ rootDir, serverPort: Number(process.env.MGE_SERVER_PORT ?? 5318), log: () => undefined });
  const manifest: Manifest = { format: CUT_PREVIEW_FORMAT, width: Math.round(1920 * args.scale), height: Math.round(1080 * args.scale), cards: {} };
  let rendered = 0;
  let skipped = 0;
  const started = Date.now();
  for (const card of CUT_CARDS) {
    // Deterministic ids, so the hash only moves when the card's output does.
    let n = 0;
    const project = cutDraftProject([card], { name: card.id, newId: (prefix) => `${prefix}_${++n}` });
    const hash = createHash('sha256').update(JSON.stringify({ project, code, scale: args.scale })).digest('hex').slice(0, 16);
    const entry: PreviewEntry = { beat: card.beat, seconds: card.seconds, hash, video: `cut-previews/${card.id}.mp4`, poster: `cut-previews/${card.id}.jpg` };
    const video = join(rootDir, 'public', entry.video);
    const poster = join(rootDir, 'public', entry.poster);
    const wanted = !args.only || args.only.has(card.id);
    const fresh = previous?.cards[card.id]?.hash === hash && (await exists(video)) && (await exists(poster));
    if (!wanted || (fresh && !args.force)) {
      if (!wanted) skipped++;
      if (previous?.cards[card.id]) manifest.cards[card.id] = fresh ? entry : previous.cards[card.id];
      continue;
    }
    const t0 = Date.now();
    await renderer.renderPreview({ project, scale: args.scale, outputPath: video });
    // The poster is the settled frame: most of the motion has landed by 70 % of the card.
    const frame = Math.min(project.scenes[0].durationInFrames - 1, Math.round(project.scenes[0].durationInFrames * 0.7));
    await renderer.renderStill({ project, frame, scale: args.scale, outputPath: poster, imageFormat: 'jpeg', jpegQuality: 82 });
    manifest.cards[card.id] = entry;
    rendered++;
    console.log(`${card.id} — ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }
  await renderer.close();
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`${rendered} rendered, ${CUT_CARDS.length - rendered - skipped} unchanged${skipped ? `, ${skipped} not asked for` : ''}, in ${((Date.now() - started) / 1000).toFixed(0)}s → ${manifestPath}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
