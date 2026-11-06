// Every command a person can give the editor, in one list: the menubar
// (Menubar.tsx), the right-click menus (ContextMenu.tsx), the command palette
// (CommandPalette.tsx) and the shortcuts sheet (ShortcutsSheet.tsx) all read
// it, so an action has one label, one shortcut and one enabled rule wherever
// it appears. Key handling stays where it was (App.tsx, canvasControls.ts);
// a shortcut here is what the surfaces print, and handleShellShortcut() owns
// only the shell's own keys (panels, palette, settings).

import { COMPONENTS } from '../core/components';
import type { JobKind } from '../core/generationStudio';
import { newId } from '../core/ids';
import type { Command, ElementType } from '../core/types';
import { fitView, zoomBy, zoomTo } from './canvasControls';
import { isDescendantOf } from './canvasTree';
import { openFormat, openNewVideo } from './createFlow';
import {
  addSceneAfterCurrent,
  canAddInstance,
  canReorderSelected,
  deleteCurrentScene,
  deleteSelected,
  duplicateCurrentScene,
  groupSelected,
  guardLocked,
  isTyping,
  LOCKED_NOTICE,
  reorderSelected,
  runCommands,
  selectAllInScope,
  selectionContext,
  shortcutLabel,
  ungroupSelected,
} from './editActions';
import type { IconName } from './icons';
import { ASKS_FOR_FILE } from './InsertMenu';
import { ELEMENT_ICON } from './InspectorColumn';
import { useLayout, type RightTab } from './layout';
import { hasModalSurface } from './modalSurface';
import { openExport } from './ExportPopover';
import { cutAfter, openGenerate, sceneMusicSeconds, selectedImageAssetId, type GenerateMode } from './generateStore';
import { exportJson, importJson, saveToServer } from './persistence';
import { togglePlayback } from './playback';
import { useEditor } from './store';
import { openStylePanel } from './StylePanel';
import { cycleTheme, useTheme, type ThemeChoice } from './theme';
import { canOpenCurveEditor, copySelectedKeys, deleteSelectedKeys, hasCopiedKeys, openCurveEditor, pasteKeysAtPlayhead, setWorkAreaAtPlayhead } from './Timeline';
import { addFromRail, openRailPopover, pickTool } from './ToolRail';
import { addMarkerAtPlayhead, stepFrame } from './Transport';
import { insertVideoFromFile } from './VideoAssetRow';

export type ActionMenu = 'file' | 'edit' | 'scene' | 'insert' | 'view' | 'help';

export const MENUS: { id: ActionMenu; label: string }[] = [
  { id: 'file', label: 'File' },
  { id: 'edit', label: 'Edit' },
  { id: 'scene', label: 'Scene' },
  { id: 'insert', label: 'Insert' },
  { id: 'view', label: 'View' },
  { id: 'help', label: 'Help' },
];

/** What a right-click landed on; the menu shows the actions whose `contexts` include its kind. */
export type ContextKind = 'canvas' | 'element' | 'scene' | 'layer' | 'clip' | 'keyframe';

export interface Shortcut {
  /** As printed: 'Z', '[', 'Space', '←'. */
  key: string;
  mod?: boolean;
  shift?: boolean;
  alt?: boolean;
}

export interface EditorAction {
  /** Stable, dotted: 'edit.undo', 'scene.add', 'insert.text', 'view.chat'. */
  id: string;
  /** A function when the label names the target ("Delete “Headline”"). */
  label: string | (() => string);
  menu: ActionMenu;
  /** Items with the same group sit together; a rule separates groups. */
  group: string;
  shortcut?: Shortcut;
  icon?: IconName;
  enabled?: () => boolean;
  /** Why it is disabled, in a sentence: the menus show it as the item's tooltip. */
  whyDisabled?: () => string | undefined;
  /** A toggle's state (show the timeline, a theme choice). */
  checked?: () => boolean;
  run: () => void;
  /** Right-click menus that offer it (they act on the selection, which the right-click sets first). */
  contexts?: ContextKind[];
  /** Extra words the palette matches. */
  keywords?: string[];
}

export function labelOf(a: EditorAction): string {
  return typeof a.label === 'function' ? a.label() : a.label;
}

