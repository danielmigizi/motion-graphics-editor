// AI patch protocol: parse, validate and apply an `mge.patch/1` document.
//
// Check order (first failure wins):
//   PROTOCOL → PROJECT_MISMATCH → STALE (unless reconciled) → NOT_FOUND
//   (unknown target) → OUT_OF_SCOPE → LOCKED → applyCommand errors (INVALID…).
// A patch applies as ONE batch with source 'ai': one undo step, one revision.
//
// Targets: `{ sceneId }` covers a scene, its elements and the audio clips
// anchored to it; `{ sceneId, elementId }` one element (and its descendants);
// `{ audio: 'project' }` the project-level audio (the music bed and every clip
// without a sceneId). `{ style: 'project' }` the style pack (`setStyle`).
// Moving a clip between a scene and the project timeline needs both. A locked
// scene locks its anchored clips.

import { applyCommand, compositionDependencies } from './commands';
import { diffProjects } from './diff';
import { commitChange, touchedSince } from './history';
import { AiPatchSchema, firstIssue } from './schema';
import type { AiPatch, ChangeEntry, Command, CommandError, DocResult, DocState, ID, PatchTarget, Project, TouchedRef } from './types';

export type ParseResult = { ok: true; patch: AiPatch } | { ok: false; error: CommandError };

/** Command types an AI patch may contain. */
export const AI_COMMAND_TYPES = ['updateElement', 'setKeyframe', 'removeKeyframe', 'addElement', 'removeElement', 'moveElement', 'updateScene', 'addAsset', 'setPropertyKeyframe', 'removePropertyKeyframe', 'setParent', 'groupElements', 'ungroup', 'addAudioClip', 'updateAudioClip', 'removeAudioClip', 'detachVideoAudio', 'setStyle'] as const;

const protocolError = (message: string, path?: string, hint?: string): { ok: false; error: CommandError } => {
  const error: CommandError = { code: 'PROTOCOL', message };
  if (path !== undefined) error.path = path;
  if (hint) error.hint = hint;
  return { ok: false, error };
};

/**
 * Pull the JSON text out of a reply: raw JSON, or the first ``` fence
 * containing "protocol" (preferring the first such fence that is valid JSON,
 * so an echoed schema sketch before the real block does not win).
 */
function extractJson(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) return trimmed;
  const fence = /```[^\n`]*\n([\s\S]*?)```/g;
  const candidates: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = fence.exec(text))) {
    if (m[1].includes('"protocol"')) candidates.push(m[1].trim());
  }
  for (const c of candidates) {
    try {
      JSON.parse(c);
      return c;
    } catch {
      // try the next fence
    }
  }
  return candidates[0] ?? null;
}

/** Validate an already-parsed value as an AiPatch. */
export function validatePatch(value: unknown): ParseResult {
  const r = AiPatchSchema.safeParse(value);
  if (!r.success) {
    const { path, message } = firstIssue(r.error);
    return protocolError(`Patch does not match ${'mge.patch/1'}: ${message}`, path, 'Ask the agent to reply with exactly the AiPatch JSON shape from the prompt.');
  }
  // Only the parsed value goes forward; strict schemas have already rejected unknown keys.
  return { ok: true, patch: r.data };
}

/** Parse pasted text (raw JSON, or JSON inside a ```json fence) into a validated AiPatch. */
export function parsePatch(text: string): ParseResult {
  const json = extractJson(text);
  if (json === null) {
    return protocolError('No patch found: paste the raw JSON or the ```json block containing "protocol": "mge.patch/1".');
  }
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (e) {
    return protocolError(`Patch is not valid JSON: ${(e as Error).message}`, undefined, 'Copy the whole ```json block from the reply.');
  }
  return validatePatch(value);
}

export interface ApplyPatchOptions {
  /** Who made the change; the revision label becomes "<actor>: <summary>" (default "AI"). */
  actor?: string;
  /** Explicitly rebase a stale patch when none of its targets changed since baseRevision. */
  reconcile?: boolean;
}

