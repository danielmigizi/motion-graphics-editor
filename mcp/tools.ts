// Tool handlers for the motion-editor MCP server. Kept free of MCP transport
// code so tests can call them against a real local server.

import { readAgentFile } from '../server/local-file';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import type { BridgeReply, ContactSheetResponse, EditorStateResponse, FrameIdentity, OpenverseAudioHit, OpenverseImportResponse, OpenverseSearchResponse, ProposalSummary, RenderJob, RenderManifest, StillResponse, UploadAssetResponse } from '../src/core/api-contract';
import { buildAuthoringGuide } from '../src/core/guide';
import { splitMcpTool, type ImportUrlResponse } from '../src/core/generation';
import { JOB_KINDS, formatUsd, type GenerateRequest, type GenerationJob, type GenerationModelsResponse, type GenerationScoreboard, type GenerationStatus } from '../src/core/generationStudio';
import { AssetProvenanceSchema } from '../src/core/schema';
import { createDocState } from '../src/core/history';
import { newId } from '../src/core/ids';
import { draftOf, formatSeconds, outlineSceneFields, outlineSeconds, outlineStoryBeatFields, outlineStoryFields, outlineTitleField, parseOutline, OUTLINE_LIMITS } from '../src/core/outline';
import { TEMPLATE_IDS, type TemplateId } from '../src/core/templates';
import { PRESET_IDS, type PresetId } from '../src/core/presets';
import { buildCutCommands, buildMotionCommands, buildResultText, buildTemplateCommands, cutCardsText, MOTION_IDS, type CutArgs, type MotionArgs, type TemplateArgs } from './build';
import { CUT_BEATS, type CutBeat } from '../src/core/cutCards';
import { critiqueProject, formatCritique, mergeBanned, type CritiqueBeats } from '../src/core/critique';
import { checkPatch, isSceneTarget } from '../src/core/patch';
import { audioClipStartFrame, formatTimecode, locateFrame, projectDurationInFrames, sceneStartFrames } from '../src/core/timing';
import { sourceToProjectFrames, type BeatsResponse } from '../src/core/beats';
import { PATCH_PROTOCOL } from '../src/core/types';
import { formatCreditsFile, projectAudioCredits } from '../src/core/credits';
import { OPENVERSE_NOTICE } from '../src/core/openverseLicense';
import { openverseAssetFromImport, openverseAssetId, openverseClipCommands, openverseClipId } from '../src/core/openverseClip';
import { brandStyleCommands, logoAssetFromPath } from '../src/core/brand-kit';
import { REFERENCE_NOTICE, type ReferenceReport } from '../src/core/reference-video';
import type { BrandScanResult } from '../server/brand-scan';
import type { AiPatch, Asset, AssetProvenance, AudioClip, ChangeEntry, Command, Project, ProjectFile, TouchedRef } from '../src/core/types';
import { validateProject } from '../src/core/validate';
import { projectHash } from '../server/manifest';
import { LocalApiError, type LocalEditor } from './local';

type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
export interface ToolResult {
  content: Content[];
  isError?: boolean;
  _meta?: {
    'mge/contract': 'mge.tools/2';
    'mge/requestId': string;
    'mge/projectId'?: string;
    'mge/revision'?: number;
    'mge/docSession'?: string;
  };
  [key: string]: unknown;
}

const text = (t: string): ToolResult => ({ content: [{ type: 'text', text: t }] });
const fail = (t: string): ToolResult => ({ content: [{ type: 'text', text: t }], isError: true });
const json = (v: unknown) => JSON.stringify(v, null, 2);
export const TOOL_CONTRACT = 'mge.tools/2' as const;

type PatchArgs = { baseRevision: number; summary: string; targets: AiPatch['targets']; commands: unknown[]; reconcile?: boolean; docSession?: string };
type CritiqueArgs = {
  sceneIds?: string[];
  addBanned?: string[];
  baseRevision?: number;
  summary?: string;
  targets?: AiPatch['targets'];
  commands?: unknown[];
  reconcile?: boolean;
  docSession?: string;
};
type ResultIdentity = { projectId?: string; revision?: number; docSession?: string };

const stateIdentity = (state: EditorStateResponse): ResultIdentity => ({
  projectId: state.project?.id ?? state.context?.projectId,
  revision: state.project?.revision ?? state.context?.revision,
  docSession: state.context?.docSession,
});
const jobIdentity = (job: RenderJob): ResultIdentity => ({ projectId: job.projectId, revision: job.projectRevision, docSession: undefined });

function buildPatch(project: Project, args: PatchArgs): AiPatch {
  return { protocol: PATCH_PROTOCOL, projectId: project.id, baseRevision: args.baseRevision, summary: args.summary, targets: args.targets, commands: args.commands as Command[] };
}

function staleSession(state: EditorStateResponse, args: PatchArgs): ToolResult | null {
  return args.docSession !== undefined && args.docSession !== state.context?.docSession
    ? fail('STALE_SESSION: the editor opened another document since you read it; re-read context') : null;
}

function frameLine(project: Project, frame: number): string {
  const loc = locateFrame(project, frame);
  return `Frame ${frame} (${formatTimecode(frame, project.fps)}) — scene "${loc?.scene.name}" frame ${loc?.frameInScene}`;
}

function identityLine(identity: FrameIdentity): string {
  const kind = identity.kind === 'proposal' && identity.proposalId === 'preview' ? 'proposal/preview' : identity.kind;
  return `${kind}, ${identity.kind === 'proposal' ? 'base ' : ''}r${identity.revision}, hash ${identity.projectHash.slice(0, 12)}, renderer ${identity.rendererVersion}, frame ${identity.frame}`;
}

function frameError(project: Project, frames: number[], max: number): ToolResult | null {
  const total = projectDurationInFrames(project);
  if (!frames.length || frames.length > max) return fail(`frames must contain 1 to ${max} frames.`);
  const bad = frames.find((f) => !Number.isInteger(f) || f < 0 || f >= total);
  return bad !== undefined ? fail(`Frame ${bad} is invalid; the project has frames 0–${total - 1}.`) : null;
}

function sampleFrames(project: Project, fractions: number[], sceneIds?: Set<string>, max = 24): number[] {
  const starts = sceneStartFrames(project);
  return [...new Set(project.scenes.flatMap((scene, i) => !sceneIds || sceneIds.has(scene.id)
    ? fractions.map((f) => starts[i] + Math.min(scene.durationInFrames - 1, Math.floor(scene.durationInFrames * f))) : []))].slice(0, max);
}

function replyError(reply: Extract<BridgeReply, { ok: false }>, what: string): ToolResult {
  const e = reply.error;
  return fail([`${what} failed: [${e.code}] ${e.message}`, e.path && `at ${e.path}`, e.hint].filter(Boolean).join('\n'));
}

function formatValue(v: unknown): string {
  const s = JSON.stringify(v);
  return s === undefined ? '—' : s.length > 80 ? `${s.slice(0, 77)}...` : s;
}

function changeLines(changes: ChangeEntry[] = []): string {
  const shown = changes.slice(0, 40).map((c) => `- ${c.label}: ${c.change === 'modified' ? `${formatValue(c.before)} → ${formatValue(c.after)}` : c.change}`);
  if (changes.length > shown.length) shown.push(`- … and ${changes.length - shown.length} more`);
  return shown.join('\n');
}

/** Who is driving this MCP server (set by the editor chat per agent; Claude Code from .mcp.json otherwise). */
const AGENT = process.env.MGE_AGENT_LABEL || 'Claude Code';
const MODEL = process.env.MGE_AGENT_MODEL || undefined;

function proposalLine(p: ProposalSummary): string {
  const outcome = p.status === 'pending' ? "Still waiting for the user's review"
    : p.status === 'applied' ? `Applied by the user as r${p.revision}`
    : p.status === 'cancelled' ? 'Declined by the user (cancelled)'
    : p.status === 'stale' ? `Stale: ${p.reason ?? 'The targets changed.'}`
    : `Replaced: ${p.reason ?? 'A newer proposal took its place.'}`;
  return `- ${p.id} (${p.agent}) "${p.summary}" [${p.status}]: ${outcome}${p.decidedAt !== undefined ? `; decidedAt ${new Date(p.decidedAt).toISOString()}` : ''}`;
}

/** Plain description for the CLI's permission callback, including unknown tools. */
export function permissionDescription(tool: string, input: Record<string, unknown>): string {
  const str = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '');
  const short = (v: string, max = 160) => (v.length > max ? `${v.slice(0, max - 1)}…` : v);
  const path = str('file_path') || str('notebook_path');
  const at = path ? ` “${path}”` : '';
  if (tool === 'Read') return `Read file${at}`;
  if (tool === 'Write') return `Write file${at}`;
  if (tool === 'Edit' || tool === 'MultiEdit' || tool === 'NotebookEdit') return `Edit file${at}`;
  if (tool === 'Bash') return str('command') ? `Run a terminal command: ${short(str('command'))}` : 'Run a terminal command';
  if (tool === 'WebFetch') return str('url') ? `Fetch ${short(str('url'))}` : 'Fetch a web page';
  if (tool === 'WebSearch') return str('query') ? `Search the web for “${short(str('query'))}”` : 'Search the web';
  if (tool === 'Task' || tool === 'Agent') return str('description') ? `Start a subagent: ${short(str('description'))}` : 'Start a subagent';
  if (tool === 'Skill') return str('skill') ? `Use the skill “${str('skill')}”` : 'Use a skill';
  const mcp = splitMcpTool(tool);
  if (mcp) return `Use “${mcp.name}” from the MCP server ${mcp.prefix.slice('mcp__'.length)}`;
  return `Use tool “${tool}”`;
}

const NO_EDITOR = 'No editor is connected. Call editor_open first; if it reports no tab connected, ask the user to open the editor URL in their browser.';

async function liveState(local: LocalEditor): Promise<EditorStateResponse & { project: Project }> {
  let state: EditorStateResponse;
  try {
    state = await local.state();
  } catch {
    throw new Error('The editor server is not running. Call editor_open to start it.');
  }
  if (!state.project || !state.context) throw new Error(NO_EDITOR);
  return state as EditorStateResponse & { project: Project };
}

