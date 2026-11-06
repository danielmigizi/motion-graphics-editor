import { describe, expect, it } from 'vitest';
import { JOB_KINDS } from './generationStudio';
import type { GenerateRequest, JobKind, JobSettings } from './generationStudio';
import { JOBS, MODELS, ROUTE_VERSION, bodyEstimates, bodySceneIds, estimate, extractOutputs, falInputs, modelsResponse, normalizeSettings, requiredMedia, route, validateRequest } from './generationRoutes';
import type { RouteContext } from './generationRoutes';

const GPT = 'gpt-image-2.5-flare';
const SEEDREAM = 'seedream-5-pro';
const FLUX = 'flux-3-image';
const MUSIC = 'elevenlabs-music-2.5';
const VOICE = 'eleven-v4';
const SFX = 'elevenlabs-sfx-2';
const ctx: RouteContext = { gptImageReserveUsd: 0.5, now: new Date(2026, 9, 21, 12).getTime() };
const refs = { referenceUrls: ['https://example.com/one.png', 'https://example.com/two.png'], maskUrl: 'https://example.com/mask.png' };
const request = (job: JobKind = 'image.generate', extra: Partial<GenerateRequest> = {}): GenerateRequest => ({ job, prompt: 'A quiet forest', projectId: 'project-1', ...extra });

describe('generation registry and routing', () => {
  it('covers every job with real registry candidates and endpoints', () => {
    expect(Object.keys(JOBS)).toEqual(JOB_KINDS);
    expect(Object.keys(MODELS)).toHaveLength(11);
    for (const job of JOB_KINDS) {
      expect(JOBS[job].job).toBe(job);
      expect(JOBS[job].hint.length).toBeGreaterThan(10);
      for (const id of JOBS[job].candidates) {
        expect(MODELS[id]?.id).toBe(id);
        expect(MODELS[id].endpoints[job]).toBeTruthy();
      }
    }
  });

  it('uses the quality order for quality and balanced', () => {
    for (const job of JOB_KINDS) for (const policy of ['quality', 'balanced'] as const) {
      const pick = route(request(job, { settings: { score: [{ sceneIds: ['one'], seconds: 30, styles: [] }], referenceAssetIds: ['one', 'two'], start: { projectFrame: 0 }, end: { assetId: 'end' }, keyframes: [0, 2.5, 5].map((atSeconds) => ({ frame: { assetId: `pin-${atSeconds}` }, atSeconds })) } }), policy, ctx);
      expect(pick.ok && pick.decision.model).toBe(JOBS[job].candidates[0]);
      expect(pick.ok && pick.decision.reason).toBe(policy === 'quality' ? 'quality default' : 'balanced: no open suggestion for this job, quality default');
    }
  });

  it('routes cutouts only to GPT and maps a transparent background', () => {
    const req = request('image.cutout');
    const pick = route(req, 'draft', ctx);
    expect(pick.ok && pick.decision.model).toBe(GPT);
    expect(falInputs(req, GPT, refs, ctx)[0].background).toBe('transparent');
    expect(route({ ...req, model: SEEDREAM }, 'quality', ctx)).toMatchObject({ ok: false, error: 'Seedream 5.0 Pro does not do this job' });
  });

  it('drops models that cannot accept a mask or twelve references', () => {
    const masked = route(request('image.edit', { settings: { referenceAssetIds: ['one'], maskAssetId: 'mask' } }), 'quality', ctx);
    expect(masked).toMatchObject({ ok: true, decision: { model: GPT, dropped: [{ model: SEEDREAM, why: 'cannot use a mask' }, { model: FLUX, why: 'cannot use a mask' }] } });
    const composite = route(request('image.composite', { settings: { referenceAssetIds: Array.from({ length: 12 }, (_, i) => `${i}`) } }), 'quality', ctx);
    expect(composite).toMatchObject({ ok: true, decision: { model: GPT, dropped: [{ model: SEEDREAM, why: 'takes at most 10 images' }, { model: FLUX, why: 'takes at most 10 images' }] } });
  });

  it.each(['image.edit', 'image.composite'] as const)('requires enough references for %s', (job) => {
    const pick = route(request(job, { settings: { referenceAssetIds: job === 'image.edit' ? [] : ['one'] } }), 'quality', ctx);
    expect(pick).toMatchObject({ ok: false, error: expect.stringContaining('No model can do this:'), dropped: expect.arrayContaining([{ model: GPT, why: `needs at least ${job === 'image.edit' ? 1 : 2} reference images`.replace('1 reference images', '1 reference image') }]) });
  });

  it('drops unavailable endpoints and chooses the next candidate', () => {
    const unavailable = { ...ctx, available: { [MODELS[GPT].endpoints['image.generate']!]: false } };
    expect(route(request(), 'quality', unavailable)).toMatchObject({ ok: true, decision: { model: SEEDREAM, dropped: [{ model: GPT, why: 'not offered by fal right now' }] } });
    expect(route(request('image.cutout'), 'quality', unavailable)).toMatchObject({ ok: false, dropped: [{ model: GPT, why: 'not offered by fal right now' }] });
  });

  it('chooses the cheapest capable draft at the requested resolution', () => {
    // At the specified constant 1k area FLUX is $0.0504, below Seedream.
    expect(route(request(), 'draft', ctx)).toMatchObject({ ok: true, decision: { model: FLUX, reason: 'draft: cheapest capable' } });
    // Seedream's two units ($0.135) still beat FLUX's 2k area price ($0.2016).
    const large = request('image.generate', { settings: { resolution: '2k' } });
    expect(estimate(large, SEEDREAM, ctx).usd).toBe(0.135);
    expect(route(large, 'draft', ctx)).toMatchObject({ ok: true, decision: { model: SEEDREAM } });
    expect(route(request(), 'draft', { ...ctx, available: { [MODELS[FLUX].endpoints['image.generate']!]: false } })).toMatchObject({ ok: true, decision: { model: SEEDREAM } });
  });

  it('honors an explicit model and refuses incapable or unknown overrides', () => {
    expect(route(request('image.generate', { model: SEEDREAM }), 'quality', ctx)).toMatchObject({ ok: true, decision: { model: SEEDREAM, overridden: true, reason: 'your choice' } });
    expect(route(request('image.generate', { model: SEEDREAM, settings: { resolution: '4k' } }), 'quality', ctx)).toMatchObject({ ok: false, error: 'Seedream 5.0 Pro: supports at most 2k resolution' });
    expect(route(request('image.generate', { model: 'unknown' }), 'quality', ctx)).toMatchObject({ ok: false, error: 'unknown does not do this job' });
    expect(route(request('image.generate', { model: 'toString' }), 'quality', ctx)).toMatchObject({ ok: false, error: 'toString does not do this job' });
  });

  it('allows FLUX ratios within three percent and rejects wider mismatches', () => {
    expect(route(request('image.generate', { model: FLUX, settings: { aspectRatio: '1.8:1' } }), 'quality', ctx).ok).toBe(true);
    expect(falInputs(request('image.generate', { settings: { aspectRatio: '1.8:1' } }), FLUX, refs, ctx)[0].aspect_ratio).toBe('16:9');
    expect(route(request('image.generate', { model: FLUX, settings: { aspectRatio: '3:1' } }), 'quality', ctx)).toMatchObject({ ok: false, error: expect.stringContaining('does not support aspect ratio 3:1') });
    expect(route(request('image.generate', { model: FLUX, settings: { aspectRatio: 'invalid' } }), 'quality', ctx)).toMatchObject({ ok: false, error: expect.stringContaining('does not support aspect ratio invalid') });
  });

  it('honors the request policy over the fallback policy', () => {
    expect(route(request('image.generate', { policy: 'draft' }), 'quality', ctx)).toMatchObject({ ok: true, decision: { model: FLUX } });
  });
});

