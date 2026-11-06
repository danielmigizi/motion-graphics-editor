// Authoring guide for a coding agent working through the agent bridge (MCP
// server in mcp/). Generated from the same component registry the validator
// and inspector use, so it cannot drift from what the editor accepts.
// Deterministic: no timestamps, no randomness.

import { COMPONENTS, ELEMENT_TYPES } from './components';
import { AI_COMMAND_TYPES } from './patch';
import { CRAFT_VERSION, EXIT_RATIO, FRAME_USE, LIVENESS, PRINCIPLES, READING, SAFE_MARGIN, SCENE_BANDS, SEAM, SPOTLIGHT, STAGGER_FRAMES, STORY, TIMING_BANDS, TYPE_MIN, TYPE_SCALE } from './motionRules';
import { WORKFLOW_IDS, WORKFLOWS } from './workflow';
import { PRESET_IDS, PRESET_KIND_LABELS, PRESETS } from './presets';
import { MOTION_PERSONALITIES, PERSONALITY_IDS, PERSONALITY_NOTES, STYLE_PACK_IDS, STYLE_PACK_NOTES, STYLE_PACKS } from './style';
import { HOUSE_PACK_ID, PULSE_CRAFT, craftLine } from './styleCraft';
import { TEMPLATE_IDS, TEMPLATES } from './templates';
import { AUDIO_COMMAND_NOTES, fieldLine, SCHEMA_V2_NOTES, V2_COMMAND_NOTES } from './prompt';
import { SFX, SFX_IDS, SFX_LICENSE, sfxAssetId, sfxSrc } from './sfx';
import { PROJECT_SCHEMA_VERSION, STORY_BEAT_ROLES } from './types';
import type { Element, ElementType, Project } from './types';

function exampleElement(id: string, type: ElementType, name: string, overrides: Partial<Element> = {}): Element {
  const def = COMPONENTS[type];
  return {
    id,
    type,
    name,
    startFrame: 0,
    durationInFrames: 120,
    visible: true,
    transform: { x: Math.round((1920 - def.defaultSize.width) / 2), y: Math.round((1080 - def.defaultSize.height) / 2), width: def.defaultSize.width, height: def.defaultSize.height, rotation: 0, scale: 1, opacity: 1 },
    props: structuredClone(def.defaultProps),
    tracks: [],
    ...overrides,
  };
}

/** A minimal, valid project: one 4 s scene with a headline that fades and slides in. */
export function exampleProject(): Project {
  const headline = exampleElement('el_headline', 'text', 'Headline', {
    startFrame: 6,
    durationInFrames: 114,
    props: { ...COMPONENTS.text.defaultProps, text: 'Ship the brief, not the backlog' },
    tracks: [
      { property: 'opacity', keyframes: [{ frame: 0, value: 0, easing: 'easeOut' }, { frame: 15, value: 1, easing: 'linear' }] },
      { property: 'y', keyframes: [{ frame: 0, value: 40, easing: 'easeOut' }, { frame: 20, value: 0, easing: 'linear' }] },
    ],
  });
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    id: 'prj_example',
    name: 'Example',
    revision: 1,
    fps: 30,
    width: 1920,
    height: 1080,
    backgroundColor: '#080B14',
    scenes: [
      {
        id: 'scn_open',
        name: 'Open',
        durationInFrames: 120,
        backgroundColor: '#0A0E1A',
        locked: false,
        transitionIn: { type: 'fade', durationInFrames: 12 },
        elements: [headline],
      },
    ],
    assets: {},
    audio: [],
    compositions: {},
    markers: [],
  };
}

