// Editing actions shared by the stage, keyboard shortcuts and the inspector.
// Each user gesture becomes exactly one command (one undo step, one revision);
// gestures over several elements become one batch.

import { evaluateElement, evaluateElementWorld, evaluateTrack, findTrack, trackValueForFinal, transformPoint, type EvaluatedElement, type Matrix, type WorldElement } from '../core/animation';
import { COMPONENTS } from '../core/components';
import { newId } from '../core/ids';
import { formatTimecode, locateFrame, sceneStartFrame } from '../core/timing';
import type { AnimatableProperty, Command, Element, ElementType, Scene, Transform } from '../core/types';
import { alignOffsets, distributeOffsets, ALIGN_LABELS, type AlignMode, type DistributeAxis } from './arrange';
import { childrenOf, indexBeside, isCanvasLocked, scopeOf, siblingStep, topMostSelected } from './canvasTree';
import { createElement, createScene, duplicateScene } from './doc';
import { cornersOf, parentInverse, pointsBounds, round2, vectorIn, withKeyframe, worldCentre, worldOf, type Point } from './geometry';
import { useEditor } from './store';

export const LOCKED_NOTICE = 'Scene locked — unlock to edit';

/** The key went to a text field: editor shortcuts leave it alone. */
export function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

/** Focused composite controls and popovers own their keys before timeline capture. */
export function ownsTimelineKeys(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return isTyping(target) || !!el?.closest?.('[role="tablist"], [role="tree"], [role="separator"], [role="menu"], [role="listbox"], [role="dialog"], input, textarea, select, [contenteditable="true"]');
}

type Modifier = 'mod' | 'alt' | 'shift';

const ON_MAC = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform);

/** A shortcut as a tooltip writes it on this platform: ⌥⇧T and ⇧⌘Z on a Mac (Apple's order, glyphs), Alt+Shift+T and Ctrl+Shift+Z elsewhere. `mod` is ⌘ or Ctrl. */
export function shortcutLabel(key: string, mods: Modifier[] = [], mac = ON_MAC): string {
  if (mac) {
    const glyph = { alt: '⌥', shift: '⇧', mod: '⌘' } as const;
    return (['alt', 'shift', 'mod'] as const).filter((m) => mods.includes(m)).map((m) => glyph[m]).join('') + key;
  }
  const word = { mod: 'Ctrl', alt: 'Alt', shift: 'Shift' } as const;
  return [...(['mod', 'alt', 'shift'] as const).filter((m) => mods.includes(m)).map((m) => word[m]), key].join('+');
}

/**
 * A button-like control focused from the keyboard: Space must activate it, not
 * play. A control focused by a click doesn't match :focus-visible, so clicking
 * a button and then pressing Space still plays.
 */
export function isFocusedControl(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el?.matches) return false;
  return el.matches('button, a[href], summary, [role="button"], [role="switch"], [role="tab"], [role="menuitem"], [role="checkbox"]') && el.matches(':focus-visible');
}

export interface EditContext {
  scene: Scene;
  sceneStart: number;
  frameInScene: number;
  element: Element | null;
  /** The primary element's own frame (a group child's counts from its group's start). */
  localFrame: number;
}

export function editContext(): EditContext | null {
  const { doc, playhead, selection } = useEditor.getState();
  const loc = locateFrame(doc.project, playhead);
  if (!loc) return null;
  const scene = doc.project.scenes.find((s) => s.id === selection.sceneId) ?? loc.scene;
  const sceneStart = sceneStartFrame(doc.project, scene.id);
  const frameInScene = playhead - sceneStart;
  const element = scene.elements.find((e) => e.id === selection.elementId) ?? null;
  return { scene, sceneStart, frameInScene, element, localFrame: element ? evaluateElementWorld(scene.elements, element, frameInScene).localFrame : 0 };
}

export function guardLocked(scene: Scene): boolean {
  if (!scene.locked) return false;
  useEditor.getState().toast({ tone: 'info', message: LOCKED_NOTICE, hint: `"${scene.name}" is locked. Use the lock toggle in the Scenes list or the inspector to unlock it.` });
  return true;
}

export function localFrameInRange(element: Element, localFrame: number): boolean {
  return localFrame >= 0 && localFrame < element.durationInFrames;
}

/** An element's own (parent-relative) evaluated values at a scene frame. */
export function localOf(elements: Element[], el: Element, frameInScene: number): EvaluatedElement {
  return evaluateElement(el, evaluateElementWorld(elements, el, frameInScene).localFrame + el.startFrame);
}