export type CheckPatchResult =
  | {
      ok: true;
      /** The project the patch would produce (revision not yet bumped). */
      project: Project;
      touched: TouchedRef[];
      diff: ChangeEntry[];
      /** True when the patch was stale and rebased via reconcile. */
      reconciled: boolean;
      label: string;
    }
  | {
      ok: false;
      error: CommandError;
      /** STALE + reconcile: targets that changed since baseRevision. */
      conflicts?: AiPatch['targets'];
    };

type Target = AiPatch['targets'][number];

/** A scene or element target (as opposed to `{ audio: 'project' }` / `{ style: 'project' }`). */
export function isSceneTarget(t: PatchTarget): t is { sceneId: ID; elementId?: ID } {
  return 'sceneId' in t;
}

/** The project-audio target `{ audio: 'project' }`. */
export function isAudioTarget(t: PatchTarget): t is { audio: 'project' } {
  return 'audio' in t;
}

/** The style-pack target `{ style: 'project' }` (`setStyle` only). */
export function isStyleTarget(t: PatchTarget): t is { style: 'project' } {
  return 'style' in t;
}

/**
 * Where an audio clip lived across the revisions in question: a scene id for
 * a scene-anchored clip, null for a project-level one (empty when unknown).
 */
export type AudioScopes = (clipId: ID) => ReadonlySet<ID | null>;

/** Audio scopes of every clip across these documents (a clip that moved counts in both places). */
export function audioScopesOf(projects: readonly Project[]): AudioScopes {
  return (clipId) => {
    const out = new Set<ID | null>();
    for (const p of projects) {
      const clip = p.audio.find((c) => c.id === clipId);
      if (clip) out.add(clip.sceneId ?? null);
    }
    return out;
  };
}

function flatten(commands: readonly Command[], prefix = 'commands'): { command: Command; path: string }[] {
  const out: { command: Command; path: string }[] = [];
  commands.forEach((c, i) => {
    const path = `${prefix}[${i}]`;
    if (c.type === 'batch') out.push(...flatten(c.commands, `${path}.commands`));
    else out.push({ command: c, path });
  });
  return out;
}

function targetLabel(t: Target): string {
  if (isStyleTarget(t)) return 'project style';
  if (!isSceneTarget(t)) return 'project audio';
  return t.elementId ? `${t.sceneId}/${t.elementId}` : t.sceneId;
}

/**
 * Does a touched ref intersect a target? Project-level touches (name, scene
 * order) never do. An audio touch intersects the project-audio target when the
 * clip is (or was) project-level, and a whole-scene target when it is (or was)
 * anchored to that scene; `audioScopes` says which. Without it (or for a clip
 * no document knows) an audio touch conservatively intersects every audio
 * target and whole-scene target.
 */
export function touchIntersects(ref: TouchedRef, target: Target, audioScopes?: AudioScopes): boolean {
  if (ref.kind === 'audio') {
    const scopes = audioScopes?.(ref.clipId);
    const unknown = !scopes || scopes.size === 0;
    if (isAudioTarget(target)) return unknown || scopes.has(null);
    if (isStyleTarget(target)) return false;
    return !target.elementId && (unknown ? !!audioScopes : scopes.has(target.sceneId));
  }
  // setStyle and other project-level edits share { kind: 'project' }; a style
  // target treats those as conflicts so two restyles cannot silently rebase.
  if (isStyleTarget(target)) return ref.kind === 'project';
  if (!isSceneTarget(target)) return false;
  if (ref.kind === 'scene') return ref.sceneId === target.sceneId;
  if (ref.kind === 'element') return ref.sceneId === target.sceneId && (!target.elementId || ref.elementId === target.elementId);
  return false;
}

function targetElements(project: Project, target: Target): import('./types').Element[] {
  if (!isSceneTarget(target)) return [];
  const elements = project.scenes.find(s => s.id === target.sceneId)?.elements ?? [];
  if (!target.elementId) return elements;
  const ids = new Set([target.elementId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const el of elements) if (el.parentId && ids.has(el.parentId) && !ids.has(el.id)) { ids.add(el.id); grew = true; }
  }
  return elements.filter(el => ids.has(el.id));
}