export function buildAuthoringGuide(): string {
  const out: string[] = [];
  out.push(
    '# Motion graphics editor: authoring guide',
    '',
    'You are working inside a live editor the user is watching. The project is one JSON document; you change it with',
    '`editor_apply_patch` (targeted edits, one undo step when applied) or replace it wholesale with `editor_write_project` (new drafts).',
    'Edits normally become proposals the user reviews; Auto-apply commits them immediately only when enabled. `editor_propose_patch` always proposes, showing a rendered Current/Proposed comparison.',
    'When a tool says proposed, say "I\'ve proposed …, review it in the editor". Do not build on an unapplied proposal unless asked: a newer proposal replaces it. Check `editor_proposal_status` or `editor_get_context` for the decision.',
    'Check committed work visually with `editor_render_frame` before handing over; pending proposals do not change its project snapshot.',
    '',
    '## Route the brief',
    '',
    'Before outlining, pick one workflow from the brief. Match the deliverable, not a word in passing. Use that pack, those templates, and that story shape. Do not invent a sixth workflow.',
    '',
    '| Route | When | Pack | Templates | Story |',
    '| --- | --- | --- | --- | --- |',
    ...WORKFLOW_IDS.map((id) => {
      const w = WORKFLOWS[id];
      return `| ${w.id} | ${w.when} | \`${w.pack}\` | ${w.templates.join(', ')} | ${w.story} |`;
    }),
    '',
    'A music bed under a launch does not override the subject. State every later correction as an absolute value (`fontSize` 32, hold 48 f, travel −80 px), not a relative nudge: relative nudges tend to overshoot and swing back and forth.',
    '',
    '## Agent tools (mge.tools/2)',
    '',
    '- Permissions: `editor_permission_prompt` is the Claude Code permission callback; it asks in the editor and returns allow/deny JSON. Destructive `editor_write_project` flags (overwrite/discardUnsaved) and `editor_open` with discardUnsaved ask the user before proceeding.',
    '- Start/read: `editor_open`, `editor_get_context`, `editor_get_project`, `editor_guide`. Context includes `contract` and `docSession`.',
    '- Edit/review: `editor_apply_patch`, `editor_propose_patch`, `editor_proposal_status`, `editor_write_project`. Pass optional `docSession` with patches; STALE_SESSION means re-read context before editing a reopened document.',
    '- Preview: `editor_preview_patch` takes patch inputs plus optional `frames` (1–8) or `contactSheet: true`. It validates and renders without applying or proposing anything. Default sheet: first frame and midpoint of each touched scene, up to 12 frames.',
    '- Critique: `editor_critique` returns frame-tied defects (reading holds, type size, dead frames, two heroes, linear moves, cuts off the beat, banned clichés the document can prove including lazy defaults, story structure, and scene-to-scene seams: settle-then-cut, axis/direction/speed mismatch, long entries, idle loops). Pass the same patch fields as preview to judge a candidate; `addBanned` after the first contact sheet (remembered this session; also store on `project.banned` when writing a draft). `editor_propose_patch` prepends a critique of the candidate — it still proposes.',
    '- Inspect visuals: `editor_render_frame` returns labelled committed frames; `editor_render_contact_sheet` returns one image with frames/timecodes/scenes, revision and hash. Defaults to 25% and 75% of each scene, up to 24 frames; optional columns (1–6) and scale (0.1–1).',
    '- Export: `editor_export_revision` starts an MP4 of the live committed document (including unsaved committed edits) and refuses while a proposal is pending. `editor_inspect_job` reads one job or the newest five, with progress, output URL and manifest summary; `editor_cancel_job` cancels an active job.',
    '- New videos: `editor_propose_outline` proposes a brief\'s outline for the user to review (see "New videos" below).',
    '- Build: `editor_build_template` and `editor_build_motion` (read-only) return the editor\'s templates and motion presets, built against the live project and its style, as validated `editor_propose_patch` arguments (baseRevision, summary, targets, commands) plus the new element ids. Nothing is applied; add your own commands to the same patch (see "Building scenes").',
    '- Music: `editor_get_beats` (read-only) returns the music bed\'s tempo, beat grid, downbeats, strong hits and onsets as project frames, and how far each scene cut sits from a beat (see "Music and sound").',
    '- Generate media: `editor_generation_models`, `editor_generate`, `editor_generation_status`, `editor_cancel_generation` (fal through the editor; permission and budget apply; place takes only through a proposal).',
    '- Free music & SFX: `editor_search_audio`, `editor_inspect_audio`, `editor_add_audio` (Openverse, CC0 and CC BY only; Made with Openverse), `editor_list_credits`.',
    '- Brand kit: `editor_scan_brand` fetches a public https page (HTML+CSS only, cached per domain) and returns ranked colours, fonts with fallbacks, and a logo (never redrawn), plus a reviewable `setStyle` overlay (`{ style: "project" }`). Pass `propose: true` to propose it.',
    '- Reference video: `editor_analyze_reference` runs local ffmpeg on a file or URL (yt-dlp for page hosts). Returns specs, scene cuts, a shot list, 1 fps contact sheets, dense strips, per-shot palettes, loudness, beats/onsets and motion stats. Analysis only — never import the source. State every correction as an absolute value.',
    '- Utilities: `editor_focus`, `editor_save`, `editor_import_asset`.',
    '- Every result includes `_meta` with `mge/contract: mge.tools/2`, a unique `mge/requestId`, and project id, revision and document session when known. Frame captions identify committed or proposal/preview snapshots; preview revision is the uncommitted base.',
    '',
    '## Document model',
    '',
    '- `Project` → ordered `scenes` (played back to back, never overlapping) → `elements` (paint order: later draws on top).',
    '- All timing is in integer frames at `project.fps` (usually 30). 30–90 s videos are 900–2700 frames.',
    '- Element `startFrame` is relative to its scene or parent group; a top-level element must fit: `startFrame + durationInFrames <= scene.durationInFrames`.',
    '- `transform` is the BASE layout: x/y = top-left corner in px on a `width`×`height` canvas (usually 1920×1080), rotation in degrees, scale (1 = 100%), opacity 0..1.',
    '- Animation `tracks` layer on top of the base: `x`, `y`, `rotation` keyframes are ADDITIVE offsets; `scale`, `opacity` keyframes are MULTIPLIERS.',
    '  So a slide-up is a `y` track from +40 to 0, and a fade-in is an `opacity` track from 0 to 1.',
    '- Keyframe frames are relative to the element start (0 = first frame on screen). One track per property, keyframes sorted with unique frames.',
    '  `easing` on a keyframe shapes the segment that STARTS there: named presets or a custom cubicBezier (see below).',
    '- Scene `transitionIn`: { type: none | fade | slide | wipe | zoom | blur, durationInFrames } plays over the scene\'s first frames.',
    '- IDs are unique across the whole project and never reused. Use prefixes: `prj_`, `scn_`, `el_`, `ast_`, `aud_`.',
    '- `locked` scenes were approved by the user: never change them, never unlock them.',
    '',
    ...SCHEMA_V2_NOTES,
    '',
    '## How v2 features render (preview and export alike)',
    '',
    '- Groups draw their children inside the group box (`clip: true` clips them to it). Blend modes inside a group or an instance blend only with that group\'s content; top-level elements blend with the scene background.',
    '- Instances: the composition is scaled to fit the instance box (contain, centred) and clipped to its bounds. It plays at instance-local frame + `timeOffset`; with `loop` it wraps modulo the composition duration, otherwise nothing is drawn before frame 0 and the last frame holds after the end.',
    '- Gradients: a linear `angle` follows CSS (0 = upward, 90 = rightward; the gradient runs corner to corner across the element box); a radial gradient fills the ellipse inscribed in the element box.',
    '- Paths: trim applies to the stroke only (the fill is never trimmed); trimStart > trimEnd is the same range; `trimOffset` shifts the drawn run and wraps past the end.',
    '- Masks: the matte follows the source\'s geometry, paint alpha, opacity, motion and trim on every frame, but only during the source\'s lifetime (outside it, alpha hides the target and inverted shows it whole). The source\'s `visible` flag and effects do not affect the matte.',
    '- Effects render as CSS filters in the element\'s own space, so blur and drop shadow rotate and scale with it.',
    '- Per-unit text reveals: charStagger (fade), charFadeUp, scaleIn and blurIn animate each character (whitespace excluded); lineStagger animates lines split on explicit newlines only (soft wraps never split). Each unit animates for `revealDurationInFrames`, units start `revealStagger` frames apart in `revealOrder`, and `revealEasing` shapes each unit. fadeUp, typewriter and wordStagger ignore the three stagger props.',
    '- Transitions are entrances over a scene\'s first frames; scenes never overlap and audio is unaffected (docs/transitions.md).',
    '',
    '## Assets and audio',
    '',
    '- `assets` is a map id → { id, kind: image | svg | audio, name, src, mimeType, width?, height?, durationInFrames? }.',
    '  `src` is relative to the editor\'s public/ folder, e.g. `assets/uploads/u_ab12.png`. Import local files with `editor_import_asset`, which returns a ready asset object.',
    '- `reference: true` marks a reference (style frame, brand image, music reference): it steers generation and is never placed in an element or clip. `provenance` { source: upload | generated | openverse, provider?, providerRefs?, model?, prompt?, seed?, requestId?, cost?, createdAt?, license? } records where a file came from; Openverse imports store license, attribution, creator and source URLs on `license`.',
    '- `audio` clips: { id, assetId, name, sceneId?, startFrame, trimStartFrames, durationInFrames, volume 0..1, fadeInFrames, fadeOutFrames, volumeEnvelope? }.',
    '  Without `sceneId`, `startFrame` is absolute (music bed). With `sceneId`, it is relative to that scene and moves with it (sound effects).',
    '  Gain at a clip frame = volume × fade-in × fade-out × volumeEnvelope (clip-relative points `{ frame, value 0..1 }`, linear between points, ends held).',
    '',
    ...musicSection(),
    '## Components',
    '',
  );
  for (const type of ELEMENT_TYPES) {
    const def = COMPONENTS[type];
    out.push(
      `### \`${type}\` — ${def.label}`,
      '',
      def.description,
      `Default size ${def.defaultSize.width}×${def.defaultSize.height}. Props are required unless marked optional; no other keys are allowed.`,
      '',
      ...def.fields.map(fieldLine),
      '',
      `Defaults: \`${JSON.stringify(def.defaultProps)}\``,
      '',
    );
  }
  out.push(...videoElementsSection());
  out.push(...newVideoSection());
  out.push(
    '## Patches (editor_apply_patch / editor_propose_patch)',
    '',
    '- Pass the `baseRevision` you last read (from editor_get_context or editor_get_project). If the user edited since, the patch is rejected as STALE; re-read and retry, or pass `reconcile: true` when your targets were not touched.',
    '- `targets` lists what you may change: `{ sceneId }` for a whole scene (needed for addElement, removeElement, updateScene; also covers the audio clips anchored to it), `{ sceneId, elementId }` for one element, `{ "audio": "project" }` for the music bed and other project-level audio, or `{ "style": "project" }` for `setStyle` (brand-kit overlay).',
    `- Allowed command types: ${AI_COMMAND_TYPES.join(', ')}.`,
    '  - `{ "type": "updateElement", "sceneId", "elementId", "changes": { "name"?, "visible"?, "startFrame"?, "durationInFrames"?, "transform"?: Partial<Transform>, "props"?: Partial<Props>, "blendMode"?: BlendMode|null, "effects"?: Partial<EffectsWithNull>|null, "mask"?: ElementMask|null } }` — transform and props are merged; send only what changes.',
    '  - `{ "type": "setKeyframe", "sceneId", "elementId", "property", "frame", "value", "easing"? }` — inserts or replaces the keyframe at that frame.',
    ...V2_COMMAND_NOTES,
    '  - `{ "type": "removeKeyframe", "sceneId", "elementId", "property", "frame" }`',
    '  - `{ "type": "addElement", "sceneId", "element": Element, "index"? }` — a full element (all props).',
    '  - `{ "type": "removeElement", "sceneId", "elementId" }`, `{ "type": "moveElement", "sceneId", "elementId", "toIndex" }`',
    '  - `{ "type": "updateScene", "sceneId", "changes": { "name"?, "durationInFrames"?, "backgroundColor"?, "transitionIn"? } }`',
    '  - `{ "type": "addAsset", "asset": Asset }` — needs no target.',
    '  - `{ "type": "setStyle", "style": StylePack | null }` — needs `{ "style": "project" }`. Prefer `editor_scan_brand`.',
    ...AUDIO_COMMAND_NOTES.map((l) => `  ${l}`),
    '- Adding or reordering scenes needs `editor_write_project` (it reloads the editor and resets undo history, so save first). Music and sound effects are ordinary patches: they show up in the review\'s summary and the user hears both versions.',
    '- The whole patch is validated before proposing or applying; errors name the failing command path. A proposal changes no project data until the user Applies it; Cancel changes nothing.',
    '',
    '## Writing a whole project (editor_write_project)',
    '',
    `Use \`schemaVersion: ${PROJECT_SCHEMA_VERSION}\`, a fresh \`prj_\` id for a new video, \`revision: 1\`. A minimal valid project:`,
    '',
    '```json',
    JSON.stringify(exampleProject(), null, 2),
    '```',
    '',
    ...craftSection(),
  );
  return out.join('\n');
}

