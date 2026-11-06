import { describe, expect, it } from 'vitest';
import { blankProject } from '../core/newProject';
import { STYLE_PACKS } from '../core/style';
import { createElement } from './doc';

describe('createElement', () => {
  it('takes the style pack’s text colour for light default colours, so text reads on the Paper plate', () => {
    const project = blankProject({ project: 'prj_p', scene: 'scn_1' });
    const text = createElement(project, project.scenes[0], 'text');
    expect(text.props.color).toBe(STYLE_PACKS.paper.colors.text);
    const path = createElement(project, project.scenes[0], 'path');
    for (const [k, v] of Object.entries(path.props)) if (typeof v === 'string' && /^#(FFFFFF|F8FAFC)$/i.test(v)) throw new Error(`${k} is still ${v}`);
  });

  it('leaves cards and bubbles alone: they carry their own dark plate', () => {
    const project = blankProject({ project: 'prj_p', scene: 'scn_1' });
    const card = createElement(project, project.scenes[0], 'uiCard');
    expect(Object.values(card.props).some((v) => v === STYLE_PACKS.paper.colors.text)).toBe(false);
  });

  it('leaves default colours alone on a project without a style pack', () => {
    const { style: _style, ...project } = blankProject({ project: 'prj_n', scene: 'scn_1' });
    const text = createElement(project, project.scenes[0], 'text');
    expect(text.props.color).toBe('#FFFFFF');
  });
});
