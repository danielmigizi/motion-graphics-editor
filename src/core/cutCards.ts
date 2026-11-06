// Cut cards: one card per story beat (hook → proof → turn → cta), each a
// recipe over the editor's own templates with named copy slots. Picking four
// cards gives a real, editable draft at once, with no agent and no reference
// video. Nothing card-specific is stored in the document: a built card is
// plain template groups. Each card also says how it moves (mechanic), what the
// user has to supply to make it theirs (swap slots), where in a cut it belongs
// (position) and why it works, so an agent adapting it keeps the point.

import { applyCommand } from './commands';
import { newId as freshId } from './ids';
import { blankProject, DEFAULT_FORMAT, type ProjectFormat } from './newProject';
import { STYLE_PACKS, type StylePackId } from './style';
import { buildTemplate, templateParamError, type TemplateId, type TemplateParams } from './templates';
import type { Asset, Command, Element, ID, Project, StoryBeat, StoryBeatRole, StylePack } from './types';

export const CUT_BEATS = ['hook', 'proof', 'turn', 'cta'] as const;
export type CutBeat = (typeof CUT_BEATS)[number];

/** What each beat is for, in the words the picker shows. */
/** What each beat is for, in the picker's words. `noun` names one card of the beat ("an opener"). */
export const CUT_BEAT_INFO: Record<CutBeat, { label: string; noun: string; job: string; role: StoryBeatRole }> = {
  hook: { label: 'Open', noun: 'opener', job: 'Stop the scroll in two seconds', role: 'hook' },
  proof: { label: 'Show', noun: 'demo', job: 'The product, working', role: 'proof' },
  turn: { label: 'Shift', noun: 'shift', job: 'Before becomes after', role: 'turn' },
  cta: { label: 'Close', noun: 'closer', job: 'Your name and the next step', role: 'cta' },
};

/** text: one line; lines: several lines (\n); list: one item per line ("Title: line" where the card says so). */
export type CutSlotKind = 'text' | 'lines' | 'list' | 'stat' | 'name' | 'url';

export interface CutSlot {
  kind: CutSlotKind;
  /** One line: what goes here. */
  doc: string;
  /** Seed copy (a fictional product) used when the slot is not filled. */
  sample: string;
  /** Longest copy the layout holds at its designed size; longer copy shrinks or re-flows. */
  maxChars?: number;
}

/** What a site scrape or the user must supply for the card to be theirs. */
export type SwapSlot = 'text' | 'logo' | 'screenshot' | 'stat' | 'list' | 'quote';

export interface CutLayer {
  template: TemplateId;
  params: TemplateParams;
}

export interface CutCard {
  /** `<beat>.<kebab-name>`, stable: previews and saved cuts key on it. */
  id: string;
  beat: CutBeat;
  /** The motion idea in one line (the picker's caption). */
  name: string;
  /** What makes it work, so an agent adapting it keeps that. */
  why: string;
  /** Designed scene length. */
  seconds: number;
  mechanic: readonly string[];
  swapSlots: readonly SwapSlot[];
  position: 'opener' | 'closer' | 'floating';
  proofKind?: 'demo' | 'output' | 'feature_list' | 'social_proof';
  /** Style pack the preview is rendered in; a project's own style wins when the card is built. */
  look: StylePackId;
  slots: Readonly<Record<string, CutSlot>>;
  /** Templates to build, bottom first (a backdrop goes first). */
  layers(slots: Readonly<Record<string, string>>): CutLayer[];
}

export type CutSlotValues = Readonly<Record<string, string | undefined>>;

/** Card slots with the given copy over the samples; unknown names are refused rather than dropped. */
export function cutSlotValues(card: CutCard, given: CutSlotValues = {}): { ok: true; values: Record<string, string> } | { ok: false; message: string } {
  for (const name of Object.keys(given)) {
    if (!Object.prototype.hasOwnProperty.call(card.slots, name)) return { ok: false, message: `${card.id} has no slot "${name}". Its slots: ${Object.keys(card.slots).join(', ')}.` };
  }
  const values: Record<string, string> = {};
  for (const [name, slot] of Object.entries(card.slots)) {
    const v = given[name];
    values[name] = typeof v === 'string' && v.trim() ? v.trim() : slot.sample;
  }
  return { ok: true, values };
}

export interface BuildCutContext {
  project: Project;
  sceneId: ID;
  slots?: CutSlotValues;
  /** Also set the scene to the card's designed length (one updateScene first), unless that would cut short what the scene holds. */
  fitScene?: boolean;
  /** Element id factory (tests pass a deterministic one). */
  newId?: () => string;
}

