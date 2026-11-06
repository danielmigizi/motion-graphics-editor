import { describe, expect, it } from 'vitest';
import { ELEMENT_TYPES } from './components';
import { buildAuthoringGuide, exampleProject } from './guide';
import { validateProject } from './validate';
import { createHandlers } from '../../mcp/tools';
import { LocalEditor } from '../../mcp/local';

describe('authoring guide', () => {
  it('ships a minimal project that passes validation', () => {
    const r = validateProject(exampleProject());
    expect(r.ok, r.ok ? '' : r.error.message).toBe(true);
  });

  it('documents every component and is deterministic', () => {
    const guide = buildAuthoringGuide();
    for (const type of ELEMENT_TYPES) expect(guide).toContain(`### \`${type}\``);
    expect(guide).toContain('addAsset');
    for (const term of ['parentId','path','stops','props.color','cubicBezier','sourceId','blendMode','dropShadow','charFadeUp','compositionId','read-only','groupElements','ungroup']) expect(guide).toContain(term);
    expect(buildAuthoringGuide()).toBe(guide);
  });

  it('documents the complete versioned agent tool set', () => {
    const guide = buildAuthoringGuide();
    const handlers = createHandlers(new LocalEditor({ rootDir: '/tmp', serverPort: 1, webPort: 1, openBrowser: false }));
    expect(Object.keys(handlers)).toHaveLength(35);
    for (const tool of Object.keys(handlers)) expect(guide).toContain(`\`${tool}\``);
    for (const term of ['mge.tools/2', 'docSession', 'STALE_SESSION', 'mge/requestId', 'project.story', 'story beats', 'product-launch', 'absolute value', 'cut mid-motion']) expect(guide).toContain(term);
  });
});