describe('generation defaults', () => {
  it('derives image defaults from the project without mutating settings', () => {
    const settings = Object.freeze({ referenceAssetIds: Object.freeze(['one']) as unknown as string[] });
    const normalized = normalizeSettings('image.plate', settings, { project: { width: 1080, height: 1920, fps: 30, durationSeconds: 20 } });
    expect(normalized).toEqual({ referenceAssetIds: ['one'], aspectRatio: '9:16', resolution: '2k' });
    expect(normalized.referenceAssetIds).not.toBe(settings.referenceAssetIds);
    expect(normalizeSettings('image.generate', undefined, {})).toEqual({ aspectRatio: '16:9', resolution: '1k' });
    expect(normalizeSettings('image.generate', { aspectRatio: '1:1', resolution: '4k' }, {})).toMatchObject({ aspectRatio: '1:1', resolution: '4k' });
  });

  it('defaults and clamps music and sfx durations and preserves explicit false', () => {
    expect(normalizeSettings('music.bed', undefined, {})).toEqual({ durationSeconds: 30, instrumental: true });
    expect(normalizeSettings('music.bed', { durationSeconds: -10, instrumental: false }, {})).toEqual({ durationSeconds: 3, instrumental: false });
    expect(normalizeSettings('music.bed', undefined, { project: { width: 0, height: 0, fps: 30, durationSeconds: 1000 } }).durationSeconds).toBe(600);
    expect(normalizeSettings('music.bed', { durationSeconds: NaN }, {}).durationSeconds).toBe(30);
    expect(normalizeSettings('sfx.hit', undefined, {})).toEqual({ durationSeconds: 2 });
    expect(normalizeSettings('sfx.ambience', undefined, {})).toEqual({ durationSeconds: 10, loop: true });
    expect(normalizeSettings('sfx.ambience', { durationSeconds: Infinity, loop: false }, {})).toEqual({ durationSeconds: 22, loop: false });
    expect(normalizeSettings('sfx.hit', { durationSeconds: -1 }, {}).durationSeconds).toBe(0.5);
    expect(normalizeSettings('voice.line', undefined, {})).toEqual({ voice: 'Rachel' });
  });
});

describe('generation estimates', () => {
  it.each([
    ['music.bed', MUSIC, 'music', { durationSeconds: 30 }, 0.3],
    ['voice.line', VOICE, 'a'.repeat(1000), {}, 0.08],
    ['voice.narration', VOICE, 'a', {}, 0.0001],
    ['sfx.ambience', SFX, 'Rain', { durationSeconds: 10 }, 0.02],
    ['image.generate', SEEDREAM, 'A tree', {}, 0.0675],
    ['image.generate', FLUX, 'A tree', { aspectRatio: '16:9', resolution: '1k' }, 0.0504],
    ['image.plate', FLUX, 'A tree', { resolution: '4k' }, 0.8054],
  ] as const)('estimates %s on %s', (job, model, prompt, settings, usd) => {
    const quote = estimate(request(job, { prompt, settings }), model, ctx);
    expect(quote.usd).toBe(usd);
    expect(quote.basis).toContain('$');
    expect(quote.reserve).toBeUndefined();
    expect(estimate(request(job, { prompt, settings, takes: 3 }), model, ctx).usd).toBeCloseTo(usd * 3, 3);
  });

  it('uses the GPT reserve for all takes and clamps takes defensively', () => {
    expect(estimate(request('image.generate', { takes: 2 }), GPT, ctx)).toEqual({ usd: 1, basis: '2 × ≈$0.50 per image (budget reserve)', reserve: true });
    expect(estimate(request('image.generate', { takes: 99 }), GPT, ctx).usd).toBe(2);
    expect(estimate(request('image.generate', { takes: -1 }), GPT, ctx).usd).toBe(0.5);
  });

  it('uses live prices only when the units match, except GPT reserves', () => {
    const endpoint = MODELS[SEEDREAM].endpoints['image.generate']!;
    expect(estimate(request(), SEEDREAM, { ...ctx, livePrices: { [endpoint]: { unit: 'units', unitPrice: 0.01 } } }).usd).toBe(0.01);
    expect(estimate(request(), SEEDREAM, { ...ctx, livePrices: { [endpoint]: { unit: 'seconds', unitPrice: 0.01 } } }).usd).toBe(0.0675);
    expect(estimate(request(), GPT, { ...ctx, livePrices: { [MODELS[GPT].endpoints['image.generate']!]: { unit: 'units', unitPrice: 1 } } }).usd).toBe(0.5);
    expect(estimate(request(), SEEDREAM, { ...ctx, livePrices: { [endpoint]: { unit: 'units', unitPrice: NaN } } }).usd).toBe(0.0675);
  });
});

describe('fal image mapping', () => {
  for (const aspectRatio of ['16:9', '9:16', '21:9', '1:1', '10:1', '1:10']) {
    it.each(['1k', '2k', '4k'] as const)(`keeps GPT ${aspectRatio} %s inside pixel and ratio bounds`, (resolution) => {
      const body = falInputs(request('image.generate', { settings: { aspectRatio, resolution } }), GPT, refs, ctx)[0];
      const { width, height } = body.image_size as { width: number; height: number };
      expect(width % 16).toBe(0);
      expect(height % 16).toBe(0);
      expect(Math.max(width / height, height / width)).toBeLessThanOrEqual(3);
      expect(width * height).toBeGreaterThanOrEqual(655360);
      expect(width * height).toBeLessThanOrEqual(8294400);
      expect(body).toMatchObject({ prompt: 'A quiet forest', background: 'auto', quality: 'high', num_images: 1, output_format: 'png' });
    });
  }

  for (const aspectRatio of ['16:9', '9:16', '21:9', '1:1']) {
    it.each(['1k', '2k'] as const)(`keeps Seedream ${aspectRatio} %s inside area bounds`, (resolution) => {
      const { width, height } = falInputs(request('image.generate', { settings: { aspectRatio, resolution } }), SEEDREAM, refs, ctx)[0].image_size as { width: number; height: number };
      expect(width % 16).toBe(0);
      expect(height % 16).toBe(0);
      expect(width * height).toBeGreaterThanOrEqual(1048576);
      expect(width * height).toBeLessThanOrEqual(4194304);
      const [w, h] = aspectRatio.split(':').map(Number);
      expect(width / height / (w / h)).toBeCloseTo(1, 1);
    });
  }

  it('uses auto size for GPT edits unless the request explicitly sets a ratio', () => {
    const req = request('image.edit', { settings: { referenceAssetIds: ['one'], maskAssetId: 'mask' } });
    expect(falInputs(req, GPT, refs, ctx)[0]).toMatchObject({ image_size: 'auto', image_urls: refs.referenceUrls, mask_url: refs.maskUrl });
    expect(falInputs({ ...req, settings: { ...req.settings, aspectRatio: '1:1' } }, GPT, refs, ctx)[0].image_size).toEqual({ width: 1536, height: 1536 });
    expect(falInputs(req, SEEDREAM, refs, ctx)[0]).toMatchObject({ image_urls: refs.referenceUrls });
    expect(falInputs(req, FLUX, refs, ctx)[0]).toMatchObject({ image_urls: refs.referenceUrls, aspect_ratio: '16:9', resolution: '1k' });
  });

  it.each([`${'9'.repeat(200)}:1`, `1:${'9'.repeat(200)}`, 'not a ratio'])('bounds Seedream sizes for extreme or malformed ratios: %s', (aspectRatio) => {
    const { width, height } = falInputs(request('image.generate', { settings: { aspectRatio } }), SEEDREAM, refs, ctx)[0].image_size as { width: number; height: number };
    expect(width * height).toBeGreaterThanOrEqual(1048576);
    expect(width * height).toBeLessThanOrEqual(4194304);
    expect(width % 16).toBe(0);
    expect(height % 16).toBe(0);
  });

  it('batches GPT and Seedream takes, sends separate FLUX bodies and no image seeds (their schemas take none)', () => {
    for (const model of [GPT, SEEDREAM]) {
      const bodies = falInputs(request('image.generate', { takes: 4, settings: { seed: 10 } }), model, refs, ctx);
      expect(bodies).toHaveLength(1);
      expect(bodies[0]).toMatchObject({ num_images: 4 });
      expect(bodies[0]).not.toHaveProperty('seed');
    }
    const bodies = falInputs(request('image.generate', { takes: 3, settings: { seed: 0 } }), FLUX, refs, ctx);
    expect(bodies).toHaveLength(3);
    expect(bodies.every((b) => !('seed' in b))).toBe(true);
    expect(bodies.every((b) => !('num_images' in b))).toBe(true);
  });
});

describe('fal audio mapping', () => {
  it('sends music milliseconds and instrumental choice, never a seed', () => {
    const bodies = falInputs(request('music.bed', { takes: 2, settings: { durationSeconds: 3.1234, seed: 7, instrumental: false } }), MUSIC, refs, ctx);
    expect(bodies).toEqual(Array(2).fill({ prompt: 'A quiet forest', music_length_ms: 3123, force_instrumental: false }));
  });

  it('maps voice text, language, timestamps and per-body seeds', () => {
    const bodies = falInputs(request('voice.line', { takes: 2, settings: { voice: 'Aria', languageCode: 'en', seed: 4 } }), VOICE, refs, ctx);
    expect(bodies[0]).toEqual({ text: 'A quiet forest', voice: 'Aria', timestamps: true, language_code: 'en', seed: 4 });
    expect(bodies[1].seed).toBe(5);
    expect(falInputs(request('voice.narration'), VOICE, refs, ctx)[0]).toEqual({ text: 'A quiet forest', voice: 'Rachel', timestamps: true });
  });

  it('maps sfx text, seconds and loop defaults', () => {
    expect(falInputs(request('sfx.hit'), SFX, refs, ctx)[0]).toEqual({ text: 'A quiet forest', duration_seconds: 2, loop: false });
    expect(falInputs(request('sfx.ambience'), SFX, refs, ctx)[0]).toEqual({ text: 'A quiet forest', duration_seconds: 10, loop: true });
  });
});

