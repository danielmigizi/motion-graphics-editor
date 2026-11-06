// "Start from a storyboard": picks (stored, shuffled, browsed), the stitched
// preview, and "Start editing" filling the open blank project in place and
// handing it to the agent. The local server is a fetch stub; no agent runs.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fixtureProject } from '../core/__fixtures__/fixtureProject';
import type { BrandKitRecord, ChatMessage, ChatState } from '../core/api-contract';
import { STYLE_PACKS } from '../core/style';
import { CUT_BEATS, cutBuildPrompt, cutInputKind } from '../core/cutCards';
import { cardsFor, cutCard } from '../core/cutCatalog';
import { createDocState } from '../core/history';
import { blankProject } from '../core/newProject';
import { validateProject } from '../core/validate';
import { useChat } from './chat';
import { clearAutosave } from './doc';
import { applyCut, cutPreviewProject, cutProjectName, cutStyle, dismissPicker, loadPicks, pickCard, pickedCards, randomPicks, shuffleBeat, useCutPicker, type CutPicks } from './firstCut';
import { useCreate } from './createFlow';
import { useLayout } from './layout';
import { useEditor } from './store';

const storage = new Map<string, string>();

it('the storyboard chat handoff dismisses the picker and opens chat before requesting focus', () => {
  useLayout.getState().setChatOpen(false);
  useCutPicker.setState({ dismissed: null, browse: 'hook' });
  const focus = useCreate.getState().composerFocus;
  dismissPicker();
  expect(useCutPicker.getState()).toMatchObject({ dismissed: useEditor.getState().docSession, browse: null });
  expect(useLayout.getState().chatOpen).toBe(true);
  expect(useCreate.getState().composerFocus).toBe(focus + 1);
});
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, v),
    removeItem: (k: string) => void storage.delete(k),
  },
});

const realFetch = globalThis.fetch;
let calls: { method: string; path: string; body: unknown }[] = [];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const chatState = (projectId: string): ChatState => ({ projectId, provider: 'claude', model: '', busy: false, messages: [] });
const sent = () => calls.filter((c) => c.path.endsWith('/messages')).map((c) => (c.body as { text: string }).text);

const KIT: BrandKitRecord = {
  id: 'kit_acme.dev',
  name: 'Acme Ledger',
  domain: 'acme.dev',
  url: 'https://acme.dev/',
  style: { ...STYLE_PACKS.paper, id: 'custom', name: 'Acme Ledger', colors: { ...STYLE_PACKS.paper.colors, accent: '#0E7C66' } },
  logoPath: 'assets/uploads/brand/acme.dev/logo.svg',
  copy: { url: 'https://acme.dev/', domain: 'acme.dev', product: 'Acme Ledger', headline: 'Close your books in a day', subhead: 'Acme Ledger reconciles every account overnight.', valueProps: [{ title: 'Automatic reconciliation' }], stat: { value: '4×', label: 'Teams close faster with Acme' }, cta: 'Start free' },
  savedAt: '2026-10-20T12:00:00.000Z',
};
/** What POST /api/brand-kits answers: a kit, or a scan failure. */
let scan: BrandKitRecord | null = null;

const PICKS: CutPicks = { hook: 'hook.big-number', proof: 'proof.cursor-click', turn: 'turn.before-after', cta: 'cta.typed-url' };
const BLANK = 'prj_blank';

beforeEach(() => {
  calls = [];
  scan = null;
  storage.clear();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body });
    if (method === 'PUT' && path.startsWith('/api/projects/')) return json({ ok: true, savedAt: '2026-10-20T12:00:00.000Z' });
    if (method === 'POST' && path === '/api/brand-kits') return scan ? json(scan) : json({ error: { code: 'INVALID', message: 'The site did not answer' } }, 502);
    const chat = /^\/api\/chat\/([^/]+)(\/\w+)?$/.exec(path);
    if (chat && chat[2] === '/messages') return json({ id: `m${calls.length}`, role: 'user', at: 1, status: 'queued', text: (body as { text: string }).text } satisfies ChatMessage);
    if (chat) return json(chatState(chat[1]));
    return json({ error: { code: 'NOT_FOUND', message: `no stub for ${method} ${path}` } }, 404);
  }) as typeof fetch;
  useEditor.getState().loadDocument(createDocState(blankProject({ project: BLANK, scene: 'scn_blank' })), { kind: 'new' });
  useEditor.setState({ toasts: [] });
  useChat.setState({ projectId: BLANK, confirmed: BLANK, messages: [], busy: false, provider: 'claude', model: '', providers: [] });
  useCutPicker.setState({ picks: { ...PICKS }, look: 'auto', browse: null, input: '', dismissed: null, using: false, stage: null, kits: [] });
});

