// The action registry: the ids other surfaces rely on, the ⋯ menu's former
// items, the printed shortcuts, enabled rules, the element and scene
// toggles, and the shell's own keys.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDocState } from '../core/history';
import { composition, element, project } from '../core/__fixtures__/schema2Project';
import type { Element, Project } from '../core/types';
import { ACTIONS, actionById, actionsFor, actionsIn, handleShellShortcut, isEnabled, labelOf, MENUS, shortcutText, type ContextKind } from './actions';
import { useLayout } from './layout';
import { useCreate } from './createFlow';
import { useExportPopover } from './ExportPopover';
import { useCutPicker } from './firstCut';
import { useGenerate } from './generateStore';
import { useProposals } from './proposals';
import { useEditor } from './store';
import { useStylePanel } from './StylePanel';

const CONTRACT = {
  file: ['file.new', 'file.open', 'file.save', 'file.importJson', 'file.exportJson', 'file.settings'],
  edit: ['edit.undo', 'edit.redo', 'edit.duplicate', 'edit.delete', 'edit.selectAll', 'edit.group', 'edit.ungroup', 'edit.forward', 'edit.backward', 'edit.lock', 'edit.hide', 'edit.rename'],
  scene: ['scene.add', 'scene.duplicate', 'scene.delete', 'scene.settings', 'scene.lock'],
  insert: ['insert.text', 'insert.shape', 'insert.image', 'insert.logo', 'insert.uiCard', 'insert.chatBubble', 'insert.path', 'insert.instance', 'insert.more', 'insert.audio', 'generate.music', 'generate.voice', 'generate.sfx', 'generate.image', 'generate.video', 'generate.readAloud', 'generate.editImage', 'generate.animateImage'],
  view: ['view.chat', 'view.timeline', 'view.layers', 'view.inspector', 'view.assets', 'view.history', 'view.generate', 'view.zoomIn', 'view.zoomOut', 'view.zoom100', 'view.fit', 'view.themeSystem', 'view.themeLight', 'view.themeDark', 'view.palette'],
  tools: ['tool.select', 'tool.hand', 'tool.pen'],
  help: ['help.shortcuts', 'help.connect'],
};

/** Everything the stage header's ⋯ menu held (StageMenu.tsx, removed). */
const FORMER_MORE_MENU = [
  'view.themeSystem', 'view.themeLight', 'view.themeDark',
  'file.new', 'file.open', 'file.save', 'file.importJson', 'file.exportJson',
  'insert.text', 'insert.shape', 'insert.image', 'insert.logo', 'insert.uiCard', 'insert.chatBubble', 'insert.path', 'insert.instance',
  'scene.add', 'scene.duplicate', 'scene.delete', 'edit.forward', 'edit.backward',
  'scene.settings', 'file.format', 'file.style', 'view.assets', 'view.history', 'help.requests', 'help.connect',
];

const st = () => useEditor.getState();
const act = (id: string) => actionById(id)!;
const scene = () => st().doc.project.scenes[0];
const el = (id: string) => scene().elements.find((e) => e.id === id)!;

function open(p: Project) {
  st().loadDocument(createDocState(p), { kind: 'sample' });
  useEditor.setState({ toasts: [], timelineOpen: false, editMode: 'layout' });
}

const twoScenes = (): Project => {
  const p = project([element('a'), element('b', 'text')]);
  return { ...p, scenes: [...p.scenes, { ...p.scenes[0], id: 's2', name: 'Second', elements: [] }] };
};

beforeEach(() => {
  open(project([element('a'), element('b', 'text'), element('g', 'group'), element('kid', 'shape', { parentId: 'g' })]));
  useLayout.setState({ chatOpen: false, rightOpen: true, rightTab: 'inspector', overlay: null, settingsPage: 'project' });
  useEditor.setState({ sheet: null, openDialog: false });
  useCreate.setState({ dialog: null });
  useStylePanel.setState({ open: false });
  useCutPicker.setState({ browse: null });
  useProposals.setState({ open: false });
  useExportPopover.setState({ open: false });
});