// ---------------------------------------------------------------------------
// Geometry edits: the common currency of stage gestures, nudges and arrange.
// ---------------------------------------------------------------------------

/**
 * One element's part of a canvas gesture. Layout mode changes the base
 * transform; animate mode keys final (parent-relative) values at the
 * element's local frame and leaves the base alone.
 */
export interface GeometryEdit {
  element: Element;
  localFrame: number;
  base?: Partial<Transform>;
  keys?: Partial<Record<AnimatableProperty, number>>;
}

const keyValue = (el: Element, property: AnimatableProperty, final: number) => round2(trackValueForFinal(el, property, final));
const keyEntries = (edit: GeometryEdit) => Object.entries(edit.keys ?? {}) as [AnimatableProperty, number][];

/** The element as the edit will leave it (for the live drag preview). */
export function previewEdit(edit: GeometryEdit): Element {
  let el = edit.base ? { ...edit.element, transform: { ...edit.element.transform, ...edit.base } } : edit.element;
  for (const [property, final] of keyEntries(edit)) el = withKeyframe(el, property, edit.localFrame, keyValue(edit.element, property, final));
  return el;
}

/** Commands for the edits; base changes that change nothing are dropped. */
export function editCommands(sceneId: string, edits: GeometryEdit[]): Command[] {
  const cmds: Command[] = [];
  for (const e of edits) {
    const base = e.base;
    if (base && (Object.keys(base) as (keyof Transform)[]).some((k) => base[k] !== e.element.transform[k])) {
      cmds.push({ type: 'updateElement', sceneId, elementId: e.element.id, changes: { transform: base } });
    }
    for (const [property, final] of keyEntries(e)) {
      cmds.push({ type: 'setKeyframe', sceneId, elementId: e.element.id, property, frame: e.localFrame, value: keyValue(e.element, property, final) });
    }
  }
  return cmds;
}

/** Run commands as one undo step (a batch when there are several). */
export function runCommands(cmds: Command[], label: string): boolean {
  if (!cmds.length) return false;
  const { run } = useEditor.getState();
  return run(cmds.length === 1 ? cmds[0] : { type: 'batch', label, commands: cmds }, label);
}

const OUTSIDE_LIFETIME = { tone: 'info' as const, message: 'The playhead is outside this element’s lifetime.', hint: 'Move the playhead onto the element’s bar in the timeline to key it.' };

/** Commit a gesture's edits as one undo step. Keys need the playhead inside each element's lifetime. */
export function commitEdits(scene: Scene, edits: GeometryEdit[], label: string): boolean {
  const outside = edits.find((e) => e.keys && !localFrameInRange(e.element, e.localFrame));
  if (outside) {
    useEditor.getState().toast({ ...OUTSIDE_LIFETIME, message: `The playhead is outside “${outside.element.name}”’s lifetime.` });
    return false;
  }
  return runCommands(editCommands(scene.id, edits), label);
}

/**
 * Move elements by world-space (on-screen) offsets. Each offset is mapped into
 * the element's parent axes, so a child of a rotated group still moves the way
 * the pointer or arrow key went. `keyBoth` keys x and y even when one is
 * unchanged (a drag sets the position); otherwise only changed axes are keyed.
 */
export function offsetEdits(elements: Element[], frameInScene: number, offsets: { element: Element; dx: number; dy: number }[], animate: boolean, keyBoth = false): GeometryEdit[] {
  return offsets.map(({ element, dx, dy }) => {
    const ev = localOf(elements, element, frameInScene);
    const d = vectorIn(parentInverse(elements, element, frameInScene), { x: dx, y: dy });
    const r = element.parentId ? round2 : Math.round;
    if (!animate) return { element, localFrame: ev.localFrame, base: { x: r(element.transform.x + d.x), y: r(element.transform.y + d.y) } };
    const fx = r(ev.x + d.x);
    const fy = r(ev.y + d.y);
    const keys: GeometryEdit['keys'] = {};
    if (keyBoth || fx !== r(ev.x)) keys.x = fx;
    if (keyBoth || fy !== r(ev.y)) keys.y = fy;
    return { element, localFrame: ev.localFrame, keys };
  });
}

/** An element as a selection gesture sees it when the gesture starts. */
export interface GestureItem {
  element: Element;
  /** Own (parent-relative) evaluated values. */
  ev: EvaluatedElement;
  world: WorldElement;
  /** World → parent-local. */
  inv: Matrix;
}

