// Light, Dark or System: the editor chrome's colour scheme, remembered per
// browser (a convenience, never in a document). System follows the OS setting
// through `color-scheme: light dark` in styles.css; Light and Dark pin it with
// data-theme on <html>. index.html applies the stored choice before first paint.
// The header's theme button and ⌥⇧T step through the choices in their listed
// order (cycleTheme); View › Theme and Settings › Editor pick one directly.

import { useSyncExternalStore } from 'react';
import { create } from 'zustand';

export type ThemeChoice = 'system' | 'light' | 'dark';

/** The scheme CSS resolves for a stored choice and the current OS preference. */
export function resolvedScheme(choice: ThemeChoice, systemDark: boolean): 'light' | 'dark' {
  return choice === 'system' ? (systemDark ? 'dark' : 'light') : choice;
}

const systemScheme = () => typeof window !== 'undefined' ? window.matchMedia('(prefers-color-scheme: dark)') : null;
const systemDark = () => systemScheme()?.matches ?? false;
const serverDark = () => false;
function subscribeSystemScheme(changed: () => void) {
  const media = systemScheme();
  media?.addEventListener('change', changed);
  return () => media?.removeEventListener('change', changed);
}

/** Canvas paint follows both explicit theme choices and live System changes. */
export function useResolvedScheme(): 'light' | 'dark' {
  const choice = useTheme((s) => s.choice);
  const dark = useSyncExternalStore(subscribeSystemScheme, systemDark, serverDark);
  return resolvedScheme(choice, dark);
}

export const THEME_KEY = 'mge.theme';
export const THEME_CHOICES: { id: ThemeChoice; label: string }[] = [
  { id: 'system', label: 'System' },
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
];

/** The choice after `choice` in the header button's cycle: System → Light → Dark → System. */
export function nextTheme(choice: ThemeChoice): ThemeChoice {
  const i = THEME_CHOICES.findIndex((c) => c.id === choice);
  return THEME_CHOICES[(i + 1) % THEME_CHOICES.length].id;
}

export function themeLabel(choice: ThemeChoice): string {
  return THEME_CHOICES.find((c) => c.id === choice)?.label ?? 'System';
}

export function parseTheme(raw: string | null | undefined): ThemeChoice {
  return raw === 'light' || raw === 'dark' ? raw : 'system';
}

function readTheme(): ThemeChoice {
  try {
    return parseTheme(localStorage.getItem(THEME_KEY));
  } catch {
    return 'system';
  }
}

function applyTheme(choice: ThemeChoice) {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (choice === 'system') delete root.dataset.theme;
  else root.dataset.theme = choice;
}

export const useTheme = create<{ choice: ThemeChoice; setChoice: (c: ThemeChoice) => void }>((set) => ({
  choice: readTheme(),
  setChoice: (choice) => {
    try {
      if (choice === 'system') localStorage.removeItem(THEME_KEY);
      else localStorage.setItem(THEME_KEY, choice);
    } catch {
      // Storage blocked: the choice still holds for this tab.
    }
    applyTheme(choice);
    set({ choice });
  },
}));

/** One step along the cycle (the header button, ⌥⇧T); returns the new choice. */
export function cycleTheme(): ThemeChoice {
  const { choice, setChoice } = useTheme.getState();
  const next = nextTheme(choice);
  setChoice(next);
  return next;
}