afterEach(() => vi.unstubAllGlobals());

describe('the registry', () => {
  it('has every id other surfaces rely on, each exactly once', () => {
    const ids = ACTIONS.map((a) => a.id);
    for (const id of Object.values(CONTRACT).flat()) expect(ids.filter((x) => x === id), id).toHaveLength(1);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('puts the tools in Edit, in their own group', () => {
    for (const id of CONTRACT.tools) expect(act(id)).toMatchObject({ menu: 'edit', group: 'tools' });
  });

  it('gives every action a label, a known menu and a group', () => {
    const menus = MENUS.map((m) => m.id);
    for (const a of ACTIONS) {
      expect(labelOf(a).trim(), a.id).not.toBe('');
      expect(menus, a.id).toContain(a.menu);
      expect(a.group, a.id).toBeTruthy();
    }
  });

  it('is in menu order, each group in one run, so a menu reads straight from it', () => {
    const order = ACTIONS.map((a) => MENUS.findIndex((m) => m.id === a.menu));
    expect(order).toEqual([...order].sort((x, y) => x - y));
    for (const m of MENUS) {
      const groups = actionsIn(m.id).map((a) => a.group);
      const runs = groups.filter((g, i) => g !== groups[i - 1]);
      expect(new Set(runs).size, m.id).toBe(runs.length);
    }
  });

  it('holds everything the ⋯ menu held', () => {
    for (const id of FORMER_MORE_MENU) expect(actionById(id), id).toBeDefined();
  });

  it('uses sentence case: no label is all capitals or title case past its first word', () => {
    for (const a of ACTIONS) {
      const words = labelOf(a).split(' ').slice(1);
      expect(words.filter((w) => /^[A-Z][a-z]/.test(w) && !['JSON'].includes(w)), a.id).toEqual([]);
    }
  });

  it('offers something on every kind of right-click', () => {
    for (const kind of ['canvas', 'element', 'scene', 'layer', 'clip', 'keyframe'] as ContextKind[]) expect(actionsFor(kind).length, kind).toBeGreaterThan(0);
    expect(actionsFor('element').map((a) => a.id)).toEqual(expect.arrayContaining(['edit.lock', 'edit.hide', 'edit.rename', 'edit.group', 'edit.duplicate', 'edit.delete']));
    expect(actionsFor('keyframe').map((a) => a.id)).toEqual(['keyframe.copy', 'keyframe.paste', 'keyframe.delete', 'keyframe.curve']);
    expect(actionsFor('scene').map((a) => a.id)).toEqual(['scene.add', 'scene.duplicate', 'scene.delete', 'scene.settings', 'scene.lock', 'generate.betweenScenes', 'generate.scoreScene']);
  });
});

describe('generate', () => {
  it('reads a selected text element aloud in the Generate tab', () => {
    st().selectElement('s', 'a');
    expect(isEnabled(act('generate.readAloud'))).toBe(false);
    expect(act('generate.readAloud').whyDisabled?.()).toBe('Select a text element first');
    st().selectElement('s', 'b');
    act('generate.readAloud').run();
    expect(useLayout.getState().rightTab).toBe('generate');
    expect(useGenerate.getState().draft).toMatchObject({ mode: 'voice', job: 'voice.line', prompt: String(el('b').props.text) });
  });

  it('edits a selected image element whose file is an image', () => {
    const p = project([element('img', 'image', { props: { assetId: 'ast_pic', fit: 'cover' } }), element('b', 'text')]);
    open({ ...p, assets: { ast_pic: { id: 'ast_pic', kind: 'image', name: 'Pic', src: 'assets/pic.png', mimeType: 'image/png' } } });
    st().selectElement('s', 'b');
    expect(isEnabled(act('generate.editImage'))).toBe(false);
    st().selectElement('s', 'img');
    act('generate.editImage').run();
    expect(useGenerate.getState().draft).toMatchObject({ mode: 'image', job: 'image.edit', settings: { referenceAssetIds: ['ast_pic'] } });
  });

  it('opens Video on a clip from text', () => {
    expect(act('generate.video')).toMatchObject({ label: 'Generate a video clip…', menu: 'insert', group: 'generate' });
    act('generate.video').run();
    expect(useLayout.getState().rightTab).toBe('generate');
    expect(useGenerate.getState().draft).toMatchObject({ mode: 'video', job: 'video.generate', settings: { videoResolution: '1080p' } });
  });

  it('animates a selected image element whose file is an image, from that image', () => {
    const p = project([element('img', 'image', { props: { assetId: 'ast_pic', fit: 'cover' } }), element('b', 'text')]);
    open({ ...p, assets: { ast_pic: { id: 'ast_pic', kind: 'image', name: 'Pic', src: 'assets/pic.png', mimeType: 'image/png' } } });
    expect(act('generate.animateImage').contexts).toEqual(['element', 'layer']);
    st().selectElement('s', 'b');
    expect(isEnabled(act('generate.animateImage'))).toBe(false);
    expect(act('generate.animateImage').whyDisabled?.()).toBe('Select an image element first');
    st().selectElement('s', 'img');
    expect(isEnabled(act('generate.animateImage'))).toBe(true);
    // A start left from an earlier request does not survive: the action's image replaces it.
    useGenerate.getState().setDraft({ job: 'video.animate', settings: { start: { projectFrame: 12 } } });
    act('generate.animateImage').run();
    expect(useGenerate.getState().draft).toMatchObject({ mode: 'video', job: 'video.animate', model: null, settings: { start: { assetId: 'ast_pic' } } });
  });

  it('generates a transition across the cut to the next scene, from the scene’s menu; not after the last scene', () => {
    // Scene "s" is 100 frames, then "Second".
    open(twoScenes());
    st().selectElement('s', null);
    expect(act('generate.betweenScenes')).toMatchObject({ label: 'Generate a transition to the next scene…', menu: 'scene', contexts: ['scene'] });
    expect(isEnabled(act('generate.betweenScenes'))).toBe(true);
    // The draft already on video.between with other frames: the action still fills this cut.
    useGenerate.getState().setDraft({ job: 'video.between', settings: { start: { assetId: 'x' }, end: { assetId: 'y' } } });
    act('generate.betweenScenes').run();
    expect(useLayout.getState().rightTab).toBe('generate');
    expect(useGenerate.getState().draft).toMatchObject({ mode: 'video', job: 'video.between', settings: { start: { projectFrame: 99 }, end: { projectFrame: 100 } } });
    st().selectElement('s2', null);
    expect(isEnabled(act('generate.betweenScenes'))).toBe(false);
    expect(act('generate.betweenScenes').whyDisabled?.()).toBe('This is the last scene: there is no cut after it');
  });
});

describe('shortcuts as the menus print them', () => {
  it('on a Mac: glyphs in Apple’s order', () => {
    expect(shortcutText(act('edit.undo').shortcut!, true)).toBe('⌘Z');
    expect(shortcutText(act('edit.redo').shortcut!, true)).toBe('⇧⌘Z');
    expect(shortcutText(act('edit.delete').shortcut!, true)).toBe('⌫');
    expect(shortcutText(act('edit.ungroup').shortcut!, true)).toBe('⇧⌘G');
    expect(shortcutText(act('view.layers').shortcut!, true)).toBe('⌥2');
    expect(shortcutText(act('view.themeNext').shortcut!, true)).toBe('⌥⇧T');
    expect(shortcutText(act('view.fit').shortcut!, true)).toBe('⇧1');
  });

  it('elsewhere: words joined with +', () => {
    expect(shortcutText(act('edit.undo').shortcut!, false)).toBe('Ctrl+Z');
    expect(shortcutText(act('edit.redo').shortcut!, false)).toBe('Ctrl+Shift+Z');
    expect(shortcutText(act('edit.delete').shortcut!, false)).toBe('Delete');
    expect(shortcutText(act('view.layers').shortcut!, false)).toBe('Alt+2');
    expect(shortcutText(act('view.themeNext').shortcut!, false)).toBe('Alt+Shift+T');
    expect(shortcutText(act('file.settings').shortcut!, false)).toBe('Ctrl+,');
  });

  it('prints the keys the editor already has, and the rail’s letters', () => {
    const keys = Object.fromEntries(ACTIONS.filter((a) => a.shortcut).map((a) => [a.id, shortcutText(a.shortcut!, true)]));
    expect(keys).toMatchObject({
      'file.save': '⌘S',
      'edit.selectAll': '⌘A',
      'edit.group': '⌘G',
      'edit.forward': '⌘]',
      'edit.backward': '⌘[',
      'view.zoomIn': '⌘=',
      'view.zoomOut': '⌘-',
      'view.zoom100': '⌘0',
      'view.play': 'Space',
      'view.animate': 'A',
      'scene.marker': 'M',
      'scene.workIn': 'B',
      'scene.workOut': 'N',
      'tool.select': 'V',
      'tool.hand': 'H',
      'tool.pen': 'P',
      'insert.text': 'T',
      'insert.shape': 'R',
      'insert.image': 'I',
      'view.palette': '⌘K',
      'view.chat': '⌘J',
      'help.shortcuts': '?',
    });
  });
});

describe('enabled follows the editor', () => {
  it('undo needs something to undo, and says so', () => {
    expect(isEnabled(act('edit.undo'))).toBe(false);
    expect(act('edit.undo').whyDisabled?.()).toBe('Nothing to undo');
    st().run({ type: 'updateElement', sceneId: 's', elementId: 'a', changes: { name: 'A' } }, 'Rename');
    expect(isEnabled(act('edit.undo'))).toBe(true);
    expect(isEnabled(act('edit.redo'))).toBe(false);
  });

  it('a video keeps its last scene', () => {
    expect(isEnabled(act('scene.delete'))).toBe(false);
    expect(act('scene.delete').whyDisabled?.()).toBe('A video needs at least one scene');
    open(twoScenes());
    expect(isEnabled(act('scene.delete'))).toBe(true);
  });

  it('bring forward stops at the top, send backward at the bottom', () => {
    st().selectElement('s', 'g');
    expect(isEnabled(act('edit.forward'))).toBe(false);
    expect(act('edit.forward').whyDisabled?.()).toMatch(/top/);
    expect(isEnabled(act('edit.backward'))).toBe(true);
    st().selectElement('s', 'a');
    expect(isEnabled(act('edit.backward'))).toBe(false);
    expect(isEnabled(act('edit.forward'))).toBe(true);
  });

  it('element actions need a selection and an unlocked scene', () => {
    expect(isEnabled(act('edit.duplicate'))).toBe(false);
    expect(act('edit.duplicate').whyDisabled?.()).toBe('Select an element first');
    st().selectElement('s', 'a');
    expect(isEnabled(act('edit.duplicate'))).toBe(true);
    st().run({ type: 'setSceneLock', sceneId: 's', locked: true });
    expect(isEnabled(act('edit.duplicate'))).toBe(false);
    expect(act('edit.duplicate').whyDisabled?.()).toMatch(/locked/i);
    expect(isEnabled(act('insert.text'))).toBe(false);
  });

  it('an instance needs a reusable component', () => {
    expect(isEnabled(act('insert.instance'))).toBe(false);
    expect(act('insert.instance').whyDisabled?.()).toBe('Make a reusable component first');
    const p = project();
    open({ ...p, compositions: { c: composition('c') } });
    expect(isEnabled(act('insert.instance'))).toBe(true);
  });

  it('ungroup needs a group', () => {
    st().selectElement('s', 'a');
    expect(isEnabled(act('edit.ungroup'))).toBe(false);
    st().selectElement('s', 'g');
    expect(isEnabled(act('edit.ungroup'))).toBe(true);
  });

  it('key actions need selected keys', () => {
    expect(isEnabled(act('keyframe.delete'))).toBe(false);
    expect(isEnabled(act('keyframe.copy'))).toBe(false);
    expect(isEnabled(act('keyframe.paste'))).toBe(false);
    expect(act('keyframe.curve').whyDisabled?.()).toBe('Show the timeline first');
  });
});

describe('actions', () => {
  it('lock and hide toggle the selection as one undo step, and the label follows', () => {
    st().selectMany('s', ['a', 'b']);
    expect(labelOf(act('edit.lock'))).toBe('Lock');
    act('edit.lock').run();
    expect([el('a').locked, el('b').locked]).toEqual([true, true]);
    expect(st().doc.undoStack.at(-1)!.label).toBe('Lock 2 elements');
    expect(labelOf(act('edit.lock'))).toBe('Unlock');
    act('edit.lock').run();
    expect([el('a').locked, el('b').locked]).toEqual([undefined, undefined]);

    st().selectElement('s', 'a');
    act('edit.hide').run();
    expect(el('a').visible).toBe(false);
    expect(st().doc.undoStack.at(-1)!.label).toBe('Hide “a”');
    expect(labelOf(act('edit.hide'))).toBe('Show');
    act('edit.hide').run();
    expect(el('a').visible).toBe(true);
  });

  it('duplicate copies an element with its children just above it and selects the copy', () => {
    st().selectElement('s', 'g');
    const before = st().doc.undoStack.length;
    act('edit.duplicate').run();
    expect(st().doc.undoStack.length).toBe(before + 1);
    const els: Element[] = scene().elements;
    expect(els).toHaveLength(6);
    const copy = els.find((e) => e.name === 'g copy')!;
    const kidCopy = els.find((e) => e.parentId === copy.id)!;
    expect(kidCopy).toMatchObject({ type: 'shape', name: 'kid' });
    expect(els.indexOf(copy)).toBeGreaterThan(els.findIndex((e) => e.id === 'kid'));
    expect(st().selection.elementIds).toEqual([copy.id]);
    st().undo();
    expect(scene().elements).toHaveLength(4);
  });

  it('scene lock toggles the current scene', () => {
    expect(labelOf(act('scene.lock'))).toBe('Lock scene');
    act('scene.lock').run();
    expect(scene().locked).toBe(true);
    expect(labelOf(act('scene.lock'))).toBe('Unlock scene');
  });

  it.each([['a', 'b'], ['b', 'a']])('duplicate remaps a sibling mask across selection order %s, %s', (first, second) => {
    open(project([element('a'), element('b', 'shape', { mask: { sourceId: 'a', mode: 'alpha' } })]));
    st().selectMany('s', [first, second]);
    const before = st().doc.undoStack.length;
    act('edit.duplicate').run();
    const mask = scene().elements.find((e) => e.name === 'a copy')!;
    const target = scene().elements.find((e) => e.name === 'b copy')!;
    expect(target.mask).toEqual({ sourceId: mask.id, mode: 'alpha' });
    expect(el('b').mask?.sourceId).toBe('a');
    expect(st().selection.elementIds).toEqual([first === 'a' ? mask.id : target.id, second === 'a' ? mask.id : target.id]);
    expect(st().doc.undoStack.length).toBe(before + 1);
    st().undo();
    expect(scene().elements.map((e) => e.id)).toEqual(['a', 'b']);
  });

  it('duplicate remaps child masks and retains references outside the copied selection', () => {
    open(project([
      element('outer', 'group'),
      element('external', 'shape', { parentId: 'outer' }),
      element('g', 'group', { parentId: 'outer' }),
      element('mask', 'shape', { parentId: 'g' }),
      element('inside', 'shape', { parentId: 'g', mask: { sourceId: 'mask', mode: 'alpha' } }),
      element('target', 'shape', { parentId: 'outer', mask: { sourceId: 'external', mode: 'inverted' } }),
      element('other', 'shape', { parentId: 'outer', mask: { sourceId: 'external', mode: 'alpha' } }),
    ]));
    st().selectMany('s', ['g', 'mask', 'target', 'other']);
    act('edit.duplicate').run();
    const group = scene().elements.find((e) => e.name === 'g copy')!;
    const mask = scene().elements.find((e) => e.parentId === group.id)!;
    const inside = scene().elements.find((e) => e.parentId === group.id && e.name === 'inside')!;
    const target = scene().elements.find((e) => e.name === 'target copy')!;
    const other = scene().elements.find((e) => e.name === 'other copy')!;
    expect(scene().elements).toHaveLength(12);
    expect(target.mask?.sourceId).toBe('external');
    expect(inside.mask?.sourceId).toBe(mask.id);
    expect([group.parentId, target.parentId, other.parentId]).toEqual(['outer', 'outer', 'outer']);
    expect(other.mask?.sourceId).toBe('external');
  });

  it('scene settings clears the selection and shows the scene in the inspector', () => {
    st().selectElement('s', 'a');
    useLayout.setState({ rightTab: 'layers', rightOpen: false });
    act('scene.settings').run();
    expect(st().selection.elementIds).toEqual([]);
    expect(st().sceneInspectorOpen).toBe(true);
    expect(useLayout.getState()).toMatchObject({ rightTab: 'inspector', rightOpen: true });
  });

  it('view toggles report their state', () => {
    expect(act('view.timeline').checked!()).toBe(false);
    act('view.timeline').run();
    expect(st().timelineOpen).toBe(true);
    expect(act('view.timeline').checked!()).toBe(true);
    expect(act('view.inspector').checked!()).toBe(true);
    act('view.layers').run();
    expect(useLayout.getState().rightTab).toBe('layers');
    expect([act('view.inspector').checked!(), act('view.layers').checked!()]).toEqual([false, true]);
    // A tab already showing folds the column.
    act('view.layers').run();
    expect(useLayout.getState().rightOpen).toBe(false);
  });
});

describe('the shell’s keys', () => {
  const field = { tagName: 'INPUT' };
  const key = (k: string, o: { mod?: boolean; alt?: boolean; shift?: boolean; code?: string; target?: unknown } = {}) => {
    const e = { key: k, code: o.code ?? '', metaKey: !!o.mod, ctrlKey: false, altKey: !!o.alt, shiftKey: !!o.shift, target: o.target ?? null, prevented: false, preventDefault() {
      e.prevented = true;
    } };
    return e as unknown as KeyboardEvent & { prevented: boolean };
  };

  it('⌘K opens the palette and ⌘J toggles the chat, even from a field', () => {
    const k = key('k', { mod: true, target: field });
    expect(handleShellShortcut(k)).toBe(true);
    expect(k.prevented).toBe(true);
    expect(useLayout.getState().overlay).toBe('palette');
    expect(handleShellShortcut(key('j', { mod: true, target: field }))).toBe(true);
    expect(useLayout.getState().chatOpen).toBe(true);
    handleShellShortcut(key('J', { mod: true }));
    expect(useLayout.getState().chatOpen).toBe(false);
  });

  it('⌘, opens settings, but not from a field', () => {
    expect(handleShellShortcut(key(',', { mod: true, target: field }))).toBe(false);
    expect(useLayout.getState().overlay).toBe(null);
    expect(handleShellShortcut(key(',', { mod: true }))).toBe(true);
    expect(useLayout.getState().overlay).toBe('settings');
  });

  it('⇧⌘E opens Export when no modal owns focus', () => {
    const e = key('E', { mod: true, shift: true, code: 'KeyE' });
    expect(handleShellShortcut(e)).toBe(true);
    expect(e.prevented).toBe(true);
    expect(useExportPopover.getState().open).toBe(true);
  });

  it('⌘K still closes the palette it already opened', () => {
    useLayout.setState({ overlay: 'palette' });
    expect(handleShellShortcut(key('k', { mod: true, target: field }))).toBe(true);
    expect(useLayout.getState().overlay).toBe(null);
  });

  it.each([
    ['Connect agents', () => useEditor.setState({ sheet: 'connect' })],
    ['Open project', () => useEditor.setState({ openDialog: true })],
    ['format', () => useCreate.setState({ dialog: 'format' })],
    ['outline review', () => useCreate.setState({ dialog: 'review' })],
    ['Style', () => useStylePanel.setState({ open: true })],
    ['cut browser', () => useCutPicker.setState({ browse: 'hook' })],
    ['proposal review', () => useProposals.setState({ open: true })],
    ['settings', () => useLayout.setState({ overlay: 'settings' })],
    ['palette', () => useLayout.setState({ overlay: 'palette' })],
    ['shortcuts', () => useLayout.setState({ overlay: 'shortcuts' })],
    ['mounted modal', () => vi.stubGlobal('document', { querySelector: vi.fn().mockReturnValue({}) })],
  ] as const)('leaves surface shortcuts to %s while allowing chat', (_name, openModal) => {
    openModal();
    const layout = useLayout.getState();
    const editor = st();
    for (const e of [
      key('E', { mod: true, shift: true, code: 'KeyE' }),
      ...(layout.overlay === 'palette' ? [] : [key('k', { mod: true }), key('k', { mod: true, target: field })]),
      key(',', { mod: true }),
      key('?', { shift: true }),
    ]) {
      expect(handleShellShortcut(e)).toBe(false);
      expect(e.prevented).toBe(false);
      expect(useExportPopover.getState().open).toBe(false);
      expect(useLayout.getState()).toBe(layout);
      expect(st()).toBe(editor);
    }
    expect(handleShellShortcut(key('j', { mod: true }))).toBe(true);
    expect(useLayout.getState().chatOpen).toBe(true);
  });

  it('⌥1 to ⌥5 pick the right column’s tab by physical key (⌥ makes e.key a glyph on a Mac)', () => {
    expect(handleShellShortcut(key('™', { alt: true, code: 'Digit2' }))).toBe(true);
    expect(useLayout.getState().rightTab).toBe('layers');
    handleShellShortcut(key('£', { alt: true, code: 'Digit3' }));
    expect(useLayout.getState().rightTab).toBe('assets');
    handleShellShortcut(key('¢', { alt: true, code: 'Digit4' }));
    expect(useLayout.getState().rightTab).toBe('history');
    handleShellShortcut(key('∞', { alt: true, code: 'Digit5' }));
    expect(useLayout.getState().rightTab).toBe('generate');
    expect(shortcutText(act('view.generate').shortcut!, true)).toBe('⌥5');
    handleShellShortcut(key('¡', { alt: true, code: 'Digit1' }));
    expect(useLayout.getState().rightTab).toBe('inspector');
    expect(handleShellShortcut(key('™', { alt: true, code: 'Digit2', target: field }))).toBe(false);
  });

  it('? opens the shortcuts sheet, not while typing', () => {
    expect(handleShellShortcut(key('?', { shift: true, target: field }))).toBe(false);
    expect(handleShellShortcut(key('?', { shift: true }))).toBe(true);
    expect(useLayout.getState().overlay).toBe('shortcuts');
  });

  it('leaves every other key to the editor', () => {
    for (const k of [key('z', { mod: true }), key('a'), key('1', { shift: true, code: 'Digit1' }), key('k'), key('6', { alt: true, code: 'Digit6' })]) expect(handleShellShortcut(k)).toBe(false);
  });
});
