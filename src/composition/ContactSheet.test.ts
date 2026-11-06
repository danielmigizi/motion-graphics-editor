import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { element, project } from '../core/__fixtures__/schema2Project';
import { sampleProject } from '../sample/sampleProject';
import { ContactSheet, type ContactSheetProps } from './ContactSheet';
import { contactSheetLayout } from './contact-sheet-layout';
import { NATIVE_MEDIA } from '../runtime/media';
import { Readiness } from '../runtime/readiness';
import { RuntimeRoot } from '../runtime/RuntimeRoot';

/** Static markup of a contact sheet as the render page hosts it (frame 0; every cell frozen). */
const sheetHtml = (props: ContactSheetProps, width: number, height: number) =>
  renderToStaticMarkup(
    React.createElement(RuntimeRoot, {
      frame: 0,
      config: { width, height, fps: props.project.fps, durationInFrames: 1 },
      environment: { isRendering: true, isPlayer: false },
      delay: new Readiness(),
      media: NATIVE_MEDIA,
      children: React.createElement(ContactSheet, props),
    }),
  );

describe('contact sheet composition', () => {
  it('freezes MainComposition Sequences at global frames across all three scenes', () => {
    const props = { project: sampleProject, assetBaseUrl: '/', frames: [30, 150, 240, 420, 510, 690], columns: 3, labels: true };
    const { width, height } = contactSheetLayout(props);
    const html = sheetHtml(props, width, height);
    expect(html.match(/data-scene-id="scn_intro"/g)).toHaveLength(2);
    expect(html.match(/data-scene-id="scn_product"/g)).toHaveLength(2);
    expect(html.match(/data-scene-id="scn_outro"/g)).toHaveLength(2);
    for (const caption of ['0:01:00', '0:05:00', '0:08:00', '0:14:00', '0:17:00', '0:23:00']) expect(html).toContain(caption);
  });
});


it('uses project dimensions for masks in a labelled, scaled contact-sheet cell', () => {
  const box = { x: 0, y: 0, width: 50, height: 50, rotation: 0, scale: 1, opacity: 1 };
  const p = { ...project([element('m', 'shape', { transform: box }), element('t', 'shape', { transform: box, mask: { sourceId: 'm', mode: 'alpha' } })]), width: 1920, height: 1080 };
  const props = { project: p, assetBaseUrl: '/', frames: [0], columns: 1, scale: 0.1, labels: true };
  const { width, height } = contactSheetLayout(props);
  const html = sheetHtml(props, width, height);
  const matte = /data-matte-for="t" style="([^"]*)"/.exec(html)?.[1];
  expect(matte).toContain('width:1920px;height:1080px;');
});