/** Beats, sound effects and ducking. */
function musicSection(): string[] {
  return [
    '## Music and sound',
    '',
    '- Call `editor_get_beats` before timing anything to music. It analyses the music bed (or `clipId`; or, in source frames, an unplaced `assetId` or an imported file\'s `src`) and returns `tempo` { bpm, framesPerBeat, framesPerBar, confidence }, `beats`, `downbeats` (bar starts), `strongHits`, `onsets` and `sceneCuts` (each cut\'s distance to the nearest beat and downbeat) in project frames, plus the markers.',
    '- Cut scenes on downbeats: change scene `durationInFrames` so every `sceneCuts[].offDownbeatBy` is 0 (a beat is fine when bars are long, e.g. under 80 BPM). Keep each scene at least as long as its text needs to be read (~2 s + 1 s per line); stretch to the next downbeat rather than cutting reading time.',
    '- Land the main entrance of a scene on its first beat and the biggest moment (logo slam, number, reveal) on a strong hit; small staggers can follow the beat grid. Never move every element to every beat: one accent per bar reads as rhythm, eight reads as noise.',
    '- Changing scene lengths moves later sound effects with their scenes; the music bed stays on the project timeline. After retiming, a bed under the whole video should end with the video: set its `durationInFrames` to the new total (and a 1–2 s `fadeOutFrames`) in the same patch, with targets `[{ "audio": "project" }, { "sceneId": … }]`.',
    '- Confidence below 0.2 means a weak pulse (ambient pads): use `strongHits`/`onsets` instead of the grid.',
    '',
    '### Built-in sound effects',
    '',
    `Generated files under public/ (${SFX_LICENSE}) Add one with an \`addAsset\` (only if the project lacks the asset id) and an \`addAudioClip\` anchored to the scene (scene target). Asset: \`{ "id": "ast_sfx_<name>", "kind": "audio", "name", "src": "assets/sfx/<name>.wav", "mimeType": "audio/wav", "durationInFrames" }\`.`,
    '',
    ...SFX_IDS.map((id) => {
      const d = SFX[id];
      return `- \`${sfxAssetId(id)}\` (\`${sfxSrc(id)}\`, ${d.seconds} s, volume ${d.volume}${d.leadFrames ? `, peaks ${d.leadFrames} frames in at 30 fps — start it that much before the moment` : ''}): ${d.description}. ${d.use}.`;
    }),
    '- Use them sparingly: a whoosh on a slide or wipe transition, a pop or tick on entrances, a hit on the biggest beat, a rise into a reveal. Keep effects 6–12 dB under the voice and below the music on busy beats (volume 0.4–0.8).',
    '',
    '### Ducking under voice-over',
    '',
    '- Duck the music bed under voice clips with a `volumeEnvelope` on the bed (an `updateAudioClip` with the project-audio target): for each voice line playing at bed frames [a, b), points `{ frame: a − 6, value: 1 }`, `{ frame: a, value: 0.25 }`, `{ frame: b, value: 0.25 }`, `{ frame: b + 12, value: 1 }` (−12 dB, 0.2 s down, 0.4 s back up at 30 fps); merge lines closer than 18 frames into one dip; clamp to 0..durationInFrames. The user can do the same with "Duck under voice" in the Inspector.',
    '',
    '### Generating media (fal)',
    '',
    'Draw with code — text, charts, data, UI, shapes, logos and motion. Generate only what code cannot draw: photographic or illustrated images, cutouts, textures and plates, music, voice-over and recorded-sounding effects.',
    '- `editor_generation_models` lists jobs, models and prices; `editor_generate` requests takes; `editor_generation_status` polls results; `editor_cancel_generation` cancels a job.',
    '- Job kinds name the work, not models; the editor routes them under the active policy. Aspect ratio and duration default from the project.',
    '- Each agent request shows the user a permission card with its cost. Respect the daily budget; a refusal explains the limit.',
    '- Takes appear in Assets › Generated takes. Place one only through an `editor_propose_patch` proposal, even when Auto-apply is enabled.',
    '- When the user has a source image, prefer editing it with `image.edit` or `image.composite` and `settings.referenceAssetIds` over generating from scratch.',
    '',
    '#### Scoring and narration',
    '- `music.scored` builds sections from the scenes; pass `settings.score` ({ sceneIds, seconds, styles, label? }[]) to adjust each section.',
    '- Set `settings.bpm` to steer the score tempo and compare scene cuts with downbeats.',
    '- `voice.narration` with `settings.lines` ({ sceneId, text }[]) makes one take per non-empty scene line; place the takes through a proposal.',
    '- The Generate tab has "Place at scenes" for narration; it anchors the takes to their scenes and ducks the music bed.',
    '',
    '#### Video',
    '- Use `video.generate` for text, `video.animate` for a still, `video.between` across a cut, `video.keyframes` for 3–10 pinned frames, `video.reference` for a consistent subject, and `video.long` for a longer clip or a document/web page.',
    '- Frames use `{assetId}` of a project image or `{projectFrame}` of the open video: set `settings.start` and `settings.end` to scene-boundary frames for a transition; keyframes pair `frame` with `atSeconds`.',
    '- Generated video arrives with its own audio off. Add music, voice or effects with the audio jobs and mix them in the editor.',
    '- Long clips and `settings.documentUrl` / `settings.webUrl` (public https URLs) go to Wan. Video defaults to 5 s and 1080p; pass the selected scene length as `settings.durationSeconds`.',
    '',
    '### Openverse (free music and SFX)',
    '',
    '- Use `editor_search_audio` { query, kind: "music"|"sfx", mood?, durationSeconds? } then `editor_add_audio` { id, role }. Only CC0 and CC BY are accepted; the server ignores any other license filter and rejects a direct file URL. Never use a paid library.',
    '- `kind: "music"` is a project-level bed: startFrame 0, duration trimmed to the video, 0.5 s fade-in and 1.5 s fade-out, volume 0.6. After placing it, `editor_get_beats` and cut on downbeats as above.',
    '- `kind: "sfx"` is scene-anchored at the playhead (or `sceneId` + `startFrame`). Prefer the built-in CC0 set for clicks/whooshes; use Openverse for specific recorded effects. Keep them quieter than voice and the bed.',
    '- Fit mood and tempo to the content: calm product demos want a sparse bed under 100 BPM; a punchy launch can take a short rhythmic loop. Trim with `trimStartFrames` / `durationInFrames`; fade the last 1–2 s. Duck under voice with the envelope recipe above.',
    '- `editor_list_credits` returns attribution lines. Export writes `credits.txt` next to the MP4. Tool output and credits say Made with Openverse.',
    '',
    '### Brand kits and reference videos',
    '',
    '- `editor_scan_brand { url }` fetches HTML and linked CSS (no JavaScript; timeouts and size caps). It ranks CSS-variable colours, lists fonts with bundled/system/licensable fallbacks, and saves the logo in cascade order (inline SVG → apple-touch-icon → og:image → favicon) without redrawing it. The returned `apply` object is a `setStyle` patch (`{ style: "project" }`); `propose: true` creates a reviewable proposal. `backgrounds: true` also paints unlocked scene backgrounds. Kit JSON is cached per domain under `public/analysis/brand/`; the logo is saved under `assets/uploads/brand/` so `addAsset` can attach it as a reference.',
    '- `editor_analyze_reference { path | url }` runs ffprobe/ffmpeg locally (yt-dlp for YouTube/X/Vimeo pages when installed). It returns specs, scene cuts, a shot list with time and frame ranges, 1 fps contact sheets, 2-frame strips for fast sections, a palette per shot, ebur128 loudness, a beat grid and onsets, and motion energy/holds. Artefacts live under `public/analysis/reference/`. Analysis only: never import the reference’s media. After you Read the sheets, write a directed brief and state every correction as an absolute value (not “a bit tighter”).',
    '',
  ];
}

