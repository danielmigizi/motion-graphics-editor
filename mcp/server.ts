// motion-editor MCP server (stdio). Claude Code launches it from .mcp.json; it
// starts the editor if needed and drives the open editor tab through the local
// server's agent bridge. stdout carries the MCP protocol only — log to stderr.

import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { DEFAULT_SERVER_PORT } from '../src/core/api-contract';
import { LocalEditor } from './local';
import { motionToolDescription, templateToolDescription } from './build';
import { createHandlers, schemas } from './tools';

const local = new LocalEditor({
  rootDir: fileURLToPath(new URL('..', import.meta.url)),
  serverPort: Number(process.env.MGE_SERVER_PORT ?? DEFAULT_SERVER_PORT),
  webPort: Number(process.env.MGE_WEB_PORT ?? 5317),
  openBrowser: process.env.MGE_OPEN_BROWSER !== '0',
});
const h = createHandlers(local);

const server = new McpServer(
  { name: 'motion-editor', version: '0.1.0' },
  {
    instructions: [
      'Tools for building and editing motion-graphics videos inside a live local editor the user is watching.',
      'Tool contract mge.tools/2: every result carries request and document identity in _meta. Pass docSession from editor_get_context with patches to reject edits to a reopened document.',
      'Start with editor_open, then editor_get_context (what the user has selected, their notes for you) and editor_guide (document format) once per session.',
      'Edits with editor_apply_patch normally become proposals for user review; editor_propose_patch always proposes. Check editor_proposal_status before building on a pending edit. Create full drafts with editor_write_project and check committed work with editor_render_frame.',
      'Use editor_preview_patch to validate and render a candidate without applying or proposing it; editor_render_contact_sheet checks several committed frames in one image; editor_critique returns frame-tied defects against motionRules and project.style.craft (reading holds, type size, dead frames, banned clichés including lazy defaults, cuts off the pack beat offset, story structure, scene-to-scene seams, baseline vs the Pulse house bar). Pulse 2–4 f pops and purposeful drift are in-style. editor_propose_patch prepends that critique (soft gate — it still proposes). editor_export_revision starts a committed MP4 export (pending proposals must first be decided); editor_inspect_job reads progress and manifests; editor_cancel_job cancels an active export. editor_get_beats returns the music bed’s tempo, beat, downbeat and strong-hit frames for timing cuts and hits. editor_search_audio / editor_inspect_audio / editor_add_audio find CC0 and CC BY music and SFX on Openverse (Made with Openverse) and place them as a bed or scene effect; editor_list_credits lists attributions (also written as credits.txt on export). editor_scan_brand fetches a public https page (HTML+CSS only) and returns a reviewable style-pack overlay; editor_analyze_reference runs local ffmpeg on a video (never imported) so you can Read contact sheets and write a directed brief with absolute numbers. editor_build_template and editor_build_motion turn the editor’s templates and motion presets into ready, validated patch commands against the live project (nothing applied): build scenes from them instead of hand-placing every element. editor_get_project, editor_focus, editor_save and editor_import_asset complete the tool set.',
      'Use editor_generation_models, editor_generate, editor_generation_status and editor_cancel_generation to generate media through the editor’s fal studio; each request asks permission with its cost, respects the daily budget, and returns takes to place only with editor_propose_patch.',
      'For a new video from a brief, propose an outline with editor_propose_outline and wait for the user to approve it; the editor then fills the open blank project and asks you to build it scene by scene.',
      'Never change locked scenes, and never discard the user’s unsaved changes without asking.',
      'editor_get_context lists reference assets (style frames, brand images) under references, with file paths you can look at; never place a reference in the video.',
    ].join(' '),
  },
);

server.registerTool('editor_generation_models', {
  title: 'List generation models',
  description: 'List the editor’s fal generation job kinds, routed defaults, alternatives and prices, with the active policy, daily spend and whether a key is configured.',
  inputSchema: schemas.generationModels,
  annotations: { readOnlyHint: true },
}, h.editor_generation_models);

server.registerTool('editor_generate', {
  title: 'Generate media',
  description: 'Generate images, music, voice or recorded-sounding effects through the editor’s fal studio. Draw text, charts, UI, shapes, logos and motion with code. Waits for the user’s permission card with its cost and respects the daily budget. Takes land in Assets › Generated takes; place them only with editor_propose_patch. Poll editor_generation_status for outputs.',
  inputSchema: schemas.generate,
  annotations: { openWorldHint: true, destructiveHint: false },
}, h.editor_generate);

server.registerTool('editor_generation_status', {
  title: 'Check generation status',
  description: 'Inspect one generation job, or all jobs for the open project: status, elapsed time, costs, errors and completed output asset JSON for a placement proposal.',
  inputSchema: schemas.generationStatus,
  annotations: { readOnlyHint: true },
}, h.editor_generation_status);