/** As the menus print it: ⇧⌘Z and ⌫ on a Mac, Ctrl+Shift+Z and Delete elsewhere. `mac` defaults to this platform. */
export function shortcutText(s: Shortcut, mac?: boolean): string {
  const mods = [s.mod && 'mod', s.alt && 'alt', s.shift && 'shift'].filter(Boolean) as ('mod' | 'alt' | 'shift')[];
  const key = s.key === 'Delete' && (mac ?? onMac()) ? '⌫' : s.key;
  return shortcutLabel(key, mods, mac);
}

/** This platform, as shortcutLabel sees it. */
const onMac = () => shortcutLabel('', ['mod']) === '⌘';

export const isEnabled = (a: EditorAction) => (a.enabled ? a.enabled() : true);

// ---------------------------------------------------------------------------
// What the actions act on: the selection, which a right-click sets first.
// ---------------------------------------------------------------------------

const st = () => useEditor.getState();

function currentScene() {
  const s = st();
  return s.doc.project.scenes.find((x) => x.id === s.selection.sceneId) ?? null;
}

/** The selected elements, without descendants of other selected elements. */
const selected = () => selectionContext()?.items ?? [];

type Rule = [ok: () => boolean, why: string];

/** `enabled` and `whyDisabled` from rules checked in order: the first that fails says why. */
function when(...rules: Rule[]): Pick<EditorAction, 'enabled' | 'whyDisabled'> {
  return { enabled: () => rules.every(([ok]) => ok()), whyDisabled: () => rules.find(([ok]) => !ok())?.[1] };
}

const SCENE: Rule = [() => !!currentScene(), 'Go to a scene first'];
const UNLOCKED: Rule = [() => !currentScene()?.locked, LOCKED_NOTICE];
const SELECTION: Rule = [() => selected().length > 0, 'Select an element first'];
const KEYS: Rule = [() => st().selectedKeyframes.length > 0, 'Select keys in the timeline first'];

const count = (n: number, one: string, many: string) => (n === 1 ? one : `${n} ${many}`);
const target = (items: { name: string }[]) => count(items.length, `“${items[0]?.name}”`, 'elements');

/**
 * Copies of the selected elements, their children with them, each just above
 * its original; the copies become the selection. One undo step. In place, as
 * a timeline editor duplicates a layer: the copy keeps its timing and motion.
 */
export function duplicateSelected(): boolean {
  const ctx = selectionContext();
  if (!ctx?.items.length || guardLocked(ctx.scene)) return false;
  let list = ctx.scene.elements.slice();
  const cmds: Command[] = [];
  const copies: string[] = [];
  const subtrees = ctx.items.map((item) => list.filter((e) => e.id === item.id || isDescendantOf(list, e, item.id)));
  // References can cross selected subtrees (a sibling mask, for example).
  const ids = new Map(subtrees.flat().map((e) => [e.id, newId('el')]));
  for (const [i, item] of ctx.items.entries()) {
    const subtree = subtrees[i];
    const clones = subtree.map((e) => {
      const c = structuredClone(e);
      c.id = ids.get(e.id)!;
      if (e.id === item.id) {
        c.name = `${e.name} copy`;
        delete c.locked;
      }
      if (e.parentId) c.parentId = ids.get(e.parentId) ?? e.parentId;
      if (e.mask && ids.has(e.mask.sourceId)) c.mask = { ...e.mask, sourceId: ids.get(e.mask.sourceId)! };
      return c;
    });
    const at = Math.max(...subtree.map((e) => list.indexOf(e))) + 1;
    clones.forEach((element, i) => cmds.push({ type: 'addElement', sceneId: ctx.scene.id, element, index: at + i }));
    list = [...list.slice(0, at), ...clones, ...list.slice(at)];
    copies.push(ids.get(item.id)!);
  }
  if (!runCommands(cmds, `Duplicate ${target(ctx.items)}`)) return false;
  st().selectMany(ctx.scene.id, copies);
  return true;
}

