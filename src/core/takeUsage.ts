// How many times each asset is used: scene elements, the reusable components
// they play (transitively) and audio clips. Shared by the takes panel, the
// generation outcome tracker and the server's "kept at export" record.

import { compositionDependencies } from './commands';
import { COMPONENTS } from './components';
import type { Element, Project } from './types';

/** Uses of each asset in scenes, the reusable components they play (transitively) and audio clips. */
export function takeUsage(project: Project): Map<string, number> {
  const m = new Map<string, number>();
  const add = (id: unknown) => typeof id === 'string' && id && m.set(id, (m.get(id) ?? 0) + 1);
  const scan = (elements: Element[]) => {
    for (const el of elements) for (const f of COMPONENTS[el.type]?.fields ?? []) if (f.kind === 'asset') add(el.props[f.key]);
  };
  const sceneElements = project.scenes.flatMap((s) => s.elements);
  scan(sceneElements);
  for (const id of compositionDependencies(project, sceneElements)) if (Object.prototype.hasOwnProperty.call(project.compositions, id)) scan(project.compositions[id].elements);
  for (const c of project.audio) add(c.assetId);
  return m;
}
