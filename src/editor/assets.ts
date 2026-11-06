// Asset upload, file probing and asset diagnostics (missing files, files a
// browser cannot decode, bundled fonts that failed to load).

import { create } from 'zustand';
import type { AssetProbeResponse, UploadAssetResponse } from '../core/api-contract';
import { COMPONENTS } from '../core/components';
import { newId } from '../core/ids';
import type { Asset, AssetKind, Element, Project } from '../core/types';
import { api, errorText, ServerDownError, SERVER_DOWN_MESSAGE, withTab } from './api';
import { useEditor } from './store';

export function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.addEventListener('cancel', () => resolve(null));
    input.click();
  });
}

export function acceptFor(kinds: readonly AssetKind[]): string {
  const parts: string[] = [];
  if (kinds.includes('image')) parts.push('image/png', 'image/jpeg', 'image/webp');
  if (kinds.includes('svg')) parts.push('image/svg+xml', '.svg');
  if (kinds.includes('audio')) parts.push('audio/*');
  if (kinds.includes('video')) parts.push('video/mp4', 'video/webm', 'video/quicktime', '.mp4', '.m4v', '.webm', '.mov');
  return parts.join(',');
}

/** Asset fields (no id) for a file the server stored; lengths in the project's frames. */
export function fieldsFromUpload(r: UploadAssetResponse, fps: number): Omit<Asset, 'id'> {
  return {
    kind: r.kind,
    name: r.name,
    src: r.src,
    mimeType: r.mimeType,
    width: r.width,
    height: r.height,
    durationInFrames: r.durationSeconds !== undefined ? Math.max(1, Math.round(r.durationSeconds * fps)) : undefined,
    // Video: the source rate and soundtrack; the preview proxy (if one is being made) is filled in when ready.
    ...(r.kind === 'video' ? { fps: r.fps, hasAudio: r.hasAudio ?? false, proxySrc: undefined } : {}),
  };
}

function uploadFailed(e: unknown, file: File) {
  const { toast } = useEditor.getState();
  if (e instanceof ServerDownError) toast({ tone: 'error', message: SERVER_DOWN_MESSAGE, hint: 'Uploading needs the local server. Everything else keeps working.' });
  else toast({ tone: 'error', message: `Could not upload “${file.name}”: ${errorText(e).message}`, hint: errorText(e).hint });
}

/** Upload to the local server and return asset fields (no id). Shows a toast and returns null on failure. */
export async function uploadAsset(kinds: readonly AssetKind[]): Promise<Omit<Asset, 'id'> | null> {
  const file = await pickFile(acceptFor(kinds));
  if (!file) return null;
  const { toast, doc } = useEditor.getState();
  try {
    const r = await api.uploadAsset(file);
    if (!kinds.includes(r.kind)) {
      toast({ tone: 'error', message: `“${file.name}” is a ${r.kind} file, but this field accepts ${kinds.join(' or ')}.`, hint: 'Choose a file of an accepted type.' });
      return null;
    }
    return fieldsFromUpload(r, doc.project.fps);
  } catch (e) {
    uploadFailed(e, file);
    return null;
  }
}

/**
 * Files dropped (or picked) for generation: each is uploaded and added to the
 * project as a reference, which steers generation and is never placed in the
 * video, in one undo step. Files of other kinds are skipped with a toast. The
 * new assets, in the files' order; none when another project opened meanwhile.
 */