describe('fal output extraction', () => {
  it('extracts valid images with a shared seed and ignores malformed entries', () => {
    expect(extractOutputs('image.generate', { seed: 42, images: [
      { url: 'https://example.com/one.png', width: 1024, height: 768, content_type: 'image/png' },
      { url: 'https://example.com/two.png', width: 'bad', height: Infinity, content_type: 7 },
      { url: 'http://example.com/no.png' }, { url: 'https://' }, null, {}, 'bad',
    ] })).toEqual([
      { url: 'https://example.com/one.png', width: 1024, height: 768, contentType: 'image/png', seed: 42 },
      { url: 'https://example.com/two.png', seed: 42 },
    ]);
  });

  it.each(['music.bed', 'voice.line', 'voice.narration', 'sfx.hit', 'sfx.ambience'] as const)('extracts %s audio and ignores timestamps', (job) => {
    expect(extractOutputs(job, { audio: { url: 'https://example.com/audio.mp3', content_type: 'audio/mpeg' }, timestamps: [{ text: 'hello' }] })).toEqual([{ url: 'https://example.com/audio.mp3', contentType: 'audio/mpeg' }]);
  });

  it.each([undefined, null, false, 0, 'garbage', [], {}, { images: 'bad' }, { images: [null, {}, { url: 'data:image/png;base64,abc' }] }, { audio: { url: 'file:///tmp/audio' } }])('returns no files for garbage %#', (value) => {
    expect(extractOutputs('image.generate', value)).toEqual([]);
    expect(extractOutputs('voice.line', value)).toEqual([]);
  });
});

describe('generation request validation', () => {
  it('accepts and trims a complete request without mutating the body', () => {
    const raw = request('image.edit', { prompt: '  Change the sky  ', takes: 4, policy: 'draft', model: GPT, regenerateOf: 'job-1', settings: { aspectRatio: '16:9', resolution: '2k', durationSeconds: 10, voice: 'Rachel', languageCode: 'en', instrumental: false, loop: true, referenceAssetIds: ['image-1'], maskAssetId: 'mask-1', seed: 0 } });
    const parsed = validateRequest(raw);
    expect(parsed).toEqual({ ok: true, value: { ...raw, prompt: 'Change the sky' } });
    expect(raw.prompt).toBe('  Change the sky  ');
  });

  it.each([
    [null, 'request'], [[], 'request'], [{ job: 'unknown.job' }, 'job'],
    [{ prompt: 7 }, 'prompt'], [{ prompt: ' ' }, 'prompt'],
    [{ projectId: '' }, 'projectId'], [{ projectId: 1 }, 'projectId'],
    [{ takes: 0 }, 'takes'], [{ takes: 5 }, 'takes'], [{ takes: 1.5 }, 'takes'], [{ takes: '2' }, 'takes'],
    [{ policy: 'cheap' }, 'policy'], [{ model: 1 }, 'model'], [{ regenerateOf: false }, 'regenerateOf'],
    [{ settings: [] }, 'settings'], [{ settings: null }, 'settings'],
    [{ settings: { unknown: true } }, 'settings.unknown'],
    ...['aspectRatio', 'voice', 'languageCode', 'maskAssetId'].map((key): [Record<string, unknown>, string] => [{ settings: { [key]: 7 } }, `settings.${key}`]),
    [{ settings: { resolution: '8k' } }, 'settings.resolution'],
    [{ settings: { durationSeconds: '10' } }, 'settings.durationSeconds'], [{ settings: { durationSeconds: NaN } }, 'settings.durationSeconds'],
    [{ settings: { seed: Infinity } }, 'settings.seed'], [{ settings: { seed: false } }, 'settings.seed'],
    [{ settings: { instrumental: 'yes' } }, 'settings.instrumental'], [{ settings: { loop: 1 } }, 'settings.loop'],
    [{ settings: { referenceAssetIds: 'one' } }, 'settings.referenceAssetIds'],
    [{ settings: { referenceAssetIds: [1] } }, 'settings.referenceAssetIds'],
    [{ settings: { referenceAssetIds: Array(17).fill('one') } }, 'settings.referenceAssetIds'],
  ])('rejects bad field %# at its path', (patch, path) => {
    const body = patch === null || Array.isArray(patch) ? patch : { ...request(), ...patch };
    const parsed = validateRequest(body);
    expect(parsed).toMatchObject({ ok: false, path, error: expect.stringContaining(path as string) });
  });

  it.each([['voice.line', 5000], ['voice.narration', 5000], ['sfx.hit', 450], ['music.bed', 4100], ['image.generate', 32000]] as const)('enforces the %s prompt length', (job, max) => {
    expect(validateRequest(request(job, { prompt: 'a'.repeat(max) })).ok).toBe(true);
    expect(validateRequest(request(job, { prompt: 'a'.repeat(max + 1) }))).toMatchObject({ ok: false, path: 'prompt' });
  });
});

describe('generation models response', () => {
  it('lists every job in order with prices, availability and policy defaults', () => {
    const response = modelsResponse('balanced', ctx);
    expect(response.routeVersion).toBe(ROUTE_VERSION);
    expect(response.policy).toBe('balanced');
    expect(response.jobs.map((j) => j.job)).toEqual(JOB_KINDS);
    for (const job of response.jobs) {
      expect(job.models.map((m) => m.id)).toEqual(JOBS[job.job].candidates);
      expect(job.defaults.quality).toBe(JOBS[job.job].candidates[0]);
      expect(job.defaults.balanced).toBe(job.defaults.quality);
      expect(job.models.some((m) => m.id === job.defaults.draft)).toBe(true);
      expect(job.models.every((m) => m.available === null && m.license && m.endpoint)).toBe(true);
    }
    expect(response.jobs.find((j) => j.job === 'image.generate')?.models.map((m) => m.priceLabel)).toEqual(['≈$0.50 per image (budget reserve)', '$0.0675 per image', '$0.048 per megapixel']);
    expect(response.jobs.find((j) => j.job === 'music.bed')?.models[0].priceLabel).toBe('$0.60 per minute');
    expect(response.jobs.find((j) => j.job === 'voice.line')?.models[0].priceLabel).toBe('$0.08 per 1,000 characters');
    expect(response.jobs.find((j) => j.job === 'sfx.hit')?.models[0].priceLabel).toBe('$0.002 per second');
  });

  it('exposes checked availability and picks a remaining default', () => {
    const response = modelsResponse('quality', { ...ctx, available: { [MODELS[GPT].endpoints['image.generate']!]: false, [MODELS[SEEDREAM].endpoints['image.generate']!]: true } });
    const generate = response.jobs.find((j) => j.job === 'image.generate')!;
    expect(generate.models.map((m) => m.available)).toEqual([false, true, null]);
    expect(generate.defaults.quality).toBe(SEEDREAM);
    expect(response.jobs.find((j) => j.job === 'image.cutout')?.defaults.quality).toBe('');
  });
});


describe('Seedream area pricing', () => {
  it.each(['1:1', '16:9', '9:16'])('charges two units above 2.36 MP for %s', (aspectRatio) => {
    const large = request('image.generate', { takes: 2, settings: { resolution: '2k', aspectRatio } });
    expect(estimate(large, SEEDREAM, ctx)).toEqual({ usd: 0.27, basis: '2 × 2 units × $0.0675' });
    expect(estimate({ ...large, settings: { resolution: '1k', aspectRatio } }, SEEDREAM, ctx)).toEqual({ usd: 0.135, basis: '2 × 1 units × $0.0675' });
  });
});

