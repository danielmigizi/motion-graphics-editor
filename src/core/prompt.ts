// Build the copyable coding-agent prompt from queued edit requests.
// Deterministic: no timestamps, no randomness — same input, same text.

import { evaluateElementWorld } from './animation';
import { COMPONENTS } from './components';
import type { FieldDescriptor } from './components';
import { AI_COMMAND_TYPES } from './patch';
import { audioClipStartFrame, formatTimecode, sceneStartFrame, sceneStartFrames } from './timing';
import { PATCH_PROTOCOL } from './types';
import type { AiPatch, EditRequest, Element, Project, Scene } from './types';

/** Shared notes keep both agent entry points consistent. */
export const SCHEMA_V2_NOTES = [
  '- Groups: `parentId` references a group in the same scene/composition; x/y are relative to its top-left, rotation/scale use its centre, opacity multiplies. Child startFrame is parent-relative; descendants are active only within every ancestor lifetime. Example: `{"type":"setParent","sceneId":"scn_open","elementId":"el_title","parentId":"el_group","keepWorld":true}`.',
  '- Paths: nodes and absolute in/out handles use the element box pixels. Example nodes: `[{"x":0,"y":80,"out":{"x":60,"y":0}},{"x":180,"y":80,"in":{"x":120,"y":160}}]`. `closed`, lineCap/lineJoin and trimStart/trimEnd/trimOffset control the path.',
  '- Paint: shape fill/stroke and path fill/stroke accept colour strings or gradients. Example: `{"type":"linear","angle":90,"stops":[{"offset":0,"color":"#3B82F6"},{"offset":1,"color":"#F8FAFC"}]}`; radial paint omits angle. Stops are sorted in 0..1; none is allowed only where specified.',
  '- Property tracks use absolute values for registry-marked animatable props and effects.blur/brightness/contrast/saturate. Example: `{"type":"setPropertyKeyframe","sceneId":"scn_open","elementId":"el_title","key":"props.color","frame":20,"value":"#3B82F6","easing":"linear"}`. Numbers interpolate, colours interpolate in linear sRGB, other values hold. Paint colour tracks require a plain colour base, never a gradient/none.',
  '- Easing curves shape the outgoing segment. Named presets: linear, easeIn, easeOut, easeInOut, backOut, easeInCubic, easeOutCubic, easeInOutCubic, easeOutExpo, easeInOutExpo, hold. Custom example: `{"type":"cubicBezier","x1":0.2,"y1":-0.3,"x2":0.8,"y2":1.2}`; x is 0..1, y is -2..3. hold switches exactly at the next keyframe. Custom easing works on stored transform keys and property-key commands; setKeyframe accepts named presets only.',
  '- Masks: `{"sourceId":"el_mask","mode":"alpha"}` or inverted. Source is another unmasked shape/path with the same parent, and is not painted itself. Blend example: `"blendMode":"screen"` (normal, multiply, screen, overlay, darken, lighten, color-dodge, color-burn, soft-light, hard-light, difference, exclusion).',
  '- Effects example: `{"blur":12,"brightness":1.2,"dropShadow":{"x":0,"y":8,"blur":20,"color":"#00000080"}}`. Blur/shadow blur 0..200; brightness/contrast/saturate 0..3. updateElement merges effects; null removes a key or clears the entire effects/mask/blendMode field.',
  '- Text reveals: none, fadeUp, typewriter, wordStagger, charStagger, lineStagger, charFadeUp, scaleIn, blurIn. Example props: `{"reveal":"charFadeUp","revealStagger":2,"revealOrder":"center","revealEasing":"easeOutCubic"}`. Order is forward/reverse/center/edges; new reveal props are optional on older documents. Fraunces is an available font.',
  '- Instances refer to reusable project.compositions trees; no direct or transitive instance cycles. Example props: `{"compositionId":"cmp_logo","timeOffset":0,"loop":false}`. Composition definitions are read-only in AI patches; reference an existing definition with an instance. Compositions/markers/changeFormat commands are excluded from patches.',
];
export const V2_COMMAND_NOTES = [
  '- `{ "type": "setPropertyKeyframe", "sceneId", "elementId", "key", "frame", "value", "easing"? }` and `{ "type": "removePropertyKeyframe", "sceneId", "elementId", "key", "frame" }` need an element or scene target.',
  '- `{ "type": "setParent", "sceneId", "elementId", "parentId": string|null, "keepWorld"?: boolean }` needs an element or scene target. keepWorld defaults true and preserves placement at local frame 0, with integer-rounded x/y; animated parents may change later motion.',
  '- `{ "type": "groupElements", "sceneId", "elementIds": string[], "group": {"id","name"} }` and `{ "type": "ungroup", "sceneId", "groupId" }` need a scene target. Grouped children share one parent. Removing a group deletes descendants; deleting a mask source clears its users in the same command.',
];