/** An asset as agents see it in the context outline. */
function assetLine(a: Asset) {
  const p = a.provenance;
  return {
    id: a.id, kind: a.kind, name: a.name,
    ...(a.reference ? { reference: true } : {}),
    ...(p?.source === 'generated' ? { generated: { provider: p.provider, model: p.model, requestId: p.requestId, providerRefs: p.providerRefs } } : {}),
    ...(p?.source === 'openverse' || p?.license ? { license: p.license, source: p.source, provider: p.provider } : {}),
  };
}

/** A compact, agent-oriented view of what the user is looking at. `publicDir` makes reference paths readable files. */
export function describeContext(state: EditorStateResponse & { project: Project }, editorUrl: string, publicDir?: string, extraBanned?: readonly string[]) {
  const { project, context } = state;
  const ctx = context!;
  const starts = sceneStartFrames(project);
  const loc = locateFrame(project, ctx.playhead);
  const scene = project.scenes.find((s) => s.id === ctx.selection.sceneId) ?? null;
  const element = scene?.elements.find((e) => e.id === ctx.selection.elementId) ?? null;
  const names = new Map<string, string>();
  for (const s of project.scenes) {
    names.set(s.id, s.name);
    for (const e of s.elements) names.set(e.id, e.name);
  }
  return {
    contract: TOOL_CONTRACT,
    docSession: ctx.docSession,
    editor: { connected: state.connected, url: editorUrl, lastReport: state.updatedAt },
    project: {
      id: project.id,
      name: project.name,
      revision: project.revision,
      unsavedChanges: ctx.dirty,
      fps: project.fps,
      size: `${project.width}x${project.height}`,
      durationInFrames: projectDurationInFrames(project),
      durationSeconds: +(projectDurationInFrames(project) / project.fps).toFixed(2),
    },
    playhead: {
      frame: ctx.playhead,
      timecode: formatTimecode(ctx.playhead, project.fps),
      playing: ctx.playing,
      sceneId: loc?.scene.id ?? null,
      sceneFrame: loc?.frameInScene ?? null,
    },
    editMode: ctx.editMode,
    ...(ctx.autoApply !== undefined ? { autoApply: ctx.autoApply } : {}),
    ...(ctx.proposal !== undefined ? { proposal: ctx.proposal } : {}),
    ...(ctx.proposalLog !== undefined ? { recentProposals: ctx.proposalLog.slice(0, 5) } : {}),
    ...(ctx.outline ? { outline: ctx.outline } : {}),
    selection: element
      ? { sceneId: scene!.id, sceneName: scene!.name, element: { ...element, elementFrame: (loc?.frameInScene ?? 0) - element.startFrame } }
      : scene
        ? { sceneId: scene.id, sceneName: scene.name, element: null }
        : null,
    notes: ctx.requests.map((r) => ({
      ...r,
      sceneName: names.get(r.sceneId) ?? '(deleted scene)',
      elementName: r.elementId ? (names.get(r.elementId) ?? '(deleted element)') : undefined,
      target: r.elementId ? { sceneId: r.sceneId, elementId: r.elementId } : { sceneId: r.sceneId },
    })),
    scenes: project.scenes.map((s, i) => ({
      id: s.id,
      name: s.name,
      startFrame: starts[i],
      durationInFrames: s.durationInFrames,
      locked: s.locked,
      transitionIn: s.transitionIn,
      elements: s.elements.map((e) => ({ id: e.id, name: e.name, type: e.type, startFrame: e.startFrame, durationInFrames: e.durationInFrames })),
    })),
    assets: Object.values(project.assets).map(assetLine),
    // Style frames, brand images, music references: steer generation, never placed in the video.
    references: Object.values(project.assets).filter((a) => a.reference).map((a) => ({ id: a.id, name: a.name, kind: a.kind, path: publicDir ? join(publicDir, a.src) : a.src })),
    audio: project.audio.map((c) => ({
      id: c.id, name: c.name, assetId: c.assetId, sceneId: c.sceneId, startFrame: c.startFrame, trimStartFrames: c.trimStartFrames, durationInFrames: c.durationInFrames,
      volume: c.volume, fadeInFrames: c.fadeInFrames, fadeOutFrames: c.fadeOutFrames, ...(c.volumeEnvelope?.length ? { volumeEnvelopePoints: c.volumeEnvelope.length } : {}),
    })),
    banned: mergeBanned(project, extraBanned),
  };
}

/** The clip (or unplaced asset) editor_get_beats analyses: the asked one, else the music bed. */
export function pickBeatsSource(project: Project, args: { clipId?: string; assetId?: string; src?: string }): { clip: AudioClip | null; asset: Asset } | { error: string } {
  if (args.src !== undefined) {
    // A file not in the project yet (e.g. just imported with editor_import_asset).
    return { clip: null, asset: { id: '(not in the project)', kind: 'audio', name: basename(args.src), src: args.src, mimeType: '' } };
  }
  // Something with sound: an audio file, or a video's soundtrack (a detached video's clip plays the video file; the decoder extracts its audio).
  const soundAsset = (id: string) => {
    const a = Object.prototype.hasOwnProperty.call(project.assets, id) ? project.assets[id] : undefined;
    return a && (a.kind === 'audio' || (a.kind === 'video' && a.hasAudio !== false)) ? a : undefined;
  };
  if (args.clipId !== undefined) {
    const clip = project.audio.find((c) => c.id === args.clipId);
    if (!clip) return { error: `Audio clip ${args.clipId} is not in the project. Clips: ${project.audio.map((c) => `${c.id} "${c.name}"`).join(', ') || 'none'}.` };
    const asset = soundAsset(clip.assetId);
    return asset ? { clip, asset } : { error: `Clip ${clip.id} uses ${clip.assetId}, which is not an audio asset (or a video with sound) in the project.` };
  }
  if (args.assetId !== undefined) {
    const asset = soundAsset(args.assetId);
    return asset ? { clip: null, asset } : { error: `${args.assetId} is not an audio asset (or a video with sound) in the project.` };
  }
  const beds = project.audio.filter((c) => !c.sceneId && soundAsset(c.assetId)).sort((a, b) => b.durationInFrames - a.durationInFrames);
  if (!beds.length) {
    const audio = Object.values(project.assets).filter((a) => a.kind === 'audio');
    return { error: `The project has no music bed (no project-level audio clip).${audio.length ? ` Audio assets: ${audio.map((a) => `${a.id} "${a.name}"`).join(', ')} — pass assetId to analyse one before placing it.` : ' Import a track with editor_import_asset first.'}` };
  }
  return { clip: beds[0], asset: soundAsset(beds[0].assetId)! };
}

/** Beats of a clip on the project timeline (or of an unplaced asset in source frames), with scene cuts measured against them. */
export function beatsReport(project: Project, beats: BeatsResponse, asset: Asset, clip: AudioClip | null) {
  const fps = project.fps;
  const start = clip ? audioClipStartFrame(project, clip) : 0;
  const map = (frames: number[]) => (clip ? sourceToProjectFrames(frames, start, clip.trimStartFrames, clip.durationInFrames) : frames);
  const beatFrames = map(beats.beats);
  const downbeats = map(beats.downbeats);
  const nearest = (list: number[], f: number) => list.reduce<number | null>((best, b) => (best === null || Math.abs(b - f) < Math.abs(best - f) ? b : best), null);
  const starts = sceneStartFrames(project);
  const framesPerBeat = beats.bpm ? +((60 * fps) / beats.bpm).toFixed(2) : null;
  return {
    source: clip
      ? { clipId: clip.id, name: clip.name, assetId: asset.id, src: asset.src, ...(clip.sceneId ? { sceneId: clip.sceneId } : {}), projectFrames: [start, start + clip.durationInFrames - 1], trimStartFrames: clip.trimStartFrames }
      : { assetId: asset.id, name: asset.name, src: asset.src, note: 'Not placed: frames are source frames (0 = first frame of the file). Add trimStartFrames/startFrame when you place it.' },
    frames: clip ? 'project' : 'source',
    fps,
    tempo: { bpm: beats.bpm, confidence: beats.confidence, framesPerBeat, framesPerBar: framesPerBeat ? +(framesPerBeat * 4).toFixed(2) : null, ...(beats.confidence < 0.2 ? { note: 'Weak pulse: treat the grid as a guess and prefer strongHits and onsets.' } : {}) },
    beats: beatFrames,
    downbeats,
    strongHits: map(beats.strong),
    onsets: map(beats.onsets),
    sceneCuts: clip
      ? project.scenes.slice(1).map((s, i) => {
          const f = starts[i + 1];
          const b = nearest(beatFrames, f);
          const d = nearest(downbeats, f);
          return { sceneId: s.id, name: s.name, startFrame: f, nearestBeat: b, offBeatBy: b === null ? null : f - b, nearestDownbeat: d, offDownbeatBy: d === null ? null : f - d };
        })
      : [],
    markers: project.markers.map((m) => ({ frame: m.frame, label: m.label })),
    totalFrames: projectDurationInFrames(project),
  };
}

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
};

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

const target = z.union([z.object({ sceneId: z.string(), elementId: z.string().optional() }), z.object({ audio: z.literal('project') }), z.object({ style: z.literal('project') })]);
const command = z.object({ type: z.string() }).passthrough();

