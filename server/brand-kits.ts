// Saved brand kits: `brand-kits/<id>.json`, one per site domain, written
// atomically. A kit is a brand scan (style overlay, logo file, site copy) kept
// so later videos can reuse it without fetching the site again.

import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BrandKitRecord } from '../src/core/api-contract';
import type { BrandScanResult } from './brand-scan';

export interface BrandKitStore {
  list(): Promise<BrandKitRecord[]>;
  get(id: string): Promise<BrandKitRecord | null>;
  save(scan: BrandScanResult): Promise<BrandKitRecord>;
}

const ID_RE = /^kit_[a-z0-9.-]{1,120}$/;

export const brandKitId = (domain: string) => `kit_${domain.toLowerCase().replace(/[^a-z0-9.-]+/g, '-').slice(0, 120)}`;

export function createBrandKitStore(dir: string): BrandKitStore {
  const file = (id: string) => join(dir, `${id}.json`);
  const read = async (id: string): Promise<BrandKitRecord | null> => {
    if (!ID_RE.test(id)) return null;
    try {
      return JSON.parse(await readFile(file(id), 'utf8')) as BrandKitRecord;
    } catch {
      return null;
    }
  };
  return {
    async list() {
      let names: string[] = [];
      try {
        names = (await readdir(dir)).filter((n) => n.endsWith('.json'));
      } catch {
        return [];
      }
      const kits = (await Promise.all(names.map((n) => read(n.slice(0, -5))))).filter((k): k is BrandKitRecord => !!k);
      return kits.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
    },
    get: read,
    async save(scan) {
      const record: BrandKitRecord = {
        id: brandKitId(scan.domain),
        name: scan.copy?.product || scan.style.name || scan.domain,
        domain: scan.domain,
        url: scan.url,
        style: { ...scan.style, name: scan.copy?.product || scan.style.name },
        ...(scan.logoPath ? { logoPath: scan.logoPath } : {}),
        ...(scan.copy ? { copy: scan.copy } : {}),
        savedAt: new Date().toISOString(),
      };
      await mkdir(dir, { recursive: true });
      const tmp = `${file(record.id)}.${process.pid}.tmp`;
      await writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`);
      await rename(tmp, file(record.id));
      return record;
    },
  };
}