function scopeError(path: string, message: string): { ok: false; error: CommandError } {
  return {
    ok: false,
    error: { code: 'OUT_OF_SCOPE', message, path, hint: 'Each command must stay inside the patch targets; regenerate the prompt with the right targets.' },
  };
}

function checkScope(patch: AiPatch, project: Project): { ok: false; error: CommandError } | null {
  const targets = patch.targets.filter(isSceneTarget);
  const sceneTargets = new Set(targets.filter((t) => !t.elementId).map((t) => t.sceneId));
  const elementTargets = new Set(targets.filter((t) => t.elementId).map((t) => `${t.sceneId}/${t.elementId}`));
  const audioTarget = patch.targets.some(isAudioTarget);
  const styleTarget = patch.targets.some(isStyleTarget);
  // Where each clip lives as the patch runs (clips added earlier in the patch count).
  const clipScope = new Map<ID, ID | null>(project.audio.map((c) => [c.id, c.sceneId ?? null]));
  const needAudio = (scope: ID | null, path: string, what: string) => {
    if (scope === null) {
      return audioTarget ? null : scopeError(path, `${what} is project-level audio and needs the target { "audio": "project" }`);
    }
    return sceneTargets.has(scope) ? null : scopeError(path, `${what} is anchored to scene ${scope} and needs the scene target { "sceneId": "${scope}" }`);
  };
  for (const { command, path } of flatten(patch.commands)) {
    if (!(AI_COMMAND_TYPES as readonly string[]).includes(command.type)) {
      return scopeError(path, `AI patches may not use ${command.type} (allowed: ${AI_COMMAND_TYPES.join(', ')})`);
    }
    switch (command.type) {
      case 'addAudioClip': {
        if (clipScope.has(command.clip.id)) return { ok: false, error: { code: 'INVALID', message: `Audio clip id ${command.clip.id} already exists`, path: `${path}.clip.id` } };
        const scope = command.clip.sceneId ?? null;
        const e = needAudio(scope, path, `addAudioClip "${command.clip.name}"`);
        if (e) return e;
        clipScope.set(command.clip.id, scope);
        break;
      }
      case 'updateAudioClip':
      case 'removeAudioClip': {
        const from = clipScope.get(command.clipId);
        if (from === undefined) break; // applyCommand reports NOT_FOUND
        const to = command.type === 'updateAudioClip' && 'sceneId' in command.changes ? (command.changes.sceneId ?? null) : from;
        const e = needAudio(from, path, `${command.type} on clip ${command.clipId}`) ?? (to !== from ? needAudio(to, path, `Moving clip ${command.clipId}`) : null);
        if (e) return e;
        if (command.type === 'removeAudioClip') clipScope.delete(command.clipId);
        else clipScope.set(command.clipId, to);
        break;
      }
      case 'setStyle':
        if (!styleTarget) return scopeError(path, 'setStyle needs the target { "style": "project" }');
        break;
      case 'detachVideoAudio':
        // Changes the element and adds a clip anchored to its scene: the scene target covers both.
        if (!sceneTargets.has(command.sceneId)) {
          return scopeError(path, `detachVideoAudio on element ${command.elementId} needs a scene target { "sceneId": "${command.sceneId}" } (it adds an audio clip anchored to that scene)`);
        }
        clipScope.set(command.clipId, command.sceneId);
        break;
      case 'groupElements':
      case 'ungroup':
      case 'updateScene':
      case 'addElement':
      case 'removeElement':
        if (!sceneTargets.has(command.sceneId)) {
          return scopeError(path, `${command.type} on scene ${command.sceneId} needs a scene target { "sceneId": "${command.sceneId}" }`);
        }
        break;
      case 'updateElement':
      case 'setPropertyKeyframe':
      case 'removePropertyKeyframe':
      case 'setParent':
      case 'setKeyframe':
      case 'removeKeyframe':
      case 'moveElement':
        if (!sceneTargets.has(command.sceneId) && !elementTargets.has(`${command.sceneId}/${command.elementId}`)) {
          return scopeError(path, `${command.type} on element ${command.elementId} in scene ${command.sceneId} is outside the patch targets (${patch.targets.map(targetLabel).join(', ')})`);
        }
        break;
    }
  }
  return null;
}

