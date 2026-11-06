// editor_build_template / editor_build_motion / editor_build_cut: the Insert
// menu's templates, motion presets and cut cards as ready patch commands
// against the live project. Pure: they
// read a project and return commands; nothing is applied or proposed. The
// commands come from the same core builders the editor runs (buildTemplate,
// presetCommands, applyStagger, followThroughCommands, matchCutCommands), and
// are checked with checkPatch before they are handed back.

import { buildCut, CUT_BEAT_INFO, CUT_BEATS, type CutBeat } from '../src/core/cutCards';
import { cardsFor, cutCard } from '../src/core/cutCatalog';
import { createDocState } from '../src/core/history';
import { checkPatch } from '../src/core/patch';
import { applyStagger, defaultPresetOptions, followThroughCommands, matchCutCommands, normalizeOptions, PRESET_IDS, PRESET_KIND_LABELS, PRESETS, presetAppliesTo, presetCommands, staggerTargets, type FollowFrom, type PresetId } from '../src/core/presets';
import { staggerFor, type StaggerOrder } from '../src/core/motionRules';
import { buildTemplate, templateParamError, templateParamLines, TEMPLATE_IDS, TEMPLATES, type TemplateId, type TemplateParams } from '../src/core/templates';
import { PATCH_PROTOCOL } from '../src/core/types';
import type { AiPatch, Command, Element, Project, Scene } from '../src/core/types';

export const MOTION_IDS = [...PRESET_IDS, 'arriveApart', 'followThrough', 'matchCut'] as const;
export type MotionId = (typeof MOTION_IDS)[number];

/** Ready-to-send editor_propose_patch arguments (plus what they build), or a plain error. */
export type BuildResult =
  | { ok: true; patch: { baseRevision: number; summary: string; targets: AiPatch['targets']; commands: Command[] }; lines: string[]; elementIds: string[] }
  | { ok: false; message: string };

export interface TemplateArgs {
  template: TemplateId;
  params?: Record<string, unknown>;
  sceneId: string;
  /** Scene frame the template starts at (default 0). */
  at?: number;
  parentId?: string;
}

export interface MotionArgs {
  preset: MotionId;
  sceneId: string;
  elementIds: string[];
  opts?: { at?: number; duration?: number; intensity?: number; preset?: PresetId; stagger?: number; order?: StaggerOrder; from?: FollowFrom };
  intoSceneId?: string;
  intoElementId?: string;
}

const fail = (message: string): BuildResult => ({ ok: false, message });

function lockedScene(project: Project, sceneId: string): { scene: Scene } | { error: string } {
  const scene = project.scenes.find((s) => s.id === sceneId);
  if (!scene) return { error: `Scene ${sceneId} is not in the project. Scenes: ${project.scenes.map((s) => `${s.id} "${s.name}"`).join(', ')}.` };
  if (scene.locked) return { error: `Scene "${scene.name}" (${scene.id}) is approved (locked); it cannot be changed. Ask the user to unlock it.` };
  return { scene };
}

/** Validate the commands like the editor will (scope, locks, document rules) before handing them back. */
function checked(project: Project, summary: string, targets: AiPatch['targets'], commands: Command[], lines: string[], elementIds: string[]): BuildResult {
  const patch = { baseRevision: project.revision, summary, targets, commands };
  const r = checkPatch(createDocState(project), { protocol: PATCH_PROTOCOL, projectId: project.id, ...patch }, { reconcile: true });
  if (!r.ok) return fail([`The built commands do not validate: [${r.error.code}] ${r.error.message}`, r.error.path && `at ${r.error.path}`, r.error.hint].filter(Boolean).join('\n'));
  return { ok: true, patch, lines, elementIds };
}

const frames = (a: number, b: number) => (b > a ? `${a}–${b}` : `${a}`);

/** One line per element: id, type, name, text, timing and what moves. */
function partLine(e: Element, sceneStart: number): string {
  const flat = typeof e.props.text === 'string' ? e.props.text.replace(/\s*\n\s*/g, ' / ') : null;
  const text = flat !== null ? ` “${flat.length > 60 ? `${flat.slice(0, 57)}…` : flat}”` : '';
  const t = e.transform;
  const moves = [...e.tracks.map((tr) => tr.property), ...(e.propTracks ?? []).map((tr) => tr.key)];
  const reveal = typeof e.props.reveal === 'string' && e.props.reveal !== 'none' ? `, reveal ${e.props.reveal}` : '';
  return `- ${e.id} ${e.type} "${e.name}"${text}: scene frames ${frames(sceneStart, sceneStart + e.durationInFrames - 1)}, box ${t.x},${t.y} ${t.width}×${t.height}${moves.length ? `, keys ${[...new Set(moves)].join(' ')}` : ''}${reveal}`;
}

