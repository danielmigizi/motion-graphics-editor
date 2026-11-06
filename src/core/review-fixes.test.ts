import { describe, expect, it } from 'vitest';
import { composition, element, project } from './__fixtures__/schema2Project';
import { COMPONENTS, componentFields } from './components';
import { applyCommand } from './commands';
import { createDocState, execute } from './history';
import { affectedRange, checkProposal, type Proposal } from './proposal';
import { PATCH_PROTOCOL, type Command, type Project } from './types';
import { validateProject } from './validate';
import { buildTemplate } from './templates';

function apply(p: Project, command: Command) {
  const result = applyCommand(p, command, { source: 'user' });
  if (!result.ok) throw new Error(result.error.message);
  return result;
}
const format: Command = { type: 'changeFormat', width: 2000, height: 1200, fps: 30, conversion: { layout: 'fit', timing: 'keepFrames' } };

describe('schema regressions', () => {
  it('exposes the same FPS-aware field bounds for editor controls and validation', () => {
    expect(componentFields('text', 30)).toEqual(COMPONENTS.text.fields);
    for (const fps of [24, 60, 120]) {
      const stagger = componentFields('text', fps).find(f => f.key === 'revealStagger');
      const reveal = componentFields('text', fps).find(f => f.key === 'revealDurationInFrames');
      const typing = componentFields('chatBubble', fps).find(f => f.key === 'typingDurationInFrames');
      expect(stagger).toMatchObject({ max: fps });
      expect(reveal).toMatchObject({ max: 10 * fps });
      expect(typing).toMatchObject({ max: 10 * fps });
    }
    expect(COMPONENTS.text.fields.find(f => f.key === 'revealStagger')).toMatchObject({ max: 30 });
  });

  it('makes a reconciled element proposal stale after format conversion', () => {
    const p = project([element('a')]);
    p.scenes[0].elements[0].transform.x = 100;
    const doc = createDocState(p);
    const proposal: Proposal = { id: 'proposal', projectId: p.id, docSession: 'session', agent: 'Codex', source: 'mcp', reconcile: true, createdAt: 0,
      patch: { protocol: PATCH_PROTOCOL, projectId: p.id, baseRevision: p.revision, summary: 'Move', targets: [{ sceneId: 's', elementId: 'a' }], commands: [{ type: 'updateElement', sceneId: 's', elementId: 'a', changes: { transform: { x: 120 } } }] } };
    const converted = execute(doc, format);
    if (!converted.ok) throw new Error(converted.error.message);
    expect(converted.state.project.scenes[0].elements[0].transform.x).toBe(200);
    expect(checkProposal(converted.state, proposal).status).toBe('stale');
    expect(converted.state.revisions.at(-1)!.touched).toContainEqual({ kind: 'scene', sceneId: 's' });
  });

  it.each([undefined, 'outer'])('ungroups at the moved group paint position (parent %s)', (parentId) => {
    const group = element('g', 'group', { parentId });
    const a = element('a', 'shape', { parentId: 'g' });
    const b = element('b', 'shape', { parentId: 'g' });
    const sibling = element('sibling', 'shape', { parentId });
    let p = project([...(parentId ? [element(parentId, 'group')] : []), group, a, b, sibling]);
    p = apply(p, { type: 'moveElement', sceneId: 's', elementId: 'g', toIndex: p.scenes[0].elements.length - 1 }).project;
    const ungrouped = apply(p, { type: 'ungroup', sceneId: 's', groupId: 'g' }).project;
    expect(ungrouped.scenes[0].elements.filter(e => e.parentId === parentId).map(e => e.id)).toEqual(['sibling', 'a', 'b']);
  });

  it('offsets grouped child spans and clips to each ancestor lifetime', () => {
    const p = project([element('g', 'group', { startFrame: 60, durationInFrames: 40 }), element('a', 'shape', { parentId: 'g', startFrame: 10, durationInFrames: 20 })]);
    const refs = [{ kind: 'element' as const, sceneId: 's', elementId: 'a' }];
    expect(affectedRange(p, p, refs)).toEqual({ start: 70, end: 89 });
    p.scenes[0].elements[0].durationInFrames = 15;
    expect(affectedRange(p, p, refs)).toEqual({ start: 70, end: 74 });
    p.scenes[0].elements.push(element('inner', 'group', { parentId: 'g', startFrame: 5, durationInFrames: 20 }));
    p.scenes[0].elements[1].parentId = 'inner';
    p.scenes[0].elements[0].durationInFrames = 40;
    expect(affectedRange(p, p, refs)).toEqual({ start: 75, end: 84 });
    p.scenes.unshift({ ...p.scenes[0], id: 'earlier', elements: [] });
    expect(affectedRange(p, p, refs)).toEqual({ start: 175, end: 184 });
  });

  it.each([24, 60, 120])('preserves valid text and typing seconds at %i fps', fps => {
    const text = element('text', 'text');
    text.props.revealStagger = 30;
    text.props.revealDurationInFrames = 300;
    const chat = element('chat', 'chatBubble');
    chat.props.typingDurationInFrames = 300;
    const p = project([text, chat]);
    const converted = apply(p, { type: 'changeFormat', width: p.width, height: p.height, fps, conversion: { layout: 'none', timing: 'keepSeconds' } }).project;
    expect(converted.scenes[0].elements[0].props.revealStagger).toBe(fps);
    expect(converted.scenes[0].elements[0].props.revealDurationInFrames).toBe(10 * fps);
    expect(converted.scenes[0].elements[1].props.typingDurationInFrames).toBe(10 * fps);
    expect(validateProject(converted).ok).toBe(true);
    converted.scenes[0].elements[0].props.revealStagger = fps + 1;
    expect(validateProject(converted).ok).toBe(false);
  });

  it.each([1, 30])('compressed chat replies display text with %i frames remaining', remaining => {
    const p = project([]);
    const built = buildTemplate('chatExchange', {}, { project: p, sceneId: 's', at: 100 - remaining });
    if (!built.ok) throw new Error(built.message);
    const replies = built.elements.filter(e => e.type === 'chatBubble' && Number(e.props.typingDurationInFrames) > 0);
    for (const reply of built.elements.filter(e => e.type === 'chatBubble')) {
      expect(Number(reply.props.typingDurationInFrames)).toBeLessThan(reply.durationInFrames);
    }
    if (remaining === 30) expect(replies.length).toBeGreaterThan(0);
  });

  it.each([8, 9])('validates composition instance chain length %i against renderer limit', depth => {
    const instance = (id: string, cid: string) => element(id, 'instance', { props: { compositionId: cid, timeOffset: 0, loop: false } });
    const p = project([instance('root', 'c0')]);
    for (let i = 0; i < depth; i++) p.compositions[`c${i}`] = composition(`c${i}`, i === depth - 1 ? [element('leaf')] : [instance(`i${i}`, `c${i + 1}`)]);
    expect(validateProject(p).ok).toBe(depth === 8);
  });
});