export const schemas = {
  open: { projectId: z.string().optional().describe('Saved project to open. Omit to keep whatever the editor shows.'), discardUnsaved: z.boolean().optional().describe('Discard unsaved changes after asking the user in the editor.') },
  permissionPrompt: { tool_name: z.string().min(1), input: z.object({}).passthrough(), tool_use_id: z.string().optional() },
  empty: {},
  proposalStatus: { proposalId: z.string().optional().describe('Proposal id to look up. Omit for the pending proposal and recent outcomes.') },
  applyPatch: {
    baseRevision: z.number().int().describe('Project revision your edit is based on (from editor_get_context / editor_get_project).'),
    summary: z.string().min(1).describe('One line, shown in the editor history and toast.'),
    targets: z.array(target).min(1).describe('What the patch may change: { sceneId } for a whole scene (with its anchored sound effects), { sceneId, elementId } for one element, { audio: "project" } for the music bed and other project-level audio, { style: "project" } for setStyle (brand-kit overlay).'),
    commands: z.array(command).min(1).describe('Commands from the authoring guide (updateElement, setKeyframe, removeKeyframe, addElement, removeElement, moveElement, updateScene, addAsset, addAudioClip, updateAudioClip, removeAudioClip, …).'),
    reconcile: z.boolean().optional().describe('Apply even if the project moved past baseRevision, as long as none of the targets changed since.'),
    docSession: z.string().optional().describe('Document session from editor_get_context; rejects edits after the editor opens another document.'),
  },
  writeProject: {
    project: z.object({ id: z.string() }).passthrough().describe('A complete Project document (see editor_guide).'),
    overwrite: z.boolean().optional().describe('Replace an existing saved project with the same id.'),
    discardUnsaved: z.boolean().optional().describe('Open it even if the editor has unsaved changes. Only with the user’s permission.'),
  },
  renderFrame: {
    frames: z.array(z.number().int().min(0)).min(1).max(8).describe('Global frames to render (up to 8), e.g. a few per scene.'),
    scale: z.number().min(0.1).max(1).optional().describe('Output scale (default 0.5, i.e. 960x540 for 1080p).'),
  },
  preview: {
    frames: z.array(z.number().int().min(0)).min(1).max(8).optional().describe('Candidate frames to render. Omit for a contact sheet of touched scenes.'),
    contactSheet: z.boolean().optional().describe('Render one sheet of the first frame and midpoint of each touched scene (up to 12 frames).'),
  },
  contactSheet: {
    frames: z.array(z.number().int().min(0)).min(1).max(24).optional().describe('Global frames; defaults to 25% and 75% of each scene, up to 24 frames.'),
    columns: z.number().int().min(1).max(6).optional(),
    scale: z.number().min(0.1).max(1).optional(),
  },
  inspectJob: { jobId: z.string().min(1).optional().describe('Export job id. Omit to inspect the newest five jobs.') },
  cancelJob: { jobId: z.string().min(1).describe('Export job to cancel; completed or otherwise terminal jobs cannot be cancelled.') },
  focus: {
    frame: z.number().int().min(0).optional().describe('Global frame to move the playhead to.'),
    sceneId: z.string().optional(),
    elementId: z.string().optional().describe('Element to select (its scene is found automatically).'),
  },
  getBeats: {
    clipId: z.string().optional().describe('Audio clip to analyse. Omit for the music bed (the longest project-level clip).'),
    assetId: z.string().optional().describe('An audio asset not placed yet: frames are then source frames (0 = start of the file).'),
    src: z.string().optional().describe('An audio file not in the project yet, by its src from editor_import_asset (e.g. "assets/uploads/u_ab12.mp3"); source frames.'),
  },
  importAsset: {
    path: z.string().optional().describe('Local file path (png, jpg, webp, gif, svg, wav, mp3, m4a, aac, ogg). Give path or url.'),
    url: z.string().optional().describe('https URL of a generated file (e.g. a generator\'s media URL); at most 200 MB, its type is read from the bytes (image, SVG, audio or video). Give path or url.'),
    name: z.string().max(120).optional().describe('Display name; defaults to the file name.'),
    provenance: AssetProvenanceSchema.extend({ source: z.enum(['upload', 'generated']).optional() }).optional()
      .describe('Where a generated file came from: provider (generator id, e.g. "fal"), providerRefs (the provider ids), model, prompt, seed, requestId (shared by every take of one request), cost (the provider\'s allowance note). Kept on the asset.'),
    reference: z.boolean().optional().describe('Import as a reference (style frame, brand image, music reference) that steers generation and is never placed in the video.'),
  },
  generationModels: {},
  generate: {
    job: z.enum(JOB_KINDS).describe('The work to do; the editor routes this job kind to a capable model.'),
    prompt: z.string().describe('Describe the media to generate; for voice jobs, the exact text to speak. May be empty for narration with settings.lines.'),
    model: z.string().min(1).optional().describe('Registry model id from editor_generation_models. Omit for the editor route default.'),
    policy: z.enum(['quality', 'balanced', 'draft']).optional().describe('Routing policy. Omit for the active editor policy; balanced uses measured route suggestions when enough runs exist.'),
    settings: z.object({
      aspectRatio: z.string().optional().describe('Image or video aspect ratio, e.g. 16:9 or 1:1. Defaults from the project format; video models must support a ratio within 3%.'),
      resolution: z.enum(['1k', '2k', '4k']).optional().describe('Image resolution tier; plates default to 2k.'),
      durationSeconds: z.number().positive().optional().describe('Music, SFX or video length in seconds (music 3–600, SFX 0.5–22; video FLUX 5–20, H3 0.92–15, Wan 2–30). Video defaults to 5 s; pass the selected scene length when known.'),
      voice: z.string().optional().describe('ElevenLabs voice name, e.g. Rachel or Aria.'),
      languageCode: z.string().optional().describe('Voice language as an ISO 639-1 code.'),
      instrumental: z.boolean().optional().describe('Generate music without vocals; music.bed defaults to true.'),
      loop: z.boolean().optional().describe('Generate a seamless sound-effect loop; sfx.ambience defaults to true.'),
      referenceAssetIds: z.array(z.string()).optional().describe('Project image asset ids for image.edit or image.composite, in order; the first is the image to edit. For video.reference, mix project images and video clips: H3 up to 9 images + 3 videos, Wan up to 10 images + 5 videos. Refer to them as Image 1 or Video 1 in the prompt.'),
      maskAssetId: z.string().optional().describe('Project image mask for image.edit; transparent areas mark what to change (GPT Image only).'),
      score: z.array(z.object({
        sceneIds: z.array(z.string().trim().min(1)).min(1).describe('Scene ids covered by this section, in timeline order; merge short adjacent scenes.'),
        seconds: z.number().min(3).max(120).describe('Section duration in seconds, from 3 to 120.'),
        styles: z.array(z.string()).describe('Musical direction for this section, added to the global prompt styles.'),
        label: z.string().optional().describe('Section label, e.g. Hook; defaults to Section n.'),
      })).min(1).max(30).refine((score) => score.reduce((sum, section) => sum + Math.round(section.seconds * 1000), 0) <= 600000, 'Score must total at most 600 seconds').optional().describe('music.scored composition plan: one section per scene or group of short scenes; 1–30 sections, at most 600 seconds total.'),
      bpm: z.number().positive().optional().describe('Tempo in BPM for scored music; sent as a musical style and used for cut alignment.'),
      lines: z.array(z.object({
        sceneId: z.string().trim().min(1).describe('Scene this narration take belongs to.'),
        text: z.string().max(5000).describe('Exact words for this scene; empty lines are skipped.'),
      })).optional().describe('voice.narration lines in scene order; each non-empty line makes a separate take, multiplied by takes.'),
      seed: z.number().int().optional().describe('Random seed for repeatable generation when the model supports it.'),
      videoResolution: z.enum(['720p', '1080p']).optional().describe('Video resolution; defaults to 1080p. H3 maps 720p to native 768P; its three-keyframe mode requires 720p.'),
      start: z.union([z.object({ assetId: z.string().trim().min(1) }).strict(), z.object({ projectFrame: z.number().int().nonnegative() }).strict()]).optional().describe('First frame: {assetId} of a project image, or {projectFrame}, a global frame of the open video the editor renders (e.g. a scene\'s last frame for a transition). Required for video.animate and video.between; optional for H3 video.reference.'),
      end: z.union([z.object({ assetId: z.string().trim().min(1) }).strict(), z.object({ projectFrame: z.number().int().nonnegative() }).strict()]).optional().describe('Last frame, using {assetId} or {projectFrame}. Required with start for video.between across a cut; optional for H3 video.reference.'),
      keyframes: z.array(z.object({
        frame: z.union([z.object({ assetId: z.string().trim().min(1) }).strict(), z.object({ projectFrame: z.number().int().nonnegative() }).strict()]).describe('Project image {assetId} or rendered global {projectFrame} to pin.'),
        atSeconds: z.number().nonnegative().describe('Time from clip start, within durationSeconds. Use unique times (FLUX rounds to frame indices at 24 fps).'),
      })).min(1).max(10).optional().describe('For video.keyframes, provide 3–10 pinned frames. H3 accepts exactly 3 in time order at 720p (native 768P); FLUX accepts up to 10.'),
      documentUrl: z.url({ protocol: /^https$/ }).max(2000).optional().describe('Public https document URL (up to 2,000 characters) for video.long on Wan; enables document reasoning.'),
      webUrl: z.url({ protocol: /^https$/ }).max(2000).optional().describe('Public https web page URL (up to 2,000 characters) for video.long on Wan; enables page reasoning.'),
    }).optional().describe('Model-neutral settings. Aspect ratio defaults from the project; video duration defaults to 5 s. Generated video has model audio disabled; request sound separately with audio jobs.'),
    takes: z.number().int().min(1).max(4).optional().describe('Number of takes to generate (1–4, default 1).'),
    regenerateOf: z.string().min(1).optional().describe('Prior generation job id when asking again or requesting more like that take.'),
  },
  generationStatus: {
    jobId: z.string().min(1).optional().describe('Generation job id. Omit to list all jobs for the open project.'),
  },
  cancelGeneration: {
    jobId: z.string().min(1).describe('Generation job id to cancel.'),
  },
  searchAudio: {
    query: z.string().min(1).max(180).describe('What to search for, e.g. "calm ambient bed", "whoosh transition", "soft click".'),
    kind: z.enum(['music', 'sfx']).optional().describe('music = beds (Openverse category music); sfx = scene effects (sound_effect). The server always filters to CC0 and CC BY.'),
    mood: z.string().max(80).optional().describe('Appended to the query: calm, tense, upbeat, warm, dark, playful, …'),
    durationSeconds: z.number().positive().optional().describe('Preferred length in seconds. For a bed, pass the video length so you can trim a longer track to it.'),
    page: z.number().int().min(1).optional().describe('Result page (default 1). Do not scrape; pick from the first pages.'),
  },
  inspectAudio: {
    id: z.string().min(1).describe('Openverse work id from editor_search_audio (a UUID). Direct file URLs are rejected — license is checked on the catalog record.'),
  },
  addAudio: {
    id: z.string().min(1).describe('Openverse work id from editor_search_audio. Direct download URLs are rejected.'),
    role: z.enum(['music', 'sfx']).describe('music = project-level bed (no sceneId); sfx = scene-anchored effect.'),
    sceneId: z.string().optional().describe('Required for sfx unless the playhead is in a scene; ignored for music.'),
    startFrame: z.number().int().optional().describe('music: global frame (default 0). sfx: scene frame (default playhead).'),
    name: z.string().max(120).optional().describe('Clip display name; defaults to the work title.'),
    replaceExisting: z.boolean().optional().describe('music only: remove existing project-level beds in the same patch.'),
    baseRevision: z.number().int().optional().describe('From editor_get_context. Omit to use the live revision.'),
    docSession: z.string().optional().describe('Document session from editor_get_context.'),
    summary: z.string().optional().describe('Patch summary shown in the editor history.'),
  },
  buildTemplate: {
    template: z.enum(TEMPLATE_IDS as [TemplateId, ...TemplateId[]]).describe('Template id (listed with its params in the tool description).'),
    params: z.record(z.string(), z.unknown()).optional().describe('Template params: text as strings (\\n between lines), numbers as numbers, asset ids as strings. Omitted params take the template default; seconds defaults to the rest of the scene.'),
    sceneId: z.string().describe('Scene to build in.'),
    at: z.number().int().min(0).optional().describe('Scene frame the template starts at (default 0).'),
    parentId: z.string().optional().describe('Build inside this group of the scene (at stays a scene frame).'),
  },
  buildMotion: {
    preset: z.enum(MOTION_IDS).describe('A motion preset id, or arriveApart / followThrough / matchCut.'),
    sceneId: z.string().describe('Scene of the elements (the outgoing scene for matchCut).'),
    elementIds: z.array(z.string()).min(1).describe('Elements to animate: one or more for a preset; several (or one group) for arriveApart; [groupId] for followThrough; [outgoing element] for matchCut.'),
    opts: z.object({
      at: z.number().int().min(0).optional().describe('Start frame: element-local for a preset; scene frame of the first arrival for arriveApart; group-local for followThrough.'),
      duration: z.number().int().min(1).optional().describe('Length in frames (each half of a match cut).'),
      intensity: z.number().min(0.25).max(2).optional().describe('Distance scale (0.25 subtle … 2 strong); timing is unchanged.'),
      preset: z.enum(PRESET_IDS as [PresetId, ...PresetId[]]).optional().describe('arriveApart: the entrance each layer gets (default riseIn).'),
      stagger: z.number().int().min(0).optional().describe('arriveApart: frames between arrivals (default the style\'s staggerFrames).'),
      order: z.enum(['reading', 'importance', 'centerOut', 'given']).optional().describe('arriveApart: who goes first (default reading).'),
      from: z.enum(['left', 'right', 'top', 'bottom']).optional().describe('followThrough: side the group comes in from (default left).'),
    }).optional(),
    intoSceneId: z.string().optional().describe('matchCut: the incoming scene.'),
    intoElementId: z.string().optional().describe('matchCut: the incoming element (top-level, starting on frame 0).'),
  },
  listCutCards: {
    beat: z.enum(CUT_BEATS).optional().describe('Only this beat (hook | proof | turn | cta); default all four.'),
  },
  buildCut: {
    card: z.string().describe('Cut card id from editor_list_cut_cards, e.g. hook.mask-rise-claim.'),
    sceneId: z.string().describe('Scene to build in (usually an empty scene for this beat).'),
    slots: z.record(z.string(), z.string()).optional().describe('Slot copy by name (\\n between lines); omitted slots keep the sample copy.'),
    fitScene: z.boolean().optional().describe('Retime the scene to the card’s designed length (default true).'),
  },
  scanBrand: {
    url: z.string().min(1).describe('https page to scan (HTML and linked CSS only; no JavaScript). Cached per domain.'),
    propose: z.boolean().optional().describe('If true and an editor is open, create a reviewable setStyle proposal ({ style: "project" }) from the extracted overlay. Default false.'),
    backgrounds: z.boolean().optional().describe('When proposing, also paint unlocked scene backgrounds with the kit’s background colour.'),
    refresh: z.boolean().optional().describe('Ignore the per-domain cache and fetch again.'),
    baseRevision: z.number().int().optional(),
    docSession: z.string().optional(),
    summary: z.string().optional(),
  },
  analyzeReference: {
    url: z.string().optional().describe('https video URL. yt-dlp is used for YouTube/X/Vimeo pages when installed; otherwise a direct mp4/webm/mov is downloaded.'),
    path: z.string().optional().describe('Local video file. Give path or url, not both.'),
    refresh: z.boolean().optional().describe('Ignore the analysis cache and run ffmpeg again.'),
  },
  critique: {
    sceneIds: z.array(z.string()).optional().describe('Limit to these scenes. Omit for the whole project (or the scenes a patch touches).'),
    addBanned: z.array(z.string().max(80)).max(20).optional().describe('Clichés you spotted on the contact sheet. Remembered for this MCP session and merged with project.banned; put the same list on project.banned when you write the draft.'),
    baseRevision: z.number().int().optional().describe('With commands: the patch to critique without proposing it.'),
    summary: z.string().optional(),
    targets: z.array(target).optional(),
    commands: z.array(command).optional(),
    reconcile: z.boolean().optional(),
    docSession: z.string().optional(),
  },
  proposeOutline: {
    title: outlineTitleField.describe('Working title of the video; the project is renamed to it on approval.'),
    scenes: z
      .array(
        z.object({
          name: outlineSceneFields.name.describe('Short scene name, e.g. "Hook".'),
          purpose: outlineSceneFields.purpose.describe('What the scene must achieve in the story.'),
          durationSeconds: outlineSceneFields.durationSeconds.describe(`Planned length in seconds (${OUTLINE_LIMITS.minSeconds}–${OUTLINE_LIMITS.maxSeconds}).`),
          onScreenText: outlineSceneFields.onScreenText.describe('The exact words on screen, if any.'),
          visuals: outlineSceneFields.visuals.describe('What we see and how it moves.'),
          templateHints: outlineSceneFields.templateHints.describe(`Editor templates that fit: ${TEMPLATE_IDS.join(', ')}.`),
        }),
      )
      .min(1)
      .max(OUTLINE_LIMITS.maxScenes)
      .describe('Scenes in playback order.'),
    story: z
      .object({
        idea: outlineStoryFields.idea.describe('The one idea the video is about.'),
        hook: outlineStoryFields.hook.describe('First 1–2 seconds: what happens and why someone stops scrolling. Not a logo.'),
        audience: outlineStoryFields.audience.describe('Who this is for.'),
        tension: outlineStoryFields.tension.describe('Setup or tension that makes the payoff land.'),
        payoff: outlineStoryFields.payoff.describe('What we now believe, in the final stretch.'),
        cta: outlineStoryFields.cta.describe('Optional call to action or loop-back.'),
        beats: z
          .array(
            z.object({
              role: outlineStoryBeatFields.role.describe('hook, setup, tension, payoff, cta or loop.'),
              summary: outlineStoryBeatFields.summary.describe('What happens in this beat, in one sentence.'),
              sceneName: outlineStoryBeatFields.sceneName.describe('Outline scene this beat plays in.'),
              fromSeconds: outlineStoryBeatFields.fromSeconds.describe('Start of the beat, seconds from 0.'),
              toSeconds: outlineStoryBeatFields.toSeconds.describe('End of the beat, seconds from 0.'),
            }),
          )
          .min(1)
          .max(OUTLINE_LIMITS.maxScenes)
          .describe('Beat-by-beat script, mapped to scenes and time ranges, written before any motion.'),
      })
      .optional()
      .describe('Story layer: write this before building motion. Stamped onto project.story on approval.'),
  },
};

