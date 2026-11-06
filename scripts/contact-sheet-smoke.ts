// Run with the local asset server on 5618: npx tsx scripts/contact-sheet-smoke.ts
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNativeRenderer } from '../server/engine/renderer';
import { sampleProject } from '../src/sample/sampleProject';

const rootDir = fileURLToPath(new URL('..', import.meta.url));
const outputPath = join(rootDir, 'renders/contact-sheet-smoke.png');
await mkdir(join(rootDir, 'renders'), { recursive: true });
const renderer = createNativeRenderer({ rootDir, serverPort: 5618 });
await renderer.renderContactSheet({ project: sampleProject, frames: [30, 150, 240, 420, 510, 690], columns: 3, outputPath });
await renderer.close();
console.log(outputPath);