/** Lock or unlock (`locked`), hide or show (`visible`) the selection: all of it one way, as one undo step. */
function toggleSelected(flag: 'locked' | 'hidden'): boolean {
  const ctx = selectionContext();
  if (!ctx?.items.length || guardLocked(ctx.scene)) return false;
  const on = !ctx.items.every((e) => (flag === 'locked' ? !!e.locked : !e.visible));
  const cmds: Command[] = ctx.items
    .filter((e) => (flag === 'locked' ? !!e.locked : !e.visible) !== on)
    .map((e) => ({ type: 'updateElement', sceneId: ctx.scene.id, elementId: e.id, changes: flag === 'locked' ? { locked: on } : { visible: !on } }));
  const verb = flag === 'locked' ? (on ? 'Lock' : 'Unlock') : on ? 'Hide' : 'Show';
  return runCommands(cmds, `${verb} ${target(ctx.items)}`);
}

const allSelected = (test: (e: { locked?: boolean; visible: boolean }) => boolean) => {
  const items = selected();
  return items.length > 0 && items.every(test);
};

/** Rename: the Inspector tab, its name field focused and selected. */
function renameSelected() {
  useLayout.getState().setRightTab('inspector');
  // The tab renders on the next frame.
  requestAnimationFrame(() => {
    const input = document.querySelector<HTMLInputElement>('[data-testid="inspector-name"]');
    input?.focus();
    input?.select();
  });
}

/** The scene's own settings in the inspector (nothing selected). */
function openSceneSettings() {
  const s = st();
  s.select({ elementId: null, elementIds: [] });
  s.setSceneInspectorOpen(true);
  useLayout.getState().setRightTab('inspector');
}

function toggleSceneLock(): boolean {
  const scene = currentScene();
  if (!scene) return false;
  return st().run({ type: 'setSceneLock', sceneId: scene.id, locked: !scene.locked }, scene.locked ? `Unlocked “${scene.name}”` : `Locked “${scene.name}”`);
}

/** A right-column tab as a View toggle: shows the tab, or folds the column when it is already showing. */
function tabToggle(id: string, tab: RightTab, label: string, digit: string): EditorAction {
  const showing = () => useLayout.getState().rightOpen && useLayout.getState().rightTab === tab;
  return {
    id,
    label,
    menu: 'view',
    group: 'panels',
    shortcut: { key: digit, alt: true },
    checked: showing,
    run: () => (showing() ? useLayout.getState().setRightOpen(false) : useLayout.getState().setRightTab(tab)),
  };
}

function insertAction(type: ElementType, shortcut?: Shortcut): EditorAction {
  const rules: Rule[] = [SCENE, UNLOCKED];
  if (type === 'instance') rules.push([canAddInstance, 'Make a reusable component first']);
  return {
    id: `insert.${type}`,
    // An image or logo starts from a file, so its item says so.
    label: ASKS_FOR_FILE.includes(type) ? `${COMPONENTS[type].label}…` : COMPONENTS[type].label,
    menu: 'insert',
    group: 'elements',
    shortcut,
    icon: ELEMENT_ICON[type],
    ...when(...rules),
    run: () => void addFromRail(type),
    contexts: type === 'text' || type === 'shape' || type === 'image' ? ['canvas'] : undefined,
    keywords: ['add', 'insert', 'new'],
  };
}

/** Open the Generate tab on a kind of media; it lands in Assets › Generated, never straight in the video. */
function generateAction(mode: GenerateMode, job: JobKind, label: string, icon: IconName, keywords: string[]): EditorAction {
  return { id: `generate.${mode}`, label, menu: 'insert', group: 'generate', icon, run: () => openGenerate({ mode, job }), keywords: ['generate', 'fal', ...keywords] };
}

/** The selected element, when exactly one is selected. */
function selectedOne() {
  const items = selected();
  return items.length === 1 ? items[0] : null;
}

const TEXT_SELECTED: Rule = [() => selectedOne()?.type === 'text', 'Select a text element first'];
const IMAGE_SELECTED: Rule = [() => !!selectedImageAssetId(), 'Select an image element first'];
/** The current scene has a cut after it (it is not the last). */
const NEXT_SCENE: Rule = [() => !!currentScene() && !!cutAfter(st().doc.project, currentScene()!.id)?.next, 'This is the last scene: there is no cut after it'];

function themeAction(choice: ThemeChoice, label: string): EditorAction {
  return { id: `view.theme${choice[0].toUpperCase()}${choice.slice(1)}`, label, menu: 'view', group: 'theme', checked: () => useTheme.getState().choice === choice, run: () => useTheme.getState().setChoice(choice), keywords: ['theme', 'appearance', 'colour', 'color'] };
}