/** A template built against the live project: same builder, style pack, assets, size and fps as Insert. */
export function buildTemplateCommands(project: Project, args: TemplateArgs, newId?: () => string): BuildResult {
  const def = TEMPLATES[args.template];
  if (!def) return fail(`Unknown template "${args.template}". Templates: ${TEMPLATE_IDS.join(', ')}.`);
  const found = lockedScene(project, args.sceneId);
  if ('error' in found) return fail(found.error);
  const { scene } = found;
  const params = args.params ?? {};
  const bad = templateParamError(args.template, params, project);
  if (bad) return fail(bad);
  const at = args.at ?? 0;
  if (!Number.isInteger(at) || at < 0 || at >= scene.durationInFrames) return fail(`at must be a scene frame from 0 to ${scene.durationInFrames - 1} (scene "${scene.name}" is ${scene.durationInFrames} frames).`);
  // Agents build whole scenes: hold to the cut (the scene's or the group's end) unless `seconds` says otherwise.
  const built = buildTemplate(args.template, { seconds: (scene.durationInFrames - at) / project.fps, ...(params as TemplateParams) }, { sceneId: scene.id, at, project, ...(args.parentId !== undefined ? { parentId: args.parentId } : {}), ...(newId ? { newId } : {}) });
  if (!built.ok) return fail(built.message);
  const [group, ...children] = built.elements;
  const groupStart = at;
  const end = groupStart + group.durationInFrames;
  const lines = [
    `${def.label} for scene "${scene.name}" (${scene.id}), scene frames ${frames(groupStart, end - 1)} of 0–${scene.durationInFrames - 1}: ${built.elements.length} elements, group ${group.id}${args.parentId ? ` inside ${args.parentId}` : ''}. Children's boxes are relative to the group's top-left; their keys to their own start.`,
    partLine(group, groupStart),
    ...children.map((c) => partLine(c, groupStart + c.startFrame)),
  ];
  if (end < scene.durationInFrames && !args.parentId) lines.push(`Note: it ends at scene frame ${end - 1}, before the cut at ${scene.durationInFrames}: the scene is empty after that unless something else holds it.`);
  return checked(project, `${def.label}: ${scene.name}`, [{ sceneId: scene.id }], built.commands, lines, built.elements.map((e) => e.id));
}

export interface CutArgs {
  card: string;
  sceneId: string;
  slots?: Record<string, string>;
  /** Also set the scene to the card's designed length (default true). */
  fitScene?: boolean;
}

/** A cut card built into a scene: its templates with the slot copy, against the live project and its style. */
export function buildCutCommands(project: Project, args: CutArgs, newId?: () => string): BuildResult {
  const card = cutCard(args.card);
  if (!card) return fail(`Unknown cut card "${args.card}". List them with editor_list_cut_cards.`);
  const found = lockedScene(project, args.sceneId);
  if ('error' in found) return fail(found.error);
  const { scene } = found;
  const built = buildCut(card, { project, sceneId: scene.id, slots: args.slots, fitScene: args.fitScene ?? true, ...(newId ? { newId } : {}) });
  if (!built.ok) return fail(built.message);
  const length = built.durationInFrames;
  const lines = [
    `${built.label} — card ${card.id} in scene "${scene.name}" (${scene.id}), ${length} frames${length !== scene.durationInFrames ? ` (scene retimed from ${scene.durationInFrames})` : ''}: ${built.elements.length} elements. Keep what makes it work: ${card.why}`,
    ...(built.note ? [`Note: ${built.note}`] : []),
    `Slots: ${Object.entries(built.values).map(([k, v]) => `${k} = “${v.replace(/\n/g, ' / ')}”`).join('; ')}.`,
    ...built.elements.map((e) => partLine(e, e.parentId ? (built.elements.find((g) => g.id === e.parentId)?.startFrame ?? 0) + e.startFrame : e.startFrame)),
  ];
  return checked(project, `${CUT_BEAT_INFO[card.beat].label} card: ${scene.name}`, [{ sceneId: scene.id }], built.commands, lines, built.elements.map((e) => e.id));
}