server.registerTool('editor_cancel_generation', {
  title: 'Cancel generation',
  description: 'Cancel a generation job through the editor’s fal studio. Reports the resulting status; completed jobs remain completed.',
  inputSchema: schemas.cancelGeneration,
  annotations: { openWorldHint: true, destructiveHint: false },
}, h.editor_cancel_generation);

server.registerTool('editor_permission_prompt', {
  title: 'Ask the user for permission',
  description: 'Claude Code permission callback: relay a tool permission decision to the user in the editor.',
  inputSchema: schemas.permissionPrompt,
}, h.editor_permission_prompt);

server.registerTool(
  'editor_open',
  {
    title: 'Open the editor',
    description: 'Start the editor and local server if they are not running, open it in the browser when possible, and optionally open a saved project. Reports whether a browser tab is connected.',
    inputSchema: schemas.open,
  },
  h.editor_open,
);

server.registerTool(
  'editor_get_context',
  {
    title: 'What the user sees',
    description:
      'The live editor context: project id/name/revision, unsaved state, Auto-apply setting, pending proposal and recent outcomes, playhead (frame, timecode, scene), the selected scene and element (full element JSON), the user’s notes for you (things they pointed at and asked for, each with its target), an outline of scenes, elements, assets and audio, and untouched: true when the open project has no element, asset, clip or marker yet (a blank project made for a new video). Call before editing; "this"/"here" in the user’s words refers to the selection and playhead.',
    inputSchema: schemas.empty,
    annotations: { readOnlyHint: true },
  },
  h.editor_get_context,
);

server.registerTool(
  'editor_get_project',
  {
    title: 'Get the full project',
    description: 'The complete live project document as JSON (including unsaved edits).',
    inputSchema: schemas.empty,
    annotations: { readOnlyHint: true },
  },
  h.editor_get_project,
);

server.registerTool(
  'editor_guide',
  {
    title: 'Authoring guide',
    description: 'How the project document works: timing, layout and animation model, every component and its props, patch commands and rules, a minimal valid project, and craft notes. Read once per session before editing.',
    inputSchema: schemas.empty,
    annotations: { readOnlyHint: true },
  },
  h.editor_guide,
);

server.registerTool(
  'editor_apply_patch',
  {
    title: 'Apply an edit',
    description:
      'Apply a targeted edit to the open project. Applies immediately only when the user has turned on Auto-apply; otherwise creates a proposal the user reviews. Rejected whole if stale, outside its targets, touching a locked scene, or invalid. Returns the applied revision or pending proposal and field-level changes.',
    inputSchema: schemas.applyPatch,
  },
  h.editor_apply_patch,
);

server.registerTool(
  'editor_propose_patch',
  {
    title: 'Propose an edit',
    description: 'Create a non-committing proposal for a targeted edit, even when Auto-apply is on. The editor shows the rendered Current/Proposed comparison for the user to Apply or Cancel. Prepends a deterministic critique of the candidate (soft gate — it still proposes). A newer proposal replaces your pending one; check its outcome before building on it.',
    inputSchema: schemas.applyPatch,
  },
  h.editor_propose_patch,
);

server.registerTool(
  'editor_proposal_status',
  {
    title: 'Check a proposal',
    description: 'Read the pending proposal and recent outcomes, or look up one proposal by id: whether the user applied or declined it, or it became stale or was replaced.',
    inputSchema: schemas.proposalStatus,
    annotations: { readOnlyHint: true },
  },
  h.editor_proposal_status,
);

server.registerTool(
  'editor_write_project',
  {
    title: 'Write a whole project',
    description:
      'Validate a complete project, save it on the local server and open it in the editor. Use for new drafts and for structural changes patches cannot make (adding or reordering scenes). Opening resets undo history. Refuses to replace an existing saved project unless overwrite is set, and refuses when the editor has unsaved changes unless discardUnsaved is set.',
    inputSchema: schemas.writeProject,
  },
  h.editor_write_project,
);

server.registerTool(
  'editor_render_frame',
  {
    title: 'Look at frames',
    description: 'Render frames of the live project to PNG with the export renderer and return them as images, so you can check layout, legibility and motion. The first call after the server starts bundles the composition (about 20 s).',
    inputSchema: schemas.renderFrame,
    annotations: { readOnlyHint: true },
  },
  h.editor_render_frame,
);

server.registerTool('editor_preview_patch', {
  title: 'Preview an edit',
  description: 'Validate a patch locally against the live committed project and render its candidate without sending an editor command, committing, or creating a proposal. Supply up to 8 frames, or use a contact sheet of first/midpoint frames of touched scenes (up to 12). Images are labelled as uncommitted previews at their base revision.',
  inputSchema: { ...schemas.applyPatch, ...schemas.preview },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
}, h.editor_preview_patch);

