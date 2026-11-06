import { describe, expect, it } from 'vitest';
import { fixtureProject } from '../core/__fixtures__/fixtureProject';
import { composition, element } from '../core/__fixtures__/schema2Project';
import type { Project } from '../core/types';
import { assetWarnings, collectAssetRefs, fontUses, groupWarnings } from './assets';

const project = (): Project => structuredClone(fixtureProject);

describe('asset diagnostics', () => {
  it('is quiet for a healthy project', () => {
    expect(assetWarnings(project())).toEqual([]);
  });

  it('reports missing and undecodable files once per affected reference, grouped per file', () => {
    const p = project();
    const logo = p.assets.ast_logo.src;
    const shot = p.assets.ast_screenshot.src;
    const warnings = assetWarnings(p, { missingSrc: new Set([logo]), undecodable: new Map([[shot, 'Not a PNG']]) });
    expect(warnings.map((w) => [w.owner.label, w.problem])).toEqual([
      ['Intro › Logo', 'missing'],
      ['Product › Screenshot', 'undecodable'],
      ['Outro › Logo', 'missing'],
    ]);
    expect(warnings[1].reason).toBe(`Can’t decode public/${shot}: Not a PNG`);
    const groups = groupWarnings(warnings);
    expect(groups.map((g) => [g.key, g.users.length])).toEqual([
      ['missing:ast_logo', 2],
      ['undecodable:ast_screenshot', 1],
    ]);
  });

  it('reports refs with no file or an unknown asset as separate problems', () => {
    const p = project();
    const intro = p.scenes[0].elements.find((e) => e.id === 'el_intro_logo')!;
    intro.props.assetId = '';
    p.audio[0].assetId = 'ast_gone';
    const groups = groupWarnings(assetWarnings(p));
    expect(groups.map((g) => g.problem)).toEqual(['noFile', 'unknownAsset']);
  });

  it('includes elements inside components, without a scene to select', () => {
    const p = project();
    p.compositions.cmp = composition('cmp', [element('in_logo', 'logo', { props: { assetId: 'ast_logo', fit: 'contain' } })]);
    const refs = collectAssetRefs(p).filter((r) => r.owner.kind === 'component');
    expect(refs).toEqual([{ key: 'in_logo.assetId', owner: { kind: 'component', compositionId: 'cmp', elementId: 'in_logo', label: 'Component cmp › in_logo' }, field: 'Logo file', assetId: 'ast_logo' }]);
  });

  it('maps failed font faces to the elements set in them', () => {
    const p = project();
    expect(fontUses(element('t', 'text', { props: { ...element('t', 'text').props, fontFamily: 'Space Grotesk', fontWeight: 500 } }))).toEqual([{ family: 'Space Grotesk', weight: 500 }]);
    expect(fontUses(element('s', 'shape'))).toEqual([]);
    const warnings = assetWarnings(p, { fontFailures: ['Inter 700'] });
    // Text in Inter 700 (the default) plus the chat bubbles / UI card, which are set in Inter.
    expect(warnings.every((w) => w.problem === 'font' && w.reason === 'Inter 700 did not load')).toBe(true);
    expect(warnings.map((w) => w.owner.label)).toContain('Product › Weekly brief card');
    expect(warnings.map((w) => w.owner.label)).not.toContain('Intro › Logo');
    expect(groupWarnings(warnings)).toHaveLength(1);
  });
});
