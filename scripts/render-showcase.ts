// Render the schema v2 showcase (src/sample/showcaseV2.ts) to PNG stills with
// the export renderer (server/engine) and the composition the MP4 export
// uses. No server needed: the showcase uses no assets.
//
//   npx tsx scripts/render-showcase.ts [--out renders/showcase]
//
// Prints one line per still (path + what it shows). Exits non-zero when the
// fixture is invalid or a still fails to render.

import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNativeRenderer } from '../server/engine/renderer';
import { validateProject } from '../src/core/validate';
import { SHOWCASE_STILLS, showcaseV2 } from '../src/sample/showcaseV2';

const rootDir = fileURLToPath(new URL('..', import.meta.url));

async function main() {
  const outIndex = process.argv.indexOf('--out');
  const outDir = resolve(outIndex > 0 ? process.argv[outIndex + 1] : join(rootDir, 'renders', 'showcase'));

  const valid = validateProject(showcaseV2);
  if (!valid.ok) throw new Error(`showcaseV2 is invalid at ${valid.error.path}: ${valid.error.message}`);

  await mkdir(outDir, { recursive: true });
  const renderer = createNativeRenderer({ rootDir, serverPort: 5318 });
  try {
    for (const still of SHOWCASE_STILLS) {
      const output = join(outDir, `${still.name}.png`);
      await renderer.renderStill({ project: showcaseV2, frame: still.frame, scale: 1, outputPath: output });
      console.log(`${output}  (frame ${still.frame}) — ${still.shows}`);
    }
  } finally {
    await renderer.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