server.registerTool('editor_render_contact_sheet', {
  title: 'Look at a contact sheet',
  description: 'Render one labelled image of up to 24 frames of the live committed project. Defaults to 25% and 75% of each scene (up to 24 frames). Returns frame/timecode/scene labels, revision and project hash.',
  inputSchema: schemas.contactSheet,
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
}, h.editor_render_contact_sheet);

server.registerTool('editor_critique', {
  title: 'Critique motion',
  description:
    'Deterministic motion and story critique of the live project (or of a patch’s candidate, same fields as editor_preview_patch). Findings are frame-tied defects from motionRules and project.style.craft: reading holds, type below video-safe size, dead frames, two heroes moving at once, linear position easing, cuts off the pack beat offset, seeded banned clichés the document can prove (including gradient type, cyan neon, pure #000/#fff, identical card grids, idle loops), story structure (no hook in the first 1.5–2 s, logo/title-card open, too many ideas, dead middle, no payoff, unresolved end, unmapped scenes when project.story.beats is set), scene-to-scene seams (settle-then-cut, axis/direction/speed, long entries — Pulse camera/drift is the hold, not an error), and baseline notes vs the pack (pop duration, stagger, drift, dead frames, type share, palette count). Pulse 2–4 f pops are in-style. Pass addBanned after the first contact sheet; extras stick for this MCP session and merge with project.banned. Read-only: nothing is applied or proposed. Call it before editor_propose_patch; propose also prepends a critique (soft gate).',
  inputSchema: schemas.critique,
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
}, h.editor_critique);

