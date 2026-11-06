// The shell's panels, remembered per browser (a convenience, never in a
// document): the chat docked on the right (closed by default, its width
// dragged and kept), the right column and its tab, the layers panel. The
// overlays (settings, palette, shortcuts) are open state only.

import { create } from 'zustand';

export type RightTab = 'inspector' | 'layers' | 'assets' | 'history' | 'generate';
export const RIGHT_TABS: { id: RightTab; label: string }[] = [
  { id: 'inspector', label: 'Inspector' },
  { id: 'layers', label: 'Layers' },
  { id: 'assets', label: 'Assets' },
  { id: 'history', label: 'History' },
  { id: 'generate', label: 'Generate' },
];

export type Overlay = 'settings' | 'palette' | 'shortcuts';
export type SettingsPage = 'project' | 'editor' | 'generation';

export const CHAT_MIN_W = 300;
export const CHAT_MAX_W = 560;
export const CHAT_DEFAULT_W = 360;

const KEY = 'mge.layout';

interface Persisted {
  chatOpen: boolean;
  chatWidth: number;
  rightOpen: boolean;
  rightTab: RightTab;
}

const DEFAULTS: Persisted = { chatOpen: false, chatWidth: CHAT_DEFAULT_W, rightOpen: true, rightTab: 'inspector' };

export const clampChatWidth = (w: number) => Math.round(Math.min(CHAT_MAX_W, Math.max(CHAT_MIN_W, w)));

export function parseLayout(raw: string | null | undefined): Persisted {
  try {
    const v = JSON.parse(raw ?? '{}') as Partial<Persisted>;
    return {
      chatOpen: typeof v.chatOpen === 'boolean' ? v.chatOpen : DEFAULTS.chatOpen,
      chatWidth: typeof v.chatWidth === 'number' && Number.isFinite(v.chatWidth) ? clampChatWidth(v.chatWidth) : DEFAULTS.chatWidth,
      rightOpen: typeof v.rightOpen === 'boolean' ? v.rightOpen : DEFAULTS.rightOpen,
      rightTab: RIGHT_TABS.some((t) => t.id === v.rightTab) ? (v.rightTab as RightTab) : DEFAULTS.rightTab,
    };
  } catch {
    return DEFAULTS;
  }
}

function read(): Persisted {
  try {
    return parseLayout(localStorage.getItem(KEY));
  } catch {
    return DEFAULTS;
  }
}

function write(p: Persisted) {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    // Storage blocked: the layout still holds for this tab.
  }
}

interface LayoutState extends Persisted {
  overlay: Overlay | null;
  settingsPage: SettingsPage;
  setChatOpen: (open: boolean) => void;
  setChatWidth: (w: number) => void;
  setRightOpen: (open: boolean) => void;
  setRightTab: (tab: RightTab) => void;
  openOverlay: (o: Overlay | null) => void;
  openSettings: (page?: SettingsPage) => void;
}

export const useLayout = create<LayoutState>((set, get) => {
  const persist = (patch: Partial<Persisted>) => {
    set(patch);
    const { chatOpen, chatWidth, rightOpen, rightTab } = get();
    write({ chatOpen, chatWidth, rightOpen, rightTab });
  };
  return {
    ...read(),
    overlay: null,
    settingsPage: 'project',
    setChatOpen: (chatOpen) => persist({ chatOpen }),
    setChatWidth: (w) => persist({ chatWidth: clampChatWidth(w) }),
    setRightOpen: (rightOpen) => persist({ rightOpen }),
    // Choosing a tab opens the column.
    setRightTab: (rightTab) => persist({ rightTab, rightOpen: true }),
    openOverlay: (overlay) => set({ overlay }),
    openSettings: (settingsPage = get().settingsPage) => set({ overlay: 'settings', settingsPage }),
  };
});