/**
 * Layout-mode scale of a multi-selection by `k` about a world-space anchor.
 * Every element scales as a whole: its own `scale` is multiplied by k and its
 * centre moves about the anchor (in its parent's space), while width/height
 * stay put — so text keeps its wrapping and grows with the design, path nodes
 * keep their coordinates, and groups scale their children, all alike.
 */
export function scaleSelectionEdits(items: readonly GestureItem[], anchor: Point, k: number): GeometryEdit[] {
  return items.map(({ element: el, ev, world, inv }) => {
    const wc = worldCentre(world);
    const lc = transformPoint(inv, { x: anchor.x + (wc.x - anchor.x) * k, y: anchor.y + (wc.y - anchor.y) * k });
    const r = el.parentId ? round2 : Math.round;
    const b = el.transform;
    // (ev − base) is the animated offset at this frame; the base keeps it.
    return { element: el, localFrame: ev.localFrame, base: { scale: round2(b.scale * k), x: r(lc.x - b.width / 2 - (ev.x - b.x)), y: r(lc.y - b.height / 2 - (ev.y - b.y)) } };
  });
}

// ---------------------------------------------------------------------------
// Selection-wide actions (keyboard, toolbar, layers).
// ---------------------------------------------------------------------------

/** The edit context plus the selected elements, without descendants of other selected elements. */
export function selectionContext() {
  const ctx = editContext();
  if (!ctx) return null;
  const { selection } = useEditor.getState();
  const items = selection.sceneId === ctx.scene.id ? topMostSelected(ctx.scene.elements, selection.elementIds) : [];
  return { ...ctx, items };
}

const count = (n: number, one: string, many: string) => (n === 1 ? one : `${n} ${many}`);

export function nudgeSelected(dx: number, dy: number): void {
  const ctx = selectionContext();
  const items = ctx?.items.filter((el) => !isCanvasLocked(ctx.scene.elements, el)) ?? [];
  if (!ctx || !items.length) return;
  if (guardLocked(ctx.scene)) return;
  const animate = useEditor.getState().editMode === 'animate';
  const edits = offsetEdits(ctx.scene.elements, ctx.frameInScene, items.map((element) => ({ element, dx, dy })), animate);
  commitEdits(ctx.scene, edits, `Nudge ${count(items.length, 'element', 'elements')}`);
}

export function deleteSelected(): boolean {
  const ctx = selectionContext();
  if (!ctx?.items.length) return false;
  if (guardLocked(ctx.scene)) return false;
  const cmds: Command[] = ctx.items.map((el) => ({ type: 'removeElement', sceneId: ctx.scene.id, elementId: el.id }));
  return runCommands(cmds, ctx.items.length === 1 ? `Delete “${ctx.items[0].name}”` : `Delete ${ctx.items.length} elements`);
}

/** ⌘G: wrap the selection (elements sharing one parent) in a new group and select it. */
export function groupSelected(): boolean {
  const ctx = selectionContext();
  if (!ctx?.items.length) return false;
  if (guardLocked(ctx.scene)) return false;
  const st = useEditor.getState();
  const parent = ctx.items[0].parentId ?? null;
  if (ctx.items.some((e) => (e.parentId ?? null) !== parent)) {
    st.toast({ tone: 'info', message: 'Only elements at the same level can be grouped.', hint: 'Select elements inside the same group, or all at the top level.' });
    return false;
  }
  const id = newId('el');
  const label = ctx.items.length === 1 ? `Group “${ctx.items[0].name}”` : `Group ${ctx.items.length} elements`;
  if (!st.run({ type: 'groupElements', sceneId: ctx.scene.id, elementIds: ctx.items.map((e) => e.id), group: { id, name: 'Group' } }, label)) return false;
  useEditor.getState().selectElement(ctx.scene.id, id);
  return true;
}

/** ⇧⌘G: dissolve the selected groups, keeping their children where they are on screen, and select the children. */
export function ungroupSelected(): boolean {
  const ctx = selectionContext();
  const groups = ctx?.items.filter((e) => e.type === 'group') ?? [];
  if (!ctx || !groups.length) return false;
  if (guardLocked(ctx.scene)) return false;
  const children = groups.flatMap((g) => childrenOf(ctx.scene.elements, g.id).map((c) => c.id));
  const cmds: Command[] = groups.map((g) => ({ type: 'ungroup', sceneId: ctx.scene.id, groupId: g.id }));
  if (!runCommands(cmds, groups.length === 1 ? `Ungroup “${groups[0].name}”` : `Ungroup ${groups.length} groups`)) return false;
  useEditor.getState().selectMany(ctx.scene.id, children);
  return true;
}