const curve = (e: (typeof MOTION_PERSONALITIES)['snappy']['enter']) => (typeof e === 'string' ? e : `cubicBezier(${e.x1}, ${e.y1}, ${e.x2}, ${e.y2})`);
const band = (r: readonly [number, number]) => `${r[0]}–${r[1]}`;
const pct = (r: readonly [number, number]) => `${Math.round(r[0] * 100)}–${Math.round(r[1] * 100)} %`;

/** Motion direction rules, numbers from motionRules.ts and style.ts (craft v2). */
function craftSection(): string[] {
  const p = PRINCIPLES;
  return [
    `## Motion direction (${CRAFT_VERSION})`,
    '',
    'Rules for motion that looks directed, not just correct. Each rule: what → numbers → how to build it. Frames at 30 fps; scale by `fps / 30`.',
    'The six things a blind judge scores: hierarchy, timing, easing, overlap, readability, polish. A draft that is correct but small, static and top-left loses on all six; the rules below are the difference.',
    'The templates and presets already follow these rules: build with them (`editor_build_template`, `editor_build_motion`) and use the numbers below to judge and adjust, not to hand-place every element.',
    '',
    '### Story first (`project.story`)',
    '',
    `- Write the story before any motion: one idea, a hook in the first ${STORY.hookSeconds[0]}–${STORY.hookSeconds[1]} s (a claim, a picture or a move — not a logo or title card), audience, tension/setup, payoff in the last ~${Math.round(STORY.payoffShare * 100)} %, optional CTA or loop-back.`,
    `- Beat-by-beat script: \`story.beats\` [{ role: ${STORY_BEAT_ROLES.join('|')}, summary, sceneName, fromSeconds?, toSeconds? }] covering every scene. On approval the editor stamps sceneId and frames onto \`project.story\`.`,
    `- One idea per scene; average filled scene ≥ ${STORY.minSceneSeconds} s. A dead middle is an interior scene with no text/picture, or a unique-text-land gap > ${STORY.deadMiddleSeconds} s on a video ≥ ${STORY.deadMiddleMinSeconds} s.`,
    '- Then motion, then `editor_critique`. Story-structure and seam findings are warnings tied to frames; mapping findings fire only when `project.story.beats` is present.',
    '',
    '### Style pack first (`project.style`)',
    '',
    '- Read `project.style` before building: fonts (heading / body / mono), colour roles, motion personality. Use only its fonts and colours; accent on the one thing per beat that matters.',
    '- Multiply every duration by `motion.timingScale`; put `motion.enter` on the first key of each arrival and `motion.exit` on the first key of each departure; stagger siblings `motion.staggerFrames` apart; overshoot by `motion.overshoot`.',
    '- No style yet: for a new project include one in `editor_write_project` (`style`, copied from a pack below); for an existing one use `editor_scan_brand` (reviewable `setStyle` with `{ style: "project" }`) or ask the user to pick one in More → Style….',
    '',
    '| Personality | timing | stagger | overshoot | enter | exit | feel |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...PERSONALITY_IDS.map((id) => {
      const m = MOTION_PERSONALITIES[id];
      return `| ${id} | ${m.timingScale}× | ${m.staggerFrames} f | ${Math.round(m.overshoot * 100)} % | \`${curve(m.enter)}\` | \`${curve(m.exit)}\` | ${PERSONALITY_NOTES[id].feel} |`;
    }),
    '',
    'Shipped packs (copy as `style`):',
    '',
    ...STYLE_PACK_IDS.map((id) => {
      const pack = STYLE_PACKS[id];
      return `- \`${id}\` (${pack.motion.id}): ${STYLE_PACK_NOTES[id]} Fonts ${pack.fonts.heading} / ${pack.fonts.body}; background ${pack.colors.background}, surface ${pack.colors.surface}, text ${pack.colors.text}, muted ${pack.colors.muted}, accent ${pack.colors.accent}${pack.colors.accent2 ? `, accent2 ${pack.colors.accent2}` : ''}.`;
    }),
    '',
    `**House bar:** \`${HOUSE_PACK_ID}\` is the default quality bar for agent work (copy it unless the brief names another pack). ${craftLine(PULSE_CRAFT)} Critique thresholds come from the pack: 2–4 f pops are correct, cuts land +3 f after the beat, small type at 3–4 % of the frame is the look, and a true reading hold still applies to key lines. Compare a draft to \`docs/golden/pulse-reference.png\`. Presets \`snapPop\`, \`springIn\` and \`smear\` write those keys.`,
    '',
    '### Timing',
    '',
    `- Entrance length by role (frames, before timingScale; exits ≈ ${EXIT_RATIO}× as long). A single entry ≤ ${SEAM.maxEntrySeconds} s; longer buildup is a stagger of several elements, not one slow tween. Pulse pops are 2–4 f; a ${PULSE_CRAFT.cameraFrames.min}–${PULSE_CRAFT.cameraFrames.max} f ease-in-out camera or one-way drift is the hold, not a long entry:`,
    ...Object.entries(TIMING_BANDS).map(([role, b]) => `  - ${role} ${band(b.frames)}: ${b.what}`),
    `- Reading hold: once text has arrived, keep it still for words ÷ ${READING.wordsPerSecond} + ${READING.findSeconds} s (at least ${READING.minSeconds} s) before anything covers, moves or removes it.`,
    `- Scene length (s): ${Object.entries(SCENE_BANDS).map(([k, b]) => `${k} ${band(b)}`).join(', ')}. One idea per scene. With music, whole beats (120 BPM = 15 f).`,
    '',
    '### Easing',
    '',
    '- Arrivals ease OUT (fast in, soft landing); departures ease IN (soft start, fast out); moves between two on-screen places ease IN-OUT. Position and scale are never linear (linear only for slow constant drifts).',
    '- Opacity finishes in the first 40–60 % of an entrance (fade with an ease-out); the move carries the rest.',
    '',
    '### Anticipation, give, follow-through',
    '',
    `- Anticipation: before a big move, wind back ${pct(p.anticipation.travel)} of the travel over the first ${pct(p.anticipation.share)} of it (preset anticipateGo).`,
    `- Give (overshoot and settle): pass the mark by ${pct(p.overshoot.fraction)} (the pack's overshoot), swing back ≈ 30 % of that, settle within ${band(p.overshoot.settleFrames)} f (overshootSettle; popIn with a pack).`,
    `- Follow-through: group the parts; move the group; give each child an additive x (or y) track: trail ≈ 10 % of the travel at the start, ${pct(p.followThrough.amplitude)} past the stop, children ${band(p.followThrough.lagFrames)} f apart, back to 0 ≈ 9 f later (Insert → Follow-through).`,
    `- Squash on land: fall with ease-in (gravity), on contact scale to ${band(p.squash.scale)} for ${band(p.squash.frames)} f with y shifted down by height × (1 − scale) / 2 so the base stays planted, rebound ${band(p.squash.rebound)}, settle (squashLand).`,
    '- Arcs: living things travel on curves. Give x and y different curves (y easeOutExpo, x easeInOutCubic) instead of one straight tween (arcIn).',
    `- Hits: on a beat, ${p.hit.attackFrames}-frame attack to ${band(p.hit.scale)} scale, ${band(p.hit.decayFrames)} f decay; key it one frame before the beat (holdHit).`,
    '',
    '### Overlap: arrive apart',
    '',
    `- Siblings arrive ${STAGGER_FRAMES.min}–${STAGGER_FRAMES.max} f apart (the pack's staggerFrames): under ${STAGGER_FRAMES.min} reads as one block, over ${STAGGER_FRAMES.max} as separate events.`,
    '- Order: reading order (rows top to bottom, then left to right) by default; biggest first when importance differs; centre-out for symmetric layouts. Exits leave in the same order, faster.',
    '- Parts of one thing follow it 2–4 f behind (a card\'s icon, title and line after its plate). Never start everything on the same frame.',
    '',
    '### Staging and hierarchy',
    '',
    '- One hero per beat: while the hero moves, everything else holds still or steps back to 50–60 % opacity. The accent colour marks the hero only.',
    '- Eye path: the next thing to arrive appears where the eye already is (reading order; the next scene starts near where the last one ended).',
    `- Safe margins ${SAFE_MARGIN.min}–${SAFE_MARGIN.max} px at 1080 px on the short side (scale with the frame); nothing important outside them.`,
    `- Type at 1080: hero ${band(TYPE_SCALE.hero)} px, headline ${band(TYPE_SCALE.headline)}, title ${band(TYPE_SCALE.title)}, body ${band(TYPE_SCALE.body)} (never under ${TYPE_SCALE.minBodyPx}), captions ${band(TYPE_SCALE.caption)}. Headlines ≤ ${TYPE_SCALE.maxLineChars.headline} characters a line, body ≤ ${TYPE_SCALE.maxLineChars.body}.`,
    '',
    '### Never dead',
    '',
    `- No frame holds fully still for more than ${LIVENESS.maxStillSeconds} s inside a scene. The hero settles and stays readable; the scene breathes around it.`,
    `- During a reading hold keep secondary motion alive: a slow push or scale of ${pct(LIVENESS.push)} over the hold (a group \`scale\` track, ease in-out, from the hero's settle frame to the cut), a one-way drift of ${band(LIVENESS.driftPx)} px, parallax between layers (background slower than foreground), a background texture moving slowly (the \`backdrop\` template: scrolling lines, a grid or a gradient glow), a rule or underline drawing on, typing, counting, or chips arriving staggered. Purposeful drift is allowed; a looping sine (breathe / float / pulse) is filler — add story, not wobble.`,
    '- A screenshot on hold gets a slow push (scale 1 → 1.03–1.05 about the point of interest); a stat gets its chip; a headline gets its kicker rule and a drifting texture; an end card gets a breathing glow. Pick one or two, never all.',
    '',
    '### Use the frame',
    '',
    '- Compositions are centred or deliberately balanced; a block pinned where the first element happened to land ("default top-left") reads as unfinished. Decide what fills the other half: a texture, a screenshot, a glow, or a bigger hero.',
    `- The hero occupies a strong share of the frame: headline cap height ≥ ${Math.round(FRAME_USE.heroCapHeightShare * 100)} % of the frame height (≈ ${Math.round((FRAME_USE.heroCapHeightShare * 1080) / 0.72)} px at 1080 for a hero statement; wrap into two or three lines rather than shrinking), product screenshots ${pct(FRAME_USE.screenshotWidthShare)} of the frame width, with a treatment (glow, shadow, rounded corners, device frame) and allowed to bleed off one edge on purpose (bottom or side, never clipped mid-flight by accident).`,
    `- Empty space is intentional: at most ${Math.round(FRAME_USE.maxEmptyShare * 100)} % of a content scene is visually empty. A hook may be mostly type; a product scene is mostly product.`,
    '',
    '### Video-safe type (minimums at 1080; scale with the frame)',
    '',
    `- Eyebrows and labels ≥ ${TYPE_MIN.label} px (tracked caps ≥ ${TYPE_MIN.trackedCaps}), body and sublines ≥ ${TYPE_MIN.body}, callouts and chips ≥ ${TYPE_MIN.callout}, a button's label ≥ ${TYPE_MIN.ctaLabel}. A screenshot must be big enough that its own headline reads.`,
    `- Contrast ≥ ${TYPE_MIN.contrast}:1 for anything meant to be read: the punchline is in the text colour or the accent, never in the muted grey (muted is for captions the viewer may skip).`,
    '',
    '### Pacing',
    '',
    `- In a content scene something new lands every ${band(LIVENESS.newBeatSeconds)} s: the next element starts while the previous one settles (overlap), not after the hold. A scene whose last arrival is at 1 s and whose cut is at 5 s has 4 s of nothing: fill it with the secondary motion above or cut sooner.`,
    '- Reveal the hook text by text: words for the headline (wordStagger), then the punchline on its own beat at full contrast, then the kicker or texture. Chips and callouts arrive after the thing they point at, staggered.',
    '',
    '### Spotlight',
    '',
    `- To point at one stat or control in a screenshot: dim everything else to ${pct(SPOTLIGHT.dimTo)} (a scene-background rect over the screen, opacity 0 → 0.5 over 12 f, with an inverted mask cut to the region) and frame the region with a rounded rect in the accent that wipes on; a callout chip follows 6 f later. The uiWalkthrough template does this with \`spotlight: 1\`.`,
    '',
    '### Palette and brand discipline',
    '',
    '- Accents come only from the style pack\'s colour roles (accent, accent2). No new hues for highlights, chips or glows: use the accent at lower opacity instead.',
    '- The logo appears in the product scene (small, above the headline or in a corner) and on the end card at least. The end card is fully composed from the moment its hero lands: logo, line, button, all on screen within ~1 s of each other, then held alive (glow, push); never an empty glow or a button plate without its label.',
    '',
    '### Typography in motion',
    '',
    '- Reveal the unit people read: lines for statements (one text element per line, each rising its own height from behind a mask shape, 2 × stagger apart), words for headlines (wordStagger), characters only for 1–3 words or a number (charFadeUp, revealStagger 1–2 f).',
    '- Masked rise: a text with `mask: { sourceId: <rect shape, same parent, same box>, mode: \'alpha\' }` and a y track from +its height to 0 (the enter curve).',
    '- Animate tracking only on small caps kickers (letterSpacing 16 → 5 px over ≈ 0.9 s while fading in); never on body text. Change weight between lines, never mid-animation.',
    '',
    '### Transitions that keep the thread',
    '',
    '- A transition must carry something across the cut; otherwise cut hard on the beat.',
    '- Positional match: the same layout in the same place on both sides (kicker and line position) makes the cut read as a swap.',
    '- Match cut: the outgoing element accelerates (exit curve) halfway to the incoming element\'s box (centre and size); the incoming one starts exactly there and decelerates into place; scene transition none. Presets matchOut (push 1 → 1.25) and matchIn (0.8 → 1) do the same without a partner.',
    '- Colour match: end on a shape in the accent that fills the frame; start the next scene on that colour.',
    '- One take: in walkthroughs keep the screen still across steps and start each cursor where the last click was.',
    `- Across a cut, the outgoing and incoming heroes move along the same axis, in the same direction and at a similar speed, and you cut mid-motion on both sides (default direction: ${SEAM.current}). Coming to rest, cutting, then starting again from rest leaves a dead beat. A common slip is an exit that shrinks away followed by an entry that grows in.`,
    `- Pause before a climax: hold ${SEAM.stillnessSeconds[0]}–${SEAM.stillnessSeconds[1]} s after the last big move, then let the result land.`,
    '- Use a scene fade (6–10 f) only when nothing carries across.',
    '',
    '### Beat sync',
    '',
    '- With music, read the beats with `editor_get_beats` (beat markers): cut scenes on beats, land each hero\'s settle frame on a beat, key holdHit one frame before it. Scene lengths in whole beats.',
    '',
    '### Check your work',
    '',
    '- Before proposing: `editor_preview_patch` (`contactSheet: true`, or 4–8 `frames`: mid-entrance, settled, mid-hold, last frame) then `editor_critique` on the same patch. Fix the findings (they name frames). Usually 2–4 rounds, one fix pass each.',
    '- Critique covers holds, type floors, dead frames, two heroes, linear position, stagger, cuts off the beat, banned clichés it can prove (including gradient type, cyan neon, pure #000/#fff, identical card grids, left-edge stripes, back-and-forth idle loops), story structure, and cuts (coming to rest before a cut, axis/direction/speed changes, long entries). The sheet is for colour, crop, collisions and taste — things a number cannot see.',
    `- After the first sheet, pass new clichés to \`editor_critique { addBanned }\` and put the same list on \`project.banned\` when you write the draft.`,
    '- Fixes are absolutes: `fontSize` 32, hold 48 f, travel −80 px. Do not write "a bit bigger" or "make the dots finer".',
    '',
  ];
}

