import { describe, expect, it } from 'vitest';
import { fixtureProject } from './__fixtures__/fixtureProject';
import { createDocState, execute } from './history';
import { affectedRange, checkProposal, describeProposal, listNames, type Proposal } from './proposal';
import { PATCH_PROTOCOL, type AiPatch, type Command, type DocState } from './types';

const fresh = () => createDocState(structuredClone(fixtureProject));

function run(doc: DocState, command: Command): DocState {
  const r = execute(doc, command);
  if (!r.ok) throw new Error(r.error.message);
  return r.state;
}

const headlinePatch = (doc: DocState, over: Partial<AiPatch> = {}): AiPatch => ({
  protocol: PATCH_PROTOCOL,
  projectId: doc.project.id,
  baseRevision: doc.project.revision,
  summary: 'Bigger headline',
  targets: [{ sceneId: 'scn_intro', elementId: 'el_intro_headline' }],
  commands: [{ type: 'updateElement', sceneId: 'scn_intro', elementId: 'el_intro_headline', changes: { props: { fontSize: 120 } } }],
  ...over,
});

const proposal = (patch: AiPatch, over: Partial<Proposal> = {}): Proposal => ({
  id: 'prop_1',
  projectId: patch.projectId,
  docSession: 's1',
  patch,
  agent: 'Codex',
  source: 'mcp',
  reconcile: true,
  createdAt: 0,
  ...over,
});

const el = (doc: { scenes: DocState['project']['scenes'] }, sceneId: string, elementId: string) => doc.scenes.find((s) => s.id === sceneId)!.elements.find((e) => e.id === elementId)!;

describe('checkProposal', () => {
  it('is ready with the candidate, its diff and the revision label, and leaves the document alone', () => {
    const doc = fresh();
    const c = checkProposal(doc, proposal(headlinePatch(doc)));
    expect(c.status).toBe('ready');
    if (c.status !== 'ready') return;
    expect(el(c.candidate, 'scn_intro', 'el_intro_headline').props.fontSize).toBe(120);
    expect(c.candidate.revision).toBe(doc.project.revision);
    expect(c.diff.map((d) => d.path)).toEqual(['props.fontSize']);
    expect(c.label).toBe('Codex: Bigger headline');
    expect(el(doc.project, 'scn_intro', 'el_intro_headline').props.fontSize).toBe(104);
  });

  it('keeps an unrelated user edit in the candidate after the document moved on', () => {
    let doc = fresh();
    const p = proposal(headlinePatch(doc));
    doc = run(doc, { type: 'updateElement', sceneId: 'scn_outro', elementId: 'el_outro_url', changes: { props: { text: 'relay.dev' } } });
    const c = checkProposal(doc, p);
    expect(c.status).toBe('ready');
    if (c.status !== 'ready') return;
    expect(el(c.candidate, 'scn_outro', 'el_outro_url').props.text).toBe('relay.dev');
    expect(el(c.candidate, 'scn_intro', 'el_intro_headline').props.fontSize).toBe(120);
    expect(c.diff.map((d) => d.path)).toEqual(['props.fontSize']);
  });

  it('goes stale, naming the conflict, when the user edits a target', () => {
    let doc = fresh();
    const p = proposal(headlinePatch(doc));
    doc = run(doc, { type: 'updateElement', sceneId: 'scn_intro', elementId: 'el_intro_headline', changes: { props: { text: 'Mine' } } });
    const c = checkProposal(doc, p);
    expect(c.status).toBe('stale');
    if (c.status !== 'stale') return;
    expect(c.error.code).toBe('STALE');
    expect(c.conflicts).toEqual([{ sceneId: 'scn_intro', elementId: 'el_intro_headline' }]);
  });

  it('is stale without reconcile when the patch was written against an older revision', () => {
    let doc = fresh();
    const patch = headlinePatch(doc);
    doc = run(doc, { type: 'updateProject', changes: { name: 'Renamed' } });
    expect(checkProposal(doc, proposal(patch, { reconcile: false })).status).toBe('stale');
    expect(checkProposal(doc, proposal(patch, { reconcile: true })).status).toBe('ready');
  });

  it('is invalid for a locked target, another project, an out-of-scope command or a bad value', () => {
    let doc = fresh();
    doc = run(doc, { type: 'setSceneLock', sceneId: 'scn_intro', locked: true });
    const locked = checkProposal(doc, proposal(headlinePatch(doc)));
    expect(locked.status === 'invalid' && locked.error.code).toBe('LOCKED');

    const other = fresh();
    const wrong = checkProposal(other, proposal(headlinePatch(other, { projectId: 'prj_other' })));
    expect(wrong.status === 'invalid' && wrong.error.code).toBe('PROJECT_MISMATCH');

    const scope = checkProposal(other, proposal(headlinePatch(other, { targets: [{ sceneId: 'scn_intro', elementId: 'el_intro_sub' }] })));
    expect(scope.status === 'invalid' && scope.error.code).toBe('OUT_OF_SCOPE');

    const bad = checkProposal(
      other,
      proposal(headlinePatch(other, { commands: [{ type: 'updateElement', sceneId: 'scn_intro', elementId: 'el_intro_headline', changes: { props: { fontSize: -5 } } }] })),
    );
    expect(bad.status).toBe('invalid');
  });
});