/** Audio commands in patches (guide and copy prompt). */
export const AUDIO_COMMAND_NOTES = [
  '- `{ "type": "addAudioClip", "clip": AudioClip }`, `{ "type": "updateAudioClip", "clipId", "changes": Partial<AudioClip> }` (merged; send only what changes) and `{ "type": "removeAudioClip", "clipId" }`. A project-level clip (the music bed: no `sceneId`, absolute `startFrame`) needs the target `{ "audio": "project" }`; a clip anchored to a scene (sound effects: `sceneId`, scene-relative `startFrame`) needs that scene\'s target `{ "sceneId" }`; moving a clip between them needs both. Clips anchored to a locked scene are locked.',
  '- AudioClip: `{ id, assetId, name, sceneId?, startFrame, trimStartFrames, durationInFrames, volume 0..1, fadeInFrames, fadeOutFrames, volumeEnvelope?: [{ frame, value 0..1 }] }`. Envelope frames are clip-relative, sorted, unique, within 0..durationInFrames; the envelope multiplies volume and fades (linear between points, ends held); `[]` removes it.',
];

/** The project's audio clips, one line each, for prompts. */
export function audioLines(project: Project): string[] {
  return project.audio.map((c) => {
    const at = audioClipStartFrame(project, c);
    const where = c.sceneId ? `anchored to scene \`${c.sceneId}\` at scene frame ${c.startFrame}` : 'project-level (music bed)';
    return `- \`${c.id}\` "${c.name}" (asset \`${c.assetId}\`): ${where}, plays frames ${at}–${at + c.durationInFrames - 1}, trim ${c.trimStartFrames}, volume ${c.volume}, fades ${c.fadeInFrames}/${c.fadeOutFrames}${c.volumeEnvelope?.length ? `, envelope of ${c.volumeEnvelope.length} points` : ''}`;
  });
}

export function fieldLine(f: FieldDescriptor): string {
  switch (f.kind) {
    case 'text':
    case 'multiline':
      return `- \`${f.key}\` (${f.kind === 'text' ? 'string' : 'string, newlines allowed'}${f.maxLength !== undefined ? `, max ${f.maxLength} chars` : ''}) — ${f.label}`;
    case 'number':
      return `- \`${f.key}\` (${f.integer ? 'integer' : 'number'} ${f.min}..${f.max}) — ${f.label}${f.animatable ? "; animatable" : ""}${f.optional ? "; optional on existing documents" : ""}`;
    case 'composition': return `- \`${f.key}\` (existing composition id) — ${f.label}`;
    case 'pathNodes': return `- \`${f.key}\` (at least two {x,y,in?:{x,y},out?:{x,y}} nodes, box-relative pixels) — ${f.label}`;
    case 'paint': return `- \`${f.key}\` (colour or linear/radial gradient${f.allowNone ? ' or "none"' : ''}) — ${f.label}${f.animatable ? '; colour tracks only for a plain colour' : ''}`;
    case 'color':
      return `- \`${f.key}\` (colour #RGB/#RRGGBB/#RRGGBBAA or rgb()/rgba()${f.allowNone ? ' or "none"' : ''}) — ${f.label}${f.animatable ? "; animatable" : ""}`;
    case 'select':
      return `- \`${f.key}\` (one of ${f.options.map((o) => JSON.stringify(o.value)).join(', ')}) — ${f.label}${f.optional ? "; optional on existing documents" : ""}`;
    case 'boolean':
      return `- \`${f.key}\` (boolean) — ${f.label}`;
    case 'asset':
      return `- \`${f.key}\` (asset id of kind ${f.assetKinds.join('/')}) — ${f.label}`;
  }
}

function trackSummary(el: Element): string {
  if (el.tracks.length === 0) return 'none';
  return el.tracks
    .map((t) => `${t.property}: ${t.keyframes.map((k) => `f${k.frame}=${k.value} (${typeof k.easing === 'string' ? k.easing : JSON.stringify(k.easing)})`).join(' → ')}`)
    .join('; ');
}

function sceneRow(s: Scene, i: number, start: number): string {
  return `| ${i + 1} | \`${s.id}\` | ${s.name} | ${start} | ${s.durationInFrames} | ${s.locked ? 'yes' : 'no'} |`;
}

