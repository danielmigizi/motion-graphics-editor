import { COMPONENTS } from '../components';
import type { Element, ElementType, NestedComposition, Project } from '../types';

export function element(id: string, type: ElementType = 'shape', changes: Partial<Element> = {}): Element {
  return { id, type, name: id, startFrame: 0, durationInFrames: 100, visible: true, transform: { x: 10, y: 20, width: 80, height: 60, rotation: 0, scale: 1, opacity: 1 }, props: structuredClone(COMPONENTS[type].defaultProps), tracks: [], ...changes };
}
export function composition(id: string, elements: Element[] = []): NestedComposition {
  return { id, name: id, width: 600, height: 400, durationInFrames: 100, backgroundColor: 'transparent', elements };
}
export function project(elements: Element[] = [element('a'), element('b', 'text')]): Project {
  return { schemaVersion: 3, id: 'p', name: 'Test', revision: 1, fps: 30, width: 1000, height: 600, backgroundColor: '#000', assets: {}, audio: [], compositions: {}, markers: [], scenes: [{ id: 's', name: 'Scene', durationInFrames: 100, backgroundColor: '#000', locked: false, transitionIn: { type: 'none', durationInFrames: 0 }, elements }] };
}