export type BuildCutResult =
  | { ok: true; commands: Command[]; elements: Element[]; label: string; values: Record<string, string>; /** The scene's length once built. */ durationInFrames: number; note?: string }
  | { ok: false; message: string };

/**
 * Build a card into a scene: each layer is the template builder's own output
 * (style pack, assets, frame size and fps of the project), held to the cut.
 * Commands are not applied; run them as one batch.
 */
export function buildCut(card: CutCard, ctx: BuildCutContext): BuildCutResult {
  const filled = cutSlotValues(card, ctx.slots);
  if (!filled.ok) return filled;
  const found = ctx.project.scenes.find((s) => s.id === ctx.sceneId);
  if (!found) return { ok: false, message: `Scene ${ctx.sceneId} is not in the project.` };
  if (found.locked) return { ok: false, message: `Scene "${found.name}" is approved (locked); it cannot be changed.` };
  const fps = ctx.project.fps;
  const designed = Math.max(1, Math.round(card.seconds * fps));
  const commands: Command[] = [];
  let project = ctx.project;
  // Never cut short what the scene already holds: then the card holds to the scene's own cut.
  const occupied = Math.max(0, ...found.elements.filter((e) => !e.parentId).map((e) => e.startFrame + e.durationInFrames));
  const retime = ctx.fitScene === true && found.durationInFrames !== designed && occupied <= designed;
  if (retime) {
    commands.push({ type: 'updateScene', sceneId: found.id, changes: { durationInFrames: designed } });
    project = { ...project, scenes: project.scenes.map((s) => (s.id === found.id ? { ...s, durationInFrames: designed } : s)) };
  }
  const scene = project.scenes.find((s) => s.id === found.id)!;
  const elements: Element[] = [];
  for (const layer of card.layers(filled.values)) {
    const bad = templateParamError(layer.template, layer.params, project);
    if (bad) return { ok: false, message: `${card.id}: ${bad}` };
    const built = buildTemplate(layer.template, { ...layer.params, seconds: scene.durationInFrames / fps }, { sceneId: scene.id, at: 0, project, ...(ctx.newId ? { newId: ctx.newId } : {}) });
    if (!built.ok) return { ok: false, message: `${card.id}: ${built.message}` };
    commands.push(...built.commands);
    elements.push(...built.elements);
  }
  return { ok: true, commands, elements, label: `${CUT_BEAT_INFO[card.beat].label}: ${card.name}`, values: filled.values, durationInFrames: scene.durationInFrames, ...(ctx.fitScene && !retime && occupied > designed ? { note: `Scene kept at ${found.durationInFrames} frames: what it already holds runs to frame ${occupied}, past the card's ${designed}.` } : {}) };
}

/** The picker's one input: a web address (site), a description (idea), or nothing yet. */
export function cutInputKind(text: string): 'site' | 'idea' | 'none' {
  const t = text.trim();
  if (!t) return 'none';
  return /^(https?:\/\/)?([a-z0-9-]+\.)+[a-z]{2,}(\/\S*)?$/i.test(t) ? 'site' : 'idea';
}