function requestSection(project: Project, req: EditRequest, n: number): string {
  const lines: string[] = [];
  const scene = project.scenes.find((s) => s.id === req.sceneId);
  lines.push(`### Request ${n}${req.elementId ? '' : ' (whole scene)'}`, '');
  lines.push(`**Instruction:** ${req.instruction}`, '');
  if (!scene) {
    lines.push(`Scene \`${req.sceneId}\` no longer exists — skip this request and say so in the summary.`, '');
    return lines.join('\n');
  }
  const start = sceneStartFrame(project, scene.id);
  lines.push(`- Scene: \`${scene.id}\` "${scene.name}" (starts at frame ${start}, ${scene.durationInFrames} frames${scene.locked ? ', LOCKED — do not change it' : ''})`);
  const sceneFrame = req.frame - start;
  const el = req.elementId ? scene.elements.find((e) => e.id === req.elementId) : undefined;
  const ctx = [
    `global frame ${req.frame} (${formatTimecode(req.frame, project.fps)})`,
    `scene frame ${sceneFrame}`,
  ];
  if (el) ctx.push(`element frame ${evaluateElementWorld(scene.elements, el, sceneFrame).localFrame}`);
  lines.push(`- Frame context: ${ctx.join(', ')}`);
  lines.push(`- Target: \`${JSON.stringify(req.elementId ? { sceneId: scene.id, elementId: req.elementId } : { sceneId: scene.id })}\``);
  if (req.elementId && !el) {
    lines.push('', `Element \`${req.elementId}\` no longer exists in this scene — skip this request and say so in the summary.`, '');
    return lines.join('\n');
  }
  if (el) {
    const def = COMPONENTS[el.type];
    lines.push(
      `- Element: \`${el.id}\` "${el.name}" (type \`${el.type}\` — ${def.label})`,
      `- Timing: startFrame ${el.startFrame} (parent-relative if grouped, otherwise scene-relative), durationInFrames ${el.durationInFrames}, visible ${el.visible}`,
      `- Base transform: ${JSON.stringify(el.transform)}`,
      `- Animation tracks (element-relative frames): ${trackSummary(el)}`,
      `- Group/appearance/property tracks: ${JSON.stringify({ parentId: el.parentId, blendMode: el.blendMode, effects: el.effects, mask: el.mask, propTracks: el.propTracks })}`,
      '',
      'Current props:',
      '```json',
      JSON.stringify(el.props, null, 2),
      '```',
      '',
      `\`${el.type}\` prop schema (required unless marked optional; no other keys are allowed):`,
      ...def.fields.map(fieldLine),
    );
  } else {
    lines.push('', 'Elements in this scene (paint order, back to front):');
    for (const e of scene.elements) {
      lines.push(`- \`${e.id}\` "${e.name}" (\`${e.type}\`), startFrame ${e.startFrame}, durationInFrames ${e.durationInFrames}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

function exampleFor(project: Project, requests: EditRequest[]): AiPatch {
  const req = requests.find((r) => r.elementId) ?? requests[0];
  const scene = req ? project.scenes.find((s) => s.id === req.sceneId) : project.scenes[0];
  const el = req?.elementId ? scene?.elements.find((e) => e.id === req.elementId) : scene?.elements[0];
  const sceneId = scene?.id ?? 'scn_example';
  const elementId = el?.id ?? 'el_example';
  const textKey = el ? COMPONENTS[el.type].fields.find((f) => f.kind === 'text' || f.kind === 'multiline')?.key : 'text';
  const props = textKey ? { [textKey]: 'New wording here' } : {};
  return {
    protocol: PATCH_PROTOCOL,
    projectId: project.id,
    baseRevision: project.revision,
    summary: 'Short description of what changed',
    targets: [{ sceneId, elementId }],
    commands: [
      { type: 'updateElement', sceneId, elementId, changes: { props } },
      { type: 'setKeyframe', sceneId, elementId, property: 'opacity', frame: 0, value: 0, easing: 'easeOut' },
      { type: 'setKeyframe', sceneId, elementId, property: 'opacity', frame: 15, value: 1, easing: 'linear' },
    ],
  };
}

export function buildAgentPrompt(project: Project, requests: EditRequest[]): string {
  const starts = sceneStartFrames(project);
  const out: string[] = [];
  out.push(
    '# Motion graphics edit request',
    '',
    'You are editing a motion-graphics project in a local editor. You cannot see the editor; everything you need is below.',
    'Reply with ONE structured patch (protocol `' + PATCH_PROTOCOL + '`) in a single ```json block. Do not edit files.',
    '',
    '## Project',
    '',
    `- Project id: \`${project.id}\``,
    `- Name: ${project.name}`,
    `- Base revision: ${project.revision}`,
    `- Frame rate: ${project.fps} fps (all timing is in integer frames)`,
    `- Size: ${project.width}×${project.height} px`,
    '',
    '### Scenes (playback order)',
    '',
    '| # | id | name | start frame | duration (frames) | locked |',
    '|---|----|------|-------------|-------------------|--------|',
    ...project.scenes.map((s, i) => sceneRow(s, i, starts[i])),
    '',
    ...(project.audio.length ? ['### Audio clips', '', ...audioLines(project), ''] : []),
    '## Requests',
    '',
  );
  requests.forEach((r, i) => out.push(requestSection(project, r, i + 1)));

  const targets = requests.map((r) => (r.elementId ? { sceneId: r.sceneId, elementId: r.elementId } : { sceneId: r.sceneId }));
  out.push(
    '## Coordinate model',
    '',
    '- `transform` is the BASE layout: x/y = top-left in px, rotation in degrees, scale (1 = 100%), opacity 0..1.',
    '- Animation tracks are layered on top: `x`, `y`, `rotation` keyframes are ADDITIVE offsets; `scale`, `opacity` keyframes are MULTIPLIERS of the base.',
    '- Keyframe frames are relative to the element start (0 = first frame on screen). Element `startFrame` is relative to its parent group, or scene when parentless.',
    '- A top-level element must fit in its scene. Children need nonnegative starts but may exceed their group lifetime; ancestors clip their activity.',
    '',
    ...SCHEMA_V2_NOTES,
    `Available compositions (read-only in patches): ${JSON.stringify(project.compositions)}`,
    '',
    '## Reply protocol',
    '',
    'Reply with exactly one ```json block containing an object of this shape:',
    '',
    '```ts',
    '{',
    `  "protocol": "${PATCH_PROTOCOL}",`,
    `  "projectId": "${project.id}",`,
    `  "baseRevision": ${project.revision},`,
    '  "summary": string,            // one line, shown in the editor history',
    '  "targets": ({ "sceneId": string, "elementId"?: string } | { "audio": "project" } | { "style": "project" })[],',
    '  "commands": Command[]',
    '}',
    '```',
    '',
    `Targets for this request: \`${JSON.stringify(targets)}\``,
    '',
    'Allowed commands:',
    '',
    '- `{ "type": "updateElement", "sceneId", "elementId", "changes": { "name"?, "visible"?, "startFrame"?, "durationInFrames"?, "transform"?: Partial<Transform>, "props"?: Partial<Props>, "blendMode"?: BlendMode|null, "effects"?: Partial<EffectsWithNull>|null, "mask"?: ElementMask|null } }`',
    '- `{ "type": "setKeyframe", "sceneId", "elementId", "property": "x"|"y"|"rotation"|"scale"|"opacity", "frame", "value", "easing"?: named preset (including cubic/expo and hold) }` (inserts or replaces the keyframe at that frame)',
    ...V2_COMMAND_NOTES,
    '- `{ "type": "removeKeyframe", "sceneId", "elementId", "property", "frame" }`',
    '- `{ "type": "addElement", "sceneId", "element": Element, "index"? }` (full element: id, type, name, startFrame, durationInFrames, visible, transform, props with every key, tracks)',
    '- `{ "type": "removeElement", "sceneId", "elementId" }`',
    '- `{ "type": "moveElement", "sceneId", "elementId", "toIndex" }` (paint order)',
    '- `{ "type": "updateScene", "sceneId", "changes": { "name"?, "durationInFrames"?, "backgroundColor"?, "transitionIn"?: { "type"?, "durationInFrames"? } } }`',
    '- `{ "type": "addAsset", "asset": { "id", "kind": "image"|"svg"|"audio", "name", "src", "mimeType", "width"?, "height"?, "durationInFrames"? } }` (register an uploaded file; needs no target)',
    ...AUDIO_COMMAND_NOTES,
    '- `{ "type": "setStyle", "style": StylePack | null }` needs the target `{ "style": "project" }`. Prefer `editor_scan_brand` (it returns a ready proposal) over inventing a pack.',
    '',
    `Only these command types are accepted (${AI_COMMAND_TYPES.join(', ')}).`,
    '',
    'Rules:',
    '',
    '1. Stay inside the targets. An element target allows commands on that element only; a scene target allows the scene, its elements and its anchored audio clips; `{ "audio": "project" }` allows the project-level audio; `{ "style": "project" }` allows `setStyle`. `addElement`, `removeElement`, `updateScene`, `groupElements` and `ungroup` need a scene target. Add an audio target only when the request is about the music or sound; add a style target only when applying a brand kit.',
    '2. Never touch locked scenes, and never lock or unlock scenes.',
    '3. Keep unrelated props unchanged: send only the props and transform fields you change (they are merged).',
    '4. Preserve timing (startFrame, durationInFrames, keyframes) unless the instruction asks to change it.',
    '5. Use only the prop keys and value ranges listed in the schema; colours are #RGB/#RRGGBB/#RRGGBBAA or rgb()/rgba() strings.',
    '6. Keep `projectId` and `baseRevision` exactly as given; the editor rejects stale patches.',
    '',
    '## Example',
    '',
    '```json',
    JSON.stringify(exampleFor(project, requests), null, 2),
    '```',
    '',
    'Now reply with your patch as one ```json block.',
    '',
  );
  return out.join('\n');
}
