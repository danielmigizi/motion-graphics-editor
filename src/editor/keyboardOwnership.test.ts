import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCreate } from './createFlow';
import { ownsTimelineKeys } from './editActions';
import { useCutPicker } from './firstCut';
import { useLayout } from './layout';
import { hasModalSurface } from './modalSurface';
import { useProposals } from './proposals';
import { useEditor } from './store';
import { useStylePanel } from './StylePanel';

// A closest() boundary stub lets the predicate's selector contract run without a browser.
const inside = (boundary: string) => ({
  tagName: 'BUTTON',
  closest: (selectors: string) => selectors.split(', ').includes(boundary) ? {} : null,
}) as unknown as EventTarget;

describe('timeline capture yields to focused controls', () => {
  it.each(['tablist', 'tree', 'separator', 'menu', 'listbox', 'dialog'])('leaves navigation and edit keys to a descendant of role=%s', (role) => {
    expect(ownsTimelineKeys(inside(`[role="${role}"]`))).toBe(true);
  });

  it.each(['INPUT', 'TEXTAREA', 'SELECT'])('leaves keys to %s', (tagName) => {
    expect(ownsTimelineKeys({ tagName } as unknown as EventTarget)).toBe(true);
  });

  it('leaves keys to editable content and its descendants', () => {
    expect(ownsTimelineKeys({ isContentEditable: true } as unknown as EventTarget)).toBe(true);
    expect(ownsTimelineKeys(inside('[contenteditable="true"]'))).toBe(true);
  });

  it('keeps timeline shortcuts available from the canvas and ordinary buttons', () => {
    expect(ownsTimelineKeys(null)).toBe(false);
    expect(ownsTimelineKeys(inside('.stage-overlay'))).toBe(false);
    expect(ownsTimelineKeys(inside('button'))).toBe(false);
  });
});

describe('Alt-alone modal ownership', () => {
  beforeEach(() => {
    useLayout.setState({ overlay: null });
    useEditor.setState({ sheet: null, openDialog: false });
    useCreate.setState({ dialog: null });
    useStylePanel.setState({ open: false });
    useCutPicker.setState({ browse: null });
    useProposals.setState({ open: false });
  });

  afterEach(() => vi.unstubAllGlobals());

  it.each([
    ['settings', () => useLayout.setState({ overlay: 'settings' })],
    ['palette', () => useLayout.setState({ overlay: 'palette' })],
    ['shortcuts', () => useLayout.setState({ overlay: 'shortcuts' })],
    ['connect sheet', () => useEditor.setState({ sheet: 'connect' })],
    ['Open project', () => useEditor.setState({ openDialog: true })],
    ['format', () => useCreate.setState({ dialog: 'format' })],
    ['outline review', () => useCreate.setState({ dialog: 'review' })],
    ['Style', () => useStylePanel.setState({ open: true })],
    ['cut browser', () => useCutPicker.setState({ browse: 'hook' })],
    ['proposal review', () => useProposals.setState({ open: true })],
  ] as const)('blocks the background menubar while %s is open', (_name, open) => {
    expect(hasModalSurface()).toBe(false);
    open();
    expect(hasModalSurface()).toBe(true);
  });

  it('uses a mounted aria-modal dialog as a backstop for other surfaces', () => {
    const querySelector = vi.fn().mockReturnValue({});
    vi.stubGlobal('document', { querySelector });
    expect(hasModalSurface()).toBe(true);
    expect(querySelector).toHaveBeenCalledWith('[role="dialog"][aria-modal="true"]');
    querySelector.mockReturnValue(null);
    expect(hasModalSurface()).toBe(false);
  });
});