/** ⌘A: every element at the selection's level (the scene's top level when nothing is selected). */
export function selectAllInScope(): void {
  const ctx = editContext();
  if (!ctx) return;
  const st = useEditor.getState();
  const ids = childrenOf(ctx.scene.elements, scopeOf(ctx.scene.elements, st.selection.elementId)).map((e) => e.id);
  st.selectMany(ctx.scene.id, ids, st.selection.elementId && ids.includes(st.selection.elementId) ? st.selection.elementId : null);
}

/** Tab / Shift+Tab: the next or previous element at the selection's level, in paint order. */
export function cycleSelection(dir: 1 | -1): void {
  const ctx = editContext();
  if (!ctx) return;
  const st = useEditor.getState();
  const sibs = childrenOf(ctx.scene.elements, scopeOf(ctx.scene.elements, st.selection.elementId));
  if (!sibs.length) return;
  const i = sibs.findIndex((e) => e.id === st.selection.elementId);
  const next = i < 0 ? sibs[dir > 0 ? 0 : sibs.length - 1] : sibs[(i + dir + sibs.length) % sibs.length];
  st.selectElement(ctx.scene.id, next.id);
}

/** Enter: select the children of the selected group. */
export function enterGroup(): boolean {
  const ctx = editContext();
  if (!ctx?.element || ctx.element.type !== 'group') return false;
  const kids = childrenOf(ctx.scene.elements, ctx.element.id);
  if (!kids.length) return false;
  useEditor.getState().selectMany(ctx.scene.id, kids.map((e) => e.id));
  return true;
}

/** Esc inside a group: select the group itself. False at the top level. */
export function selectParent(): boolean {
  const ctx = editContext();
  const parentId = ctx?.element?.parentId;
  if (!ctx || !parentId) return false;
  useEditor.getState().selectElement(ctx.scene.id, parentId);
  return true;
}

export const DISTRIBUTE_LABELS: Record<DistributeAxis, string> = {
  horizontal: 'Distribute horizontal spacing',
  vertical: 'Distribute vertical spacing',
};

/** Align (to the selection, or the canvas for one element) or distribute the selection, as one undo step. */
export function arrangeSelected(kind: { align: AlignMode } | { distribute: DistributeAxis }): boolean {
  const ctx = selectionContext();
  if (!ctx?.items.length) return false;
  if (guardLocked(ctx.scene)) return false;
  const { doc, editMode } = useEditor.getState();
  const boxes = ctx.items.map((el) => ({ id: el.id, box: pointsBounds(cornersOf(worldOf(ctx.scene.elements, el, ctx.frameInScene))) }));
  const canvas = { left: 0, top: 0, right: doc.project.width, bottom: doc.project.height };
  const offsets = 'align' in kind ? alignOffsets(boxes, kind.align, canvas) : distributeOffsets(boxes, kind.distribute);
  const moving = offsets.filter((o) => Math.abs(o.dx) > 0.005 || Math.abs(o.dy) > 0.005);
  const byId = new Map(ctx.items.map((e) => [e.id, e]));
  const edits = offsetEdits(ctx.scene.elements, ctx.frameInScene, moving.map((o) => ({ element: byId.get(o.id)!, dx: o.dx, dy: o.dy })), editMode === 'animate');
  if (!edits.length) return false;
  return commitEdits(ctx.scene, edits, 'align' in kind ? ALIGN_LABELS[kind.align] : DISTRIBUTE_LABELS[kind.distribute]);
}

/** Key the property at the playhead with its current track value (or a given final value). */
export function keyAtPlayhead(property: AnimatableProperty, finalValue?: number): boolean {
  const ctx = editContext();
  if (!ctx?.element) return false;
  if (guardLocked(ctx.scene)) return false;
  const { element, scene, localFrame } = ctx;
  if (!localFrameInRange(element, localFrame)) {
    useEditor.getState().toast(OUTSIDE_LIFETIME);
    return false;
  }
  const value = finalValue === undefined ? evaluateTrack(element, property, localFrame) : trackValueForFinal(element, property, finalValue);
  const existing = findTrack(element, property)?.keyframes.find((k) => k.frame === localFrame);
  return useEditor
    .getState()
    .run(
      { type: 'setKeyframe', sceneId: scene.id, elementId: element.id, property, frame: localFrame, value: round2(value), easing: typeof existing?.easing === 'string' ? existing.easing : undefined },
      `${existing ? 'Update' : 'Add'} ${property} keyframe`,
    );
}