const ELEMENT: ContextKind[] = ['element', 'layer', 'clip'];

/** The registry, in menu order: every menu lists its actions in the order here, a rule between groups. */
export const ACTIONS: EditorAction[] = [
  // File
  { id: 'file.new', label: 'New video…', menu: 'file', group: 'project', icon: 'plus', run: () => void openNewVideo(), keywords: ['project', 'blank'] },
  { id: 'file.open', label: 'Open project…', menu: 'file', group: 'project', icon: 'folderOpen', run: () => st().setOpenDialog(true) },
  { id: 'file.save', label: 'Save now', menu: 'file', group: 'save', shortcut: { key: 'S', mod: true }, icon: 'save', run: () => void saveToServer() },
  { id: 'file.importJson', label: 'Import JSON…', menu: 'file', group: 'save', icon: 'upload', run: () => void importJson() },
  { id: 'file.export', label: 'Export…', menu: 'file', group: 'save', shortcut: { key: 'E', mod: true, shift: true }, icon: 'download', run: () => openExport(), keywords: ['mp4', 'video', 'render', 'still', 'thumbnail', 'gif', 'webm', 'prores'] },
  { id: 'file.exportJson', label: 'Export JSON', menu: 'file', group: 'save', icon: 'download', run: exportJson, keywords: ['download', 'copy'] },
  { id: 'file.format', label: 'Size & frame rate…', menu: 'file', group: 'settings', icon: 'maximize', run: openFormat, keywords: ['format', 'fps', 'resolution', 'aspect'] },
  { id: 'file.style', label: 'Style…', menu: 'file', group: 'settings', icon: 'wand', run: openStylePanel, keywords: ['brand', 'colours', 'fonts'] },
  { id: 'file.settings', label: 'Settings…', menu: 'file', group: 'settings', shortcut: { key: ',', mod: true }, icon: 'settings', run: () => useLayout.getState().openSettings(), keywords: ['preferences'] },

  // Edit
  { id: 'edit.undo', label: 'Undo', menu: 'edit', group: 'history', shortcut: { key: 'Z', mod: true }, icon: 'undo', ...when([() => st().doc.undoStack.length > 0, 'Nothing to undo']), run: () => st().undo(), contexts: ['canvas'] },
  { id: 'edit.redo', label: 'Redo', menu: 'edit', group: 'history', shortcut: { key: 'Z', mod: true, shift: true }, icon: 'redo', ...when([() => st().doc.redoStack.length > 0, 'Nothing to redo']), run: () => st().redo(), contexts: ['canvas'] },
  { id: 'edit.duplicate', label: 'Duplicate', menu: 'edit', group: 'element', icon: 'copy', ...when(SELECTION, UNLOCKED), run: () => void duplicateSelected(), contexts: ELEMENT, keywords: ['copy', 'clone'] },
  { id: 'edit.delete', label: 'Delete', menu: 'edit', group: 'element', shortcut: { key: 'Delete' }, icon: 'trash', ...when(SELECTION, UNLOCKED), run: () => void deleteSelected(), contexts: ELEMENT, keywords: ['remove'] },
  { id: 'edit.selectAll', label: 'Select all', menu: 'edit', group: 'element', shortcut: { key: 'A', mod: true }, ...when([() => !!currentScene()?.elements.length, 'Nothing in this scene yet']), run: selectAllInScope, contexts: ['canvas'] },
  { id: 'edit.group', label: 'Group', menu: 'edit', group: 'group', shortcut: { key: 'G', mod: true }, icon: 'group', ...when(SELECTION, UNLOCKED), run: () => void groupSelected(), contexts: ELEMENT },
  { id: 'edit.ungroup', label: 'Ungroup', menu: 'edit', group: 'group', shortcut: { key: 'G', mod: true, shift: true }, icon: 'ungroup', ...when([() => selected().some((e) => e.type === 'group'), 'Select a group first'], UNLOCKED), run: () => void ungroupSelected(), contexts: ELEMENT },
  { id: 'edit.forward', label: 'Bring forward', menu: 'edit', group: 'arrange', shortcut: { key: ']', mod: true }, icon: 'up', ...when(SELECTION, [() => canReorderSelected(1), 'Already the top layer at its level'], UNLOCKED), run: () => void reorderSelected(1), contexts: ELEMENT, keywords: ['layer', 'order', 'raise'] },
  { id: 'edit.backward', label: 'Send backward', menu: 'edit', group: 'arrange', shortcut: { key: '[', mod: true }, icon: 'down', ...when(SELECTION, [() => canReorderSelected(-1), 'Already the bottom layer at its level'], UNLOCKED), run: () => void reorderSelected(-1), contexts: ELEMENT, keywords: ['layer', 'order', 'lower'] },
  { id: 'edit.lock', label: () => (allSelected((e) => !!e.locked) ? 'Unlock' : 'Lock'), menu: 'edit', group: 'layer', icon: 'lock', ...when(SELECTION, UNLOCKED), run: () => void toggleSelected('locked'), contexts: ELEMENT },
  { id: 'edit.hide', label: () => (allSelected((e) => !e.visible) ? 'Show' : 'Hide'), menu: 'edit', group: 'layer', icon: 'eyeOff', ...when(SELECTION, UNLOCKED), run: () => void toggleSelected('hidden'), contexts: ELEMENT, keywords: ['visible', 'visibility'] },
  { id: 'edit.rename', label: 'Rename…', menu: 'edit', group: 'layer', icon: 'textInput', ...when(SELECTION, UNLOCKED), run: renameSelected, contexts: ELEMENT, keywords: ['name'] },
  { id: 'keyframe.copy', label: 'Copy keys', menu: 'edit', group: 'keys', shortcut: { key: 'C', mod: true }, icon: 'copy', ...when(KEYS), run: () => void copySelectedKeys(), contexts: ['keyframe'], keywords: ['keyframes'] },
  { id: 'keyframe.paste', label: 'Paste keys', menu: 'edit', group: 'keys', shortcut: { key: 'V', mod: true }, ...when([hasCopiedKeys, 'Copy keys first'], [() => !!st().selection.elementId, 'Select an element first']), run: () => void pasteKeysAtPlayhead(), contexts: ['keyframe'], keywords: ['keyframes'] },
  { id: 'keyframe.delete', label: 'Delete keys', menu: 'edit', group: 'keys', shortcut: { key: 'Delete' }, icon: 'trash', ...when(KEYS), run: () => void deleteSelectedKeys(), contexts: ['keyframe'], keywords: ['keyframes', 'remove'] },
  { id: 'keyframe.curve', label: 'Curve editor…', menu: 'edit', group: 'keys', icon: 'spline', ...when([() => st().timelineOpen, 'Show the timeline first'], [canOpenCurveEditor, 'Select a key on a track with two or more keys']), run: () => void openCurveEditor(), contexts: ['keyframe'], keywords: ['easing', 'ease', 'graph'] },
  { id: 'tool.select', label: 'Select', menu: 'edit', group: 'tools', shortcut: { key: 'V' }, checked: () => st().tool === 'select' && !st().handTool, run: () => pickTool('select'), keywords: ['tool', 'pointer', 'move'] },
  { id: 'tool.hand', label: 'Hand', menu: 'edit', group: 'tools', shortcut: { key: 'H' }, checked: () => st().handTool, run: () => pickTool(st().handTool ? 'select' : 'hand'), keywords: ['tool', 'pan'] },
  { id: 'tool.pen', label: 'Pen', menu: 'edit', group: 'tools', shortcut: { key: 'P' }, checked: () => st().tool === 'pen', run: () => pickTool('pen'), keywords: ['tool', 'path', 'draw', 'bezier'] },

  // Scene
  { id: 'scene.add', label: 'Add scene', menu: 'scene', group: 'scenes', icon: 'plus', run: () => void addSceneAfterCurrent(), contexts: ['scene'], keywords: ['new'] },
  { id: 'scene.duplicate', label: 'Duplicate scene', menu: 'scene', group: 'scenes', icon: 'copy', ...when(SCENE), run: () => void duplicateCurrentScene(), contexts: ['scene'], keywords: ['copy'] },
  { id: 'scene.delete', label: 'Delete scene', menu: 'scene', group: 'scenes', icon: 'trash', ...when(SCENE, [() => st().doc.project.scenes.length > 1, 'A video needs at least one scene'], UNLOCKED), run: () => void deleteCurrentScene(), contexts: ['scene'], keywords: ['remove'] },
  { id: 'scene.settings', label: 'Scene settings', menu: 'scene', group: 'scene', icon: 'frame', ...when(SCENE), run: openSceneSettings, contexts: ['canvas', 'scene'], keywords: ['background', 'length', 'duration', 'transition'] },
  { id: 'scene.lock', label: () => (currentScene()?.locked ? 'Unlock scene' : 'Lock scene'), menu: 'scene', group: 'scene', icon: 'lock', ...when(SCENE), run: () => void toggleSceneLock(), contexts: ['canvas', 'scene'], keywords: ['approve'] },
  { id: 'scene.marker', label: 'Add marker', menu: 'scene', group: 'time', shortcut: { key: 'M' }, icon: 'flag', run: () => void addMarkerAtPlayhead() },
  { id: 'scene.workIn', label: 'Set work area in', menu: 'scene', group: 'time', shortcut: { key: 'B' }, run: () => setWorkAreaAtPlayhead('start'), keywords: ['in point', 'loop'] },
  { id: 'scene.workOut', label: 'Set work area out', menu: 'scene', group: 'time', shortcut: { key: 'N' }, run: () => setWorkAreaAtPlayhead('end'), keywords: ['out point', 'loop'] },
  {
    id: 'generate.betweenScenes',
    label: 'Generate a transition to the next scene…',
    menu: 'scene',
    group: 'generate',
    icon: 'video',
    ...when(SCENE, NEXT_SCENE),
    // Fresh: the job's defaults are the cut after this scene, its last frame to the next scene's first.
    run: () => openGenerate({ mode: 'video', job: 'video.between' }, true),
    contexts: ['scene'],
    keywords: ['generate', 'video', 'cut', 'between', 'morph', 'fal'],
  },
  {
    id: 'generate.scoreScene',
    label: 'Generate music for this scene…',
    menu: 'scene',
    group: 'generate',
    icon: 'music',
    ...when(SCENE),
    // A bed as long as the scene; Use this take then places it in this scene, whatever is selected by then.
    run: () => {
      const scene = currentScene();
      if (scene) openGenerate({ mode: 'music', job: 'music.bed', settings: { durationSeconds: sceneMusicSeconds(st().doc.project, scene.id) }, forScene: scene.id }, true);
    },
    contexts: ['scene'],
    keywords: ['generate', 'music', 'soundtrack', 'bed', 'score', 'fal'],
  },

  // Insert
  insertAction('text', { key: 'T' }),
  insertAction('shape', { key: 'R' }),
  insertAction('image', { key: 'I' }),
  insertAction('logo'),
  insertAction('uiCard'),
  insertAction('chatBubble'),
  insertAction('path'),
  insertAction('instance'),
  { id: 'insert.video', label: 'Video…', menu: 'insert', group: 'media', icon: 'video', ...when(SCENE, UNLOCKED), run: () => void insertVideoFromFile(), keywords: ['add', 'insert', 'clip', 'upload'] },
  {
    id: 'insert.audio',
    label: 'Audio…',
    menu: 'insert',
    group: 'media',
    icon: 'audio',
    ...when(SCENE),
    // The rail's Audio popover: import a file or a built-in sound effect at the playhead.
    run: () => openRailPopover('audio'),
    keywords: ['add', 'insert', 'sound', 'music', 'sfx'],
  },
  // The Generate tab: takes land in Assets › Generated for you to pick.
  generateAction('music', 'music.bed', 'Generate music…', 'music', ['soundtrack', 'bed', 'score']),
  generateAction('voice', 'voice.line', 'Generate voice-over…', 'mic', ['narration', 'speech', 'tts', 'voice']),
  generateAction('sfx', 'sfx.hit', 'Generate a sound effect…', 'audio', ['sfx', 'sound', 'ambience', 'whoosh']),
  generateAction('image', 'image.generate', 'Generate an image…', 'image', ['picture', 'background', 'cutout', 'still']),
  generateAction('video', 'video.generate', 'Generate a video clip…', 'video', ['clip', 'footage', 'b-roll', 'shot', 'motion']),
  // Fresh: the plan and the lines come from the scenes and the story as they are now.
  { id: 'generate.scoreVideo', label: 'Score the video to its cuts…', menu: 'insert', group: 'generate', icon: 'music', run: () => openGenerate({ mode: 'music', job: 'music.scored' }, true), keywords: ['generate', 'music', 'score', 'soundtrack', 'scenes', 'downbeat', 'beat', 'sync', 'fal'] },
  { id: 'generate.narrate', label: 'Write narration for each scene…', menu: 'insert', group: 'generate', icon: 'mic', run: () => openGenerate({ mode: 'voice', job: 'voice.narration' }, true), keywords: ['generate', 'voice', 'voice-over', 'narration', 'script', 'story', 'tts', 'fal'] },
  {
    id: 'generate.readAloud',
    label: 'Read aloud (voice-over)…',
    menu: 'insert',
    group: 'generate',
    icon: 'mic',
    ...when(TEXT_SELECTED),
    run: () => openGenerate({ mode: 'voice', job: 'voice.line', prompt: String(selectedOne()?.props.text ?? '') }),
    contexts: ['element', 'layer'],
    keywords: ['generate', 'voice', 'narration', 'speech', 'tts'],
  },
  {
    id: 'generate.editImage',
    label: 'Edit this image with AI…',
    menu: 'insert',
    group: 'generate',
    icon: 'wand',
    ...when(IMAGE_SELECTED),
    run: () => {
      const assetId = selectedImageAssetId();
      if (assetId) openGenerate({ mode: 'image', job: 'image.edit', settings: { referenceAssetIds: [assetId] } });
    },
    contexts: ['element', 'layer'],
    keywords: ['generate', 'change', 'retouch', 'fal'],
  },
  {
    id: 'generate.animateImage',
    label: 'Animate this image…',
    menu: 'insert',
    group: 'generate',
    icon: 'video',
    ...when(IMAGE_SELECTED),
    run: () => {
      const assetId = selectedImageAssetId();
      if (assetId) openGenerate({ mode: 'video', job: 'video.animate', settings: { start: { assetId } } }, true);
    },
    contexts: ['element', 'layer'],
    keywords: ['generate', 'video', 'motion', 'image to video', 'fal'],
  },
  // The rail's Insert popover: every element, the templates and the motion presets.
  { id: 'insert.more', label: 'Insert…', menu: 'insert', group: 'more', icon: 'insert', run: () => openRailPopover('insert'), keywords: ['add', 'element'] },

  // View
  { id: 'view.chat', label: 'Show chat', menu: 'view', group: 'panels', shortcut: { key: 'J', mod: true }, checked: () => useLayout.getState().chatOpen, run: () => useLayout.getState().setChatOpen(!useLayout.getState().chatOpen), keywords: ['agent', 'assistant', 'conversation'] },
  { id: 'view.timeline', label: 'Show timeline', menu: 'view', group: 'panels', checked: () => st().timelineOpen, run: () => st().setTimelineOpen(!st().timelineOpen), keywords: ['keyframes', 'layers'] },
  tabToggle('view.inspector', 'inspector', 'Show inspector', '1'),
  tabToggle('view.layers', 'layers', 'Show layers', '2'),
  tabToggle('view.assets', 'assets', 'Show assets', '3'),
  tabToggle('view.history', 'history', 'Show history', '4'),
  tabToggle('view.generate', 'generate', 'Show generate', '5'),
  { id: 'view.zoomIn', label: 'Zoom in', menu: 'view', group: 'zoom', shortcut: { key: '=', mod: true }, icon: 'zoomIn', run: () => zoomBy(1) },
  { id: 'view.zoomOut', label: 'Zoom out', menu: 'view', group: 'zoom', shortcut: { key: '-', mod: true }, icon: 'zoomOut', run: () => zoomBy(-1) },
  { id: 'view.zoom100', label: 'Zoom to 100%', menu: 'view', group: 'zoom', shortcut: { key: '0', mod: true }, run: () => zoomTo(1), contexts: ['canvas'], keywords: ['actual size'] },
  { id: 'view.fit', label: 'Zoom to fit', menu: 'view', group: 'zoom', shortcut: { key: '1', shift: true }, icon: 'fit', run: fitView, contexts: ['canvas'] },
  { id: 'view.play', label: 'Play / pause', menu: 'view', group: 'playback', shortcut: { key: 'Space' }, icon: 'play', run: () => togglePlayback() },
  { id: 'view.prevFrame', label: 'Previous frame', menu: 'view', group: 'playback', shortcut: { key: ',' }, icon: 'stepBack', run: () => stepFrame(-1) },
  { id: 'view.nextFrame', label: 'Next frame', menu: 'view', group: 'playback', shortcut: { key: '.' }, icon: 'stepForward', run: () => stepFrame(1) },
  { id: 'view.animate', label: 'Animate mode', menu: 'view', group: 'playback', shortcut: { key: 'A' }, checked: () => st().editMode === 'animate', run: () => st().setEditMode(st().editMode === 'animate' ? 'layout' : 'animate'), keywords: ['layout', 'keyframe', 'mode'] },
  themeAction('system', 'System theme'),
  themeAction('light', 'Light theme'),
  themeAction('dark', 'Dark theme'),
  { id: 'view.themeNext', label: 'Next theme', menu: 'view', group: 'theme', shortcut: { key: 'T', alt: true, shift: true }, run: () => void cycleTheme(), keywords: ['theme', 'appearance', 'dark', 'light'] },
  { id: 'view.palette', label: 'Command palette', menu: 'view', group: 'palette', shortcut: { key: 'K', mod: true }, icon: 'command', run: () => useLayout.getState().openOverlay(useLayout.getState().overlay === 'palette' ? null : 'palette'), keywords: ['search', 'find', 'command'] },

  // Help
  { id: 'help.shortcuts', label: 'Keyboard shortcuts', menu: 'help', group: 'help', shortcut: { key: '?' }, icon: 'keyboard', run: () => useLayout.getState().openOverlay('shortcuts'), keywords: ['keys', 'hotkeys'] },
  { id: 'help.connect', label: 'Connect agents…', menu: 'help', group: 'agents', icon: 'plug', run: () => st().setSheet('connect'), keywords: ['claude', 'codex', 'cursor', 'mcp'] },
  { id: 'help.requests', label: () => (st().requests.length ? `Queued requests (${st().requests.length})` : 'Queued requests'), menu: 'help', group: 'agents', icon: 'clock', run: () => useLayout.getState().openSettings('editor'), keywords: ['agent', 'notes', 'patches'] },
];

