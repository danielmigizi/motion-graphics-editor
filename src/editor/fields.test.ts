// Label scrubbing in the inspector: one preview stream and one commit per drag,
// bound to the document and element the drag started on.

import { describe, expect, it, vi } from 'vitest';
import { scrubController, type ScrubSpec } from './fields';

function setup() {
  const a = { onPreview: vi.fn(), onCommit: vi.fn() };
  const b = { onPreview: vi.fn(), onCommit: vi.fn() };
  let spec: ScrubSpec = { value: 10, step: 1, ...a };
  let scope = 'session-1/scn_intro/el_a';
  const ctl = scrubController(() => spec, () => scope);
  // The agent focuses element B: the same field now shows B's X, with B's callbacks.
  const switchToB = () => {
    spec = { value: 500, step: 1, ...b };
    scope = 'session-1/scn_intro/el_b';
  };
  return { a, b, ctl, switchToB };
}

const plain = { shiftKey: false, altKey: false };

describe('scrubController', () => {
  it('previews while dragging and commits once on release', () => {
    const { a, ctl } = setup();
    ctl.down(0);
    ctl.move(20, plain);
    expect(a.onPreview).toHaveBeenLastCalledWith(20);
    expect(ctl.up()).toBe(true);
    expect(a.onPreview).toHaveBeenLastCalledWith(null);
    expect(a.onCommit).toHaveBeenCalledTimes(1);
    expect(a.onCommit).toHaveBeenCalledWith(20);
  });

  it('cancels, clearing its preview, when the inspected element changes mid-drag', () => {
    const { a, b, ctl, switchToB } = setup();
    ctl.down(0);
    ctl.move(20, plain);
    switchToB();
    ctl.syncScope();
    expect(a.onPreview).toHaveBeenLastCalledWith(null);
    ctl.move(40, plain);
    expect(ctl.up()).toBe(false);
    expect(a.onCommit).not.toHaveBeenCalled();
    expect(b.onCommit).not.toHaveBeenCalled();
    expect(b.onPreview).not.toHaveBeenCalled();
  });

  it('never commits to another element even when the release arrives before the scope sync', () => {
    const { a, b, ctl, switchToB } = setup();
    ctl.down(0);
    ctl.move(20, plain);
    switchToB();
    ctl.up();
    expect(a.onPreview).toHaveBeenLastCalledWith(null);
    expect(a.onCommit).not.toHaveBeenCalled();
    expect(b.onCommit).not.toHaveBeenCalled();
  });

  it('cancel clears an active preview without committing', () => {
    const { a, ctl } = setup();
    ctl.down(0);
    ctl.move(20, plain);
    ctl.cancel();
    expect(a.onPreview).toHaveBeenLastCalledWith(null);
    expect(ctl.up()).toBe(false);
    expect(a.onCommit).not.toHaveBeenCalled();
  });
});