server.registerTool('editor_export_revision', {
  title: 'Export the committed revision',
  description: 'Start an MP4 export of the live committed document, including unsaved committed edits. Refuses while a proposal awaits review. Returns job id, revision and projectHash; use editor_inspect_job for progress and output.',
  inputSchema: schemas.empty,
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, h.editor_export_revision);

server.registerTool('editor_inspect_job', {
  title: 'Inspect an export',
  description: 'Read one export job by id, or the newest five. Reports status, progress, rendered/encoded frames, revision, hash, output URL, errors and manifest assets/fonts/renderer/git summary when available.',
  inputSchema: schemas.inspectJob,
  annotations: { readOnlyHint: true, openWorldHint: false },
}, h.editor_inspect_job);

server.registerTool('editor_cancel_job', {
  title: 'Cancel an export',
  description: 'Cancel an active MP4 export by job id. Reports the server message when the job does not exist or is already terminal and cannot be cancelled.',
  inputSchema: schemas.cancelJob,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
}, h.editor_cancel_job);

server.registerTool(
  'editor_focus',
  {
    title: 'Point at something',
    description: 'Move the editor playhead and/or select a scene or element, so the user sees what you are talking about.',
    inputSchema: schemas.focus,
  },
  h.editor_focus,
);

server.registerTool(
  'editor_save',
  {
    title: 'Save',
    description: 'Save the open project to the local server (same as the Save button).',
    inputSchema: schemas.empty,
  },
  h.editor_save,
);

server.registerTool(
  'editor_get_beats',
  {
    title: 'Read the music’s beats',
    description:
      'Tempo (BPM), beat grid, downbeats (bar starts), strong hits and onsets of the music bed — or of a given audio clip, or an audio asset not placed yet — as frames on the project timeline (within the clip’s trim and timing), plus how far each scene cut sits from the nearest beat and downbeat, and the project markers. Use it to cut scenes on downbeats and land entrances and sound effects on beats. Read-only; the analysis is cached per file.',
    inputSchema: schemas.getBeats,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  h.editor_get_beats,
);

server.registerTool(
  'editor_build_template',
  {
    title: 'Build a template',
    description: templateToolDescription(),
    inputSchema: schemas.buildTemplate,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  h.editor_build_template,
);

server.registerTool(
  'editor_build_motion',
  {
    title: 'Build motion',
    description: motionToolDescription(),
    inputSchema: schemas.buildMotion,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  h.editor_build_motion,
);

server.registerTool(
  'editor_list_cut_cards',
  {
    title: 'List cut cards',
    description: 'The cut-card catalog: twelve cards per beat (hook, proof, turn, cta), each a recipe over the editor\'s templates with named copy slots, its motion idea, why it works, its mechanics and what to swap in. One card per beat makes a launch cut. Read-only.',
    inputSchema: schemas.listCutCards,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  h.editor_list_cut_cards,
);

server.registerTool(
  'editor_build_cut',
  {
    title: 'Build a cut card',
    description: 'Build one cut card into a scene of the open project with the user\'s copy in its slots — its templates built against the live project, style pack, assets, size and fps — and return ready editor_propose_patch arguments, validated, with the new element ids. It retimes the scene to the card\'s designed length unless fitScene is false. Read-only: nothing is applied or proposed. Keep the card\'s motion (its "why"); change copy, not choreography.',
    inputSchema: schemas.buildCut,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  h.editor_build_cut,
);

server.registerTool(
  'editor_import_asset',
  {
    title: 'Import a file',
    description: 'Upload a local image, SVG or audio file (reference art, logo, music), or download a generated file from an https URL (image, SVG, audio or video, up to 200 MB, e.g. a generator result), and get back a ready Asset object. Pass provenance for generated files (provider, providerRefs with the provider ids, model, prompt, requestId shared by every take) and reference: true for style frames. Add it with addAsset in editor_propose_patch so the user reviews the placement.',
    inputSchema: schemas.importAsset,
  },
  h.editor_import_asset,
);

server.registerTool(
  'editor_search_audio',
  {
    title: 'Search free music and SFX',
    description:
      'Search Openverse for CC0 and CC BY music beds and sound effects (never NC/SA/ND or paid sources). Filter by query, optional mood, kind (music|sfx), and preferred duration. Returns id, title, creator, duration, license, attribution and preview URL. Made with Openverse. Then editor_inspect_audio or editor_add_audio.',
    inputSchema: schemas.searchAudio,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  h.editor_search_audio,
);

server.registerTool(
  'editor_inspect_audio',
  {
    title: 'Inspect a free track',
    description:
      'Load one Openverse work by id: duration, license, attribution, creator, source page and preview URL. The server refuses anything that is not CC0 or CC BY. Direct file URLs are rejected. Made with Openverse.',
    inputSchema: schemas.inspectAudio,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  h.editor_inspect_audio,
);

server.registerTool(
  'editor_add_audio',
  {
    title: 'Add a free track to the video',
    description:
      'Download (and cache) an Openverse work and patch it into the open project as a music bed (role: music, project-level) or a scene SFX (role: sfx, scene-anchored). License is re-checked server-side: only CC0 and CC BY. Uses addAsset + addAudioClip. After a bed, call editor_get_beats and duck under voice. Made with Openverse.',
    inputSchema: schemas.addAudio,
  },
  h.editor_add_audio,
);

server.registerTool(
  'editor_list_credits',
  {
    title: 'List audio credits',
    description:
      'Attribution lines for licensed audio in the open project (Openverse CC0/CC BY and any other stored license). Export also writes credits.txt next to the MP4. Mentions Made with Openverse when that catalog was used.',
    inputSchema: schemas.empty,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  h.editor_list_credits,
);

server.registerTool(
  'editor_scan_brand',
  {
    title: 'Scan a brand kit',
    description:
      'Fetch a public https page and its linked CSS (read-only, no JavaScript) and extract a brand kit: ranked colours (CSS variables first), fonts with weights and bundled/system/licensable fallbacks, and a logo (inline SVG → apple-touch-icon → og:image → favicon; never redrawn). Cached per domain under public/analysis/brand/. Returns the kit plus a setStyle overlay ({ style: "project" }). Pass propose: true to create a reviewable, undoable proposal; backgrounds: true also paints unlocked scene backgrounds.',
    inputSchema: schemas.scanBrand,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  h.editor_scan_brand,
);

server.registerTool(
  'editor_analyze_reference',
  {
    title: 'Analyse a reference video',
    description:
      'Run ffprobe/ffmpeg on a local video file or https URL (yt-dlp for YouTube/X/Vimeo pages when installed; otherwise a direct mp4/webm/mov). Returns specs, scene cuts, a shot list with time and frame ranges, 1 fps contact sheets plus dense 2-frame strips for fast sections, a palette per shot, ebur128 loudness, a beat grid and onsets, and motion energy/holds. Deterministic and cached under public/analysis/reference/. Analysis only — never import the source into a project. Read the contact sheets and write a directed brief; state every correction as an absolute value.',
    inputSchema: schemas.analyzeReference,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  h.editor_analyze_reference,
);

server.registerTool(
  'editor_propose_outline',
  {
    title: 'Propose an outline',
    description:
      'Propose the outline of a new video (title, story beats, and scenes with purpose, duration, on-screen text, visuals and template hints) for the user to review in the editor. Write the story (hook, one idea, tension, payoff, optional CTA, beats mapped to scenes and seconds) before any motion. Returns at once with "awaiting the user\'s review"; the user edits it and approves or declines. On approval the editor fills the open project, stamps story onto project.story, and asks you to build it. Read the decision and the edited outline from editor_get_context (outline field).',
    inputSchema: schemas.proposeOutline,
  },
  h.editor_propose_outline,
);

await server.connect(new StdioServerTransport());
console.error(`[motion-editor] MCP server ready (local server http://127.0.0.1:${local.cfg.serverPort}, editor ${local.editorUrl})`);
