// Thin editor-side adapters over src/core. Everything that changes the
// document goes through executeCommand → core `execute`; files use core serializeDoc/loadDoc.

import { COMPONENTS } from '../core/components';
import { execute, loadDoc as coreLoadDoc, serializeDoc as coreSerializeDoc } from '../core/history';
import { parseProjectFile } from '../core/validate';
import { newId } from '../core/ids';
import type { Command, CommandError, DocResult, DocState, Element, ElementType, Project, ProjectFile, Scene } from '../core/types';

export function executeCommand(state: DocState, command: Command, label?: string): DocResult {
  return execute(state, command, 'user', label);
}

export function serializeDoc(state: DocState): ProjectFile {
  return coreSerializeDoc(state);
}

export type LoadResult = { ok: true; state: DocState; file: ProjectFile } | { ok: false; error: CommandError };

/** Accepts a ProjectFile (or a bare Project, wrapped) and returns a fresh DocState via core loadDoc. */
export function loadDoc(input: unknown): LoadResult {
  if (!input || typeof input !== 'object') {
    return { ok: false, error: { code: 'INVALID', message: 'The file is not a JSON object.', hint: 'Choose a file exported from this editor (Export JSON).' } };
  }
  const obj = input as Record<string, unknown>;
  let candidate = input as ProjectFile;
  if (obj.format === undefined && Array.isArray(obj.scenes)) {
    candidate = { format: 'mge.project/1', project: obj as unknown as Project, revisions: [], savedAt: new Date(0).toISOString() };
  } else if (obj.format !== 'mge.project/1') {
    return {
      ok: false,
      error: { code: 'INVALID', message: `Unsupported file format "${String(obj.format)}".`, hint: 'Expected format "mge.project/1" — export the project again from the editor.', path: 'format' },
    };
  }
  const parsed = parseProjectFile(candidate);
  if (!parsed.ok) return parsed;
  const r = coreLoadDoc(parsed.value);
  if (!r.ok) return r;
  return { ok: true, state: r.state, file: parsed.value };
}

// ---------------------------------------------------------------------------
// Autosave (browser-local convenience; never the source of truth)
// ---------------------------------------------------------------------------

const AUTOSAVE_KEY = 'mge.autosave.v1';

export interface Autosave {
  file: ProjectFile;
  at: number;
  /** Editor docSession that wrote it (absent in autosaves from older builds). */
  session?: string;
}

export function writeAutosave(state: DocState, session?: string): void {
  try {
    const payload: Autosave = { file: serializeDoc(state), at: Date.now(), ...(session ? { session } : {}) };
    localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(payload));
  } catch {
    // Storage full or blocked — autosave is best-effort.
  }
}

export function readAutosave(): Autosave | null {
  try {
    const raw = localStorage.getItem(AUTOSAVE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Autosave;
    if (!v?.file) return null;
    const parsed = parseProjectFile(v.file);
    return parsed.ok ? { ...v, file: parsed.value } : null;
  } catch {
    return null;
  }
}

export function clearAutosave(): void {
  try {
    localStorage.removeItem(AUTOSAVE_KEY);
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// Factories for new entities
// ---------------------------------------------------------------------------

/** Relative luminance above 0.6: a colour meant for a dark plate. */
function isLightHex(hex: string): boolean {
  const m = /^#([0-9a-f]{6})/i.exec(hex.trim());
  if (!m) return false;
  const n = parseInt(m[1], 16);
  const lin = (c: number) => { const x = c / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin(n >> 16) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255) > 0.6;
}

export function createElement(project: Project, scene: Scene, type: ElementType): Element {
  const def = COMPONENTS[type];
  const props: Record<string, unknown> = structuredClone(def.defaultProps);
  for (const f of def.fields) {
    if (f.kind === 'asset' && !props[f.key]) {
      const match = Object.values(project.assets).find((a) => f.assetKinds.includes(a.kind) && !a.reference);
      if (match) props[f.key] = match.id;
    }
  }
  // Component defaults assume a dark plate. On a project with a style pack, light
  // default colours (white text, pale strokes) take the pack's text colour instead,
  // for elements drawn straight on the plate; cards and bubbles carry their own.
  const style = project.style;
  if (style && (type === 'text' || type === 'path' || type === 'shape')) {
    for (const f of def.fields) {
      const v = props[f.key];
      if ((f.kind === 'color' || f.kind === 'paint') && typeof v === 'string' && v !== 'none' && isLightHex(v)) props[f.key] = style.colors.text;
    }
  }
  const { width, height } = def.defaultSize;
  const count = scene.elements.filter((e) => e.type === type).length;
  // A video never outlasts its file.
  const sourceLength = type === 'video' ? project.assets[String(props.assetId)]?.durationInFrames : undefined;
  return {
    id: newId('el'),
    type,
    name: count ? `${def.label} ${count + 1}` : def.label,
    startFrame: 0,
    durationInFrames: Math.min(scene.durationInFrames, sourceLength ?? Infinity),
    visible: true,
    transform: {
      x: Math.round((project.width - width) / 2),
      y: Math.round((project.height - height) / 2),
      width,
      height,
      rotation: 0,
      scale: 1,
      opacity: 1,
    },
    props,
    tracks: [],
  };
}

export function createScene(project: Project, name: string): Scene {
  return {
    id: newId('scn'),
    name,
    durationInFrames: project.fps * 5,
    backgroundColor: project.backgroundColor,
    locked: false,
    transitionIn: { type: 'none', durationInFrames: 0 },
    elements: [],
  };
}

export function duplicateScene(scene: Scene): Scene {
  const copy = structuredClone(scene);
  copy.id = newId('scn');
  copy.name = `${scene.name} copy`;
  copy.locked = false;
  const ids = new Map(copy.elements.map(e => [e.id, newId('el')]));
  copy.elements = copy.elements.map(e => ({ ...e, id: ids.get(e.id)!,
    ...(e.parentId ? { parentId: ids.get(e.parentId)! } : {}),
    ...(e.mask ? { mask: { ...e.mask, sourceId: ids.get(e.mask.sourceId)! } } : {}),
  }));
  return copy;
}

export function findElement(project: Project, sceneId: string | null, elementId: string | null): { scene: Scene; element: Element } | null {
  if (!sceneId || !elementId) return null;
  const scene = project.scenes.find((s) => s.id === sceneId);
  const element = scene?.elements.find((e) => e.id === elementId);
  return scene && element ? { scene, element } : null;
}
