import { beforeEach, describe, expect, it } from 'vitest';
import { CHAT_DEFAULT_W, CHAT_MAX_W, CHAT_MIN_W, clampChatWidth, parseLayout, useLayout } from './layout';

const DEFAULTS = { chatOpen: false, chatWidth: CHAT_DEFAULT_W, rightOpen: true, rightTab: 'inspector' };

describe('parseLayout', () => {
  it('starts with the chat closed at 360 px and the right column open on the Inspector', () => {
    expect(parseLayout(null)).toEqual(DEFAULTS);
    expect(parseLayout(undefined)).toEqual(DEFAULTS);
    expect(parseLayout('{}')).toEqual(DEFAULTS);
    expect(CHAT_DEFAULT_W).toBe(360);
  });

  it('keeps what was stored', () => {
    expect(parseLayout(JSON.stringify({ chatOpen: true, chatWidth: 420, rightOpen: false, rightTab: 'history' }))).toEqual({ chatOpen: true, chatWidth: 420, rightOpen: false, rightTab: 'history' });
  });

  it('clamps the chat width to 300–560 px, in whole pixels', () => {
    expect(parseLayout(JSON.stringify({ chatWidth: 120 })).chatWidth).toBe(CHAT_MIN_W);
    expect(parseLayout(JSON.stringify({ chatWidth: 9000 })).chatWidth).toBe(CHAT_MAX_W);
    expect(parseLayout(JSON.stringify({ chatWidth: 400.6 })).chatWidth).toBe(401);
    expect([CHAT_MIN_W, CHAT_MAX_W]).toEqual([300, 560]);
    expect(clampChatWidth(-5)).toBe(300);
  });

  it('falls back to the default for each bad value, and for text that is not JSON', () => {
    expect(parseLayout(JSON.stringify({ chatOpen: 'yes', chatWidth: 'wide', rightOpen: 1, rightTab: 'layer' }))).toEqual(DEFAULTS);
    expect(parseLayout('{"chatWidth": null}').chatWidth).toBe(CHAT_DEFAULT_W);
    expect(parseLayout('not json')).toEqual(DEFAULTS);
    expect(parseLayout(JSON.stringify({ chatOpen: true, rightTab: 42 }))).toEqual({ ...DEFAULTS, chatOpen: true });
  });
});

describe('useLayout', () => {
  beforeEach(() => useLayout.setState({ ...DEFAULTS, rightTab: 'inspector' }));

  it('opens the right column when a tab is chosen', () => {
    useLayout.getState().setRightOpen(false);
    useLayout.getState().setRightTab('assets');
    expect(useLayout.getState()).toMatchObject({ rightOpen: true, rightTab: 'assets' });
  });

  it('clamps a dragged chat width', () => {
    useLayout.getState().setChatWidth(1000);
    expect(useLayout.getState().chatWidth).toBe(CHAT_MAX_W);
    useLayout.getState().setChatWidth(10);
    expect(useLayout.getState().chatWidth).toBe(CHAT_MIN_W);
  });
});