export function modeStatus(mode: 'layout' | 'animate', playhead: number, fps: number): string {
  return mode === 'layout' ? 'Editing base layout' : `Keying animation at ${formatTimecode(playhead, fps)}`;
}

// ---------------------------------------------------------------------------
// Scene and element commands shared by the menubar, the right-click menus,
// the tool rail and the palette (actions.ts).
// ---------------------------------------------------------------------------

/** Element types a user adds by hand; groups come from grouping, video from Insert; an instance needs a reusable component. */
export const ADDABLE: ElementType[] = ['text', 'shape', 'image', 'logo', 'uiCard', 'chatBubble', 'path', 'instance'];

function currentScene(): Scene | undefined {
  const s = useEditor.getState();
  return s.doc.project.scenes.find((x) => x.id === s.selection.sceneId);
}

export const canAddInstance = () => Object.keys(useEditor.getState().doc.project.compositions).length > 0;

/** A new element of `type` in the current scene, selected. */
export function addElementOfType(type: ElementType): boolean {
  const s = useEditor.getState();
  const scene = currentScene();
  if (!scene || guardLocked(scene)) return false;
  const el = createElement(s.doc.project, scene, type);
  // An instance plays a reusable component: start with the first one; the inspector changes it.
  if (type === 'instance') el.props = { ...el.props, compositionId: Object.keys(s.doc.project.compositions)[0] ?? '' };
  if (!s.run({ type: 'addElement', sceneId: scene.id, element: el }, `Add ${COMPONENTS[type].label.toLowerCase()}`)) return false;
  s.selectElement(scene.id, el.id);
  return true;
}

/** A new empty scene after the current one; the playhead goes to it. */
export function addSceneAfterCurrent(): boolean {
  const s = useEditor.getState();
  const project = s.doc.project;
  const idx = Math.max(0, project.scenes.findIndex((x) => x.id === s.selection.sceneId)) + 1;
  const created = createScene(project, `Scene ${project.scenes.length + 1}`);
  if (!s.run({ type: 'addScene', scene: created, index: idx }, 'Add scene')) return false;
  s.seek(sceneStartFrame(useEditor.getState().doc.project, created.id));
  return true;
}

export function duplicateCurrentScene(): boolean {
  const s = useEditor.getState();
  const scene = currentScene();
  if (!scene) return false;
  const copy = duplicateScene(scene);
  if (!s.run({ type: 'addScene', scene: copy, index: s.doc.project.scenes.indexOf(scene) + 1 }, `Duplicate “${scene.name}”`)) return false;
  s.seek(sceneStartFrame(useEditor.getState().doc.project, copy.id));
  return true;
}

/** Asks first (the scene and its elements go; undo brings them back). */
export function deleteCurrentScene(): boolean {
  const s = useEditor.getState();
  const scene = currentScene();
  if (!scene || s.doc.project.scenes.length < 2 || guardLocked(scene)) return false;
  if (!window.confirm(`Delete scene “${scene.name}” and its ${scene.elements.length} element${scene.elements.length === 1 ? '' : 's'}? You can undo this.`)) return false;
  return s.run({ type: 'removeScene', sceneId: scene.id }, `Delete “${scene.name}”`);
}

/** The selected element one layer up (1) or down (-1) among its siblings: ⌘] / ⌘[. */
export function canReorderSelected(dir: 1 | -1): boolean {
  const s = useEditor.getState();
  const scene = currentScene();
  const el = scene?.elements.find((e) => e.id === s.selection.elementId);
  return !!scene && !!el && !!siblingStep(scene.elements, el, dir);
}

export function reorderSelected(dir: 1 | -1): boolean {
  const s = useEditor.getState();
  const scene = currentScene();
  const el = scene?.elements.find((e) => e.id === s.selection.elementId);
  if (!scene || !el || guardLocked(scene)) return false;
  const next = siblingStep(scene.elements, el, dir);
  if (!next) return false;
  return s.run({ type: 'moveElement', sceneId: scene.id, elementId: el.id, toIndex: indexBeside(scene.elements, el, next, dir === 1 ? 'above' : 'below') }, dir === 1 ? `Bring “${el.name}” forward` : `Send “${el.name}” backward`);
}