describe('affectedRange', () => {
  it('spans the touched element in global frames', () => {
    const doc = fresh();
    const c = checkProposal(doc, proposal(headlinePatch(doc)));
    if (c.status !== 'ready') throw new Error('not ready');
    // Headline: Intro starts at 0, element from frame 20 for 190 frames.
    expect(affectedRange(doc.project, c.candidate, c.touched)).toEqual({ start: 20, end: 209 });
  });

  it('unions both documents when a change moves an element, and offsets by the scene start', () => {
    const doc = fresh();
    const patch = headlinePatch(doc, {
      summary: 'Later answer',
      targets: [{ sceneId: 'scn_product', elementId: 'el_product_chat_ai' }],
      commands: [{ type: 'updateElement', sceneId: 'scn_product', elementId: 'el_product_chat_ai', changes: { startFrame: 200, durationInFrames: 60 } }],
    });
    const c = checkProposal(doc, proposal(patch));
    if (c.status !== 'ready') throw new Error('not ready');
    // Product starts at 210; the answer was 160..269 and becomes 200..259 (scene-relative).
    expect(affectedRange(doc.project, c.candidate, c.touched)).toEqual({ start: 370, end: 479 });
  });

  it('covers a whole scene for scene changes', () => {
    const doc = fresh();
    const patch = headlinePatch(doc, {
      summary: 'Longer outro',
      targets: [{ sceneId: 'scn_outro' }],
      commands: [{ type: 'updateScene', sceneId: 'scn_outro', changes: { durationInFrames: 300 } }],
    });
    const c = checkProposal(doc, proposal(patch));
    if (c.status !== 'ready') throw new Error('not ready');
    // Outro starts at 480 and grows from 240 to 300 frames.
    expect(affectedRange(doc.project, c.candidate, c.touched)).toEqual({ start: 480, end: 779 });
  });

  it('clamps to the candidate’s length', () => {
    const candidate = structuredClone(fixtureProject);
    candidate.scenes[2].durationInFrames = 120;
    // Outro was 480..719 and becomes 480..599: the candidate ends at 599.
    expect(affectedRange(fixtureProject, candidate, [{ kind: 'scene', sceneId: 'scn_outro' }])).toEqual({ start: 480, end: 599 });
  });

  it('falls back to the whole project for project-level or off-screen changes', () => {
    const p = fixtureProject;
    expect(affectedRange(p, p, [{ kind: 'project' }])).toEqual({ start: 0, end: 719 });
    expect(affectedRange(p, p, [{ kind: 'asset', assetId: 'ast_logo' }])).toEqual({ start: 0, end: 719 });
    expect(affectedRange(p, p, [])).toEqual({ start: 0, end: 719 });
  });
});

describe('describeProposal', () => {
  it('summarises the changes and names the scene › layer targets', () => {
    const doc = fresh();
    const patch = headlinePatch(doc, {
      targets: [{ sceneId: 'scn_intro' }],
      commands: [
        { type: 'updateElement', sceneId: 'scn_intro', elementId: 'el_intro_headline', changes: { props: { fontSize: 120, color: '#FFD8A8' } } },
        { type: 'setKeyframe', sceneId: 'scn_intro', elementId: 'el_intro_logo', property: 'scale', frame: 0, value: 0.8 },
      ],
    });
    const c = checkProposal(doc, proposal(patch));
    if (c.status !== 'ready') throw new Error('not ready');
    expect(describeProposal(c.diff, c.candidate)).toEqual({
      headline: '3 changes to Logo and Headline in “Intro”',
      targets: ['Intro › Logo', 'Intro › Headline'],
      refs: [
        { sceneId: 'scn_intro', elementId: 'el_intro_logo' },
        { sceneId: 'scn_intro', elementId: 'el_intro_headline' },
      ],
    });
  });

  it('describes scene-level, multi-scene and removed things', () => {
    const p = fixtureProject;
    const intro = p.scenes[0];
    expect(describeProposal([{ kind: 'scene', sceneId: 'scn_intro', label: '', path: 'backgroundColor', change: 'modified', before: '#000', after: '#111' }], p)).toEqual({
      headline: '1 change to scene “Intro”',
      targets: ['Intro'],
      refs: [{ sceneId: 'scn_intro' }],
    });
    const removed = {
      kind: 'element' as const,
      sceneId: 'scn_intro',
      elementId: 'el_gone',
      label: '',
      path: '',
      change: 'removed' as const,
      before: { ...intro.elements[0], id: 'el_gone', name: 'Old glow' },
    };
    const outro = { kind: 'element' as const, sceneId: 'scn_outro', elementId: 'el_outro_url', label: '', path: 'props.text', change: 'modified' as const, before: 'a', after: 'b' };
    expect(describeProposal([removed, outro], p)).toMatchObject({ headline: '2 changes across “Intro” and “Outro”', targets: ['Intro › Old glow', 'Outro › URL'] });
  });

  it('lists names compactly', () => {
    expect(listNames(['A'])).toBe('A');
    expect(listNames(['A', 'B'])).toBe('A and B');
    expect(listNames(['A', 'B', 'C'])).toBe('A, B and C');
    expect(listNames(['A', 'B', 'C', 'D'])).toBe('A, B and 2 more');
  });
});
