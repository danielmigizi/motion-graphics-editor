// The inspector's tab, folds and search: which tab shows after a mode switch,
// a selection or a pick by hand, and where ⌘F goes.

import { beforeEach, describe, expect, it } from 'vitest';
import { findOpensSearch, parseInspectorView, shownTab, tabAfterMode, tabAfterSelect, useInspectorView } from './inspectorView';

const view = () => useInspectorView.getState();

describe('tab rules', () => {
  it('Animate mode shows the Animate tab; Layout turns Animate back into Design and leaves the rest', () => {
    expect(tabAfterMode('design', 'animate')).toBe('animate');
    expect(tabAfterMode('scene', 'animate')).toBe('animate');
    expect(tabAfterMode('animate', 'layout')).toBe('design');
    expect(tabAfterMode('scene', 'layout')).toBe('scene');
    expect(tabAfterMode('design', 'layout')).toBe('design');
  });

  it('a new element leaves the Scene tab for the element, in the tab its mode implies', () => {
    expect(tabAfterSelect('scene', 'layout')).toBe('design');
    expect(tabAfterSelect('scene', 'animate')).toBe('animate');
    expect(tabAfterSelect('animate', 'layout')).toBe('animate');
    expect(tabAfterSelect('design', 'animate')).toBe('design');
  });

  it('with nothing selected only the scene shows', () => {
    expect(shownTab('design', false)).toBe('scene');
    expect(shownTab('animate', true)).toBe('animate');
  });
});

describe('parseInspectorView', () => {
  it('starts on Design with nothing folded, and keeps what was stored', () => {
    expect(parseInspectorView(null)).toEqual({ tab: 'design', folded: [] });
    expect(parseInspectorView(JSON.stringify({ tab: 'animate', folded: ['Appearance'] }))).toEqual({ tab: 'animate', folded: ['Appearance'] });
  });

  it('falls back for each bad value, and for text that is not JSON', () => {
    expect(parseInspectorView(JSON.stringify({ tab: 'layers', folded: 'Appearance' }))).toEqual({ tab: 'design', folded: [] });
    expect(parseInspectorView(JSON.stringify({ folded: ['Layout', 3] })).folded).toEqual(['Layout']);
    expect(parseInspectorView('not json')).toEqual({ tab: 'design', folded: [] });
  });
});

describe('useInspectorView', () => {
  beforeEach(() => useInspectorView.setState({ tab: 'design', folded: [], searching: false, query: '', seenMode: 'layout', seenElement: null }));

  it('follows a mode switch once; a tab picked afterwards stays until the next switch', () => {
    view().followMode('animate');
    expect(view().tab).toBe('animate');
    view().pickTab('design');
    view().followMode('animate'); // the same mode again (a re-render): no switch
    expect(view().tab).toBe('design');
    view().followMode('layout');
    expect(view().tab).toBe('design');
    view().followMode('animate');
    expect(view().tab).toBe('animate');
  });

  it('a new selection leaves Scene; the same element again does not', () => {
    view().followSelection('el_a', 'layout');
    view().pickTab('scene');
    view().followSelection('el_a', 'layout');
    expect(view().tab).toBe('scene');
    view().followSelection('el_b', 'layout');
    expect(view().tab).toBe('design');
    view().pickTab('scene');
    view().followSelection(null, 'layout');
    expect(view().tab).toBe('scene');
    view().followSelection('el_b', 'animate');
    expect(view().tab).toBe('animate');
  });

  it('folds and unfolds a section by title', () => {
    view().toggleFold('Appearance');
    view().toggleFold('Layout');
    expect(view().folded).toEqual(['Appearance', 'Layout']);
    view().toggleFold('Appearance');
    expect(view().folded).toEqual(['Layout']);
  });

  it('closing the search clears its query', () => {
    view().openSearch();
    view().setQuery('blur');
    expect(view()).toMatchObject({ searching: true, query: 'blur' });
    view().closeSearch();
    expect(view()).toMatchObject({ searching: false, query: '' });
  });
});

describe('findOpensSearch', () => {
  const at = (...inside: string[]) => ({ tagName: 'INPUT', closest: (sel: string) => (inside.some((s) => sel.includes(s)) ? {} : null) });

  it('takes ⌘F in the inspector and on the stage', () => {
    expect(findOpensSearch(at('inspector-column'), false)).toBe(true);
    expect(findOpensSearch(at('stage-column'), false)).toBe(true);
  });

  it('takes it with nothing focused, unless a dialog is open', () => {
    expect(findOpensSearch({ tagName: 'BODY', closest: () => null }, false)).toBe(true);
    expect(findOpensSearch(null, false)).toBe(true);
    expect(findOpensSearch({ tagName: 'BODY', closest: () => null }, true)).toBe(false);
  });

  it('leaves it to the browser in the chat, a dialog or a menu', () => {
    expect(findOpensSearch(at('chat-column'), false)).toBe(false);
    expect(findOpensSearch(at('role="dialog"', 'stage-column'), false)).toBe(false);
    expect(findOpensSearch(at('role="menu"'), false)).toBe(false);
  });
});
