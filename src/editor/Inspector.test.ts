import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { element, project } from '../core/__fixtures__/schema2Project';
import { createDocState } from '../core/history';
import { Inspector } from './Inspector';
import type { InspectorTab } from './inspectorView';
import { useEditor } from './store';

// Render the current test document without a browser subscription. Zustand's
// server hook otherwise reads the boot document captured when the store loaded.
vi.mock('./store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./store')>();
  type State = ReturnType<typeof actual.useEditor.getState>;
  return {
    ...actual,
    useEditor: Object.assign(<T>(select: (state: State) => T) => select(actual.useEditor.getState()), actual.useEditor),
    useCurrentScene: () => {
      const s = actual.useEditor.getState();
      return s.doc.project.scenes.find((scene) => scene.id === s.selection.sceneId) ?? null;
    },
  };
});

const render = (tab: InspectorTab, query: string) => renderToStaticMarkup(createElement(Inspector, { tab, query }));

beforeEach(() => {
  useEditor.getState().loadDocument(createDocState(project([element('text', 'text'), element('chat', 'chatBubble')])), { kind: 'sample' });
  useEditor.getState().selectElement('s', 'text');
});

describe('inspector cross-tab search', () => {
  it.each(['design', 'animate', 'scene'] as const)('finds Design and Animate fields from %s', (tab) => {
    expect(render(tab, 'font size')).toContain('data-testid="inspector-field-fontSize"');
    expect(render(tab, 'reveal order')).toContain('data-testid="inspector-field-revealOrder"');
  });

  it.each(['design', 'animate', 'scene'] as const)('provides scene fallback results from %s when no element field matches', (tab) => {
    const html = render(tab, 'entrance');
    const elementResults = html.split('class="inspector-element-results"')[1].split('class="inspector-scene-results"')[0];
    expect(elementResults).not.toContain('data-field=');
    expect(html).toContain('data-testid="inspector-field-transitionType"');
  });

  it('searches the scene with nothing selected', () => {
    useEditor.getState().selectElement('s', null);
    expect(render('design', 'entrance')).toContain('data-testid="inspector-field-transitionType"');
  });

  it('keeps the chosen tab when the query is blank', () => {
    expect(render('scene', '  ')).not.toContain('data-testid="inspector-field-fontSize"');
    expect(render('design', '')).toContain('data-testid="inspector-field-fontSize"');
  });
});

describe('component field search metadata', () => {
  it.each(['typing indicator', 'indicator first', 'typing'])('finds the chat checkbox by "%s"', (query) => {
    useEditor.getState().selectElement('s', 'chat');
    const html = render('scene', query);
    expect(html).toContain('data-testid="inspector-field-typing"');
    expect(html).toContain('Indicator first');
  });

  it('keeps the checkbox filtered out for an unrelated query', () => {
    useEditor.getState().selectElement('s', 'chat');
    expect(render('design', 'font size')).not.toContain('data-testid="inspector-field-typing"');
  });
});