export async function addReferenceFiles(files: readonly File[], kinds: readonly AssetKind[]): Promise<Asset[]> {
  const st = useEditor.getState();
  const session = st.docSession;
  const projectId = st.doc.project.id;
  const added: Asset[] = [];
  const skipped: string[] = [];
  for (const file of files) {
    try {
      const r = await api.uploadAsset(file);
      if (kinds.includes(r.kind)) added.push(newAsset({ ...fieldsFromUpload(r, st.doc.project.fps), reference: true }));
      else skipped.push(file.name);
    } catch (e) {
      uploadFailed(e, file);
    }
  }
  const now = useEditor.getState();
  if (skipped.length) now.toast({ tone: 'info', message: `${skipped.map((n) => `“${n}”`).join(', ')} ${skipped.length === 1 ? 'is' : 'are'} not ${kinds.join(' or ')}, so ${skipped.length === 1 ? 'it was' : 'they were'} left out.` });
  if (!added.length) return [];
  if (now.docSession !== session || now.doc.project.id !== projectId) {
    now.toast({ tone: 'info', message: 'The files were uploaded, but another project is open now, so they were not added.' });
    return [];
  }
  const label = added.length === 1 ? `Add reference ${added[0].name}` : `Add ${added.length} references`;
  const commands = added.map((asset) => ({ type: 'addAsset' as const, asset }));
  if (!(commands.length === 1 ? now.run(commands[0], label) : now.run({ type: 'batch', label, commands }, label))) return [];
  return added;
}

export function newAsset(fields: Omit<Asset, 'id'>): Asset {
  const a: Asset = { id: newId('ast'), ...fields };
  // Drop undefined optionals so the document stays clean JSON.
  for (const k of Object.keys(a) as (keyof Asset)[]) if (a[k] === undefined) delete a[k];
  return a;
}

// ---------------------------------------------------------------------------
// File probes (GET /api/assets/probe) and bundled-font status
// ---------------------------------------------------------------------------

export type AssetProbe = AssetProbeResponse;

/** Probe one asset file. null when the server is down or answered with an error. */
export async function probeAsset(src: string): Promise<AssetProbe | null> {
  try {
    const res = await fetch(`/api/assets/probe?src=${encodeURIComponent(src)}`, withTab({ signal: AbortSignal.timeout(4000) }));
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('application/json')) return null;
    return (await res.json()) as AssetProbe;
  } catch {
    return null;
  }
}

interface AssetStatus {
  /** Latest probe per asset src (absent = not probed, or the server is down). */
  probes: Record<string, AssetProbe>;
  /** "Family weight" faces that failed to load in this page, e.g. "Inter 700". */
  fontFailures: string[];
}

export const useAssetStatus = create<AssetStatus>(() => ({ probes: {}, fontFailures: [] }));

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

export type AssetOwner =
  | { kind: 'element'; sceneId: string; elementId: string; label: string }
  | { kind: 'audio'; clipId: string; sceneId?: string; label: string }
  /** An element inside a reusable component (no direct selection). */
  | { kind: 'component'; compositionId: string; elementId: string; label: string };

export interface AssetRef {
  key: string;
  owner: AssetOwner;
  field: string;
  assetId: string;
}

export type AssetProblemKind = 'noFile' | 'unknownAsset' | 'missing' | 'undecodable' | 'font';

export interface AssetWarning extends AssetRef {
  problem: AssetProblemKind;
  reason: string;
}

function elementRefs(el: Element, owner: AssetOwner): AssetRef[] {
  return (COMPONENTS[el.type]?.fields ?? []).flatMap((f) =>
    f.kind !== 'asset' ? [] : [{ key: `${el.id}.${f.key}`, owner, field: f.label, assetId: String(el.props[f.key] ?? '') }],
  );
}

/** Every element / component / audio-clip reference to an asset. */
export function collectAssetRefs(project: Project): AssetRef[] {
  const refs: AssetRef[] = [];
  for (const scene of project.scenes) {
    for (const el of scene.elements) refs.push(...elementRefs(el, { kind: 'element', sceneId: scene.id, elementId: el.id, label: `${scene.name} › ${el.name}` }));
  }
  for (const comp of Object.values(project.compositions)) {
    for (const el of comp.elements) refs.push(...elementRefs(el, { kind: 'component', compositionId: comp.id, elementId: el.id, label: `Component ${comp.name} › ${el.name}` }));
  }
  for (const clip of project.audio) {
    refs.push({ key: `${clip.id}.assetId`, owner: { kind: 'audio', clipId: clip.id, sceneId: clip.sceneId, label: `Audio › ${clip.name}` }, field: 'Audio file', assetId: clip.assetId });
  }
  return refs;
}

