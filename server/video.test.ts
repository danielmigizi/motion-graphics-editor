import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COMPONENTS } from '../src/core/components';
import type { Project } from '../src/core/types';
import { sampleProject } from '../src/sample/sampleProject';
import { createApp } from './app';
import { sniffAssetKind } from './assets';
import { buildManifest } from './manifest';
import { createProjectStore } from './projects';
import { RenderManager } from './renders';
import { interpretProbe, mediaTool, probeVideo, ProxyQueue, proxyArgs, proxyReasons, proxySrcFor, storeVideoUpload, videoExportProblem, VideoUploadError } from './video';

let root: string;
let clip: string;
let clipBytes: Buffer;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'mge-video-'));
  clip = join(root, 'tiny.mp4');
  // A 1 s 64×48 H.264 + AAC clip from the bundled ffmpeg.
  const tool = mediaTool('ffmpeg');
  execFileSync(tool.cmd, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'nullsrc=s=64x48:r=30:d=1,format=yuv420p', '-f', 'lavfi', '-i', 'sine=f=440:d=1', '-c:v', 'libx264', '-g', '30', '-c:a', 'aac', '-shortest', clip], { cwd: tool.cwd, env: tool.env });
  clipBytes = await readFile(clip);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('video kinds', () => {
  it('recognises MP4, WebM and MOV by extension and mime type', () => {
    expect(sniffAssetKind(undefined, 'rec.mp4')).toMatchObject({ kind: 'video', ext: 'mp4', mimeType: 'video/mp4' });
    expect(sniffAssetKind(undefined, 'rec.MOV')).toMatchObject({ kind: 'video', ext: 'mov', mimeType: 'video/quicktime' });
    expect(sniffAssetKind(undefined, 'rec.webm')).toMatchObject({ kind: 'video', ext: 'webm' });
    expect(sniffAssetKind('video/webm', 'blob')?.kind).toBe('video');
    expect(sniffAssetKind('video/x-msvideo', 'rec.avi')).toBeNull();
  });
});

describe('interpretProbe', () => {
  const stream = { codec_type: 'video', codec_name: 'h264', profile: 'High', width: 1920, height: 1080, r_frame_rate: '30/1', avg_frame_rate: '30/1', duration: '30.0' };
  const cfrPackets = Array.from({ length: 60 }, (_, i) => ({ pts: i / 30, key: i % 30 === 0 }));

  it('reads size, duration, rate, audio and keyframe spacing of a decodable H.264 file', () => {
    const p = interpretProbe({ streams: [stream, { codec_type: 'audio', codec_name: 'aac' }] }, cfrPackets);
    expect(p).toMatchObject({ decodable: true, width: 1920, height: 1080, durationSeconds: 30, fps: 30, codec: 'h264', hasAudio: true, vfr: false });
    expect(p.keyframeSeconds).toBeCloseTo(59 / 30 / 1, 1);
  });

  it('flags variable frame rate from the rates or from uneven packet spacing', () => {
    expect(interpretProbe({ streams: [{ ...stream, r_frame_rate: '60/1', avg_frame_rate: '58080/1799' }] }).vfr).toBe(true);
    const uneven = [0, 1 / 60, 2 / 60, 10 / 60, 11 / 60].map((pts, i) => ({ pts, key: i === 0 }));
    expect(interpretProbe({ streams: [stream] }, uneven).vfr).toBe(true);
  });

  it('refuses codecs the browser cannot decode, with the reason', () => {
    expect(interpretProbe({ streams: [{ ...stream, codec_name: 'hevc' }] })).toMatchObject({ decodable: false, error: expect.stringContaining('H.265/HEVC') });
    expect(interpretProbe({ streams: [{ ...stream, codec_name: 'prores' }] })).toMatchObject({ decodable: false, error: expect.stringContaining('ProRes') });
    expect(interpretProbe({ streams: [{ ...stream, profile: 'High 10' }] }).decodable).toBe(false);
    expect(interpretProbe({ streams: [{ codec_type: 'audio', codec_name: 'aac' }] })).toMatchObject({ decodable: false, error: 'The file has no video stream' });
  });

  it('a soundtrack in a codec the browser cannot play counts as no audio', () => {
    expect(interpretProbe({ streams: [stream, { codec_type: 'audio', codec_name: 'pcm_alaw' }] }).hasAudio).toBe(false);
  });
});

