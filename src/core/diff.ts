// Field-level comparison between two project revisions. Entities are matched
// by ID, never by index. Order changes are reported as `moved` (path `order`)
// only for items whose relative order actually changed (items outside the
// longest common subsequence), so inserting or removing one scene does not
// mark every later scene as moved. `revision` itself is never reported.

import type { Asset, AudioClip, ChangeEntry, Element, Project, Scene } from './types';

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return Number.isNaN(a) && Number.isNaN(b);
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    return a.length === bb.length && a.every((v, i) => deepEqual(v, bb[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao).filter((k) => ao[k] !== undefined);
  const bk = Object.keys(bo).filter((k) => bo[k] !== undefined);
  return ak.length === bk.length && ak.every((k) => Object.prototype.hasOwnProperty.call(bo, k) && deepEqual(ao[k], bo[k]));
}

/** IDs (present in both lists) whose relative order changed. */
function movedIds(before: readonly string[], after: readonly string[]): Set<string> {
  const inAfter = new Set(after);
  const inBefore = new Set(before);
  const a = before.filter((id) => inAfter.has(id));
  const b = after.filter((id) => inBefore.has(id));
  // LCS table
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  }
  const keep = new Set<string>();
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      keep.add(a[i]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return new Set(a.filter((id) => !keep.has(id)));
}

const sceneLabel = (s: Scene) => `Scene "${s.name}"`;

function diffFields(
  out: ChangeEntry[],
  base: Omit<ChangeEntry, 'label' | 'path' | 'change' | 'before' | 'after'>,
  labelPrefix: string,
  pairs: [path: string, before: unknown, after: unknown][],
) {
  for (const [path, before, after] of pairs) {
    if (deepEqual(before, after)) continue;
    const change = before === undefined ? 'added' : after === undefined ? 'removed' : 'modified';
    out.push({ ...base, label: `${labelPrefix} › ${path}`, path, change, before, after });
  }
}

function elementPairs(a: Element, b: Element): [string, unknown, unknown][] {
  const pairs: [string, unknown, unknown][] = [
    ['name', a.name, b.name],
    ['type', a.type, b.type],
    ['startFrame', a.startFrame, b.startFrame],
    ['durationInFrames', a.durationInFrames, b.durationInFrames],
    ['visible', a.visible, b.visible],
    ['locked', a.locked ?? false, b.locked ?? false],
    ...(['parentId', 'blendMode', 'effects', 'mask'] as const).map(k => [k, a[k], b[k]] as [string, unknown, unknown]),
  ];
  for (const k of ['x', 'y', 'width', 'height', 'rotation', 'scale', 'opacity'] as const) {
    pairs.push([`transform.${k}`, a.transform[k], b.transform[k]]);
  }
  if (a.props !== b.props) {
    const keys = [...new Set([...Object.keys(a.props), ...Object.keys(b.props)])];
    for (const k of keys) pairs.push([`props.${k}`, a.props[k], b.props[k]]);
  }
  if (a.tracks !== b.tracks) {
    const props = [...new Set([...a.tracks.map((t) => t.property), ...b.tracks.map((t) => t.property)])];
    for (const p of props) {
      pairs.push([`tracks.${p}`, a.tracks.find((t) => t.property === p)?.keyframes, b.tracks.find((t) => t.property === p)?.keyframes]);
    }
  }
  for (const key of new Set([...(a.propTracks ?? []).map(t => t.key), ...(b.propTracks ?? []).map(t => t.key)])) {
    pairs.push([`propTracks.${key}`, a.propTracks?.find(t => t.key === key)?.keyframes, b.propTracks?.find(t => t.key === key)?.keyframes]);
  }
  return pairs;
}

function diffScene(out: ChangeEntry[], a: Scene, b: Scene) {
  if (a === b) return;
  const label = sceneLabel(b);
  diffFields(out, { kind: 'scene', sceneId: b.id }, label, [
    ['name', a.name, b.name],
    ['durationInFrames', a.durationInFrames, b.durationInFrames],
    ['backgroundColor', a.backgroundColor, b.backgroundColor],
    ['locked', a.locked, b.locked],
    ['transitionIn.type', a.transitionIn.type, b.transitionIn.type],
    ['transitionIn.durationInFrames', a.transitionIn.durationInFrames, b.transitionIn.durationInFrames],
  ]);
  if (a.elements === b.elements) return;
  const beforeEls = new Map(a.elements.map((e) => [e.id, e]));
  const afterEls = new Map(b.elements.map((e) => [e.id, e]));
  for (const e of a.elements) {
    if (!afterEls.has(e.id)) {
      out.push({ kind: 'element', sceneId: b.id, elementId: e.id, label: `${label} › ${e.name}`, path: '', change: 'removed', before: e });
    }
  }
  const moved = movedIds(
    a.elements.map((e) => e.id),
    b.elements.map((e) => e.id),
  );
  b.elements.forEach((e, idx) => {
    const prev = beforeEls.get(e.id);
    const elLabel = `${label} › ${e.name}`;
    if (!prev) {
      out.push({ kind: 'element', sceneId: b.id, elementId: e.id, label: elLabel, path: '', change: 'added', after: e });
      return;
    }
    if (moved.has(e.id)) {
      out.push({
        kind: 'element',
        sceneId: b.id,
        elementId: e.id,
        label: `${elLabel} › order`,
        path: 'order',
        change: 'moved',
        before: a.elements.indexOf(prev),
        after: idx,
      });
    }
    if (prev !== e) diffFields(out, { kind: 'element', sceneId: b.id, elementId: e.id }, elLabel, elementPairs(prev, e));
  });
}

function assetPairs(a: Asset, b: Asset): [string, unknown, unknown][] {
  return (['name', 'kind', 'src', 'mimeType', 'width', 'height', 'durationInFrames', 'fps', 'hasAudio', 'proxySrc', 'reference', 'provenance'] as const).map((k) => [k, a[k], b[k]]);
}

function clipPairs(a: AudioClip, b: AudioClip): [string, unknown, unknown][] {
  return (['name', 'assetId', 'sceneId', 'startFrame', 'trimStartFrames', 'durationInFrames', 'volume', 'fadeInFrames', 'fadeOutFrames', 'volumeEnvelope'] as const).map((k) => [
    k,
    a[k],
    b[k],
  ]);
}

export function diffProjects(before: Project, after: Project): ChangeEntry[] {
  const out: ChangeEntry[] = [];
  if (before === after) return out;

  diffFields(out, { kind: 'project' }, 'Project', [
    ['name', before.name, after.name],
    ['backgroundColor', before.backgroundColor, after.backgroundColor],
    ['fps', before.fps, after.fps],
    ['width', before.width, after.width],
    ['height', before.height, after.height],
    ['style', before.style, after.style],
  ]);

  // Scenes
  if (before.scenes !== after.scenes) {
    const beforeScenes = new Map(before.scenes.map((s) => [s.id, s]));
    const afterIds = new Set(after.scenes.map((s) => s.id));
    for (const s of before.scenes) {
      if (!afterIds.has(s.id)) out.push({ kind: 'scene', sceneId: s.id, label: sceneLabel(s), path: '', change: 'removed', before: s });
    }
    const moved = movedIds(
      before.scenes.map((s) => s.id),
      after.scenes.map((s) => s.id),
    );
    after.scenes.forEach((s, idx) => {
      const prev = beforeScenes.get(s.id);
      if (!prev) {
        out.push({ kind: 'scene', sceneId: s.id, label: sceneLabel(s), path: '', change: 'added', after: s });
        return;
      }
      if (moved.has(s.id)) {
        out.push({ kind: 'scene', sceneId: s.id, label: `${sceneLabel(s)} › order`, path: 'order', change: 'moved', before: before.scenes.indexOf(prev), after: idx });
      }
      diffScene(out, prev, s);
    });
  }

  // Assets
  if (before.assets !== after.assets) {
    for (const [id, a] of Object.entries(before.assets)) {
      const b = after.assets[id];
      if (!b) out.push({ kind: 'asset', label: `Asset "${a.name}"`, path: '', change: 'removed', before: a });
      else if (a !== b) diffFields(out, { kind: 'asset' }, `Asset "${b.name}"`, assetPairs(a, b));
    }
    for (const [id, b] of Object.entries(after.assets)) {
      if (!before.assets[id]) out.push({ kind: 'asset', label: `Asset "${b.name}"`, path: '', change: 'added', after: b });
    }
  }

  // Audio (array order carries no meaning)
  if (before.audio !== after.audio) {
    const beforeClips = new Map(before.audio.map((c) => [c.id, c]));
    const afterIds = new Set(after.audio.map((c) => c.id));
    for (const c of before.audio) {
      if (!afterIds.has(c.id)) out.push({ kind: 'audio', label: `Audio "${c.name}"`, path: '', change: 'removed', before: c });
    }
    for (const c of after.audio) {
      const prev = beforeClips.get(c.id);
      if (!prev) out.push({ kind: 'audio', label: `Audio "${c.name}"`, path: '', change: 'added', after: c });
      else if (prev !== c) diffFields(out, { kind: 'audio' }, `Audio "${c.name}"`, clipPairs(prev, c));
    }
  }

  // Reusable trees and timeline markers have their own entity kinds.
  for (const id of new Set([...Object.keys(before.compositions), ...Object.keys(after.compositions)])) {
    const a = before.compositions[id], b = after.compositions[id];
    const label = `Composition "${(b ?? a).name}"`;
    const prefix = `compositions.${id}`;
    if (!a || !b) out.push({ kind: 'composition', label, path: prefix, change: a ? 'removed' : 'added', before: a, after: b });
    else {
      diffFields(out, { kind: 'composition' }, label, (['name', 'width', 'height', 'durationInFrames', 'backgroundColor'] as const).map(k => [`${prefix}.${k}`, a[k], b[k]]));
      const oldEls = new Map(a.elements.map(el => [el.id, el])), newEls = new Map(b.elements.map(el => [el.id, el]));
      const moved = movedIds(a.elements.map(el => el.id), b.elements.map(el => el.id));
      for (const eid of new Set([...oldEls.keys(), ...newEls.keys()])) {
        const ae = oldEls.get(eid), be = newEls.get(eid), ep = `${prefix}.elements.${eid}`;
        if (!ae || !be) out.push({ kind: 'composition', elementId: eid, label: `${label} › ${(be ?? ae)!.name}`, path: ep, change: ae ? 'removed' : 'added', before: ae, after: be });
        else {
          diffFields(out, { kind: 'composition', elementId: eid }, `${label} › ${be.name}`, elementPairs(ae, be).map(([path, av, bv]) => [`${ep}.${path}`, av, bv]));
          if (moved.has(eid)) out.push({ kind: 'composition', elementId: eid, label: `${label} › ${be.name} › order`, path: `${ep}.order`, change: 'moved', before: a.elements.indexOf(ae), after: b.elements.indexOf(be) });
        }
      }
    }
  }
  const oldMarkers = new Map(before.markers.map(m => [m.id,m])), newMarkers = new Map(after.markers.map(m => [m.id,m]));
  for (const id of new Set([...oldMarkers.keys(), ...newMarkers.keys()])) {
    const a = oldMarkers.get(id), b = newMarkers.get(id), label = `Marker "${(b ?? a)!.label}"`, prefix = `markers.${id}`;
    if (!a || !b) out.push({ kind: 'marker', label, path: prefix, change: a ? 'removed' : 'added', before: a, after: b });
    else diffFields(out, { kind: 'marker' }, label, (['frame', 'label', 'color'] as const).map(k => [`${prefix}.${k}`, a[k], b[k]]));
  }
  return out;
}