/** The catalog (or one beat of it) as tool text: id, length, the motion idea, slots with samples, what to swap. */
export function cutCardsText(beat?: CutBeat): string {
  const beats = beat ? [beat] : [...CUT_BEATS];
  return [
    'Cut cards: one per beat makes a cut (hook → proof → turn → cta). Build one into a scene with editor_build_cut { card, sceneId, slots }; it retimes the scene to the card unless fitScene is false. Slots not given keep the sample copy (a fictional product, Brieflet): replace every one with the user’s copy.',
    ...beats.flatMap((b) => [
      '',
      `## ${CUT_BEAT_INFO[b].label} (${b}): ${CUT_BEAT_INFO[b].job}`,
      ...cardsFor(b).map((c) => `- ${c.id} (${c.seconds} s, ${c.position}${c.proofKind ? `, ${c.proofKind}` : ''}; ${c.mechanic.join(', ')}): ${c.name}. Why: ${c.why} Slots: ${Object.entries(c.slots).map(([k, s]) => `${k} (${s.kind}${s.maxChars ? ` ≤${s.maxChars}` : ''}) “${s.sample.replace(/\n/g, ' / ')}”`).join('; ')}. Swap: ${c.swapSlots.join(', ')}.`),
    ]),
  ].join('\n');
}