const FLUX_VIDEO = 'flux-3-max';
const H3 = 'h3-max';
const TURBO = 'h3-max-turbo';
const WAN_PRIME = 'wan-3-prime';
const WAN = 'wan-3';
const videoJobs = JOB_KINDS.filter((job) => job.startsWith('video.'));
const videoSettings: JobSettings = {
  durationSeconds: 8, videoResolution: '720p', aspectRatio: '16:9', seed: 42,
  start: { projectFrame: 120 }, end: { assetId: 'last' },
  keyframes: [0, 3.125, 8].map((atSeconds, i) => ({ frame: { assetId: `pin-${i}` }, atSeconds })),
  referenceAssetIds: ['image-1', 'video-1'],
};
const videoRefs = {
  referenceUrls: ['https://example.com/reference.png'], referenceVideoUrls: ['https://example.com/reference.mp4'],
  startUrl: 'https://example.com/start.png', endUrl: 'https://example.com/end.png',
  keyframeUrls: [0, 1, 2].map((i) => `https://example.com/pin-${i}.png`),
};
const videoRequest = (job: JobKind = 'video.generate', settings: JobSettings = {}): GenerateRequest => request(job, { settings: { ...videoSettings, ...(job === 'video.reference' ? { start: undefined, end: undefined } : {}), ...settings } });

describe('video registry and routing', () => {
  it.each([
    [FLUX_VIDEO, 'blackforestlabs/flux-3-max', { 'video.generate': 'text-to-video', 'video.animate': 'image-to-video', 'video.between': 'image-to-video', 'video.keyframes': 'keyframes-to-video' }],
    [H3, 'minimax/h3-max', { 'video.generate': 'text-to-video', 'video.animate': 'image-to-video', 'video.between': 'image-to-video', 'video.keyframes': 'reference-to-video', 'video.reference': 'reference-to-video' }],
    [TURBO, 'minimax/h3-max-turbo', { 'video.generate': 'text-to-video', 'video.animate': 'image-to-video', 'video.between': 'image-to-video' }],
    [WAN_PRIME, 'alibaba/wan-3.0-prime', { 'video.generate': 'reference-to-video', 'video.animate': 'reference-to-video', 'video.reference': 'reference-to-video', 'video.long': 'reference-to-video' }],
    [WAN, 'alibaba/wan-3.0', { 'video.reference': 'reference-to-video', 'video.long': 'reference-to-video' }],
  ] as const)('registers every endpoint for %s', (id, prefix, jobs) => {
    expect(MODELS[id].price.unit).toBe('seconds');
    expect(MODELS[id].endpoints).toEqual(Object.fromEntries(Object.entries(jobs).map(([job, endpoint]) => [job, `${prefix}/${endpoint}`])));
  });

  it.each(['video.generate', 'video.animate', 'video.between'] as const)('picks FLUX quality and Turbo draft for %s', (job) => {
    expect(route(videoRequest(job), 'quality', ctx)).toMatchObject({ ok: true, decision: { model: FLUX_VIDEO } });
    expect(route(videoRequest(job), 'draft', ctx)).toMatchObject({ ok: true, decision: { model: TURBO } });
  });

  it.each([
    // Below a model's minimum it still routes (it generates its minimum); only the maximum drops it.
    [FLUX_VIDEO, 4.99, true], [FLUX_VIDEO, 5, true], [FLUX_VIDEO, 20, true], [FLUX_VIDEO, 20.01, false],
    [H3, 0.91, true], [H3, 0.92, true], [H3, 15, true], [H3, 15.01, false],
    [TURBO, 0.91, true], [TURBO, 15, true], [TURBO, 15.01, false],
    [WAN_PRIME, 1.99, true], [WAN_PRIME, 2, true], [WAN_PRIME, 30, true], [WAN_PRIME, 30.01, false],
  ])('filters %s at %s seconds', (model, durationSeconds, ok) => {
    const result = route({ ...videoRequest('video.generate', { durationSeconds: durationSeconds as number }), model: model as string }, 'quality', ctx);
    expect(result.ok).toBe(ok);
    if (!ok) expect(result).toMatchObject({ dropped: expect.arrayContaining([{ model, why: expect.stringContaining('at most') }]) });
  });

  it('routes over 20 seconds to Wan and drops H3 over 15 seconds', () => {
    // A 4 s scene keeps FLUX 3 Max: it generates its 5 s minimum, billed as 5 s, and the take is trimmed when placed.
    const short = videoRequest('video.generate', { durationSeconds: 4 });
    expect(route(short, 'quality', ctx)).toMatchObject({ ok: true, decision: { model: FLUX_VIDEO, dropped: [] } });
    expect(estimate(short, FLUX_VIDEO, ctx).usd).toBeCloseTo(5 * 0.0425);
    expect(falInputs(short, FLUX_VIDEO, { referenceUrls: [] }, ctx)[0]).toMatchObject({ duration: 5 });
    expect(route(videoRequest('video.generate', { durationSeconds: 21 }), 'quality', ctx)).toMatchObject({ ok: true, decision: { model: WAN_PRIME, dropped: expect.arrayContaining([{ model: H3, why: 'takes at most 15 seconds' }, { model: FLUX_VIDEO, why: 'takes at most 20 seconds' }]) } });
    expect(route(videoRequest('video.generate', { durationSeconds: 16 }), 'draft', ctx)).toMatchObject({ ok: true, decision: { model: FLUX_VIDEO } });
    expect(route(videoRequest('video.long', { durationSeconds: 30 }), 'quality', ctx)).toMatchObject({ ok: true, decision: { model: WAN_PRIME } });
  });

  it.each([
    ['video.animate', { start: undefined }, 'needs a start frame'],
    ['video.between', { start: undefined }, 'needs a start frame'],
    ['video.between', { end: undefined }, 'needs an end frame'],
    ['video.keyframes', { keyframes: [] }, 'needs 3 to 10 keyframes'],
    ['video.reference', { referenceAssetIds: [] }, 'needs at least 1 reference image or video'],
  ] as [JobKind, JobSettings, string][])('explains missing media for %s', (job, settings, why) => {
    const result = route(videoRequest(job, settings), 'quality', ctx);
    expect(result).toMatchObject({ ok: false, dropped: expect.arrayContaining([{ model: JOBS[job].candidates[0], why }]) });
    // Missing job-specific media is deliberately a routing error, not malformed JSON.
    expect(validateRequest(request(job)).ok).toBe(true);
  });

  it('filters H3 keyframe count/resolution and rejects invalid timing', () => {
    const pick = (settings: JobSettings, model = H3) => route({ ...videoRequest('video.keyframes', settings), model }, 'quality', ctx);
    expect(pick({}).ok).toBe(true);
    expect(pick({ videoResolution: '1080p' })).toMatchObject({ ok: false, error: 'MiniMax H3 Max: takes a middle frame only at 768P' });
    expect(pick({ keyframes: [...videoSettings.keyframes!, { frame: { projectFrame: 10 }, atSeconds: 7 }] })).toMatchObject({ ok: false, error: expect.stringContaining('exactly 3') });
    expect(pick({ keyframes: [0, 3, 9].map((atSeconds) => ({ frame: { projectFrame: 0 }, atSeconds })) }, FLUX_VIDEO)).toMatchObject({ ok: false, error: expect.stringContaining('within the clip duration') });
    expect(pick({ durationSeconds: 7.6 }, FLUX_VIDEO)).toMatchObject({ ok: false, error: expect.stringContaining('within the clip duration') });
    expect(pick({ keyframes: [0, 0.01, 8].map((atSeconds) => ({ frame: { projectFrame: 0 }, atSeconds })) }, FLUX_VIDEO)).toMatchObject({ ok: false, error: expect.stringContaining('unique keyframe frame indices') });
    expect(pick({ keyframes: [0, 0, 8].map((atSeconds) => ({ frame: { projectFrame: 0 }, atSeconds })) })).toMatchObject({ ok: false, error: expect.stringContaining('unique keyframe times') });
    expect(pick({ keyframes: [...videoSettings.keyframes!].reverse() })).toMatchObject({ ok: false, error: expect.stringContaining('increasing time order') });
    const ten = Array.from({ length: 10 }, (_, i) => ({ frame: { projectFrame: i }, atSeconds: i * 0.5 }));
    expect(pick({ keyframes: ten }, FLUX_VIDEO).ok).toBe(true);
    expect(pick({ keyframes: [...ten, { frame: { projectFrame: 11 }, atSeconds: 6 }] }, FLUX_VIDEO).ok).toBe(false);
  });

  it.each([
    [H3, 9, 3, true], [H3, 10, 0, false], [H3, 0, 4, false], [H3, 9, 4, false],
    [WAN_PRIME, 10, 5, true], [WAN_PRIME, 11, 0, false], [WAN_PRIME, 0, 6, false],
    [WAN, 0, 5, true], [WAN, 10, 5, true], [WAN, 10, 6, false],
  ])('filters %s with %s images and %s videos', (model, images, videos, ok) => {
    const imageIds = Array.from({ length: images as number }, (_, i) => `image-${i}`);
    const videoIds = Array.from({ length: videos as number }, (_, i) => `video-${i}`);
    const result = route({ ...videoRequest('video.reference', { referenceAssetIds: [...imageIds, ...videoIds] }), model: model as string }, 'quality', {
      ...ctx, referenceAssetKinds: Object.fromEntries(videoIds.map((id) => [id, 'video' as const])),
    });
    expect(result.ok).toBe(ok);
    if (!ok) expect(result).toMatchObject({ dropped: expect.arrayContaining([{ model, why: expect.stringContaining('takes at most') }]) });
  });

  it('treats unclassified ids as images and verifies resolved limits before submission', () => {
    expect(route(videoRequest('video.reference', { referenceAssetIds: Array(10).fill('image') }), 'quality', ctx)).toMatchObject({ ok: true, decision: { model: WAN_PRIME, dropped: [{ model: H3, why: 'takes at most 9 reference images' }] } });
    expect(() => falInputs(videoRequest('video.reference'), H3, { referenceUrls: [], referenceVideoUrls: Array(4).fill('https://example.com/v.mp4') }, ctx)).toThrow('takes at most 3 reference videos');
    expect(() => falInputs(videoRequest('video.reference'), WAN, { referenceUrls: Array(11).fill('https://example.com/i.png') }, ctx)).toThrow('takes at most 10 reference images');
    expect(() => falInputs(videoRequest('video.reference'), H3, { referenceUrls: [] }, ctx)).toThrow('needs at least 1 reference');
  });

  it.each([FLUX_VIDEO, H3, TURBO, WAN_PRIME])('maps nearby ratios and rejects unsupported ratios for %s', (model) => {
    const req = { ...videoRequest('video.generate', { aspectRatio: '1.8:1' }), model };
    expect(route(req, 'quality', ctx).ok).toBe(true);
    expect(falInputs(req, model, videoRefs, ctx)[0].aspect_ratio).toBe('16:9');
    for (const aspectRatio of ['3:1', 'bad']) expect(route({ ...req, settings: { ...req.settings, aspectRatio } }, 'quality', ctx)).toMatchObject({ ok: false, error: expect.stringContaining('does not support aspect ratio') });
  });

  it('supports FLUX 2:1, H3 21:9 and follows the start image for H3 i2v', () => {
    expect(route({ ...videoRequest('video.generate', { aspectRatio: '2:1' }), model: FLUX_VIDEO }, 'quality', ctx).ok).toBe(true);
    expect(route({ ...videoRequest('video.generate', { aspectRatio: '21:9' }), model: H3 }, 'quality', ctx).ok).toBe(true);
    expect(route({ ...videoRequest('video.generate', { aspectRatio: '21:9' }), model: WAN_PRIME }, 'quality', ctx).ok).toBe(false);
    for (const model of [H3, TURBO]) {
      const req = { ...videoRequest('video.between', { aspectRatio: '3:1' }), model };
      expect(route(req, 'quality', ctx).ok).toBe(true);
      expect(falInputs(req, model, videoRefs, ctx)[0]).not.toHaveProperty('aspect_ratio');
    }
  });

  it('routes document and web clips only through video.long on Wan', () => {
    expect(route(videoRequest('video.long', { documentUrl: 'https://example.com/doc.pdf', webUrl: 'https://example.com/page' }), 'quality', ctx)).toMatchObject({ ok: true, decision: { model: WAN_PRIME } });
    expect(route(videoRequest('video.generate', { documentUrl: 'https://example.com/doc.pdf' }), 'quality', ctx)).toMatchObject({ ok: false, error: expect.stringContaining('only with video.long on Wan') });
  });
});