export function actionById(id: string): EditorAction | undefined {
  return ACTIONS.find((a) => a.id === id);
}

export function actionsIn(menu: ActionMenu): EditorAction[] {
  return ACTIONS.filter((a) => a.menu === menu);
}

export function actionsFor(kind: ContextKind): EditorAction[] {
  return ACTIONS.filter((a) => a.contexts?.includes(kind));
}

/** ⌥1–⌥5 by physical key: ⌥ turns e.key into a glyph on a Mac. */
const TAB_KEYS: Record<string, string> = { Digit1: 'view.inspector', Digit2: 'view.layers', Digit3: 'view.assets', Digit4: 'view.history', Digit5: 'view.generate' };

/**
 * The shell's own keys: ⌘K palette, ⌘J chat, ⌘, settings, ⌥1–⌥5 right-column
 * tabs, ⇧? shortcuts. App.tsx calls it before its own handling; returns true
 * when the key was taken.
 */
export function handleShellShortcut(e: KeyboardEvent): boolean {
  const mod = e.metaKey || e.ctrlKey;
  const take = (id: string) => {
    e.preventDefault();
    actionById(id)?.run();
    return true;
  };
  const openSurface = (id: string) => !hasModalSurface() && take(id);
  if (mod && !e.altKey && !e.shiftKey) {
    // From anywhere, a text field included: the palette and the chat are where you type next.
    const k = e.key.toLowerCase();
    if (k === 'k') return useLayout.getState().overlay === 'palette' ? take('view.palette') : openSurface('view.palette');
    if (k === 'j') return take('view.chat');
  }
  if (isTyping(e.target)) return false;
  if (mod && e.shiftKey && !e.altKey && e.code === 'KeyE') return openSurface('file.export');
  if (mod && !e.altKey && !e.shiftKey && e.key === ',') return openSurface('file.settings');
  if (e.altKey && !mod && !e.shiftKey && TAB_KEYS[e.code]) return take(TAB_KEYS[e.code]);
  if (!mod && !e.altKey && e.key === '?') return openSurface('help.shortcuts');
  return false;
}