describe('proxies', () => {
  const base = { decodable: true, hasAudio: true, vfr: false, width: 1920, height: 1080, fps: 30, nominalFps: 30, keyframeSeconds: 1 };
  it('are made for > 1080p, VFR, long-GOP or > 50 MB sources', () => {
    expect(proxyReasons(base, 10e6)).toEqual([]);
    expect(proxyReasons({ ...base, width: 3840, height: 2160 }, 10e6)).toEqual(['larger than 1080p']);
    expect(proxyReasons({ ...base, vfr: true, keyframeSeconds: 10 }, 60 * 1024 * 1024)).toEqual(['variable frame rate', 'few keyframes', 'larger than 50 MB']);
  });

  it('are 720p H.264 with a keyframe every second and AAC, keeping the source timestamps (no frame-rate conversion)', () => {
    expect(proxySrcFor('assets/uploads/u_ab.mov')).toBe('assets/uploads/u_ab.proxy.mp4');
    const args = proxyArgs('in.mov', 'out.mp4', { ...base, vfr: true, nominalFps: 60, fps: 41.2 }).join(' ');
    expect(args).toContain('-vf scale=-2:720 -fps_mode passthrough -force_key_frames expr:gte(t,n_forced*1)');
    expect(args).toContain('-c:v libx264');
    expect(args).toContain('-c:a aac');
    expect(args).not.toMatch(/fps=|-r |-g /);
    expect(proxyArgs('a', 'b', { ...base, height: 481, nominalFps: 30000 / 1001 }).join(' ')).toContain('-vf scale=-2:480 -fps_mode passthrough');
  });

  it('a queued proxy is written next to the source and reported ready', async () => {
    const pub = join(root, 'pq');
    await mkdir(join(pub, 'assets', 'uploads'), { recursive: true });
    const abs = join(pub, 'assets', 'uploads', 'u_t.mp4');
    await writeFile(abs, clipBytes);
    const q = new ProxyQueue(pub, () => undefined);
    q.enqueue('assets/uploads/u_t.mp4', abs, await probeVideo(abs), ['test']);
    expect((await q.status('assets/uploads/u_t.mp4')).status).toBe('pending');
    await q.idle();
    expect(await q.status('assets/uploads/u_t.mp4')).toMatchObject({ status: 'ready', proxySrc: 'assets/uploads/u_t.proxy.mp4' });
    const proxy = await probeVideo(join(pub, 'assets', 'uploads', 'u_t.proxy.mp4'));
    expect(proxy).toMatchObject({ decodable: true, codec: 'h264', hasAudio: true, vfr: false });
  }, 60_000);

  // i7 #3: a 30000/1001 source must not be retimed to 30 fps (the preview would show a different frame than the export).
  it('keep every source presentation timestamp (29.97 fps stays 29.97), keyed every second', async () => {
    const pub = join(root, 'pq-ntsc');
    await mkdir(join(pub, 'assets', 'uploads'), { recursive: true });
    const abs = join(pub, 'assets', 'uploads', 'u_ntsc.mp4');
    const tool = mediaTool('ffmpeg');
    execFileSync(tool.cmd, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=s=64x48:r=30000/1001:d=3,format=yuv420p', '-c:v', 'libx264', '-g', '300', abs], { cwd: tool.cwd, env: tool.env });
    const q = new ProxyQueue(pub, () => undefined);
    const probe = await probeVideo(abs);
    expect(probe.nominalFps).toBeCloseTo(29.97, 2);
    q.enqueue('assets/uploads/u_ntsc.mp4', abs, probe, ['few keyframes']);
    await q.idle();
    const out = join(pub, 'assets', 'uploads', 'u_ntsc.proxy.mp4');
    const frames = (file: string) => {
      const p = mediaTool('ffprobe');
      return execFileSync(p.cmd, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time,flags', '-of', 'csv=p=0', file], { cwd: p.cwd, env: p.env, encoding: 'utf8' })
        .trim().split('\n').map((l) => l.split(',')).map(([t, f]) => ({ t: Number(t), key: f.includes('K') })).sort((a, b) => a.t - b.t);
    };
    const src = frames(abs);
    const px = frames(out);
    expect(px).toHaveLength(src.length);
    expect(Math.max(...px.map((f, i) => Math.abs(f.t - src[i].t)))).toBeLessThan(0.0005);
    // Keyframes about every second (fast seeking), unlike the 300-frame GOP source.
    expect(px.filter((f) => f.key).length).toBeGreaterThanOrEqual(3);
  }, 60_000);
});

describe('storeVideoUpload (streamed)', () => {
  const info = { ext: 'mp4', mimeType: 'video/mp4' };

  it('streams to disk and returns the probe', async () => {
    const pub = join(root, 'up1');
    const r = await storeVideoUpload(pub, Readable.from([clipBytes.subarray(0, 1000), clipBytes.subarray(1000)]), info, 'Screen Recording.mp4');
    expect(r).toMatchObject({ kind: 'video', name: 'Screen Recording.mp4', mimeType: 'video/mp4', width: 64, height: 48, fps: 30, hasAudio: true, codec: 'h264', bytes: clipBytes.length, proxy: 'none' });
    expect(r.durationSeconds).toBeGreaterThan(0.9);
    expect(await readFile(join(pub, r.src))).toEqual(clipBytes);
  });

  it('refuses more than the limit mid-stream and leaves no file behind', async () => {
    const pub = join(root, 'up2');
    await expect(storeVideoUpload(pub, Readable.from([clipBytes]), info, 'big.mp4', { limit: 1000 })).rejects.toMatchObject({ status: 413 });
    await expect(storeVideoUpload(pub, Readable.from([clipBytes]), info, 'big.mp4', { limit: 1000, contentLength: 5000 })).rejects.toBeInstanceOf(VideoUploadError);
    expect(await readdir(join(pub, 'assets', 'uploads'))).toEqual([]);
  });

  it('refuses a file that is not a decodable video, naming it', async () => {
    const pub = join(root, 'up3');
    await expect(storeVideoUpload(pub, Readable.from([Buffer.from('not a video at all')]), info, 'notes.mp4')).rejects.toThrow(/notes\.mp4/);
    expect(await readdir(join(pub, 'assets', 'uploads'))).toEqual([]);
  });
});

describe('export preflight and manifest', () => {
  const withVideo = (src: string): Project => {
    const p = structuredClone(sampleProject);
    p.assets.ast_rec = { id: 'ast_rec', kind: 'video', name: 'Recording', src, mimeType: 'video/mp4', durationInFrames: 30, fps: 30, hasAudio: true };
    const scene = p.scenes[0];
    scene.elements.push({ id: 'el_rec', type: 'video', name: 'Screen recording', startFrame: 0, durationInFrames: 30, visible: true, transform: { x: 0, y: 0, width: 640, height: 360, rotation: 0, scale: 1, opacity: 1 }, props: { ...COMPONENTS.video.defaultProps, assetId: 'ast_rec' }, tracks: [] });
    return p;
  };

  it('names the element whose video file is missing or undecodable', async () => {
    const pub = join(root, 'pre');
    await mkdir(join(pub, 'assets', 'uploads'), { recursive: true });
    const resolve = (src: string) => join(pub, src);
    expect(await videoExportProblem(withVideo('assets/uploads/gone.mp4'), resolve)).toMatch(/^Video element "Screen recording" in scene ".+" uses “Recording”, which is missing/);
    await writeFile(join(pub, 'assets/uploads/bad.mp4'), 'garbage');
    expect(await videoExportProblem(withVideo('assets/uploads/bad.mp4'), resolve)).toMatch(/can't be decoded/);
    await writeFile(join(pub, 'assets/uploads/ok.mp4'), clipBytes);
    expect(await videoExportProblem(withVideo('assets/uploads/ok.mp4'), resolve)).toBeNull();
  });

  it('hashes video files by streaming and freezes them by copying', async () => {
    const pub = join(root, 'man');
    await mkdir(join(pub, 'assets', 'uploads'), { recursive: true });
    await writeFile(join(pub, 'assets/uploads/v.mp4'), clipBytes);
    const frozen: string[] = [];
    const p = withVideo('assets/uploads/v.mp4');
    const captured: string[] = [];
    const m = await buildManifest(p, {
      publicDir: pub, rootDir: process.cwd(),
      captureAsset: (id) => captured.push(id),
      freezeLargeAsset: async (id, path) => {
        const target = join(root, `frozen-${id}.mp4`);
        await writeFile(target, await readFile(path));
        frozen.push(id);
        return target;
      },
    });
    expect(frozen).toEqual(['ast_rec']);
    expect(captured).not.toContain('ast_rec');
    expect(m.assets.find((a) => a.id === 'ast_rec')).toMatchObject({ sha256: createHash('sha256').update(clipBytes).digest('hex'), bytes: clipBytes.length, missing: false });
  });
});

describe('routes', () => {
  let server: Server;
  let port: number;
  const pub = () => join(root, 'app', 'public');
  const proxyLog: string[] = [];
  let queue: ProxyQueue;
  const send = (method: string, path: string, headers: Record<string, string>, body?: Buffer | string) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port, method, path, headers }, (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
      });
      req.on('error', reject);
      if (body !== undefined) req.write(body);
      req.end();
    });

  beforeAll(async () => {
    const app = createApp({
      publicDir: pub(),
      rendersDir: join(root, 'app', 'renders'),
      projects: createProjectStore(join(root, 'app', 'projects')),
      renders: new RenderManager({ rendersDir: join(root, 'app', 'renders'), renderer: async () => undefined }),
      webPort: 5951,
      serverPort: 5952,
      proxies: (queue = new ProxyQueue(pub(), (m) => proxyLog.push(m))),
    });
    await new Promise<void>((r) => (server = app.listen(0, '127.0.0.1', () => r())));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('POST /api/assets streams a video and GET /api/assets/proxy reports on its proxy', async () => {
    const up = await send('POST', '/api/assets?filename=rec.mp4', { 'Content-Type': 'video/mp4', 'Content-Length': String(clipBytes.length) }, clipBytes);
    expect(up.status).toBe(200);
    const body = JSON.parse(up.body);
    expect(body).toMatchObject({ kind: 'video', width: 64, height: 48, hasAudio: true, proxy: 'none' });
    expect(existsSync(join(pub(), body.src))).toBe(true);
    const proxy = await send('GET', `/api/assets/proxy?src=${encodeURIComponent(body.src)}`, {});
    expect(JSON.parse(proxy.body)).toEqual({ status: 'none', reasons: [] });
    const probe = JSON.parse((await send('GET', `/api/assets/probe?src=${encodeURIComponent(body.src)}`, {})).body);
    expect(probe).toMatchObject({ exists: true, decodable: true, mimeType: 'video/mp4', width: 64, height: 48, hasAudio: true });
  });

  // i7 #4: a foreign page can GET (CORS-simple) but must not start ffmpeg; aliases of one file share one job.
  it('GET proxy status only reads; an origin-checked POST makes the proxy, once per file whatever the spelling', async () => {
    await mkdir(join(pub(), 'assets', 'uploads'), { recursive: true });
    const abs = join(pub(), 'assets', 'uploads', 'u_gop.mp4');
    const tool = mediaTool('ffmpeg');
    // One keyframe in 3 s: needs a proxy ("few keyframes").
    execFileSync(tool.cmd, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=s=64x48:r=30:d=3,format=yuv420p', '-c:v', 'libx264', '-g', '300', abs], { cwd: tool.cwd, env: tool.env });
    const src = 'assets/uploads/u_gop.mp4';
    const out = join(pub(), 'assets', 'uploads', 'u_gop.proxy.mp4');
    const status = async (method: 'GET' | 'POST', s: string, origin?: string) => {
      const headers: Record<string, string> = { ...(origin ? { Origin: origin } : {}), ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}) };
      const r = await send(method, method === 'GET' ? `/api/assets/proxy?src=${encodeURIComponent(s)}` : '/api/assets/proxy', headers, method === 'POST' ? JSON.stringify({ src: s }) : undefined);
      return { code: r.status, body: JSON.parse(r.body) };
    };
    // A foreign page may not even read the status; a CLI (no Origin) and the editor may.
    expect((await status('GET', src, 'https://evil.example')).code).toBe(403);
    for (const s of [src, 'assets/./uploads/u_gop.mp4']) expect(await status('GET', s)).toEqual({ code: 200, body: { status: 'none', reasons: [] } });
    await queue.idle();
    expect(existsSync(out)).toBe(false);
    expect(proxyLog).toEqual([]);
    expect((await status('POST', src, 'https://evil.example')).code).toBe(403);
    await queue.idle();
    expect(existsSync(out)).toBe(false);
    // The editor (or a CLI without Origin) asks; every spelling of the same file joins the one job.
    expect(await status('POST', 'assets/./uploads/u_gop.mp4', 'http://localhost:5951')).toEqual({ code: 200, body: { status: 'pending', reasons: ['few keyframes'] } });
    for (const alias of [src, 'assets/uploads//u_gop.mp4', '/assets/uploads/u_gop.mp4', 'assets/uploads/../uploads/u_gop.mp4']) {
      expect((await status('POST', alias)).body, alias).toMatchObject({ status: 'pending' });
    }
    await queue.idle();
    expect(proxyLog).toHaveLength(1);
    expect(existsSync(out)).toBe(true);
    for (const alias of [src, 'assets/uploads//u_gop.mp4']) expect((await status('GET', alias, 'http://localhost:5951')).body).toMatchObject({ status: 'ready', proxySrc: 'assets/uploads/u_gop.proxy.mp4' });
    // A proxy is never proxied; paths outside public/ are nothing.
    expect((await status('POST', 'assets/uploads/u_gop.proxy.mp4')).body).toEqual({ status: 'none', reasons: [] });
    expect((await status('POST', '../../etc/x.mp4')).body).toEqual({ status: 'none', reasons: [] });
    expect((await status('POST', 'assets/uploads/u_gop.txt')).code).toBe(400);
    await queue.idle();
    expect(proxyLog).toHaveLength(1);
  }, 60_000);

  it('refuses an oversized video before reading it', async () => {
    const r = await send('POST', '/api/assets?filename=huge.mp4', { 'Content-Type': 'video/mp4', 'Content-Length': String(600 * 1024 * 1024) }, Buffer.alloc(10));
    expect(r.status).toBe(413);
    expect(JSON.parse(r.body).error.message).toContain('limit 500 MB');
  });

  it('refuses to export a project with a missing video, naming the element', async () => {
    const p = structuredClone(sampleProject);
    p.assets.ast_rec = { id: 'ast_rec', kind: 'video', name: 'Recording', src: 'assets/uploads/missing.mp4', mimeType: 'video/mp4', durationInFrames: 30 };
    p.scenes[0].elements.push({ id: 'el_rec', type: 'video', name: 'Demo clip', startFrame: 0, durationInFrames: 30, visible: true, transform: { x: 0, y: 0, width: 640, height: 360, rotation: 0, scale: 1, opacity: 1 }, props: { ...COMPONENTS.video.defaultProps, assetId: 'ast_rec' }, tracks: [] });
    const r = await send('POST', '/api/renders', { 'Content-Type': 'application/json' }, JSON.stringify({ project: p }));
    expect(r.status).toBe(400);
    expect(JSON.parse(r.body).error.message).toMatch(/Video element "Demo clip" .* missing/);
  });
});