/**
 * Faces an element's text is set in. Text elements use their own family and
 * weight; UI cards and chat bubbles are set in fixed families by their
 * renderers (any failed weight of those families affects them).
 */
export function fontUses(el: Element): { family: string; weight?: number }[] {
  const defaults = COMPONENTS[el.type]?.defaultProps ?? {};
  if (el.type === 'text') return [{ family: String(el.props.fontFamily ?? defaults.fontFamily), weight: Number(el.props.fontWeight ?? defaults.fontWeight) }];
  if (el.type === 'chatBubble') return [{ family: 'Inter' }];
  if (el.type === 'uiCard') return [{ family: 'Inter' }, { family: 'Space Grotesk' }];
  return [];
}

function usesFailedFont(el: Element, failed: readonly string[]): string[] {
  return failed.filter((face) => fontUses(el).some((u) => (u.weight === undefined ? face.startsWith(`${u.family} `) : face === `${u.family} ${u.weight}`)));
}

export interface AssetChecks {
  /** srcs the server reported as not on disk. */
  missingSrc?: ReadonlySet<string>;
  /** src → why a browser cannot decode it. */
  undecodable?: ReadonlyMap<string, string>;
  /** Faces that failed to load in this page. */
  fontFailures?: readonly string[];
}

/** Every asset problem, one warning per affected reference (element, component element or audio clip). */
export function assetWarnings(project: Project, checks: AssetChecks = {}): AssetWarning[] {
  const out: AssetWarning[] = [];
  for (const ref of collectAssetRefs(project)) {
    const asset = ref.assetId ? project.assets[ref.assetId] : undefined;
    if (!ref.assetId) out.push({ ...ref, problem: 'noFile', reason: 'No file chosen' });
    else if (!asset) out.push({ ...ref, problem: 'unknownAsset', reason: `Asset “${ref.assetId}” is not in this project` });
    else if (checks.missingSrc?.has(asset.src)) out.push({ ...ref, problem: 'missing', reason: `File not found on disk: public/${asset.src}` });
    else if (checks.undecodable?.has(asset.src)) out.push({ ...ref, problem: 'undecodable', reason: `Can’t decode public/${asset.src}: ${checks.undecodable.get(asset.src)}` });
  }
  const failed = checks.fontFailures ?? [];
  if (failed.length) {
    const visit = (el: Element, owner: AssetOwner) => {
      const faces = usesFailedFont(el, failed);
      if (faces.length) out.push({ key: `${el.id}.font`, owner, field: 'Font', assetId: '', problem: 'font', reason: `${faces.join(', ')} did not load` });
    };
    for (const scene of project.scenes) for (const el of scene.elements) visit(el, { kind: 'element', sceneId: scene.id, elementId: el.id, label: `${scene.name} › ${el.name}` });
    for (const comp of Object.values(project.compositions)) for (const el of comp.elements) visit(el, { kind: 'component', compositionId: comp.id, elementId: el.id, label: `Component ${comp.name} › ${el.name}` });
  }
  return out;
}

/** Warnings grouped into one row per problem (one asset file, or all font failures), listing who is affected. */
export interface AssetProblem {
  key: string;
  problem: AssetProblemKind;
  assetId?: string;
  reason: string;
  users: AssetWarning[];
}

export function groupWarnings(warnings: readonly AssetWarning[]): AssetProblem[] {
  const groups = new Map<string, AssetProblem>();
  for (const w of warnings) {
    // Refs with no file / unknown ids are each their own problem; file and font problems group.
    const key = w.problem === 'font' ? 'font' : w.problem === 'missing' || w.problem === 'undecodable' ? `${w.problem}:${w.assetId}` : `${w.problem}:${w.key}`;
    const g = groups.get(key);
    if (g) g.users.push(w);
    else groups.set(key, { key, problem: w.problem, assetId: w.assetId || undefined, reason: w.reason, users: [w] });
  }
  return [...groups.values()];
}