afterEach(() => {
  globalThis.fetch = realFetch;
  clearAutosave();
});

describe('picks', () => {
  it('restores stored picks, and starts fresh when a stored id is gone or in the wrong beat', () => {
    expect(loadPicks(JSON.stringify(PICKS))).toEqual(PICKS);
    for (const stored of [JSON.stringify({ ...PICKS, hook: 'hook.gone' }), JSON.stringify({ ...PICKS, hook: 'cta.typed-url' }), '{not json', null]) {
      const picks = loadPicks(stored);
      for (const b of CUT_BEATS) expect(cutCard(picks[b])?.beat).toBe(b);
    }
  });

  it('draws one card of each beat at random', () => {
    expect(randomPicks(() => 0)).toEqual(Object.fromEntries(CUT_BEATS.map((b) => [b, cardsFor(b)[0].id])));
    expect(randomPicks(() => 0.999).hook).toBe(cardsFor('hook').at(-1)!.id);
  });

  it('shuffles to a different card of the same beat and stores the picks', () => {
    for (const r of [0, 0.5, 0.999]) {
      const before = useCutPicker.getState().picks.proof;
      shuffleBeat('proof', () => r);
      const after = useCutPicker.getState().picks.proof;
      expect(after).not.toBe(before);
      expect(cutCard(after)?.beat).toBe('proof');
    }
    expect(JSON.parse(storage.get('mge.cutPicker.v1')!).proof).toBe(useCutPicker.getState().picks.proof);
  });

  it('picks a browsed card into its own beat', () => {
    pickCard('turn.zero-stat');
    expect(useCutPicker.getState().picks).toEqual({ ...PICKS, turn: 'turn.zero-stat' });
    pickCard('nope');
    expect(useCutPicker.getState().picks.turn).toBe('turn.zero-stat');
  });
});

describe('stitched preview', () => {
  it('is one valid project in the open format, in the hook card’s look unless one is chosen', () => {
    const project = cutPreviewProject(PICKS, 'auto', { width: 1080, height: 1920, fps: 30, backgroundColor: '#000000' });
    expect(validateProject(project).ok).toBe(true);
    expect([project.width, project.height]).toEqual([1080, 1920]);
    expect(project.scenes.map((s) => s.name)).toEqual(['Open', 'Show', 'Shift', 'Close']);
    expect(project.style?.id).toBe(cutCard(PICKS.hook)!.look);
    expect(cutStyle(PICKS, 'editorial').id).toBe('editorial');
    // Same picks, same ids: the Player gets an equal project on every render.
    expect(cutPreviewProject(PICKS, 'auto', { width: 1080, height: 1920, fps: 30, backgroundColor: '#000000' })).toEqual(project);
  });
});

describe('the input', () => {
  it('reads a web address as a site and anything else as an idea', () => {
    expect(cutInputKind('')).toBe('none');
    expect(cutInputKind('  acme.dev ')).toBe('site');
    expect(cutInputKind('https://www.acme.dev/pricing')).toBe('site');
    expect(cutInputKind('A budgeting app for students')).toBe('idea');
    expect(cutProjectName('https://www.acme.dev/pricing')).toBe('acme.dev');
    expect(cutProjectName('A budgeting app')).toBe('Launch cut');
  });

  it('hands the agent each scene’s card, the site, and how to make it theirs', () => {
    const project = cutPreviewProject(PICKS, 'auto', { width: 1920, height: 1080, fps: 30, backgroundColor: '#000000' });
    const prompt = cutBuildPrompt(project, pickedCards(PICKS), 'acme.dev');
    for (const [i, id] of Object.values(PICKS).entries()) {
      expect(prompt).toContain(id);
      expect(prompt).toContain(project.scenes[i].id);
    }
    expect(prompt).toContain('https://acme.dev');
    expect(prompt).toContain('editor_scan_brand');
    expect(prompt).toContain('editor_build_cut');
    expect(cutBuildPrompt(project, pickedCards(PICKS), 'A budgeting app for students')).toContain('Make it about: A budgeting app for students');
  });
});