describe('video defaults, cost and output', () => {
  it('defaults to 5 s, 1080p and the project ratio, preserving explicit duration', () => {
    for (const job of videoJobs) {
      expect(normalizeSettings(job, undefined, {})).toEqual({ aspectRatio: '16:9', durationSeconds: 5, videoResolution: '1080p' });
      expect(normalizeSettings(job, { durationSeconds: 21 }, { project: { width: 1080, height: 1920, fps: 30, durationSeconds: 100 } })).toMatchObject({ aspectRatio: '9:16', durationSeconds: 21 });
    }
  });

  it('uses resolution and endpoint tables despite live lowest-resolution prices', () => {
    expect(estimate(videoRequest('video.generate', { videoResolution: '1080p' }), FLUX_VIDEO, ctx)).toEqual({ usd: 0.58, basis: '1 × 8 s × $0.0725 per second at 1080p (promotional until 7 Nov)' });
    expect(estimate(videoRequest(), FLUX_VIDEO, ctx).usd).toBe(0.34);
    expect(estimate(videoRequest('video.reference', { durationSeconds: 10 }), H3, ctx).usd).toBe(0.8);
    expect(estimate(videoRequest('video.keyframes', { durationSeconds: 10 }), H3, ctx).usd).toBe(0.8);
    expect(estimate(videoRequest(), H3, ctx).usd).toBe(0.416);
    expect(estimate({ ...videoRequest(), takes: 3 }, FLUX_VIDEO, ctx).usd).toBe(1.02);
    const endpoint = MODELS[H3].endpoints['video.reference']!;
    for (const unit of ['seconds', 'units']) expect(estimate(videoRequest('video.reference'), H3, { ...ctx, livePrices: { [endpoint]: { unit, unitPrice: 0.0325 } } }).usd).toBe(0.64);
    const jobs = modelsResponse('quality', ctx).jobs;
    expect(jobs.find((j) => j.job === 'video.generate')?.models[0].priceLabel).toBe('$0.0725 per second at 1080p (promotional until 7 Nov)');
    expect(jobs.find((j) => j.job === 'video.reference')?.models[0].priceLabel).toBe('$0.16 per second at 1080p (standard)');
  });

  it.each(videoJobs)('extracts %s metadata and ignores invalid video metadata/URLs', (job) => {
    expect(extractOutputs(job, { seed: 7, video: { url: 'https://example.com/clip.mp4', content_type: 'video/mp4', width: 1920, height: 1080, duration: 8 } })).toEqual([{ url: 'https://example.com/clip.mp4', contentType: 'video/mp4', width: 1920, height: 1080, duration: 8, seed: 7 }]);
    expect(extractOutputs(job, { seed: Infinity, video: { url: 'https://example.com/clip.mp4', width: -1, height: '1080', duration: NaN } })).toEqual([{ url: 'https://example.com/clip.mp4' }]);
    for (const result of [null, {}, { video: { url: 'http://example.com/clip.mp4' } }, { video: { url: 'data:video/mp4;base64,a' } }]) expect(extractOutputs(job, result)).toEqual([]);
  });
});