/** `https://` in front of a bare address, for editor_scan_brand. */
export const siteUrl = (text: string) => (/^https?:\/\//i.test(text.trim()) ? text.trim() : `https://${text.trim()}`);

export interface CutHandOff {
  /** Slots already filled from the site, and what is still sample copy, by card id (cutFill.ts). */
  fill?: Readonly<Record<string, { fromSite: readonly string[]; missing: readonly string[] }>>;
  /** A brand kit already applied (style, fonts, logo): no rescan. */
  kit?: { name: string; url: string };
}

/**
 * The chat message that hands a filled cut to the agent: which card each scene
 * came from, the user's site or idea, and how to make it theirs (copy into the
 * slots, the card's motion kept) one reviewed scene at a time.
 */
export function cutBuildPrompt(project: Project, cards: readonly CutCard[], input: string, handOff: CutHandOff = {}): string {
  const kind = cutInputKind(input);
  const { fill, kit } = handOff;
  const scenes = cards.map((card, i) => {
    const scene = project.scenes[i];
    const f = fill?.[card.id];
    const state = f ? ` Filled from the site: ${f.fromSite.join(', ') || 'nothing'}.${f.missing.length ? ` Still sample facts, replace: ${f.missing.join(', ')}.` : ''}` : '';
    return `- ${CUT_BEAT_INFO[card.beat].label}: scene "${scene?.name}" (${scene?.id}) from card ${card.id} — ${card.name}. Keep: ${card.why}${state}`;
  });
  const about =
    kit
      ? [`The brand kit "${kit.name}" from ${kit.url} is already applied (colours, fonts, logo): do not rescan or restyle. Read the page if you need more copy.`]
      : kind === 'site'
      ? [`The product is at ${siteUrl(input)}. Scan it with editor_scan_brand (propose: true) so the look is theirs, and read the page for the product name, the claim, what it does, a number worth showing and the call to action.`]
      : kind === 'idea'
        ? [`Make it about: ${input.trim()}`]
        : ['Ask me what the product is before changing anything.'];
  return [
    fill
      ? `I picked a launch cut: ${cards.length} cut cards, one scene each, already filled with my site's own copy where it had some. Any sample fact left (numbers, people, the fictional product Brieflet) must not ship.`
      : `I picked a launch cut: ${cards.length} cut cards, one scene each. Every scene still shows the cards' sample copy for a fictional product (Brieflet).`,
    ...scenes,
    '',
    ...about,
    '',
    `Make it mine, one scene at a time: ${fill ? 'replace the sample facts first (ask me for a number or quote the site does not have, or rewrite the line without it), then sharpen the rest — ' : ''}rebuild each scene from its card with editor_build_cut { card, sceneId, slots } with my copy in every slot (the slot names are in editor_list_cut_cards), remove the scene's current top-level elements in the same patch before the new ones, then editor_preview_patch → editor_critique → editor_propose_patch. Keep each card's motion; change the copy, not the choreography. One story across the four: the hook's problem is what the turn flips and the proof shows. Then reply in two sentences.`,
  ].join('\n');
}

export interface CutDraftOptions {
  format?: ProjectFormat;
  /** The cut's look (default: the first card's preview pack). */
  style?: StylePack;
  name?: string;
  /** The story's one idea (default: the name). */
  idea?: string;
  /** Assets added before the cards are built (a brand logo: logo cards pick up the first SVG). */
  assets?: readonly Asset[];
  /** Slot copy per card id. */
  slots?: Readonly<Record<string, CutSlotValues>>;
  newId?: (prefix: 'prj' | 'scn' | 'el') => string;
}

/**
 * A whole project from cards, one scene per card in order, with the story
 * beats stamped onto the scenes. Used for previews (one card) and the picked
 * cut (four). Throws on a card that does not build: the catalog is code.
 */
export function cutDraftProject(cards: readonly CutCard[], opts: CutDraftOptions = {}): Project {
  if (!cards.length) throw new Error('A cut needs at least one card.');
  const id = opts.newId ?? freshId;
  const style = structuredClone(opts.style ?? STYLE_PACKS[cards[0].look]);
  const format = { ...(opts.format ?? DEFAULT_FORMAT), backgroundColor: style.colors.background };
  const base = blankProject({ project: id('prj'), scene: id('scn') }, format, opts.name ?? 'Launch cut');
  let project: Project = {
    ...base,
    style,
    assets: Object.fromEntries((opts.assets ?? []).map((a) => [a.id, a])),
    scenes: cards.map((card) => ({
      ...base.scenes[0],
      id: id('scn'),
      name: CUT_BEAT_INFO[card.beat].label,
      durationInFrames: Math.max(1, Math.round(card.seconds * format.fps)),
    })),
  };
  cards.forEach((card, i) => {
    const sceneId = project.scenes[i].id;
    const built = buildCut(card, { project, sceneId, slots: opts.slots?.[card.id], newId: () => id('el') });
    if (!built.ok) throw new Error(built.message);
    const applied = applyCommand(project, { type: 'batch', label: built.label, commands: built.commands }, { source: 'user' });
    if (!applied.ok) throw new Error(`${card.id}: ${applied.error.message}`);
    project = applied.project;
  });
  let frame = 0;
  const beats: StoryBeat[] = cards.map((card, i) => {
    const scene = project.scenes[i];
    const beat: StoryBeat = { role: CUT_BEAT_INFO[card.beat].role, summary: card.name, sceneId: scene.id, sceneName: scene.name, fromFrame: frame, toFrame: frame + scene.durationInFrames };
    frame += scene.durationInFrames;
    return beat;
  });
  const of = (beat: CutBeat) => cards.find((c) => c.beat === beat)?.name;
  project.story = {
    idea: opts.idea?.trim() || opts.name || 'Launch cut',
    hook: of('hook') ?? cards[0].name,
    payoff: of('proof') ?? of('turn') ?? cards[cards.length - 1].name,
    ...(of('turn') ? { tension: of('turn') } : {}),
    ...(of('cta') ? { cta: of('cta') } : {}),
    beats,
  };
  return project;
}
