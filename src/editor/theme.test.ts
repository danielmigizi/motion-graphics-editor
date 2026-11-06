import { describe, expect, it } from 'vitest';
import { cycleTheme, nextTheme, parseTheme, resolvedScheme, useTheme } from './theme';

describe('resolvedScheme', () => {
  it('follows OS changes while the stored choice remains System', () => {
    expect(resolvedScheme('system', false)).toBe('light');
    expect(resolvedScheme('system', true)).toBe('dark');
    expect(resolvedScheme('system', false)).toBe('light');
  });

  it.each([false, true])('keeps explicit choices when systemDark is %s', (systemDark) => {
    expect(resolvedScheme('light', systemDark)).toBe('light');
    expect(resolvedScheme('dark', systemDark)).toBe('dark');
  });
});

describe('parseTheme', () => {
  it('keeps a stored Light or Dark choice', () => {
    expect(parseTheme('light')).toBe('light');
    expect(parseTheme('dark')).toBe('dark');
  });

  it('falls back to the system setting for anything else', () => {
    expect(parseTheme(null)).toBe('system');
    expect(parseTheme('')).toBe('system');
    expect(parseTheme('sepia')).toBe('system');
  });
});

describe('cycleTheme', () => {
  it('steps System → Light → Dark and back to System', () => {
    expect(nextTheme('system')).toBe('light');
    expect(nextTheme('light')).toBe('dark');
    expect(nextTheme('dark')).toBe('system');
  });

  it('applies each step to the theme store', () => {
    useTheme.getState().setChoice('system');
    expect(cycleTheme()).toBe('light');
    expect(useTheme.getState().choice).toBe('light');
    expect(cycleTheme()).toBe('dark');
    expect(cycleTheme()).toBe('system');
    expect(useTheme.getState().choice).toBe('system');
  });
});
