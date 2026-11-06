// "Start from a storyboard": the open blank project's stage shows four beat
// slots (hook → proof → turn → cta), each a cut card that can be shuffled or
// browsed, a live stitched preview of the cut, and one input for the user's
// website or idea. "Start editing" fills the blank project in place with the
// cut (same id, so its chat and server record stay, like an approved outline
// in createFlow.ts) and hands it to the chat's agent to make it theirs.
// The picks are a per-browser convenience (localStorage), never in a document.

import { create } from 'zustand';
import type { BrandKitRecord } from '../core/api-contract';
import { logoAssetFromPath } from '../core/brand-kit';
import { CUT_BEATS, cutBuildPrompt, cutDraftProject, cutInputKind, siteUrl, type CutBeat, type CutCard } from '../core/cutCards';
import { fillCut } from '../core/cutFill';
import { cardsFor, cutCard } from '../core/cutCatalog';
import { createDocState } from '../core/history';
import { newId } from '../core/ids';
import { formatOf, isUntouched } from '../core/newProject';
import { STYLE_PACK_IDS, STYLE_PACKS, type StylePackId } from '../core/style';
import type { Asset, Project, StylePack } from '../core/types';
import { validateProject } from '../core/validate';
import { api, errorText } from './api';
import { agentName, requestComposerFocus } from './createFlow';
import { sendChat } from './chat';
import { writeAutosave } from './doc';
import { saveToServer } from './persistence';
import { useEditor } from './store';

export type CutPicks = Record<CutBeat, string>;
/** 'auto': the hook card's own look; `kit:<id>`: a saved brand kit (its style, logo and site copy). */
export type CutLook = StylePackId | 'auto' | `kit:${string}`;

interface CutPickerState {
  picks: CutPicks;
  look: CutLook;
  /** The beat whose cards the browse dialog shows, or null when it is closed. */
  browse: CutBeat | null;
  /** The user's website or idea. */
  input: string;
  /** The document session the user chose "Describe it instead" for: its stage goes back to the editor. */
  dismissed: string | null;
  using: boolean;
  /** What a running Use this cut is doing, for the button. */
  stage: 'scanning' | 'building' | null;
  /** Saved brand kits (the server's brand-kits/), newest first. */
  kits: BrandKitRecord[];
}

const STORAGE_KEY = 'mge.cutPicker.v1';

/** One random card per beat. */
export function randomPicks(rand: () => number = Math.random): CutPicks {
  return Object.fromEntries(CUT_BEATS.map((b) => {
    const cards = cardsFor(b);
    return [b, cards[Math.floor(rand() * cards.length) % cards.length].id];
  })) as CutPicks;
}

/** Saved picks when every id is still a card of its beat; otherwise a fresh random cut. */
export function loadPicks(stored: string | null): CutPicks {
  try {
    const p = stored ? (JSON.parse(stored) as Partial<CutPicks>) : null;
    if (p && CUT_BEATS.every((b) => cutCard(String(p[b]))?.beat === b)) return p as CutPicks;
  } catch {
    // Unreadable storage: start fresh.
  }
  return randomPicks();
}

function readStored(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function store(picks: CutPicks, look: CutLook) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(picks));
    localStorage.setItem(`${STORAGE_KEY}.look`, look);
  } catch {
    // Private window or blocked storage: the picks just won't survive a reload.
  }
}

function storedLook(): CutLook {
  try {
    const v = localStorage.getItem(`${STORAGE_KEY}.look`);
    return v && ((STYLE_PACK_IDS as string[]).includes(v) || v.startsWith('kit:')) ? (v as CutLook) : 'auto';
  } catch {
    return 'auto';
  }
}

export const useCutPicker = create<CutPickerState>()(() => ({
  picks: loadPicks(readStored()),
  look: storedLook(),
  browse: null,
  input: '',
  dismissed: null,
  using: false,
  stage: null,
  kits: [],
}));

const set = useCutPicker.setState;
const get = useCutPicker.getState;

/** The picked cards in beat order. */
export const pickedCards = (picks: CutPicks): CutCard[] => CUT_BEATS.map((b) => cutCard(picks[b])!);