describe('fal video mapping', () => {
  for (const job of videoJobs) for (const model of JOBS[job].candidates) {
    it(`maps ${model} × ${job}, disabling model audio and sending one take per body`, () => {
      const req = { ...videoRequest(job), takes: 2 };
      const bodies = falInputs(req, model, videoRefs, ctx);
      expect(bodies).toHaveLength(2);
      const body = bodies[0];
      expect(body).toMatchObject({ prompt: req.prompt, duration: 8, seed: 42 });
      expect(bodies[1].seed).toBe(43);
      expect(body).not.toHaveProperty('num_images');
      expect(body).not.toHaveProperty('num_videos');
      if (model === FLUX_VIDEO) expect(body).toMatchObject({ generate_audio: false, resolution: '720p', aspect_ratio: '16:9' });
      else if (model === H3 || model === TURBO) {
        expect(body).toMatchObject({ prompt_expansion_mode: 'balanced', resolution: '768P' });
        expect(body).not.toHaveProperty('audio');
        expect(body).not.toHaveProperty('generate_audio');
      } else expect(body).toMatchObject({ audio: false, resolution: '720p', aspect_ratio: '16:9', enable_prompt_expansion: true });
      if (job === 'video.animate' && model === WAN_PRIME) expect(body.reference_image_urls).toEqual([videoRefs.startUrl]);
      else if (job === 'video.animate' || job === 'video.between') expect(body.image_url).toBe(videoRefs.startUrl);
      if (job === 'video.between') expect(body.end_image_url).toBe(videoRefs.endUrl);
      if (job === 'video.reference') {
        expect(body).toMatchObject({ reference_image_urls: videoRefs.referenceUrls, reference_video_urls: videoRefs.referenceVideoUrls });
        if (model === H3) expect(body).toMatchObject({ image_url: videoRefs.startUrl, end_image_url: videoRefs.endUrl });
      }
      if (job === 'video.generate' || job === 'video.long') {
        expect(body).not.toHaveProperty('image_url');
        expect(body).not.toHaveProperty('reference_image_urls');
      }
    });
  }

  it('maps exact FLUX keyframe indices and H3 middle-frame fields', () => {
    expect(falInputs(videoRequest('video.keyframes'), FLUX_VIDEO, videoRefs, ctx)[0]).toEqual({
      prompt: 'A quiet forest', duration: 8, resolution: '720p', aspect_ratio: '16:9', generate_audio: false, seed: 42,
      keyframes: [0, 75, 192].map((frame_index, i) => ({ image_url: videoRefs.keyframeUrls[i], frame_index })),
    });
    expect(falInputs(videoRequest('video.keyframes'), H3, videoRefs, ctx)[0]).toEqual({
      prompt: 'A quiet forest', duration: 8, resolution: '768P', aspect_ratio: '16:9', prompt_expansion_mode: 'balanced', seed: 42,
      image_url: videoRefs.keyframeUrls[0], middle_image_url: videoRefs.keyframeUrls[1], middle_frame_time: 3.125, end_image_url: videoRefs.keyframeUrls[2],
    });
    expect(falInputs(videoRequest('video.keyframes', { keyframes: [0, 3.14, 8].map((atSeconds) => ({ frame: { projectFrame: 0 }, atSeconds })) }), FLUX_VIDEO, videoRefs, ctx)[0].keyframes).toMatchObject([{}, { frame_index: 75 }, {}]);
  });

  it.each([
    [FLUX_VIDEO, 4, 5], [FLUX_VIDEO, 5.6, 6], [FLUX_VIDEO, 21, 20],
    [H3, 0.1, 0.92], [H3, 7.25, 7.25], [H3, 16, 15],
    [TURBO, 15.01, 15], [WAN_PRIME, 1, 2], [WAN_PRIME, 2.6, 3], [WAN_PRIME, 31, 30],
  ])('maps and estimates %s duration %s as %s', (model, durationSeconds, duration) => {
    const req = videoRequest('video.generate', { durationSeconds: durationSeconds as number });
    expect(falInputs(req, model as string, videoRefs, ctx)[0].duration).toBe(duration);
    expect(estimate(req, model as string, ctx).basis).toContain(`${duration} s`);
  });

  it.each([FLUX_VIDEO, H3, TURBO, WAN_PRIME])('maps 1080p correctly for %s', (model) => {
    expect(falInputs(videoRequest('video.generate', { videoResolution: '1080p' }), model, videoRefs, ctx)[0].resolution).toBe(model === H3 || model === TURBO ? '1080P' : '1080p');
  });

  it.each([WAN_PRIME, WAN])('maps document and web URLs with thinking on %s', (model) => {
    for (const settings of [{ documentUrl: 'https://example.com/doc.pdf' }, { webUrl: 'https://example.com/page' }, { documentUrl: 'https://example.com/doc.pdf', webUrl: 'https://example.com/page' }]) {
      expect(falInputs(videoRequest('video.long', settings), model, videoRefs, ctx)[0]).toEqual({
        prompt: 'A quiet forest', duration: 8, resolution: '720p', aspect_ratio: '16:9', audio: false, enable_prompt_expansion: true, enable_thinking: true, seed: 42,
        ...(settings.documentUrl ? { file_url: settings.documentUrl } : {}), ...(settings.webUrl ? { web_url: settings.webUrl } : {}),
      });
    }
    expect(falInputs(videoRequest('video.long'), model, videoRefs, ctx)[0]).not.toHaveProperty('enable_thinking');
    expect(falInputs(videoRequest('video.reference'), model, { referenceUrls: [], referenceVideoUrls: videoRefs.referenceVideoUrls }, ctx)[0]).toMatchObject({ reference_video_urls: videoRefs.referenceVideoUrls });
  });
});

describe('required media resolution plan', () => {
  it.each(videoJobs)('requests only applicable media for %s', (job) => {
    const result = requiredMedia(videoRequest(job, { start: videoSettings.start, end: videoSettings.end }));
    expect(result).toEqual({
      ...(job === 'video.animate' || job === 'video.between' || job === 'video.reference' ? { start: videoSettings.start } : {}),
      ...(job === 'video.between' || job === 'video.reference' ? { end: videoSettings.end } : {}),
      keyframes: job === 'video.keyframes' ? videoSettings.keyframes!.map((pin) => pin.frame) : [],
      referenceImageIds: job === 'video.reference' ? videoSettings.referenceAssetIds : [], referenceVideoIds: [],
    });
    expect(result.referenceImageIds).not.toBe(videoSettings.referenceAssetIds);
  });

  it('omits unused Wan start/end references and preserves existing image reference resolution', () => {
    for (const model of [WAN_PRIME, WAN]) expect(requiredMedia({ ...videoRequest('video.reference'), model })).toEqual({ keyframes: [], referenceImageIds: videoSettings.referenceAssetIds, referenceVideoIds: [] });
    for (const job of ['image.edit', 'image.composite'] as const) expect(requiredMedia(request(job, { settings: { referenceAssetIds: ['one', 'two'] } }))).toEqual({ keyframes: [], referenceImageIds: ['one', 'two'], referenceVideoIds: [] });
    expect(requiredMedia(request('music.bed'))).toEqual({ keyframes: [], referenceImageIds: [], referenceVideoIds: [] });
  });
});

describe('video request validation', () => {
  it('accepts all new settings without changing the contract', () => {
    const raw = videoRequest('video.keyframes', { documentUrl: 'https://example.com/doc.pdf', webUrl: 'https://example.com/page' });
    expect(validateRequest(raw)).toEqual({ ok: true, value: raw });
    expect(validateRequest(videoRequest('video.reference', { start: { assetId: 'first' }, end: { projectFrame: 0 }, videoResolution: '1080p' })).ok).toBe(true);
  });

  it.each([
    [{ videoResolution: '768P' }, 'settings.videoResolution'],
    ...['start', 'end'].flatMap((key) => [null, {}, { assetId: '' }, { assetId: 7 }, { projectFrame: -1 }, { projectFrame: 0.5 }, { projectFrame: Infinity }, { assetId: 'one', projectFrame: 0 }, { projectFrame: 0, extra: true }].map((value) => [{ [key]: value }, `settings.${key}`])),
    [{ keyframes: [] }, 'settings.keyframes'], [{ keyframes: 'bad' }, 'settings.keyframes'],
    [{ keyframes: Array(11).fill({ frame: { projectFrame: 0 }, atSeconds: 0 }) }, 'settings.keyframes'],
    [{ keyframes: [null] }, 'settings.keyframes.0'],
    [{ keyframes: [{ frame: { projectFrame: -1 }, atSeconds: 0 }] }, 'settings.keyframes.0.frame'],
    ...[-1, NaN, Infinity, '1'].map((atSeconds) => [{ keyframes: [{ frame: { projectFrame: 0 }, atSeconds }] }, 'settings.keyframes.0.atSeconds']),
    ...['documentUrl', 'webUrl'].flatMap((key) => ['http://example.com', 'file:///tmp/file', 'bad', 'https://', 3, `https://example.com/${'a'.repeat(2000)}`].map((value) => [{ [key]: value }, `settings.${key}`])),
    [{ seed: 0.1 }, 'settings.seed'],
  ] as [Record<string, unknown>, string][])('rejects malformed new setting %#', (settings, path) => {
    expect(validateRequest({ ...request('video.generate'), settings })).toMatchObject({ ok: false, path });
  });

  it.each(videoJobs)('limits %s prompts to 5,000 characters', (job) => {
    expect(validateRequest(request(job, { prompt: 'a'.repeat(5000) })).ok).toBe(true);
    expect(validateRequest(request(job, { prompt: 'a'.repeat(5001) }))).toMatchObject({ ok: false, path: 'prompt' });
  });
});


