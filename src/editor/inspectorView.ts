// What the inspector shows, remembered per browser tab (sessionStorage; a
// convenience, never in a document): its tab (Design, Animate or Scene), the
// sections folded away, and the property search (open or not, its query).
//
// The tab follows the header's Layout / Animate switch as an event, not as a
// state: switching to Animate shows the Animate tab, switching back to Layout
// turns Animate back into Design, and a tab picked by hand after a switch
// stays until the next switch. Selecting another element while the Scene tab
// shows brings the element back (Design, or Animate in Animate mode). With
// nothing selected only the scene shows, whatever the tab.

import { create } from 'zustand';
import type { EditMode } from './store';

export type InspectorTab = 'design' | 'animate' | 'scene';

export const INSPECTOR_TABS: readonly { id: InspectorTab; label: string }[] = [
  { id: 'design', label: 'Design' },
  { id: 'animate', label: 'Animate' },
  { id: 'scene', label: 'Scene' },
];

const elementTab = (mode: EditMode): InspectorTab => (mode === 'animate' ? 'animate' : 'design');

/** The tab after the header switches to `mode`. A switch to Layout leaves Design and Scene alone. */
export function tabAfterMode(tab: InspectorTab, mode: EditMode): InspectorTab {
  if (mode === 'animate') return 'animate';
  return tab === 'animate' ? 'design' : tab;
}

/** The tab when a different element is selected: the Scene tab gives way to the element. */
export function tabAfterSelect(tab: InspectorTab, mode: EditMode): InspectorTab {
  return tab === 'scene' ? elementTab(mode) : tab;
}

/** The tab that shows: with nothing selected, the scene. */
export function shownTab(tab: InspectorTab, hasElement: boolean): InspectorTab {
  return hasElement ? tab : 'scene';
}

/** Something that may be focused: an element (with `closest`) or nothing. */
interface FocusTarget {
  tagName?: string;
  closest?: (selector: string) => unknown;
}

/**
 * Whether ⌘F opens the property search: focus is in the inspector, on the
 * stage, or nowhere in particular (the page itself, with no dialog open).
 * Anywhere else (the chat composer, a dialog, a menu, the timeline) it stays
 * the browser's find.
 */
export function findOpensSearch(target: FocusTarget | null, dialogOpen: boolean): boolean {
  if (!target?.closest || target.tagName === 'BODY' || target.tagName === 'HTML') return !dialogOpen;
  if (target.closest('[role="dialog"], [role="alertdialog"], [role="menu"]')) return false;
  return !!target.closest('[data-testid="inspector-column"], [data-testid="stage-column"]');
}

interface Persisted {
  tab: InspectorTab;
  /** Titles of the folded sections (a title folds that section for every element). */
  folded: string[];
}

const KEY = 'mge.inspector';
const DEFAULTS: Persisted = { tab: 'design', folded: [] };

export function parseInspectorView(raw: string | null | undefined): Persisted {
  try {
    const v = JSON.parse(raw ?? '{}') as Partial<Persisted>;
    return {
      tab: INSPECTOR_TABS.some((t) => t.id === v.tab) ? (v.tab as InspectorTab) : DEFAULTS.tab,
      folded: Array.isArray(v.folded) ? v.folded.filter((t): t is string => typeof t === 'string') : DEFAULTS.folded,
    };
  } catch {
    return DEFAULTS;
  }
}

function read(): Persisted {
  try {
    return parseInspectorView(sessionStorage.getItem(KEY));
  } catch {
    return DEFAULTS;
  }
}

function write(p: Persisted) {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    // Storage blocked: the choice still holds until the page reloads.
  }
}

interface InspectorViewState extends Persisted {
  /** The search field shows in the inspector head. */
  searching: boolean;
  query: string;
  /** The header mode the tab last followed (the editor opens in Layout). */
  seenMode: EditMode;
  /** The element the tab last followed. */
  seenElement: string | null;
  /** A tab chosen by hand. */
  pickTab: (tab: InspectorTab) => void;
  /** The header's Layout / Animate switch, seen from the inspector (a no-op unless the mode changed). */
  followMode: (mode: EditMode) => void;
  /** The selection, seen from the inspector (a no-op unless the element changed). */
  followSelection: (elementId: string | null, mode: EditMode) => void;
  toggleFold: (title: string) => void;
  openSearch: () => void;
  setQuery: (query: string) => void;
  /** Escape or the close button: clear the query and hide the field. */
  closeSearch: () => void;
}

export const useInspectorView = create<InspectorViewState>((set, get) => {
  const persist = (patch: Partial<Persisted>) => {
    set(patch);
    const { tab, folded } = get();
    write({ tab, folded });
  };
  return {
    ...read(),
    searching: false,
    query: '',
    seenMode: 'layout',
    seenElement: null,
    pickTab: (tab) => persist({ tab }),
    followMode: (mode) => {
      const { seenMode, tab } = get();
      if (mode === seenMode) return;
      set({ seenMode: mode });
      persist({ tab: tabAfterMode(tab, mode) });
    },
    followSelection: (elementId, mode) => {
      const { seenElement, tab } = get();
      if (elementId === seenElement) return;
      set({ seenElement: elementId });
      if (elementId) persist({ tab: tabAfterSelect(tab, mode) });
    },
    toggleFold: (title) => {
      const { folded } = get();
      persist({ folded: folded.includes(title) ? folded.filter((t) => t !== title) : [...folded, title] });
    },
    openSearch: () => set({ searching: true }),
    setQuery: (query) => set({ query }),
    closeSearch: () => set({ searching: false, query: '' }),
  };
});
