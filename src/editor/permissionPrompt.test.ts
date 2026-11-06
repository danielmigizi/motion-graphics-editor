// The generation permission card in the editor: what it says a call spends.

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import type { GenerationAsk } from '../core/generation';
import { GenerationDetail } from './PermissionPrompt';
import { askPermission, cancelPermission, usePermissions } from './permissions';

afterEach(() => usePermissions.getState().decide('denied'));

describe('native approval cancellation', () => {
  it('withdraws only the matching card and resolves its pending decision as denied', async () => {
    const pending = askPermission({ type: 'askPermission', requestId: 'old', agent: 'Codex', action: 'Write a file' });
    cancelPermission('other');
    expect(usePermissions.getState().pending?.requestId).toBe('old');
    cancelPermission('old');
    expect(usePermissions.getState().pending).toBeNull();
    expect(await pending).toMatchObject({ ok: true, message: 'denied' });
  });

  it('ignores a stale cancellation after a new request has opened', async () => {
    const old = askPermission({ type: 'askPermission', requestId: 'old', agent: 'Codex', action: 'Old action' });
    cancelPermission('old');
    await old;
    const current = askPermission({ type: 'askPermission', requestId: 'new', agent: 'Cursor Agent', action: 'New action' });
    cancelPermission('old');
    expect(usePermissions.getState().pending?.requestId).toBe('new');
    usePermissions.getState().decide('allowed');
    expect(await current).toMatchObject({ ok: true, message: 'allowed' });
  });
});

const ask = (over: Partial<GenerationAsk>): GenerationAsk => ({ provider: 'fal', tool: 'generate_image', kind: 'generate', title: 'Generate an image', settings: [], generations: 1, usedToday: 0, dailyLimit: 3, ...over });
const html = (g: GenerationAsk) => renderToStaticMarkup(createElement(GenerationDetail, { g }));

describe('generation card', () => {
  it('a generation spends the provider allowance and shows the count against the daily limit', () => {
    const out = html(ask({ media: 'image', prompt: 'Glass bottle on wet slate', model: 'flux', target: 'scene 2' }));
    expect(out).toContain('Spends fal allowance');
    expect(out).toContain('This would be 1 of 3 today');
    expect(out).toContain('Glass bottle on wet slate');
    expect(out).toContain('scene 2');
    expect(out).not.toContain('No generation');
  });

  it('a studio ask shows the estimate and today’s spend against the budget instead of a count', () => {
    const out = html(ask({ media: 'image', model: 'Seedream 5.0 Pro', estimateUsd: 0.27, estimateBasis: '4 × $0.0675 per image', spendTodayUsd: 1.2, budgetUsd: 5 }));
    expect(out).toContain('Spends your fal credit');
    expect(out).toContain('~$0.27 · today $1.20 of $5.00');
    expect(out).toContain('title="4 × $0.0675 per image"');
    expect(out).toContain('Seedream 5.0 Pro');
    expect(out).not.toContain('This would be');
    expect(out).not.toContain('allowance');
    // The meter is today's spend with this request: (1.20 + 0.27) / 5.
    expect(out).toContain('width:29.4%');
  });

  it('a budget reserve says so, and a request past the budget fills the meter', () => {
    const out = html(ask({ estimateUsd: 1, reserve: true, spendTodayUsd: 4.5, budgetUsd: 5 }));
    expect(out).toContain('≈$1.00 (budget reserve) · today $4.50 of $5.00');
    expect(out).toContain('gen-ask-meter over');
    expect(out).toContain('width:100%');
  });

  it('a studio ask without a budget shows the estimate alone', () => {
    const out = html(ask({ estimateUsd: 0.0675 }));
    expect(out).toContain('~$0.0675');
    expect(out).not.toContain('today');
    expect(out).not.toContain('gen-ask-meter');
  });

  it('a write does not generate', () => {
    const out = html(ask({ kind: 'write', title: 'Save a preset', generations: 0 }));
    expect(out).toContain('Writes to fal');
    expect(out).toContain('No generation');
  });
});
