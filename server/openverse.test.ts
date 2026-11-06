import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OPENVERSE_LICENSE_QUERY, OPENVERSE_NOTICE } from '../src/core/openverseLicense';
import { createOpenverseClient, extractOpenverseId, OpenverseError, parseOpenverseWork } from './openverse';
import type { ImportUrlResponse } from '../src/core/generation';

const cc0Work = {
  id: '11111111-1111-4111-8111-111111111111',
  title: 'Calm pad',
  creator: 'Ada',
  license: 'cc0',
  license_version: '1.0',
  attribution: '"Calm pad" by Ada is licensed under CC0.',
  url: 'https://cdn.example.com/calm.mp3',
  foreign_landing_url: 'https://www.jamendo.com/track/1',
  duration: 45_000,
  category: 'music',
  tags: [{ name: 'ambient' }],
};

const ncWork = { ...cc0Work, id: '22222222-2222-4222-8222-222222222222', license: 'by-nc-sa', attribution: 'NC' };

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

describe('Openverse client', () => {
  let dir: string;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('parses catalog duration (ms) and extracts ids from URLs', () => {
    expect(parseOpenverseWork(cc0Work).durationSeconds).toBe(45);
    expect(extractOpenverseId(cc0Work.id)).toBe(cc0Work.id);
    expect(extractOpenverseId(`https://openverse.org/audio/${cc0Work.id}/`)).toBe(cc0Work.id);
    expect(extractOpenverseId('https://cdn.example.com/calm.mp3')).toBeNull();
  });

  it('searches with a hard CC0/BY filter and drops disallowed hits', async () => {
    const calls: string[] = [];
    const client = createOpenverseClient({
      fetch: async (input) => {
        calls.push(String(input));
        return jsonResponse({ result_count: 2, page_count: 1, page: 1, results: [cc0Work, ncWork] });
      },
    });
    const r = await client.searchAudio({ query: 'ambient', kind: 'music', mood: 'calm', durationSeconds: 40 });
    expect(calls[0]).toContain(`license=${encodeURIComponent(OPENVERSE_LICENSE_QUERY)}`);
    expect(calls[0]).toContain('license_type=commercial');
    expect(calls[0]).toContain('category=music');
    expect(calls[0]).toContain('calm');
    expect(r.results.map((h) => h.id)).toEqual([cc0Work.id]);
    expect(r.notice).toContain('Made with Openverse');
  });

  it('refuses NC/SA on inspect even when the caller asked for that work', async () => {
    const client = createOpenverseClient({
      fetch: async () => jsonResponse(ncWork),
    });
    await expect(client.getAudio(ncWork.id)).rejects.toMatchObject({ code: 'LICENSE', status: 403 });
  });

  it('refuses a direct file URL in place of a work id', async () => {
    const client = createOpenverseClient({ fetch: async () => jsonResponse(cc0Work) });
    await expect(client.getAudio('https://cdn.example.com/calm.mp3')).rejects.toMatchObject({ code: 'INVALID' });
  });

  it('surfaces 429 with Retry-After', async () => {
    const client = createOpenverseClient({
      fetch: async () => jsonResponse({ detail: 'throttled' }, 429, { 'Retry-After': '12' }),
    });
    try {
      await client.searchAudio({ query: 'pad' });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(OpenverseError);
      expect((e as OpenverseError).code).toBe('RATE_LIMIT');
      expect((e as OpenverseError).retryAfterSeconds).toBe(12);
    }
  });

  it('imports through the downloader, caches the file, and reuses it', async () => {
    dir = await mkdtemp(join(tmpdir(), 'mge-ov-'));
    const imports: string[] = [];
    const client = createOpenverseClient({
      fetch: async () => jsonResponse(cc0Work),
      importAudioFile: async (publicDir, url, name) => {
        imports.push(url);
        await mkdir(join(publicDir, 'assets', 'uploads'), { recursive: true });
        const src = 'assets/uploads/u_tmp.mp3';
        await writeFile(join(publicDir, src), Buffer.from('ID3'));
        const up: ImportUrlResponse = { src, name: name ?? 'Calm pad', mimeType: 'audio/mpeg', kind: 'audio', bytes: 3, durationSeconds: 45 };
        return up;
      },
    });
    const first = await client.importAudio(dir, cc0Work.id);
    expect(first.cached).toBe(false);
    expect(first.src).toMatch(/^assets\/uploads\/openverse\//);
    expect(first.work.license).toBe('cc0');
    expect(imports).toHaveLength(1);
    const second = await client.importAudio(dir, cc0Work.id);
    expect(second.cached).toBe(true);
    expect(second.src).toBe(first.src);
    expect(imports).toHaveLength(1);
    expect(await readFile(join(dir, first.src))).toHaveLength(3);
  });

  it('does not cache a disallowed work', async () => {
    dir = await mkdtemp(join(tmpdir(), 'mge-ov-'));
    const client = createOpenverseClient({
      fetch: async () => jsonResponse(ncWork),
      importAudioFile: async () => {
        throw new Error('should not download');
      },
    });
    await expect(client.importAudio(dir, ncWork.id)).rejects.toMatchObject({ code: 'LICENSE' });
  });
});