/** Run every check and compute the would-be result + diff without committing (for preview). */
export function checkPatch(state: DocState, input: AiPatch, opts: ApplyPatchOptions = {}): CheckPatchResult {
  const valid = validatePatch(input);
  if (!valid.ok) return valid;
  const patch = valid.patch;
  const project = state.project;

  if (patch.projectId !== project.id) {
    return {
      ok: false,
      error: {
        code: 'PROJECT_MISMATCH',
        message: `This patch is for project ${patch.projectId}, but the open project is ${project.id}.`,
        hint: 'Open the matching project, or regenerate the prompt from this one.',
      },
    };
  }

  let reconciled = false;
  if (patch.baseRevision !== project.revision) {
    const staleMessage = `Patch is based on revision ${patch.baseRevision}, but the project is at revision ${project.revision}. Regenerate the prompt, or Reconcile if the targets have not changed.`;
    if (!opts.reconcile || patch.baseRevision > project.revision) {
      return { ok: false, error: { code: 'STALE', message: staleMessage } };
    }
    const touched = touchedSince(state, patch.baseRevision);
    if (touched === null) {
      return {
        ok: false,
        error: {
          code: 'STALE',
          message: `Cannot reconcile: history no longer reaches back to revision ${patch.baseRevision} (project is at revision ${project.revision}). Regenerate the prompt.`,
        },
      };
    }
    // Every document since the base: a clip that moved between scenes and the project timeline counts in both places.
    const audioScopes = audioScopesOf([...state.revisions.filter((r) => r.revision >= patch.baseRevision).map((r) => r.snapshot), project]);
    const conflicts = patch.targets.filter((t) => touched.some((ref) => touchIntersects(ref, t, audioScopes) || (ref.kind === 'composition' && compositionDependencies(project, targetElements(project, t)).has(ref.compositionId))));
    if (conflicts.length) {
      return {
        ok: false,
        error: {
          code: 'STALE',
          message: `Cannot reconcile: these targets changed since revision ${patch.baseRevision}: ${conflicts.map(targetLabel).join(', ')}. Regenerate the prompt.`,
        },
        conflicts,
      };
    }
    reconciled = true;
  }

  // Targets must exist.
  for (let i = 0; i < patch.targets.length; i++) {
    const t = patch.targets[i];
    if (!isSceneTarget(t)) continue; // the project audio always exists
    const scene = project.scenes.find((s) => s.id === t.sceneId);
    if (!scene) return { ok: false, error: { code: 'NOT_FOUND', message: `Target scene ${t.sceneId} does not exist`, path: `targets[${i}].sceneId` } };
    if (t.elementId && !scene.elements.some((e) => e.id === t.elementId)) {
      return { ok: false, error: { code: 'NOT_FOUND', message: `Target element ${t.elementId} is not in scene "${scene.name}" (${scene.id})`, path: `targets[${i}].elementId` } };
    }
  }

  const scope = checkScope(patch, project);
  if (scope) return scope;

  for (const t of patch.targets.filter(isSceneTarget)) {
    const scene = project.scenes.find((s) => s.id === t.sceneId)!;
    if (scene.locked) {
      return {
        ok: false,
        error: {
          code: 'LOCKED',
          message: `Scene "${scene.name}" (${scene.id}) is locked. Unlock it first to let the AI change it.`,
          hint: 'Approved scenes are locked; unlock the scene in the editor, then apply again.',
        },
      };
    }
  }

  const label = `${opts.actor?.trim() || 'AI'}: ${patch.summary}`;
  const r = applyCommand(project, { type: 'batch', label, commands: patch.commands }, { source: 'ai' });
  if (!r.ok) return r;
  return { ok: true, project: r.project, touched: r.touched, diff: diffProjects(project, r.project), reconciled, label };
}

/** Validate and apply atomically as source 'ai'. One undo step, one revision. */
export function applyPatch(state: DocState, patch: AiPatch, opts: ApplyPatchOptions = {}): DocResult {
  const r = checkPatch(state, patch, opts);
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, state: commitChange(state, r.project, r.label, 'ai', r.touched) };
}