export function pickCard(id: string) {
  const card = cutCard(id);
  if (!card) return;
  const picks = { ...get().picks, [card.beat]: id };
  set({ picks });
  store(picks, get().look);
}

/** Another card for one beat (never the same one). */
export function shuffleBeat(beat: CutBeat, rand: () => number = Math.random) {
  const others = cardsFor(beat).filter((c) => c.id !== get().picks[beat]);
  pickCard(others[Math.floor(rand() * others.length) % others.length].id);
}

export function shuffleAll(rand: () => number = Math.random) {
  for (const b of CUT_BEATS) shuffleBeat(b, rand);
}

export function setLook(look: CutLook) {
  set({ look });
  store(get().picks, look);
}

export const openBrowse = (beat: CutBeat) => set({ browse: beat });
export const closeBrowse = () => set({ browse: null });
export const setCutInput = (input: string) => set({ input });

/** "Describe it instead": the stage goes back to the editor and the chat composer takes focus. */
export function dismissPicker() {
  set({ dismissed: useEditor.getState().docSession, browse: null });
  requestComposerFocus();
}

/** The saved kits, for the Look menu (quietly none while the server is down). */
export async function loadBrandKits(): Promise<void> {
  try {
    set({ kits: await api.listBrandKits() });
  } catch {
    // Offline: packs only.
  }
}

/** The brand kit a look names, if it is still saved. */
export const kitOf = (look: CutLook, kits: readonly BrandKitRecord[]): BrandKitRecord | undefined => (look.startsWith('kit:') ? kits.find((k) => `kit:${k.id}` === look) : undefined);

/** The cut's style: a brand kit's, the chosen pack, or the hook card's own look. */
export function cutStyle(picks: CutPicks, look: CutLook, kits: readonly BrandKitRecord[] = []): StylePack {
  const kit = kitOf(look, kits);
  if (kit) return kit.style;
  return STYLE_PACKS[look === 'auto' || look.startsWith('kit:') ? cutCard(picks.hook)!.look : (look as StylePackId)];
}

/** A kit's logo as a project asset. SVG only: an image would be taken for a screenshot by the product cards. */
export function brandAssets(kit: BrandKitRecord | undefined, id: () => string = () => newId('ast')): Asset[] {
  if (!kit?.logoPath || !/\.svg$/i.test(kit.logoPath)) return [];
  const asset = logoAssetFromPath(id(), kit.logoPath, `${kit.name} logo`);
  return asset ? [asset as Asset] : [];
}

/** The picks as a whole project in the open project's format (the stitched preview; ids are stable per call). */
export function cutPreviewProject(picks: CutPicks, look: CutLook, format: ReturnType<typeof formatOf>, kits: readonly BrandKitRecord[] = []): Project {
  let n = 0;
  const cards = pickedCards(picks);
  const kit = kitOf(look, kits);
  // A brand kit's preview is already theirs: its logo and its site's copy in the slots.
  return cutDraftProject(cards, { format, style: cutStyle(picks, look, kits), assets: brandAssets(kit, () => 'ast_preview_logo'), ...(kit?.copy ? { slots: fillCut(cards, kit.copy).slots } : {}), newId: (prefix) => `${prefix}_preview_${++n}` });
}