describe('Start editing', () => {
  it('fills the open blank project in place, saves it, and hands it to the agent', async () => {
    useCutPicker.setState({ input: 'acme.dev' });
    expect(await applyCut()).toBe(true);
    const { project } = useEditor.getState().doc;
    expect(project.id).toBe(BLANK);
    expect(project.name).toBe('acme.dev');
    expect(project.scenes.map((s) => s.name)).toEqual(['Open', 'Show', 'Shift', 'Close']);
    expect(project.story?.beats.map((b) => b.role)).toEqual(['hook', 'proof', 'turn', 'cta']);
    expect(validateProject(project).ok).toBe(true);
    expect(calls.some((c) => c.method === 'PUT' && c.path === `/api/projects/${BLANK}`)).toBe(true);
    expect(sent()).toHaveLength(1);
    expect(sent()[0]).toContain('https://acme.dev');
    expect(useCutPicker.getState().input).toBe('');
    // The project has content now: a second use does nothing.
    expect(await applyCut()).toBe(false);
  });

  it('keeps the sample copy and asks nothing of the agent without a site or idea', async () => {
    expect(await applyCut()).toBe(true);
    expect(useEditor.getState().doc.project.name).toBe('Launch cut');
    expect(sent()).toEqual([]);
    expect(useEditor.getState().toasts.at(-1)?.hint).toContain('Tell');
  });

  it('never replaces a project that already has work in it', async () => {
    useEditor.getState().loadDocument(createDocState(structuredClone(fixtureProject)), { kind: 'server', id: fixtureProject.id });
    expect(await applyCut()).toBe(false);
    expect(useEditor.getState().doc.project.id).toBe(fixtureProject.id);
  });
});

describe('Start editing with a website', () => {
  it('scans and saves the site as a brand kit, dresses the cut in it and fills the slots with its copy', async () => {
    scan = KIT;
    useCutPicker.setState({ input: 'acme.dev' });
    expect(await applyCut()).toBe(true);
    expect(calls.find((c) => c.path === '/api/brand-kits')?.body).toEqual({ url: 'https://acme.dev' });
    const { project } = useEditor.getState().doc;
    expect(project.name).toBe('Acme Ledger');
    expect(project.style?.colors.accent).toBe('#0E7C66');
    expect(Object.values(project.assets)).toEqual([expect.objectContaining({ kind: 'svg', src: KIT.logoPath })]);
    const texts = project.scenes.flatMap((s) => s.elements.map((e) => e.props.text));
    expect(texts).toEqual(expect.arrayContaining(['4×', 'Teams close faster with Acme']));
    expect(texts.some((t) => typeof t === 'string' && /brieflet/i.test(t))).toBe(false);
    expect(validateProject(project).ok).toBe(true);
    // The kit is listed for the next video.
    expect(useCutPicker.getState().kits.map((k) => k.id)).toEqual(['kit_acme.dev']);
    expect(sent()[0]).toContain('brand kit "Acme Ledger"');
    expect(sent()[0]).toContain('Filled from the site');
    expect(sent()[0]).not.toContain('editor_scan_brand');
    expect(useEditor.getState().toasts.at(-1)?.message).toMatch(/lines from acme.dev/);
  });

  it('still builds from the sample when the site cannot be read, and leaves the scan to the agent', async () => {
    useCutPicker.setState({ input: 'acme.dev' });
    expect(await applyCut()).toBe(true);
    expect(useEditor.getState().doc.project.name).toBe('acme.dev');
    expect(useEditor.getState().toasts.at(-1)).toMatchObject({ tone: 'info', message: expect.stringContaining('Could not read acme.dev') });
    expect(sent()[0]).toContain('editor_scan_brand');
  });

  it('reuses a saved kit picked as the look without fetching the site again', async () => {
    useCutPicker.setState({ kits: [KIT], look: 'kit:kit_acme.dev' });
    const preview = cutPreviewProject(PICKS, 'kit:kit_acme.dev', { width: 1920, height: 1080, fps: 30, backgroundColor: '#000000' }, [KIT]);
    expect(preview.scenes[0].elements.map((e) => e.props.text)).toContain('4×');
    expect(await applyCut()).toBe(true);
    expect(calls.some((c) => c.path === '/api/brand-kits')).toBe(false);
    expect(useEditor.getState().doc.project.style?.colors.accent).toBe('#0E7C66');
    expect(sent()[0]).toContain('https://acme.dev/');
  });
});