/** Outline flow, templates and motion presets, generated from their registries. */
function newVideoSection(): string[] {
  return [
    '## New videos: brief → outline → scenes',
    '',
    '- When the user describes a new video (the editor\'s "New video" dialog sends you their brief), pick a route from "Route the brief" above, then call `editor_propose_outline` once with { title, story, scenes: [{ name, purpose, durationSeconds, onScreenText?, visuals?, templateHints? }] } and stop. Write the story beats first (hook in 1–2 s, one idea, audience, tension, payoff, optional CTA/loop, every scene mapped to a beat and a time range) — do not build motion yet. It returns "awaiting the user\'s review"; nothing is created yet. The brief in that message is directed (GOAL / OUTPUT / ROUTE / TIME / LOOK / MOTION / SHOTS / STORY / BANNED / QA) with pack numbers — copy those numbers; do not replace them with adjectives.',
    '- The user edits the outline (rename, reorder, retime, delete, add, notes) and approves or declines it. `editor_get_context` reports it as `outline` { status: pending | approved | declined, title, scenes, targetSeconds, projectId? }.',
    '- On approval the editor creates and opens a new project with one empty scene per approved item (in order, with the approved lengths, brand files as assets and the chosen track as the music bed) and asks you to build it. With a music bed, read `editor_get_beats` before timing scenes. Build it scene by scene the way that message says: with Auto-apply off, `editor_propose_patch` (targets: [{ sceneId }]) one proposal at a time, waiting for each decision; with Auto-apply on, `editor_apply_patch` per scene straight through, then one contact sheet and critique over the whole video. Only ever change that project.',
    '',
    '### Building scenes',
    '',
    '1. Story is already written (`project.story`, stamped from the outline). Build motion to serve those beats; do not invent a new structure while placing elements.',
    '2. Build each scene from templates with `editor_build_template` (it holds to the cut unless you pass `seconds`): `kineticTitle` for the hook (with `sub` for the punchline); `uiWalkthrough` / `walkthroughStep` for the product (`imageAssetId`, `bleed`, `spotlight`, `chips`); `statReveal`, `featureGrid`, `beforeAfter`, `testimonial` as the story needs; `logoSting` with `cta` for the end card; a `backdrop` under content scenes that would otherwise hold still (narrow the title with `widthShare` to leave it room).',
    '   For a launch cut (beats hook → proof → turn → cta), start each scene from a cut card instead: `editor_list_cut_cards` lists twelve per beat (motion idea, why it works, copy slots); `editor_build_cut` { card, sceneId, slots } builds one into the scene with the user\'s copy and retimes the scene to it. Fill every slot with the user\'s copy; keep the card\'s motion.',
    '3. Add motion with `editor_build_motion`: a preset on an element, `arriveApart` on siblings, `followThrough` on a group, `matchCut` across a cut.',
    '4. Put the returned commands in one patch per scene and adjust text and timing there (updateElement on the returned ids).',
    '5. Look at it with `editor_preview_patch` (`contactSheet: true`), then `editor_critique` (same patch fields), fix the findings once, then `editor_propose_patch` (or `editor_apply_patch` when the build request says Auto-apply is on).',
    '',
    '### Templates (build with `editor_build_template`; the user inserts them from the Insert menu; name them in `templateHints`)',
    '',
    ...TEMPLATE_IDS.map((id) => `- \`${id}\` — ${TEMPLATES[id].label}: ${TEMPLATES[id].description} Params: ${[...Object.keys(TEMPLATES[id].params), 'seconds'].join(', ')}.`),
    '',
    '### Motion presets (house style for keyframes; build them with `editor_build_motion`)',
    '',
    'The editor\'s presets write ordinary keys; `editor_build_motion` returns them as commands, so your motion matches what the user applies by hand. Frames are element-local; lengths at 30 fps before the style\'s timingScale. Principle presets (marked ★) encode the motion direction rules below.',
    '',
    ...PRESET_IDS.map((id) => {
      const p = PRESETS[id];
      return `- ${p.principle ? '★ ' : ''}${PRESET_KIND_LABELS[p.kind]} · ${p.label}${p.seconds ? ` (${Math.round(p.seconds * 30)} frames)` : ''}: ${p.description}`;
    }),
    '- ★ Several layers · Arrive apart: one entrance on each, staggerFrames apart in reading order (Insert → Arrive apart on a multi-selection or a group; `arriveApart`).',
    '- ★ Group · Follow-through: the group slides in 200 px; its layers trail, carry on past the stop and settle (Insert → Follow-through; `followThrough`).',
    '- ★ Two scenes · Match cut: the outgoing element accelerates halfway to the incoming one\'s box, which picks up there and settles; the cut becomes hard (`matchCut`).',
    '',
  ];
}