/** Motion presets, arrive apart, follow-through and match cuts as commands against the live project and its style. */
export function buildMotionCommands(project: Project, args: MotionArgs): BuildResult {
  const found = lockedScene(project, args.sceneId);
  if ('error' in found) return fail(found.error);
  const { scene } = found;
  const o = args.opts ?? {};
  const motion = project.style?.motion;
  const fps = project.fps;
  const ids = [...new Set(args.elementIds)];
  if (!ids.length) return fail('elementIds must name at least one element.');
  const missing = ids.find((id) => !scene.elements.some((e) => e.id === id));
  if (missing) return fail(`Element ${missing} is not in scene "${scene.name}". Its elements: ${scene.elements.map((e) => `${e.id} "${e.name}" (${e.type})`).join(', ') || 'none'}.`);
  const elements = ids.map((id) => scene.elements.find((e) => e.id === id)!);
  const sceneTarget = [{ sceneId: scene.id }];

  if (args.preset === 'arriveApart') {
    const presetId = o.preset ?? 'riseIn';
    if (!PRESETS[presetId]) return fail(`Unknown preset "${presetId}" for arriveApart. Presets: ${PRESET_IDS.join(', ')}.`);
    const targets = staggerTargets(scene, { elementId: ids.length === 1 ? ids[0] : null, elementIds: ids.length >= 2 ? ids : [] });
    if (targets.length < 2) return fail('Arrive apart needs two or more layers: pass several elementIds, or one group id (its direct layers arrive).');
    const commands = applyStagger(targets, presetId, { sceneId: scene.id, fps, intensity: o.intensity, motion, within: scene.elements, ...(o.at !== undefined ? { at: o.at } : {}), ...(o.duration !== undefined ? { duration: o.duration } : {}), ...(o.stagger !== undefined ? { stagger: o.stagger } : {}), ...(o.order ? { order: o.order } : {}) });
    if (!commands.length) return fail(`${PRESETS[presetId].label} does not fit these layers (types: ${PRESETS[presetId].appliesTo.join(', ')}), or they are too short to arrive apart.`);
    const touched = targets.filter((t) => commands.some((c) => 'elementId' in c && c.elementId === t.id));
    return checked(project, `Arrive apart · ${touched.length} layers`, sceneTarget, commands, [
      `Arrive apart (${PRESETS[presetId].label}) on ${touched.length} layers in scene "${scene.name}", ${o.stagger ?? staggerFor(motion)} f apart (${o.order ?? 'reading'} order); each layer's existing entrance is replaced:`,
      ...touched.map((t) => `- ${t.id} ${t.type} "${t.name}"`),
    ], touched.map((t) => t.id));
  }

  if (args.preset === 'followThrough') {
    const group = elements[0];
    const children = scene.elements.filter((e) => e.parentId === group.id);
    if (elements.length !== 1 || group.type !== 'group' || !children.length) return fail('Follow-through takes one group with layers in it (elementIds: [groupId]).');
    const commands = followThroughCommands(scene.id, group, children, { fps, intensity: o.intensity, motion, ...(o.at !== undefined ? { at: o.at } : {}), ...(o.duration !== undefined ? { duration: o.duration } : {}), ...(o.from ? { from: o.from } : {}) });
    if (!commands.length) return fail(`Group "${group.name}" is too short for a follow-through.`);
    const moved = children.filter((c) => commands.some((cmd) => 'elementId' in cmd && cmd.elementId === c.id));
    return checked(project, `Follow-through on “${group.name}”`, sceneTarget, commands, [
      `Follow-through on group ${group.id} "${group.name}": it slides in from the ${o.from ?? 'left'}; ${moved.length} of its ${children.length} layers trail and settle (layers that arrive after the move are left alone).`,
    ], [group.id, ...moved.map((c) => c.id)]);
  }

  if (args.preset === 'matchCut') {
    const out = elements[0];
    if (elements.length !== 1 || !args.intoSceneId || !args.intoElementId) return fail('matchCut takes the outgoing element (elementIds: [id] in sceneId) and the incoming one (intoSceneId, intoElementId).');
    const into = lockedScene(project, args.intoSceneId);
    if ('error' in into) return fail(into.error);
    const incoming = into.scene.elements.find((e) => e.id === args.intoElementId);
    if (!incoming) return fail(`Element ${args.intoElementId} is not in scene "${into.scene.name}".`);
    if (out.parentId || incoming.parentId) return fail('A match cut works on top-level elements only (neither may be inside a group).');
    const commands = matchCutCommands({ sceneId: scene.id, element: out }, { sceneId: into.scene.id, element: incoming }, { fps, motion, ...(o.duration !== undefined ? { outFrames: o.duration, inFrames: o.duration } : {}) });
    if (!commands.length) return fail('Both elements must be on screen for at least two frames.');
    const lines = [`Match cut: "${out.name}" (${scene.name}) accelerates halfway to "${incoming.name}" (${into.scene.name}), which starts there and settles; "${into.scene.name}" gets a hard cut.`];
    if (out.startFrame + out.durationInFrames !== scene.durationInFrames) lines.push(`Note: "${out.name}" ends at scene frame ${out.startFrame + out.durationInFrames - 1}, not on the cut (${scene.durationInFrames - 1}); extend it so the move meets the cut.`);
    if (incoming.startFrame !== 0) lines.push(`Note: "${incoming.name}" starts at frame ${incoming.startFrame}, not on the cut; set startFrame 0 so it picks up the move.`);
    const next = project.scenes[project.scenes.indexOf(scene) + 1];
    if (next?.id !== into.scene.id) lines.push(`Note: "${into.scene.name}" does not follow "${scene.name}" directly.`);
    return checked(project, `Match cut: ${out.name} → ${incoming.name}`, [{ sceneId: scene.id }, { sceneId: into.scene.id }], commands, lines, [out.id, incoming.id]);
  }

  const presetId = args.preset;
  const preset = PRESETS[presetId];
  if (!preset) return fail(`Unknown preset "${presetId}". Use one of: ${MOTION_IDS.join(', ')}.`);
  const commands: Command[] = [];
  const lines: string[] = [];
  for (const element of elements) {
    if (!presetAppliesTo(preset, element)) return fail(`${preset.label} does not apply to "${element.name}" (${element.type}${element.durationInFrames < 2 ? ', on screen under two frames' : ''}); it works on ${preset.appliesTo.join(', ')} elements.`);
    // Same defaults as the inspector: entrances from the first frame, exits ending on the last, emphasis mid-element, loops after the entrance.
    const options = { ...defaultPresetOptions(preset, element, { fps, intensity: o.intensity, motion }), ...(o.at !== undefined ? { at: o.at } : {}), ...(o.duration !== undefined ? { duration: o.duration } : {}), fps };
    const own = presetCommands(scene.id, element, presetId, options);
    if (!own.length) return fail(`${preset.label} does not fit "${element.name}" at frame ${options.at} for ${options.duration} frames (it is ${element.durationInFrames} frames long).`);
    commands.push(...own);
    const n = normalizeOptions(preset, element, options);
    lines.push(`- ${element.id} ${element.type} "${element.name}": ${PRESET_KIND_LABELS[preset.kind]} · ${preset.label}, element frames ${frames(n.at, n.at + n.duration)}${n.intensity !== 1 ? `, intensity ${n.intensity}` : ''}`);
  }
  const summary = elements.length === 1 ? `${preset.label} on “${elements[0].name}”` : `${preset.label} on ${elements.length} layers`;
  return checked(project, summary, sceneTarget, commands, [`${preset.label} (${preset.description})`, ...lines], elements.map((e) => e.id));
}