/** Music-bed beats for critique. Missing bed or analysis failure → skip cut-on-beat checks. */
async function beatsForCritique(local: LocalEditor, project: Project): Promise<CritiqueBeats | undefined> {
  const picked = pickBeatsSource(project, {});
  if ('error' in picked) return undefined;
  try {
    const beats = await local.request<BeatsResponse>('GET', `/api/assets/beats?src=${encodeURIComponent(picked.asset.src)}&fps=${project.fps}`);
    const report = beatsReport(project, beats, picked.asset, picked.clip);
    return { beats: report.beats, downbeats: report.downbeats, confidence: beats.confidence };
  } catch {
    return undefined;
  }
}

/** Session extras only (seeded ids are always merged at critique time). */
function rememberBanned(map: Map<string, string[]>, projectId: string, added: readonly string[]): string[] {
  const prev = map.get(projectId) ?? [];
  const next: string[] = [];
  const seen = new Set<string>();
  for (const raw of [...prev, ...added]) {
    const item = raw.trim().slice(0, 80);
    if (!item || seen.has(item)) continue;
    seen.add(item);
    next.push(item);
  }
  const trimmed = next.slice(0, 40);
  map.set(projectId, trimmed);
  return trimmed;
}

function sceneIdsOfTouched(touched: readonly TouchedRef[]): string[] | undefined {
  const ids = [...new Set(touched.flatMap((t) => ('sceneId' in t ? [t.sceneId] : [])))];
  return ids.length ? ids : undefined;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export function createHandlers(local: LocalEditor) {
  // Extra banned items this MCP session added after a contact sheet (per project).
  const extraBanned = new Map<string, string[]>();

  const guard = async (fn: (identify: (identity: ResultIdentity) => void) => Promise<ToolResult>): Promise<ToolResult> => {
    const requestId = newId('req');
    const known: ResultIdentity = {};
    let result: ToolResult;
    try {
      result = await fn((identity) => Object.assign(known, identity));
    } catch (e) {
      result = e instanceof LocalApiError
        ? fail([e.message, e.error?.path && `at ${e.error.path}`, e.error?.hint].filter(Boolean).join('\n'))
        : fail(e instanceof Error ? e.message : String(e));
    }
    const state = await local.state().catch(() => null);
    // A render or context read describes its captured snapshot even if the user
    // opens another document while the request is in flight.
    const { projectId, revision, docSession } = { ...(state ? stateIdentity(state) : {}), ...known };
    return { ...result, _meta: {
      'mge/contract': TOOL_CONTRACT, 'mge/requestId': requestId,
      ...(projectId !== undefined ? { 'mge/projectId': projectId } : {}),
      ...(revision !== undefined ? { 'mge/revision': revision } : {}),
      ...(docSession !== undefined ? { 'mge/docSession': docSession } : {}),
    } };
  };

  const sendPatch = (args: PatchArgs, mode: 'auto' | 'propose') =>
    guard(async (identify) => {
      const state = await liveState(local);
      identify(stateIdentity(state));
      const stale = staleSession(state, args);
      if (stale) return stale;
      const patch = buildPatch(state.project, args);
      // Soft gate on propose: run critique on the candidate and prepend it.
      // Do not block — fixture goldens have dead-frame warnings, and a hard
      // gate would teach agents to pass `force` blindly. Beats stay off this
      // path (latency); editor_critique fetches them.
      let critiqueText = '';
      if (mode === 'propose') {
        const checked = checkPatch(createDocState(state.project), patch, { reconcile: args.reconcile });
        if (checked.ok) {
          const report = critiqueProject(checked.project, {
            sceneIds: sceneIdsOfTouched(checked.touched),
            extraBanned: extraBanned.get(state.project.id),
          });
          critiqueText = formatCritique(report);
        }
      }
      const r = await local.command({ type: 'applyPatch', patch, reconcile: args.reconcile, agent: AGENT, model: MODEL, mode, ...(args.docSession !== undefined ? { docSession: args.docSession } : {}) });
      if (!r.ok) return replyError(r, 'Patch');
      identify({ projectId: r.projectId, revision: r.revision });
      if (r.proposal) {
        const p = r.proposal;
        return text([
          critiqueText,
          `Proposed — awaiting the user's review (proposal ${p.id}, based on r${p.baseRevision}). Nothing has changed in the project yet. The user will Apply or Cancel it in the editor; check the outcome with editor_proposal_status or editor_get_context before building on it.`,
          changeLines(r.changes),
          r.replaced && `Replaced your earlier pending proposal "${r.replaced.summary}".`,
        ].filter(Boolean).join('\n'));
      }
      if (r.applied === true || (r.applied === undefined && r.revision !== undefined)) {
        const applied = `Applied as r${r.revision} (${r.changes?.length ?? 0} change${r.changes?.length === 1 ? '' : 's'}):\n${changeLines(r.changes)}`;
        return text(critiqueText ? `${critiqueText}\n${applied}` : applied);
      }
      return fail('The editor did not confirm an applied edit or a proposal. Check editor_get_context before continuing.');
    });

  const sheet = async (project: Project, frames: number[], kind: 'committed' | 'proposal/preview', columns?: number, scale?: number): Promise<ToolResult> => {
    const invalid = frameError(project, frames, 24);
    if (invalid) return invalid;
    const rendered = await local.request<ContactSheetResponse>('POST', '/api/stills/contact-sheet', { project, frames, columns, scale: scale ?? 0.5 });
    return { content: [
      { type: 'text', text: `${kind}, ${kind === 'proposal/preview' ? 'base ' : ''}r${project.revision}, hash ${projectHash(project).slice(0, 12)}\n${frames.map((f) => frameLine(project, f)).join('\n')}` },
      { type: 'image', data: (await readAgentFile(rendered.path, local.cfg.rootDir)).toString('base64'), mimeType: 'image/png' },
    ] };
  };

  const inspectJob = async (job: RenderJob): Promise<string> => {
    let manifest: RenderManifest | null = null;
    try {
      manifest = await local.request<RenderManifest>('GET', `/api/renders/${encodeURIComponent(job.id)}/manifest`);
    } catch (e) {
      if (!(e instanceof LocalApiError && e.status === 404)) throw e;
    }
    return [
      `Job ${job.id}: ${job.status}, ${Math.round(job.progress * 100)}%; frames rendered ${job.renderedFrames}/${job.totalFrames}, encoded ${job.encodedFrames}/${job.totalFrames}; committed r${job.projectRevision}, projectHash ${job.projectHash?.slice(0, 12) ?? 'pending'}`,
      job.outputUrl && `outputUrl: http://localhost:${local.cfg.serverPort}${job.outputUrl}`,
      job.error && `error: ${job.error}`,
      manifest ? `Manifest: ${manifest.assets.length} assets; fonts: ${manifest.fonts.map((f) => `${f.family} (${f.version})`).join(', ') || 'none'}; renderer ${manifest.renderer.version ?? 'unknown'}; git commit ${manifest.code.gitCommit?.slice(0, 12) ?? 'unknown'}` : 'Manifest: not available yet.',
    ].filter(Boolean).join('\n');
  };

  const changedWhileWaiting = async (before: EditorStateResponse): Promise<ToolResult | null> => {
    const after = await local.state();
    const a = before.context;
    const b = after.context;
    return before.connected !== after.connected || a?.docSession !== b?.docSession || a?.projectId !== b?.projectId || a?.revision !== b?.revision
      ? fail('The open document changed while permission was waiting. Read the editor context and try again.') : null;
  };

  // Codex, Cursor and OpenCode have no headless permission hook in the CLI
  // modes we use. MCP asks cover their destructive editor actions as well.
  const permission = async (action: string, detail?: string): Promise<ToolResult | null> => {
    const r = await local.command({ type: 'askPermission', requestId: newId('req'), agent: AGENT, action, detail });
    if (r.ok && r.message === 'allowed') return null;
    return fail(`The user declined: ${action}${r.ok ? ` (${('reason' in r ? r.reason : undefined) ?? r.message ?? 'denied'})` : ` (${r.error.message})`}`);
  };

  return {
    editor_permission_prompt: (args: { tool_name: string; input: Record<string, unknown>; tool_use_id?: string }) => guard(async () => {
      // Claude Code expects one text block containing this JSON, not a tool error.
      try {
        // Every tool (built-in or any MCP server's) gets the same card in the editor.
        if (typeof args.tool_name !== 'string') return text(json({ behavior: 'deny', message: 'The editor could not tell which tool this is; nothing ran.' }));
        const action = permissionDescription(args.tool_name, args.input);
        const declined = await permission(action, json(args.input));
        return text(json(declined
          ? { behavior: 'deny', message: (declined.content[0] as { text: string }).text }
          : { behavior: 'allow', updatedInput: args.input }));
      } catch (e) {
        return text(json({ behavior: 'deny', message: e instanceof Error ? e.message : String(e) }));
      }
    }),

    editor_open: (args: { projectId?: string; discardUnsaved?: boolean }) =>
      guard(async () => {
        const { started, logPath } = await local.ensureRunning();
        const lines: string[] = [];
        if (started.length) lines.push(`Started ${started.map((s) => `npm run ${s}`).join(' and ')} (log: ${logPath}).`);
        let connected = (await local.state()).connected;
        if (!connected) {
          const launched = local.openBrowser();
          connected = await local.waitForEditor(launched ? 12000 : 3000);
        }
        if (!connected) {
          lines.push(`The editor is running at ${local.editorUrl} but no browser tab is connected yet. Ask the user to open the editor link stored in ${local.editorLinkFile}, then call editor_get_context.`);
          return text(lines.join('\n'));
        }
        if (args.projectId) {
          const current = await local.state();
          let discardUnsaved = false;
          if (current.context?.dirty && args.discardUnsaved) {
            const declined = await permission(`Replace the open project “${current.context.projectName}” (unsaved changes will be lost)`, `Open saved project ${args.projectId}.`);
            if (declined) return declined;
            const changed = await changedWhileWaiting(current);
            if (changed) return changed;
            discardUnsaved = true;
          }
          const r = await local.command({ type: 'openProject', projectId: args.projectId, discardUnsaved: args.discardUnsaved === undefined ? undefined : discardUnsaved, agent: AGENT });
          if (!r.ok) return replyError(r, `Opening ${args.projectId}`);
        }
        const state = await liveState(local);
        const ctx = state.context!;
        lines.push(`Editor connected at ${local.editorUrl}. Showing "${ctx.projectName}" (${ctx.projectId}) at r${ctx.revision}${ctx.dirty ? ' with unsaved changes' : ''}.`);
        lines.push('Next: editor_get_context to see the selection and the user’s notes, editor_guide for the document format.');
        return text(lines.join('\n'));
      }),

    editor_get_context: () => guard(async (identify) => {
      const state = await liveState(local);
      identify(stateIdentity(state));
      return text(json(describeContext(state, local.editorUrl, join(local.cfg.rootDir, 'public'), extraBanned.get(state.project.id))));
    }),

    editor_get_project: () => guard(async (identify) => {
      const state = await liveState(local);
      identify(stateIdentity(state));
      return text(json(state.project));
    }),

    editor_guide: () => guard(async () => text(buildAuthoringGuide())),

    editor_apply_patch: (args: Parameters<typeof sendPatch>[0]) => sendPatch(args, 'auto'),

    editor_propose_patch: (args: Parameters<typeof sendPatch>[0]) => sendPatch(args, 'propose'),

    editor_preview_patch: (args: PatchArgs & { frames?: number[]; contactSheet?: boolean }) =>
      guard(async (identify) => {
        const state = await liveState(local);
        identify(stateIdentity(state));
        const stale = staleSession(state, args);
        if (stale) return stale;
        const checked = checkPatch(createDocState(state.project), buildPatch(state.project, args), { reconcile: true });
        if (!checked.ok) return replyError({ ok: false, error: checked.error }, 'Patch');
        const project = checked.project;
        const content: Content[] = [{ type: 'text', text: `Uncommitted preview of your patch (not applied, not proposed)\n${changeLines(checked.diff)}` }];
        if (args.contactSheet || !args.frames) {
          const frames = sampleFrames(project, [0, 0.5], new Set(checked.touched.flatMap((t) => 'sceneId' in t ? [t.sceneId] : [])), 12);
          // Asset- and audio-only patches have no scene touch; use their declared scene targets, else the whole video.
          const declared = sampleFrames(project, [0, 0.5], new Set(args.targets.filter(isSceneTarget).map((t) => t.sceneId)), 12);
          const result = await sheet(project, frames.length ? frames : declared.length ? declared : sampleFrames(project, [0, 0.5], undefined, 12), 'proposal/preview');
          return { ...result, content: [...content, ...result.content] };
        }
        const invalid = frameError(project, args.frames, 8);
        if (invalid) return invalid;
        for (const frame of args.frames) {
          const still = await local.request<StillResponse>('POST', '/api/stills', { project, frame, scale: 0.5, proposalId: 'preview' });
          content.push({ type: 'text', text: `${frameLine(project, frame)} — ${identityLine(still.identity)}` });
          content.push({ type: 'image', data: (await readAgentFile(still.path, local.cfg.rootDir)).toString('base64'), mimeType: 'image/png' });
        }
        return { content };
      }),

    editor_render_contact_sheet: (args: { frames?: number[]; columns?: number; scale?: number }) =>
      guard(async (identify) => {
        const state = await liveState(local);
        identify(stateIdentity(state));
        const { project } = state;
        return sheet(project, args.frames ?? sampleFrames(project, [0.25, 0.75]), 'committed', args.columns, args.scale);
      }),

    editor_critique: (args: CritiqueArgs = {}) =>
      guard(async (identify) => {
        const state = await liveState(local);
        identify(stateIdentity(state));
        if (args.docSession !== undefined) {
          const stale = staleSession(state, {
            baseRevision: args.baseRevision ?? state.project.revision,
            summary: args.summary ?? 'critique',
            targets: args.targets ?? [],
            commands: args.commands ?? [],
            docSession: args.docSession,
          });
          if (stale) return stale;
        }
        if (args.addBanned?.length) rememberBanned(extraBanned, state.project.id, args.addBanned);

        let project = state.project;
        let sceneIds = args.sceneIds;
        if (args.commands !== undefined) {
          if (args.baseRevision === undefined || args.summary === undefined || args.targets === undefined) {
            return fail('A patch critique needs baseRevision, summary, targets and commands (the same fields as editor_preview_patch).');
          }
          const patchArgs: PatchArgs = {
            baseRevision: args.baseRevision,
            summary: args.summary,
            targets: args.targets,
            commands: args.commands,
            reconcile: args.reconcile,
            docSession: args.docSession,
          };
          const checked = checkPatch(createDocState(state.project), buildPatch(state.project, patchArgs), { reconcile: args.reconcile });
          if (!checked.ok) return replyError({ ok: false, error: checked.error }, 'Patch');
          project = checked.project;
          if (!sceneIds?.length) sceneIds = sceneIdsOfTouched(checked.touched);
        }

        const beats = await beatsForCritique(local, project);
        const report = critiqueProject(project, { sceneIds, beats, extraBanned: extraBanned.get(state.project.id) });
        return text(json({
          text: formatCritique(report),
          errors: report.errors,
          warnings: report.warnings,
          scenes: report.scenes,
          banned: report.banned,
          findings: report.findings,
          stats: report.stats,
          bar: report.bar,
          next: report.findings.length
            ? 'Fix the findings (they name frames), render a contact sheet, then editor_propose_patch. Usually 2–4 rounds.'
            : 'No document-level defects. Still look at a contact sheet for colour, crop and taste, then propose.',
        }));
      }),

    editor_export_revision: () =>
      guard(async (identify) => {
        const state = await liveState(local);
        identify(stateIdentity(state));
        const { project, context } = state;
        if (context?.proposal?.status === 'pending') return fail('PROPOSAL_PENDING: a proposal is awaiting review. Apply or cancel it before exporting. editor_export_revision exports only the live committed document.');
        const job = await local.request<RenderJob>('POST', '/api/renders', { project });
        identify({ projectId: job.projectId, revision: job.projectRevision });
        return text(`MP4 export job ${job.id} started for the live committed document at r${job.projectRevision}; projectHash ${job.projectHash ?? projectHash(project)}. Check progress with editor_inspect_job.`);
      }),

    editor_inspect_job: (args: { jobId?: string }) =>
      guard(async (identify) => {
        const jobs = args.jobId !== undefined
          ? [await local.request<RenderJob>('GET', `/api/renders/${encodeURIComponent(args.jobId)}`)]
          : (await local.request<RenderJob[]>('GET', '/api/renders')).slice(0, 5);
        if (jobs.length === 1) identify(jobIdentity(jobs[0]));
        const lines: string[] = [];
        for (const job of jobs) lines.push(await inspectJob(job));
        return text(lines.length ? lines.join('\n\n') : 'No export jobs. Start one with editor_export_revision.');
      }),

    editor_cancel_job: (args: { jobId: string }) =>
      guard(async (identify) => {
        const job = await local.request<RenderJob>('POST', `/api/renders/${encodeURIComponent(args.jobId)}/cancel`);
        identify(jobIdentity(job));
        return text(`Job ${job.id}: ${job.status}, ${Math.round(job.progress * 100)}%; committed r${job.projectRevision}, projectHash ${job.projectHash?.slice(0, 12) ?? 'pending'}.`);
      }),

    editor_proposal_status: (args: { proposalId?: string }) =>
      guard(async () => {
        const { context } = await local.state();
        const proposals = [...(context?.proposal ? [context.proposal] : []), ...(context?.proposalLog ?? [])];
        if (args.proposalId !== undefined) {
          const proposal = proposals.find((p) => p.id === args.proposalId);
          return text(proposal ? proposalLine(proposal) : `Proposal ${args.proposalId} was not found in the editor's pending proposal or recent log.`);
        }
        return text(proposals.length ? proposals.map(proposalLine).join('\n') : 'No pending proposal or recent proposal outcomes were reported by the editor.');
      }),

    editor_write_project: (args: { project: Record<string, unknown>; overwrite?: boolean; discardUnsaved?: boolean }) =>
      guard(async () => {
        const input = structuredClone(args.project) as unknown as Project;
        const valid = validateProject(input);
        if (!valid.ok) return fail([`Project is invalid: ${valid.error.message}`, valid.error.path && `at ${valid.error.path}`, valid.error.hint].filter(Boolean).join('\n'));
        const project = valid.value;
        const state = await local.state().catch(() => null);
        if (!state) return fail('The editor server is not running. Call editor_open first.');
        const ctx = state.connected ? state.context : null;
        if (ctx?.dirty && !args.discardUnsaved) {
          return fail(`The editor has unsaved changes to "${ctx.projectName}" (r${ctx.revision}). Call editor_save first, or ask the user before passing discardUnsaved: true.`);
        }
        let existing: ProjectFile | null = null;
        try {
          existing = await local.request<ProjectFile>('GET', `/api/projects/${encodeURIComponent(project.id)}`);
        } catch (e) {
          if (!(e instanceof LocalApiError && e.status === 404)) throw e;
        }
        if (existing && !args.overwrite) {
          return fail(`A saved project with id ${project.id} ("${existing.project.name}") already exists. Use a new prj_ id, or pass overwrite: true to replace it.`);
        }
        if (args.discardUnsaved || args.overwrite) {
          const action = [
            args.discardUnsaved ? `Replace the open project “${ctx?.projectName ?? 'current project'}” (unsaved changes will be lost)` : '',
            args.overwrite ? `Overwrite saved project “${existing?.project.name ?? project.name}”` : '',
          ].filter(Boolean).join('; ');
          const declined = await permission(action);
          if (declined) return declined;
          const changed = await changedWhileWaiting(state);
          if (changed) return changed;
        }
        // Keep revisions moving forward so a patch based on the old document can never apply to the new one.
        const floor = Math.max(existing?.project.revision ?? 0, ctx?.projectId === project.id ? ctx.revision : 0);
        if (project.revision <= floor) project.revision = floor + 1;
        const file: ProjectFile = { format: 'mge.project/1', project, revisions: [], savedAt: new Date().toISOString() };
        await local.request('PUT', `/api/projects/${encodeURIComponent(project.id)}`, file);
        if (!state.connected) {
          return text(`Saved "${project.name}" (${project.id}) at r${project.revision}, but no editor is open. Call editor_open with projectId "${project.id}".`);
        }
        const r = await local.command({ type: 'openProject', projectId: project.id, discardUnsaved: args.discardUnsaved, agent: AGENT });
        if (!r.ok) return replyError(r, `Saved ${project.id}, but opening it in the editor`);
        const seconds = (projectDurationInFrames(project) / project.fps).toFixed(1);
        return text(`Saved and opened "${project.name}" (${project.id}) at r${r.revision}: ${project.scenes.length} scenes, ${seconds} s. Check it with editor_render_frame.`);
      }),

    editor_render_frame: (args: { frames: number[]; scale?: number }) =>
      guard(async (identify) => {
        const state = await liveState(local);
        identify(stateIdentity(state));
        const { project } = state;
        const invalid = frameError(project, args.frames, 8);
        if (invalid) return invalid;
        const content: Content[] = [];
        for (const frame of args.frames) {
          const still = await local.request<StillResponse>('POST', '/api/stills', { project, frame, scale: args.scale ?? 0.5 });
          content.push({ type: 'text', text: `${frameLine(project, frame)} — ${identityLine(still.identity)}` });
          content.push({ type: 'image', data: (await readAgentFile(still.path, local.cfg.rootDir)).toString('base64'), mimeType: 'image/png' });
        }
        return { content };
      }),

    editor_focus: (args: { frame?: number; sceneId?: string; elementId?: string }) =>
      guard(async () => {
        const r = await local.command({ type: 'focus', frame: args.frame, sceneId: args.sceneId, elementId: args.elementId });
        if (!r.ok) return replyError(r, 'Focus');
        return text(r.message ?? 'Done.');
      }),

    editor_save: () =>
      guard(async () => {
        const r = await local.command({ type: 'save' });
        if (!r.ok) return replyError(r, 'Save');
        return text(`Saved ${r.projectId} at r${r.revision}.`);
      }),

    editor_propose_outline: (args: { title: string; scenes: unknown[]; story?: unknown }) =>
      guard(async (identify) => {
        const parsed = parseOutline(args);
        if (!parsed.ok) return fail(`Outline is invalid: ${parsed.message}`);
        const state = await liveState(local);
        identify(stateIdentity(state));
        const { outline } = parsed;
        const r = await local.command({ type: 'proposeOutline', outline: draftOf(outline), agent: AGENT, model: MODEL });
        if (!r.ok) return replyError(r, 'Outline');
        return text([
          `Outline proposed — awaiting the user's review in the editor ("${outline.title}": ${outline.scenes.length} scene${outline.scenes.length === 1 ? '' : 's'}, ${formatSeconds(outlineSeconds(outline))}). Nothing has been built yet.`,
          'The user may rename, reorder, retime, cut or add scenes and leave notes before deciding. When they approve, the editor fills the open project (same id) with one empty scene per approved item — or creates a new project if the open one already has content — and sends you the approved outline to build; that message says how the build lands (one `editor_propose_patch` per scene for review, or `editor_apply_patch` straight through when Auto-apply is on). Read their decision in editor_get_context (field "outline": status pending | approved | declined, the edited scenes, and the projectId).',
          'Do not build or write any project until then.',
        ].join('\n'));
      }),

    editor_build_template: (args: TemplateArgs) =>
      guard(async (identify) => {
        const state = await liveState(local);
        identify(stateIdentity(state));
        const r = buildTemplateCommands(state.project, args);
        return r.ok ? text(buildResultText(r, state.context?.docSession)) : fail(r.message);
      }),

    editor_list_cut_cards: (args: { beat?: CutBeat }) =>
      guard(async (identify) => {
        const state = await liveState(local);
        identify(stateIdentity(state));
        return text(cutCardsText(args?.beat));
      }),

    editor_build_cut: (args: CutArgs) =>
      guard(async (identify) => {
        const state = await liveState(local);
        identify(stateIdentity(state));
        const r = buildCutCommands(state.project, args);
        return r.ok ? text(buildResultText(r, state.context?.docSession)) : fail(r.message);
      }),

    editor_build_motion: (args: MotionArgs) =>
      guard(async (identify) => {
        const state = await liveState(local);
        identify(stateIdentity(state));
        const r = buildMotionCommands(state.project, args);
        return r.ok ? text(buildResultText(r, state.context?.docSession)) : fail(r.message);
      }),

    editor_get_beats: (args: { clipId?: string; assetId?: string; src?: string }) =>
      guard(async (identify) => {
        const state = await liveState(local);
        identify(stateIdentity(state));
        const { project } = state;
        const picked = pickBeatsSource(project, args);
        if ('error' in picked) return fail(picked.error);
        const { clip, asset } = picked;
        const beats = await local.request<BeatsResponse>('GET', `/api/assets/beats?src=${encodeURIComponent(asset.src)}&fps=${project.fps}`);
        return text(json(beatsReport(project, beats, asset, clip)));
      }),

    editor_import_asset: (args: { path?: string; url?: string; name?: string; provenance?: Partial<AssetProvenance>; reference?: boolean }) =>
      guard(async () => {
        if ((args.path === undefined) === (args.url === undefined)) return fail('Give either path (a local file) or url (an https URL), not both.');
        const provenance: AssetProvenance | undefined = args.provenance
          ? { ...args.provenance, source: args.provenance.source ?? (args.provenance.provider ? 'generated' : 'upload'), ...(args.provenance.provider && args.provenance.createdAt === undefined ? { createdAt: Date.now() } : {}) }
          : undefined;
        let up: UploadAssetResponse | ImportUrlResponse;
        let label: string;
        if (args.url !== undefined) {
          up = await local.request<ImportUrlResponse>('POST', '/api/assets/import-url', { url: args.url, name: args.name, provenance, agent: AGENT });
          label = up.name;
        } else {
          const path = isAbsolute(args.path!) ? args.path! : resolve(process.cwd(), args.path!);
          const filename = basename(path);
          const ext = filename.split('.').pop()?.toLowerCase() ?? '';
          if (!MIME_BY_EXT[ext]) return fail(`Unsupported file type ".${ext}". Supported: ${Object.keys(MIME_BY_EXT).join(', ')}.`);
          up = await local.request<UploadAssetResponse>('POST', '/api/assets/import-local', { path, name: args.name });
          label = filename;
        }
        const fps = (await local.state().catch(() => null))?.project?.fps ?? 30;
        const asset: Asset = { id: newId('ast'), kind: up.kind, name: args.name ?? up.name, src: up.src, mimeType: up.mimeType };
        if (up.width) asset.width = up.width;
        if (up.height) asset.height = up.height;
        if (up.durationSeconds) asset.durationInFrames = Math.max(1, Math.round(up.durationSeconds * fps));
        if ('fps' in up && up.fps) asset.fps = up.fps;
        if ('hasAudio' in up && up.hasAudio !== undefined) asset.hasAudio = up.hasAudio;
        if (args.reference) asset.reference = true;
        if (provenance) asset.provenance = provenance;
        return text(
          `${args.url !== undefined ? 'Downloaded' : 'Uploaded'} ${label}. Asset object (not yet in the project — add it with an addAsset command in editor_propose_patch so the user reviews it, or put it in project.assets for editor_write_project${asset.reference ? '; it is a reference, so never place it in an element or clip' : ''}):\n${json(asset)}`,
        );
      }),

    editor_generation_models: () =>
      guard(async () => {
        const [models, status, evidence] = await Promise.all([
          local.request<GenerationModelsResponse>('GET', '/api/generation/models'),
          local.request<GenerationStatus>('GET', '/api/generation/status'),
          local.request<GenerationScoreboard>('GET', '/api/generation/scoreboard').catch((error: unknown) => {
            if (error instanceof LocalApiError && error.status === 404) return undefined;
            throw error;
          }),
        ]);
        const lines = models.jobs.map((job) => {
          const defaultId = job.defaults[models.policy];
          const modelLine = (model: (typeof job.models)[number]) => `${model.label} (${model.id}): ${model.priceLabel}${model.available === false ? ' [unavailable]' : ''}`;
          const picked = job.models.find((model) => model.id === defaultId);
          return `${job.job} — ${job.label}\n  Default: ${picked ? modelLine(picked) : `${defaultId} [unavailable]`}\n  Alternatives: ${job.models.filter((model) => model.id !== defaultId).map(modelLine).join('; ') || 'none'}`;
        });
        if (evidence && Array.isArray(evidence.rows)) {
          for (const job of models.jobs) {
            for (const row of evidence.rows.filter((row) => row.job === job.job)) lines.push(
              `${job.job} — ${row.modelLabel} (${row.model}): ${row.runs} runs; ${row.smallSample ? 'too few runs' : `keep rate ${Math.round(row.keepRate * 100)}%; ${row.costPerKept === null ? 'no kept takes' : `${formatUsd(row.costPerKept)} per kept take`}`}`,
            );
            for (const suggestion of evidence.suggestions.filter((suggestion) => suggestion.job === job.job)) lines.push(`${job.job} suggestion (${suggestion.kind}): ${suggestion.reason}`);
          }
        }
        return text(`Route version: ${models.routeVersion}\nActive policy: ${models.policy}\nToday's spend: ${formatUsd(status.spendTodayUsd)} of ${formatUsd(status.settings.dailyBudgetUsd)} daily budget\nKey configured: ${status.key.configured ? 'yes (configured)' : 'no'}\n\n${lines.join('\n')}\n\n${json(models)}`);
      }),

    editor_generate: (args: Omit<GenerateRequest, 'projectId'>) =>
      guard(async (identify) => {
        const state = await local.state();
        const projectId = state.context?.projectId;
        if (!projectId) return fail('Open a project in the editor first (editor_open).');
        identify(stateIdentity(state));
        const { job } = await local.request<{ job: GenerationJob }>('POST', '/api/generation/jobs', { ...args, projectId, agent: AGENT }, undefined, 330_000);
        const next = job.status === 'denied' ? `The user declined: ${job.error?.message ?? 'Permission was denied.'}`
          : job.status === 'queued' ? `Queued as ${job.id}. Poll editor_generation_status; takes land in the project's Assets › Generated takes. Place one with editor_propose_patch (never without a proposal).`
          : `Poll editor_generation_status for ${job.id}. Place takes only with editor_propose_patch.`;
        return text(`Job: ${job.id}\nStatus: ${job.status}\nModel: ${job.modelLabel} (${job.model})\nEstimate: ${formatUsd(job.estimate.usd)} (${job.estimate.basis})\n${next}`);
      }),

    editor_generation_status: (args: { jobId?: string }) =>
      guard(async (identify) => {
        let jobs: GenerationJob[];
        if (args.jobId) {
          const job = await local.request<GenerationJob>('GET', `/api/generation/jobs/${encodeURIComponent(args.jobId)}`);
          identify({ projectId: job.projectId });
          jobs = [job];
        } else {
          const state = await local.state();
          const projectId = state.context?.projectId;
          if (!projectId) return fail('Open a project in the editor first (editor_open).');
          identify(stateIdentity(state));
          jobs = await local.request<GenerationJob[]>('GET', `/api/generation/jobs?${new URLSearchParams({ projectId })}`);
        }
        return text(jobs.map((job) => {
          const elapsed = Math.max(0, ((job.finishedAt ?? Date.now()) - job.createdAt) / 1000).toFixed(1);
          const outputs = job.status === 'done' ? job.outputs.map((asset) => `- ${asset.id}: ${asset.name} (${asset.kind}${asset.width !== undefined && asset.height !== undefined ? `, ${asset.width}×${asset.height}` : ''}${asset.durationInFrames !== undefined ? `, ${asset.durationInFrames} frames${asset.fps ? ` at ${asset.fps} fps` : ''}` : ''}); delivered: ${job.delivered ? 'yes' : 'no'}`).join('\n') : '';
          return `Job: ${job.id}\nStatus: ${job.status}\nModel: ${job.modelLabel} (${job.model})\nElapsed: ${elapsed} s\nEstimate: ${formatUsd(job.estimate.usd)} (${job.estimate.basis})\nActual cost: ${job.actualUsd === undefined ? 'not available' : formatUsd(job.actualUsd)}${job.error ? `\nError: ${job.error.type}: ${job.error.message}` : ''}${job.status === 'done' ? `\nOutputs:\n${outputs}\nAsset JSON (place only with editor_propose_patch):\n${json(job.outputs)}` : ''}`;
        }).join('\n\n') || 'No generation jobs for the open project.');
      }),

    editor_cancel_generation: (args: { jobId: string }) =>
      guard(async (identify) => {
        const job = await local.request<GenerationJob>('POST', `/api/generation/jobs/${encodeURIComponent(args.jobId)}/cancel`);
        identify({ projectId: job.projectId });
        return text(`Job: ${job.id}\nStatus: ${job.status}\nModel: ${job.modelLabel} (${job.model})`);
      }),

    editor_search_audio: (args: { query: string; kind?: 'music' | 'sfx'; mood?: string; durationSeconds?: number; page?: number }) =>
      guard(async () => {
        const params = new URLSearchParams({ q: args.query });
        if (args.kind) params.set('kind', args.kind);
        if (args.mood) params.set('mood', args.mood);
        if (args.durationSeconds !== undefined) params.set('durationSeconds', String(args.durationSeconds));
        if (args.page !== undefined) params.set('page', String(args.page));
        const data = await local.request<OpenverseSearchResponse>('GET', `/api/openverse/audio/search?${params}`);
        const results = data.results.map(summarizeOpenverseHit);
        return text(json({
          results,
          page: data.page,
          pageCount: data.pageCount,
          resultCount: data.resultCount,
          authenticated: data.authenticated,
          rateLimit: data.rateLimit,
          license: 'Only CC0 and CC BY. NC, SA, ND and other terms are refused server-side even if a filter asks for them. Never use a paid source.',
          next: results.length
            ? 'Pick an id and call editor_inspect_audio or editor_add_audio { id, role: "music"|"sfx" }. After a bed, call editor_get_beats and duck under voice with a volumeEnvelope.'
            : 'No CC0/CC BY hits. Try a broader query, drop mood, or omit durationSeconds.',
          notice: data.notice ?? OPENVERSE_NOTICE,
        }));
      }),

    editor_inspect_audio: (args: { id: string }) =>
      guard(async () => {
        const work = await local.request<OpenverseAudioHit & { notice?: string }>('GET', `/api/openverse/audio/${encodeURIComponent(args.id)}`);
        return text(json({
          ...summarizeOpenverseHit(work),
          licenseRule: 'Only CC0 and CC BY are accepted. This inspect call already ran the server guardrail.',
          next: 'editor_add_audio { id, role: "music"|"sfx" } downloads (cached) and patches the open project.',
          notice: work.notice ?? OPENVERSE_NOTICE,
        }));
      }),

    editor_add_audio: (args: {
      id: string;
      role: 'music' | 'sfx';
      sceneId?: string;
      startFrame?: number;
      name?: string;
      replaceExisting?: boolean;
      baseRevision?: number;
      docSession?: string;
      summary?: string;
    }) =>
      guard(async (identify) => {
        const state = await liveState(local);
        identify(stateIdentity(state));
        const stale = staleSession(state, { baseRevision: args.baseRevision ?? state.project.revision, summary: args.summary ?? 'Add audio', targets: [{ audio: 'project' }], commands: [{ type: 'addAsset' }], docSession: args.docSession });
        if (stale) return stale;
        const { project } = state;
        const context = state.context!;
        const loc = locateFrame(project, context.playhead);
        const sceneId = args.role === 'sfx' ? (args.sceneId ?? loc?.scene.id) : undefined;
        if (args.role === 'sfx' && !sceneId) return fail('sfx needs a sceneId (or a playhead in a scene).');
        const scene = sceneId ? project.scenes.find((s) => s.id === sceneId) : undefined;
        if (args.role === 'sfx' && scene?.locked) return fail(`Scene "${scene.name}" (${scene.id}) is locked. Unlock it first to add a sound effect.`);
        const existing = Object.values(project.assets).find((a) => a.provenance?.license?.openverseId === args.id || a.provenance?.providerRefs?.openverseId === args.id);
        let asset: Asset;
        let cached = false;
        if (existing) {
          asset = existing;
          cached = true;
        } else {
          const imported = await local.request<OpenverseImportResponse>('POST', '/api/openverse/audio/import', { id: args.id, name: args.name });
          cached = imported.cached;
          asset = openverseAssetFromImport(imported.work, { ...imported, kind: 'audio', bytes: imported.bytes ?? 0 }, project.fps, {
            assetId: openverseAssetId(imported.work.id),
            name: args.name,
            cachedAt: Date.now(),
          });
        }
        const startFrame = args.startFrame ?? (args.role === 'music' ? 0 : (loc && loc.scene.id === sceneId ? loc.frameInScene : 0));
        const clipId = openverseClipId();
        const commands: Command[] = [];
        if (args.role === 'music' && args.replaceExisting) {
          for (const clip of project.audio.filter((c) => !c.sceneId)) commands.push({ type: 'removeAudioClip', clipId: clip.id });
        }
        commands.push(...openverseClipCommands(project, asset, { clipId, role: args.role, sceneId, startFrame }));
        const targets: AiPatch['targets'] = args.role === 'music' ? [{ audio: 'project' }] : [{ sceneId: sceneId! }];
        const summary = args.summary ?? (args.role === 'music' ? `Add Openverse music bed “${asset.name}”` : `Add Openverse SFX “${asset.name}”`);
        const patch = buildPatch(project, { baseRevision: args.baseRevision ?? project.revision, summary, targets, commands, docSession: args.docSession });
        const r = await local.command({ type: 'applyPatch', patch, agent: AGENT, model: MODEL, mode: 'auto', ...(args.docSession !== undefined ? { docSession: args.docSession } : {}) });
        if (!r.ok) return replyError(r, 'Adding audio');
        identify({ projectId: r.projectId, revision: r.revision });
        const credits = projectAudioCredits({ ...project, assets: { ...project.assets, [asset.id]: asset }, audio: [...project.audio, { id: clipId, assetId: asset.id, name: asset.name, startFrame, trimStartFrames: 0, durationInFrames: 1, volume: 1, fadeInFrames: 0, fadeOutFrames: 0 }] });
        const outcome = r.proposal
          ? `Proposed — awaiting the user's review (proposal ${r.proposal.id}).`
          : `Applied as r${r.revision}.`;
        return text([
          `${outcome} ${args.role === 'music' ? 'Music bed' : 'Scene SFX'} “${asset.name}” (${asset.id}, clip ${clipId})${cached ? ' (reused cached file)' : ' (downloaded and cached)'}.`,
          `License: ${asset.provenance?.license?.spdxOrCc ?? 'unknown'}. ${asset.provenance?.license?.attribution ?? ''}`,
          args.role === 'music' ? 'Next: editor_get_beats, then cut scenes on downbeats and duck the bed under voice with a volumeEnvelope (see the guide).' : 'Place sparingly on transitions and key entrances; keep volume under the bed and voice.',
          `Credits so far:\n${credits.lines.map((l) => `- ${l}`).join('\n') || '- (none yet)'}`,
          OPENVERSE_NOTICE,
        ].join('\n'));
      }),

    editor_list_credits: () =>
      guard(async (identify) => {
        const state = await liveState(local);
        identify(stateIdentity(state));
        const credits = projectAudioCredits(state.project);
        return text(json({
          lines: credits.lines,
          madeWithOpenverse: credits.madeWithOpenverse,
          file: formatCreditsFile(credits),
          notice: credits.madeWithOpenverse ? OPENVERSE_NOTICE : undefined,
          note: 'Export writes credits.txt next to the MP4 when the project has licensed audio.',
        }));
      }),

    editor_scan_brand: (args: { url: string; propose?: boolean; backgrounds?: boolean; refresh?: boolean; baseRevision?: number; docSession?: string; summary?: string }) =>
      guard(async (identify) => {
        const kit = await local.request<BrandScanResult>('POST', '/api/brand/scan', { url: args.url, refresh: args.refresh === true });
        const logoAsset = kit.logoPath ? logoAssetFromPath(newId('ast'), kit.logoPath, `${kit.domain} logo`) : undefined;
        const apply = {
          summary: args.summary ?? `Apply brand kit from ${kit.domain}`,
          targets: [{ style: 'project' as const }],
          commands: brandStyleCommands({ style: kit.style, logoAsset }),
        };
        if (!args.propose) {
          return text(json({
            kit,
            apply,
            note: 'Reviewable overlay. Pass propose: true (or feed apply to editor_propose_patch) with target { style: "project" }. Logo is never redrawn; fonts list availability and bundled fallbacks. Cached per domain.',
          }));
        }
        let state: EditorStateResponse & { project: Project };
        try {
          state = await liveState(local);
        } catch (e) {
          return text(json({
            kit,
            apply,
            note: e instanceof Error ? e.message : String(e),
          }));
        }
        identify(stateIdentity(state));
        const backgroundSceneIds = args.backgrounds ? state.project.scenes.filter((s) => !s.locked).map((s) => s.id) : [];
        const commands = brandStyleCommands({ style: kit.style, logoAsset, backgroundSceneIds });
        const targets: AiPatch['targets'] = [{ style: 'project' }, ...backgroundSceneIds.map((sceneId) => ({ sceneId }))];
        const patchArgs: PatchArgs = {
          baseRevision: args.baseRevision ?? state.project.revision,
          summary: apply.summary,
          targets,
          commands,
          docSession: args.docSession,
        };
        const stale = staleSession(state, patchArgs);
        if (stale) return stale;
        const r = await local.command({ type: 'applyPatch', patch: buildPatch(state.project, patchArgs), agent: AGENT, model: MODEL, mode: 'propose', ...(args.docSession !== undefined ? { docSession: args.docSession } : {}) });
        if (!r.ok) return replyError(r, 'Brand kit');
        identify({ projectId: r.projectId, revision: r.revision });
        const outcome = r.proposal
          ? `Proposed — awaiting the user's review (proposal ${r.proposal.id}, based on r${r.proposal.baseRevision}). Nothing has changed in the project yet.`
          : r.applied === true || r.revision !== undefined
            ? `Applied as r${r.revision}.`
            : 'The editor did not confirm a proposal.';
        return text([
          outcome,
          changeLines(r.changes),
          json({ kit, apply: { ...apply, targets, commands } }),
          'Logo is a reference asset (never placed on a layer). Review the style overlay in the editor; Cancel undoes it.',
        ].filter(Boolean).join('\n'));
      }),

    editor_analyze_reference: (args: { url?: string; path?: string; refresh?: boolean }) =>
      guard(async () => {
        if ((args.path === undefined) === (args.url === undefined)) return fail('Give either path (a local video file) or url (https), not both.');
        const report = await local.request<ReferenceReport>('POST', '/api/reference/analyze', { url: args.url, path: args.path, refresh: args.refresh === true });
        const publicDir = join(local.cfg.rootDir, 'public');
        const artifacts = report.artifacts.map((a) => ({
          ...a,
          path: isAbsolute(a.path) ? a.path : join(publicDir, a.path),
        }));
        const out = { ...report, artifacts, notice: report.notice ?? REFERENCE_NOTICE };
        const content: Content[] = [{ type: 'text', text: json(out) }];
        const sheet = artifacts.find((a) => a.kind === 'contact-sheet');
        if (sheet) {
          try {
            content.push({ type: 'image', data: (await readAgentFile(sheet.path, local.cfg.rootDir)).toString('base64'), mimeType: 'image/png' });
          } catch {
            // Path is in the JSON; the agent can Read it once ffmpeg finishes writing.
          }
        }
        return { content };
      }),
  };
}

function summarizeOpenverseHit(work: OpenverseAudioHit) {
  return {
    id: work.id,
    title: work.title,
    creator: work.creator,
    durationSeconds: work.durationSeconds,
    license: work.license,
    licenseVersion: work.licenseVersion,
    licenseUrl: work.licenseUrl,
    attribution: work.attribution,
    category: work.category,
    provider: work.provider,
    foreignLandingUrl: work.foreignLandingUrl,
    previewUrl: work.previewUrl,
    tags: work.tags.slice(0, 12),
  };
}

export type Handlers = ReturnType<typeof createHandlers>;