describe('BF1 video routing and pricing regressions', () => {
  it.each([
    [FLUX_VIDEO, 10, 7, 0.0425, 0.0725, 0.17, 0.29],
    [H3, 9, 31, 0.052, 0.104, 0.08, 0.16],
    [TURBO, 9, 31, 0.026, 0.052, 0.04, 0.08],
  ] as const)('switches %s promotion after its inclusive local-date deadline', (model, month, day, lowPromo, highPromo, lowStandard, highStandard) => {
    for (const [resolution, promo, standard] of [['720p', lowPromo, lowStandard], ['1080p', highPromo, highStandard]] as const) {
      const req = videoRequest('video.generate', { durationSeconds: 5, videoResolution: resolution });
      const before = { ...ctx, now: new Date(2026, month, day, 23, 59, 59, 999).getTime() };
      const after = { ...ctx, now: new Date(2026, month, day + 1, 0).getTime() };
      expect(estimate(req, model, before).usd).toBeCloseTo(5 * promo, 4);
      expect(estimate(req, model, before).basis).toContain('promotional until');
      expect(estimate(req, model, after).usd).toBeCloseTo(5 * standard, 4);
      expect(estimate(req, model, after).basis).toContain('(standard)');
      const labels = modelsResponse('quality', after).jobs.find((j) => j.job === 'video.generate')!.models;
      expect(labels.find((m) => m.id === model)!.priceLabel).toContain(`$${highStandard} per second at 1080p`);
    }
  });
  it('retains all supplied 480p rates for future resolution controls', () => {
    expect(MODELS[H3].videoPrice).toMatchObject({ standard: { '480p': 0.05 }, promotion: { rates: { '480p': 0.0325 } } });
    expect(MODELS[TURBO].videoPrice).toMatchObject({ standard: { '480p': 0.025 }, promotion: { rates: { '480p': 0.01625 } } });
    expect(MODELS[WAN_PRIME].videoPrice?.standard['480p']).toBe(0.068);
    expect(MODELS[WAN].videoPrice?.standard['480p']).toBe(0.05);
    expect(MODELS[H3].referenceVideoRates?.['480p']).toBe(0.006);
  });
  const clips: RouteContext = { ...ctx, referenceAssetKinds: { a: 'video', b: 'video' }, referenceAssetSeconds: { a: 2, b: 4 } };
  it.each([[WAN_PRIME, '720p', 0.14], [WAN_PRIME, '1080p', 0.28], [WAN, '720p', 0.1], [WAN, '1080p', 0.2]] as const)('bills Wan input seconds per take for %s at %s', (model, videoResolution, rate) => {
    const req = { ...videoRequest('video.reference', { referenceAssetIds: ['a', 'b'], durationSeconds: 5, videoResolution }), takes: 2 };
    expect(estimate(req, model, clips).usd).toBeCloseTo((5 + 6) * rate * 2);
    expect(estimate(req, model, clips).basis).toContain('+ 6 s of reference clips');
  });
  it.each(['720p', '1080p'] as const)('adds the conservative H3 reference surcharge at %s', (videoResolution) => {
    const req = { ...videoRequest('video.reference', { referenceAssetIds: ['a', 'b'], durationSeconds: 5, videoResolution }), takes: 2 };
    expect(estimate(req, H3, clips).usd).toBeCloseTo((5 * (videoResolution === '720p' ? 0.08 : 0.16) + 6 * 0.08) * 2);
    expect(estimate(req, H3, clips).basis).toContain('+ 6 s of reference clips');
  });
  it('uses the same complete estimates for draft routing', () => {
    const req = videoRequest('video.reference', { referenceAssetIds: ['a', 'b'], durationSeconds: 5, videoResolution: '720p' });
    expect(route(req, 'draft', clips)).toMatchObject({ ok: true, decision: { model: H3 } });
    const withMoreInput = { ...clips, referenceAssetSeconds: { a: 7, b: 8 } };
    // H3 remains cheaper at this resolution even with its input surcharge.
    expect(route(req, 'draft', withMoreInput)).toMatchObject({ ok: true, decision: { model: H3 } });
    expect(route(videoRequest('video.generate'), 'draft', { ...ctx, livePrices: { [MODELS[FLUX_VIDEO].endpoints['video.generate']!]: { unit: 'seconds', unitPrice: 0 } } })).toMatchObject({ ok: true, decision: { model: TURBO } });
  });
  it.each(['video.between', 'video.keyframes'] as const)('drops minimum-duration lifts for exact-length %s jobs', (job) => {
    const req = videoRequest(job, { durationSeconds: 4, keyframes: [0, 2, 4].map((atSeconds) => ({ frame: { projectFrame: 0 }, atSeconds })) });
    expect(route(req, 'quality', ctx)).toMatchObject({ ok: true, decision: { model: H3, dropped: expect.arrayContaining([{ model: FLUX_VIDEO, why: 'makes at least 5 s; this clip must be 4 s' }]) } });
    expect(route({ ...req, settings: { ...req.settings, durationSeconds: 0.5 } }, 'quality', ctx)).toMatchObject({ ok: false, dropped: expect.arrayContaining([{ model: H3, why: 'makes at least 0.92 s; this clip must be 0.5 s' }]) });
  });
  it.each([[0.1, 2, 8], [0, 2, 7], [0, 0.01, 8], [0, 7.99, 8]])('rejects H3 pins that move boundaries or round the middle onto an end: %j', (...times) => {
    const req = { ...videoRequest('video.keyframes', { keyframes: times.map((atSeconds) => ({ frame: { projectFrame: 0 }, atSeconds })) }), model: H3 };
    expect(route(req, 'quality', ctx)).toMatchObject({ ok: false, error: expect.stringContaining('pins the first and last frames to the ends of the clip') });
  });
  it.each([[0, 2, 8], [1 / 24, 2, 8 - 1 / 24], [0, 2, 8 + 1 / 24]])('accepts H3 boundary pins within one frame: %j', (...times) => {
    const req = { ...videoRequest('video.keyframes', { keyframes: times.map((atSeconds) => ({ frame: { projectFrame: 0 }, atSeconds })) }), model: H3 };
    expect(route(req, 'quality', ctx).ok).toBe(true);
  });
  it.each([WAN_PRIME, WAN])('drops %s reference jobs with a chosen start or end', (model) => {
    for (const frame of ['start', 'end']) expect(route({ ...videoRequest('video.reference', { [frame]: { assetId: 'image' } }), model }, 'quality', ctx)).toMatchObject({ ok: false, error: expect.stringContaining("can't start or end on a chosen frame") });
  });
  it('never routes animate to Wan, including clips over twenty seconds', () => {
    expect(route(videoRequest('video.animate', { durationSeconds: 21 }), 'quality', ctx)).toMatchObject({ ok: false, dropped: expect.arrayContaining([{ model: WAN_PRIME, why: "can't start or end on a chosen frame" }]) });
  });
  it('omits empty H3 reference_image_urls for clips-only input', () => {
    const body = falInputs(videoRequest('video.reference'), H3, { referenceUrls: [], referenceVideoUrls: ['https://example.com/clip.mp4'] }, ctx)[0];
    expect(body).not.toHaveProperty('reference_image_urls');
    expect(body.reference_video_urls).toEqual(['https://example.com/clip.mp4']);
  });
  it('drops only H3 for clips shorter than two seconds', () => {
    const req = videoRequest('video.reference', { referenceAssetIds: ['a'] });
    expect(route(req, 'quality', { ...clips, referenceAssetSeconds: { a: 1.99 }, referenceAssetFps: { a: 16 } })).toMatchObject({ ok: true, decision: { model: WAN_PRIME, dropped: [{ model: H3, why: 'needs reference clips of at least 2 s' }] } });
    expect(route(req, 'quality', clips)).toMatchObject({ ok: true, decision: { model: H3 } });
  });
  it('drops only Wan for clips below sixteen fps', () => {
    const req = videoRequest('video.reference', { referenceAssetIds: ['a'] });
    expect(route(req, 'quality', { ...clips, referenceAssetFps: { a: 15.99 } })).toMatchObject({ ok: true, decision: { model: H3, dropped: [WAN_PRIME, WAN].map((model) => ({ model, why: 'needs reference clips of at least 16 fps' })) } });
    expect(route({ ...req, model: WAN_PRIME }, 'quality', { ...clips, referenceAssetFps: { a: 16 } }).ok).toBe(true);
  });
});