/** The result as tool text: what it builds, then the ready patch. */
export function buildResultText(r: Extract<BuildResult, { ok: true }>, docSession?: string): string {
  return [
    ...r.lines,
    '',
    `Not applied or proposed. Send this to editor_preview_patch / editor_propose_patch as is, or add your own commands (text, timing tweaks, other templates) to the same patch first. Element ids: ${r.elementIds.join(', ')}.`,
    JSON.stringify({ ...r.patch, ...(docSession !== undefined ? { docSession } : {}) }),
  ].join('\n');
}

/** editor_build_template's description, generated from the template registry. */
export function templateToolDescription(): string {
  return [
    'Build one of the editor\'s templates (the Insert menu\'s designs: layout, type scale, glows, choreography and never-dead holds) for a scene of the open project, with its style pack, assets, frame size and fps — and return the result as ready editor_propose_patch arguments (baseRevision, summary, targets [{ sceneId }], commands), validated, plus the new element ids with one line per part. Read-only: nothing is applied or proposed.',
    'Inputs: template, params (below; text params are strings, \\n separates lines), sceneId, at (scene frame, default 0), parentId (build inside a group). The template holds to the end of the scene unless params.seconds is given. Combine several templates and your own adjustments in one patch (a backdrop goes under the content scene\'s template). Errors (locked scene, unknown or mistyped params, missing assets) come back as plain messages.',
    'Templates:',
    ...TEMPLATE_IDS.map((id) => `- ${id} (${TEMPLATES[id].seconds} s designed): ${TEMPLATES[id].description} Params: ${templateParamLines(id).join('; ')}.`),
  ].join('\n');
}

/** editor_build_motion's description, generated from the preset registry. */
export function motionToolDescription(): string {
  return [
    'Build motion with the editor\'s presets (the inspector\'s and Insert menu\'s recipes, timed and eased by the project\'s style.motion) on elements of the open project, returned as ready editor_propose_patch arguments (validated commands that replace the keys in each preset\'s window). Read-only: nothing is applied or proposed.',
    'Inputs: preset, sceneId, elementIds, opts { at (element-local frame; arriveApart: scene frame the first layer starts), duration (frames), intensity (0.25–2, distance not timing) }, plus per kind below. Defaults: entrances start on the element\'s first frame, exits end on its last, emphasis plays mid-element, loops run after the entrance.',
    'One preset applied to each of elementIds:',
    ...PRESET_IDS.map((id) => `- ${id} (${PRESET_KIND_LABELS[PRESETS[id].kind].toLowerCase()}${PRESETS[id].principle ? ', principle' : ''}; ${PRESETS[id].appliesTo.length > 2 ? 'any element' : `${PRESETS[id].appliesTo.join('/')} only`}): ${PRESETS[id].description}`),
    'Several elements:',
    '- arriveApart: several elementIds, or one group id (its direct layers), enter one after another in reading order, staggerFrames apart; each layer\'s existing entrance is replaced. opts.preset (an entrance, default riseIn), opts.stagger (frames), opts.order (reading | importance | centerOut | given).',
    '- followThrough: elementIds [groupId]; the group slides in, its layers trail, carry on past the stop and settle. opts.from (left | right | top | bottom), opts.at (group-local), opts.duration (travel frames).',
    '- matchCut: elementIds [outgoing element, ending on its scene\'s cut], intoSceneId + intoElementId (the incoming element, starting on frame 0): the outgoing one accelerates halfway to the incoming one\'s box, which picks up there and decelerates into place; the incoming scene\'s transition becomes a hard cut. Both top-level. opts.duration sets both halves.',
    'Each call reads the committed project: combine calls on different elements in one patch; for a second preset on the same element, apply the first one before building the second.',
  ].join('\n');
}