/** The project name the input suggests: a site's host, else "Launch cut". */
export function cutProjectName(input: string): string {
  if (cutInputKind(input) !== 'site') return 'Launch cut';
  const host = input.trim().replace(/^https?:\/\//i, '').split('/')[0].replace(/^www\./i, '');
  return host || 'Launch cut';
}

/**
 * "Start editing": the open blank project becomes the cut, in place (same id,
 * so its chat and server record stay), saved, then handed to the chat's agent
 * to make it theirs. A website is scanned first and saved as a brand kit: its
 * style and logo dress the cut, and its own copy fills the cards' slots
 * (cutFill.ts), so the draft is in the user's words before any agent runs.
 * A saved kit picked as the Look does the same without fetching again.
 */
export async function applyCut(): Promise<boolean> {
  const st = useEditor.getState();
  const open = st.doc.project;
  const { picks, look, input, using, kits } = get();
  if (using || !isUntouched(open)) return false;
  const session = st.docSession;
  set({ using: true, stage: 'building' });
  try {
    const cards = pickedCards(picks);
    const kind = cutInputKind(input);
    let kit = kitOf(look, kits);
    let scanFailed: string | null = null;
    if (kind === 'site' && kit?.domain !== domainOf(input)) {
      set({ stage: 'scanning' });
      try {
        kit = await api.saveBrandKit({ url: siteUrl(input) });
        const saved = kit;
        set({ kits: [saved, ...get().kits.filter((k) => k.id !== saved.id)] });
      } catch (e) {
        kit = undefined;
        scanFailed = errorText(e).message;
      }
      set({ stage: 'building' });
      // The user opened something else, or started work here, while the site was read.
      if (useEditor.getState().docSession !== session || !isUntouched(useEditor.getState().doc.project)) return false;
    }
    const fill = kit?.copy && kind !== 'idea' ? fillCut(cards, kit.copy) : undefined;
    // A kit dresses the cut unless the user chose a pack for it.
    const style = kit && (look === 'auto' || look.startsWith('kit:')) ? kit.style : cutStyle(picks, look, kits);
    const draft = cutDraftProject(cards, {
      format: formatOf(open),
      style,
      name: kit?.name ?? cutProjectName(input),
      idea: kind === 'idea' ? input : undefined,
      assets: brandAssets(kit),
      ...(fill ? { slots: fill.slots } : {}),
      newId,
    });
    const project: Project = { ...draft, id: open.id, revision: open.revision + 1 };
    const valid = validateProject(project);
    if (!valid.ok) {
      st.toast({ tone: 'error', message: `Could not build the cut: ${valid.error.message}`, path: valid.error.path, hint: valid.error.hint });
      return false;
    }
    st.loadDocument(createDocState(project), st.origin.kind === 'server' ? st.origin : { kind: 'new' });
    // Dirty until the save lands, so browser recovery and the autosave cover it meanwhile.
    useEditor.setState({ cleanRevision: open.revision });
    const filled = useEditor.getState().docSession;
    const stillOpen = () => useEditor.getState().docSession === filled;
    await saveToServer({ quiet: true, canonical: true });
    if (stillOpen() && useEditor.getState().doc.project.revision !== useEditor.getState().cleanRevision) writeAutosave(useEditor.getState().doc, filled);
    set({ input: '' });

    const name = agentName();
    const handOff = kind !== 'none' || !!kit;
    const sent = handOff && stillOpen() && (await sendChat(cutBuildPrompt(project, cards, kind === 'none' && kit ? kit.url : input, { ...(fill ? { fill: fill.report } : {}), ...(kit ? { kit: { name: kit.name, url: kit.url } } : {}) }), []));
    const fromSite = fill ? Object.values(fill.report).reduce((n, f) => n + f.fromSite.length, 0) : 0;
    const toReplace = fill ? Object.values(fill.report).reduce((n, f) => n + f.missing.length, 0) : 0;
    useEditor.getState().toast({
      tone: scanFailed ? 'info' : 'success',
      message: scanFailed
        ? `Could not read ${domainOf(input)} (${scanFailed}); “${project.name}” starts from the sample copy.`
        : fill
          ? `“${project.name}” is your cut: ${fromSite} lines from ${kit!.domain}${toReplace ? `, ${toReplace} sample ${toReplace === 1 ? 'fact' : 'facts'} still to replace` : ''}.`
          : `“${project.name}” is your cut: ${project.scenes.length} scenes, ready to play.`,
      hint: sent ? `${name} is making it yours; review each scene’s proposal as it arrives.` : `Tell ${name} in the chat about your product to make it yours.`,
    });
    return true;
  } finally {
    set({ using: false, stage: null });
  }
}

/** The host a site input names, without www. */
export const domainOf = (input: string) => input.trim().replace(/^https?:\/\//i, '').split('/')[0].replace(/^www\./i, '').toLowerCase();