/** Video elements: import, timing, audio, rendering. */
function videoElementsSection(): string[] {
  return [
    '## Video elements',
    '',
    '- Import a screen recording or b-roll with `editor_import_asset` (.mp4 H.264/AAC, .webm VP9/Opus, .mov H.264; up to 500 MB). The asset has `kind: "video"`, `durationInFrames` (at project fps), `width`/`height`, and `fps`/`hasAudio` when known; add it with an `addAsset` command. Files the browser cannot decode (HEVC, ProRes) are refused with the reason.',
    '- A `video` element plays its asset in the element box (`fit` cover/contain, `cornerRadius`). At element frame f it shows source frame `trimStartFrames + f × playbackRate` (project-fps frames from the file start), so "start at 12.5 s of the recording" is `trimStartFrames: 12.5 × fps`.',
    '- Without `loop`, `durationInFrames` must be ≤ (asset.durationInFrames − trimStartFrames) ÷ playbackRate; changing speed or the in-point may require shortening the element in the same patch. With `loop` the trimmed source repeats.',
    '- Sound: the soundtrack plays with the element (anchored to its scene, mixed into exports) at `volume` (0..1; animate it with `setPropertyKeyframe` key `props.volume`) unless `muted`. The user can Detach audio (`detachVideoAudio`), which mutes the element and adds an audio clip with the same file, in-point and timing.',
    '- Device frames: give the video a `cornerRadius`, or mask it with a rounded `shape` (`mask: { sourceId, mode: "alpha" }`); videos work in groups, instances, masks, effects and blend modes like any element.',
    '- To find the right moment in a recording, place the element, then check with `editor_render_frame` / `editor_render_contact_sheet` (they show the exact source frames the export will use) and adjust `trimStartFrames`.',
    '- The editor preview may play a lighter 720p proxy of large or variable-frame-rate files; renders and exports always read the original. An export, still or contact sheet is refused while a video element\'s file is missing or undecodable; the error names the element.',
    '',
  ];
}