describe('Phase C scored music and narration', () => {
  const score = [{ sceneIds: ['intro'], seconds: 3.1234, styles: ['building'], label: 'Hook' }, { sceneIds: ['end'], seconds: 60, styles: [] }];
  it('maps a seeded composition plan without prompt-only fields and estimates its full length', () => {
    const req = request('music.scored', { prompt: ' warm, keys, ,drums, 4,5,6,7,8,9', takes: 2, settings: { score, bpm: 100, seed: 7, durationSeconds: 500, instrumental: false } });
    expect(route(req, 'quality', ctx)).toMatchObject({ ok: true, decision: { model: MUSIC, endpoint: 'elevenlabs/music/v2.5' } });
    const bodies = falInputs(req, MUSIC, refs, ctx);
    expect(bodies).toEqual([7, 8].map((seed) => ({ seed, composition_plan: { chunks: [
      { text: '[Hook]', duration_ms: 3123, positive_styles: ['warm', 'keys', 'drums', '4', '5', '6', '7', '8', 'building', '100 BPM', 'instrumental'], context_adherence: 'high' },
      { text: '[Section 2]', duration_ms: 60000, positive_styles: ['warm', 'keys', 'drums', '4', '5', '6', '7', '8', '100 BPM', 'instrumental'], context_adherence: 'high' },
    ] } })));
    expect(estimate(req, MUSIC, ctx)).toMatchObject({ usd: 1.2625, basis: expect.stringContaining('minutes') });
    expect(bodySceneIds(req)).toEqual([undefined, undefined]);
    expect(validateRequest(req).ok).toBe(true);
    expect(JOBS['music.scored']).toMatchObject({ label: 'Music scored to the cut' });
  });

  it.each([
    [undefined, 'settings.score'], [[], 'settings.score'], [Array(31).fill(score[0]), 'settings.score'],
    [[...score, { ...score[0], seconds: 2.999 }], 'settings.score[2].seconds'],
    [[{ ...score[0], seconds: 120.001 }], 'settings.score[0].seconds'],
    [[{ ...score[0], seconds: NaN }], 'settings.score[0].seconds'],
    [[{ ...score[0], seconds: Infinity }], 'settings.score[0].seconds'],
    [[...Array(5).fill({ ...score[0], seconds: 120 }), score[0]], 'settings.score[5].seconds'],
    [[{ ...score[0], sceneIds: [] }], 'settings.score[0].sceneIds'],
    [[{ ...score[0], styles: [1] }], 'settings.score[0].styles'],
    [[{ ...score[0], label: 1 }], 'settings.score[0].label'],
  ])('rejects malformed or out-of-range score plans %# with a field path', (score, path) => {
    const req = request('music.scored', { settings: { score } as JobSettings });
    expect(validateRequest(req)).toMatchObject({ ok: false, path });
    expect(route(req, 'quality', ctx)).toMatchObject({ ok: false, error: expect.stringContaining(path as string) });
    expect(() => falInputs(req, MUSIC, refs, ctx)).toThrow(path as string);
  });

  it('accepts chunk and total bounds and rejects totals after rounding to milliseconds', () => {
    for (const score of [Array(30).fill({ sceneIds: ['s'], seconds: 3, styles: [] }), Array(5).fill({ sceneIds: ['s'], seconds: 120, styles: [] })]) {
      expect(validateRequest(request('music.scored', { settings: { score } })).ok).toBe(true);
    }
    const score = Array(6).fill({ sceneIds: ['s'], seconds: 100.0006, styles: [] });
    expect(validateRequest(request('music.scored', { settings: { score } }))).toMatchObject({ ok: false, path: 'settings.score[5].seconds' });
  });

  it('fans narration into non-empty lines in scene order for each take, tagging and charging every body', () => {
    const req = request('voice.narration', { prompt: '', takes: 2, settings: { voice: 'Aria', languageCode: 'en', seed: 4, lines: [
      { sceneId: 'a', text: 'a'.repeat(1000) }, { sceneId: 'empty', text: '  ' }, { sceneId: 'b', text: 'b'.repeat(500) },
    ] } });
    expect(validateRequest(req)).toMatchObject({ ok: true });
    const bodies = falInputs(req, VOICE, refs, ctx);
    expect(bodies.map((body) => body.text)).toEqual(['a'.repeat(1000), 'b'.repeat(500), 'a'.repeat(1000), 'b'.repeat(500)]);
    expect(bodies.map((body) => body.seed)).toEqual([4, 5, 6, 7]);
    for (const body of bodies) expect(body).toMatchObject({ voice: 'Aria', language_code: 'en', timestamps: true });
    expect(bodySceneIds(req)).toEqual(['a', 'b', 'a', 'b']);
    expect(estimate(req, VOICE, ctx).usd).toBe(0.24);
    for (const body of bodies) expect(extractOutputs('voice.narration', { audio: { url: `https://example.com/${String(body.seed)}.mp3` } })).toHaveLength(1);
    expect(bodySceneIds(request('voice.narration', { takes: 2 }))).toEqual([undefined, undefined]);
    expect(bodySceneIds(request('image.generate', { takes: 4 }))).toEqual([undefined]);
  });

  it.each([
    [{ bpm: 0 }, 'settings.bpm'], [{ bpm: Infinity }, 'settings.bpm'],
    [{ lines: {} }, 'settings.lines'], [{ lines: [{}] }, 'settings.lines[0].sceneId'],
    [{ lines: [{ sceneId: 's', text: 1 }] }, 'settings.lines[0].text'],
    [{ lines: [{ sceneId: 's', text: 'a'.repeat(5001) }] }, 'settings.lines[0].text'],
    [{ lines: [{ sceneId: 's', text: ' ' }] }, 'settings.lines'],
  ])('validates tempo and narration lines %#', (settings, path) => {
    expect(validateRequest(request('voice.narration', { settings: settings as JobSettings }))).toMatchObject({ ok: false, path });
  });
});

describe('Phase C measured routing', () => {
  const suggestion = { job: 'image.generate' as const, from: GPT, to: SEEDREAM, kind: 'cheaper' as const, reason: 'Seedream keeps 60% at $0.11 per kept take instead of $0.82.' };
  it('uses capable accepted defaults for quality and balanced, preserving named choices and draft', () => {
    const context = { ...ctx, routeOverrides: { 'image.generate': SEEDREAM }, suggestions: [{ ...suggestion, to: FLUX }] };
    for (const policy of ['quality', 'balanced'] as const) expect(route(request(), policy, context)).toMatchObject({ ok: true, decision: { model: SEEDREAM, reason: 'your default (accepted suggestion)', overridden: false } });
    expect(route(request('image.generate', { model: GPT }), 'balanced', context)).toMatchObject({ ok: true, decision: { model: GPT, reason: 'your choice', overridden: true } });
    expect(route(request(), 'draft', context)).toEqual(route(request(), 'draft', ctx));
    expect(modelsResponse('quality', context).jobs.find((job) => job.job === 'image.generate')?.defaults).toMatchObject({ quality: SEEDREAM, balanced: SEEDREAM });
  });
  it('uses open suggestions only for balanced and falls back when overrides or suggestions cannot take the request', () => {
    const context = { ...ctx, suggestions: [suggestion] };
    expect(route(request(), 'balanced', context)).toMatchObject({ ok: true, decision: { model: SEEDREAM, reason: `balanced: ${suggestion.reason}` } });
    expect(route(request(), 'quality', context)).toMatchObject({ ok: true, decision: { model: GPT } });
    expect(route(request('image.generate', { settings: { resolution: '4k' } }), 'balanced', { ...context, routeOverrides: { 'image.generate': SEEDREAM } })).toMatchObject({ ok: true, decision: { model: GPT } });
    expect(route(request(), 'quality', { ...ctx, routeOverrides: { 'image.generate': 'missing' } })).toMatchObject({ ok: true, decision: { model: GPT } });
    expect(route(request(), 'balanced', { ...context, available: { [MODELS[SEEDREAM].endpoints['image.generate']!]: false } })).toMatchObject({ ok: true, decision: { model: GPT } });
    expect(modelsResponse('balanced', context).jobs.find((job) => job.job === 'image.generate')?.defaults).toMatchObject({ quality: GPT, balanced: SEEDREAM });
  });
});


it('allocates narration reservations by line length in take/body order', () => {
  const req = request('voice.narration', { prompt: '', takes: 2, settings: { lines: [{ sceneId: 'a', text: 'a'.repeat(4900) }, { sceneId: 'empty', text: ' ' }, { sceneId: 'b', text: 'b'.repeat(100) }] } });
  expect(bodyEstimates(req, VOICE, ctx)).toEqual([0.392, 0.008, 0.392, 0.008]);
  expect(bodyEstimates(req, VOICE, ctx).reduce((a, b) => a + b, 0)).toBeCloseTo(estimate(req, VOICE, ctx).usd, 10);
  const tiny = { ...req, settings: { lines: [{ sceneId: 'a', text: 'a' }, { sceneId: 'b', text: 'bb' }] } };
  expect(bodyEstimates(tiny, VOICE, ctx).every((amount) => amount >= 0)).toBe(true);
  expect(bodyEstimates(tiny, VOICE, ctx).reduce((a, b) => a + b, 0)).toBeCloseTo(estimate(tiny, VOICE, ctx).usd, 10);
  expect(bodyEstimates(request('image.generate', { takes: 3 }), GPT, ctx)).toEqual([1.5]);
});
it('validates narration line lengths independently of the unused aggregate prompt', () => {
  const req = request('voice.narration', { prompt: 'x'.repeat(6000), settings: { lines: [{ sceneId: 'a', text: 'a'.repeat(3000) }, { sceneId: 'b', text: 'b'.repeat(3000) }] } });
  expect(validateRequest(req).ok).toBe(true);
  expect(validateRequest({ ...req, prompt: '' }).ok).toBe(true);
  req.settings!.lines![1].text = 'x'.repeat(5001);
  expect(validateRequest(req)).toMatchObject({ ok: false, path: 'settings.lines[1].text' });
});
