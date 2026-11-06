// Registered component property schemas. Pure data — no React — so the
// command validator, the inspector and the AI prompt builder all read the same
// definition. The visual implementation of each type lives in
// src/composition/elements/ and must honour exactly these props.

import type { AssetKind, ElementType } from './types';

export type FieldDescriptor = ({ optional?: true; animatable?: true } & (
  | { kind: 'text'; key: string; label: string; maxLength?: number }
  | { kind: 'multiline'; key: string; label: string; maxLength?: number }
  | { kind: 'number'; key: string; label: string; min: number; max: number; step: number; integer?: boolean }
  | { kind: 'color'; key: string; label: string; allowNone?: boolean }
  | { kind: 'select'; key: string; label: string; options: readonly { value: string | number; label: string }[] }
  | { kind: 'boolean'; key: string; label: string }
  | { kind: 'asset'; key: string; label: string; assetKinds: readonly AssetKind[] }
  | { kind: 'paint'; key: string; label: string; allowNone?: boolean }
  | { kind: 'pathNodes'; key: string; label: string }
  | { kind: 'composition'; key: string; label: string }));

export interface ComponentDefinition {
  type: ElementType;
  label: string;
  description: string;
  fields: readonly FieldDescriptor[];
  defaultProps: Record<string, unknown>;
  /** Default base size when inserted. */
  defaultSize: { width: number; height: number };
}

/** Fonts bundled locally (via @fontsource) so preview and export match exactly. */
export const FONT_FAMILIES = ['Inter', 'Space Grotesk', 'IBM Plex Mono', 'Fraunces', 'Archivo', 'Archivo Expanded', 'Archivo Narrow', 'Geist Mono'] as const;
export type FontFamily = (typeof FONT_FAMILIES)[number];

const fontFamilyField: FieldDescriptor = {
  kind: 'select',
  key: 'fontFamily',
  label: 'Font',
  options: FONT_FAMILIES.map((f) => ({ value: f, label: f })),
};

const fontWeightField: FieldDescriptor = {
  kind: 'select',
  key: 'fontWeight',
  label: 'Weight',
  options: [400, 500, 600, 700].map((w) => ({ value: w, label: String(w) })),
};

export const COMPONENTS: Record<ElementType, ComponentDefinition> = {
  path: {
    type: 'path', label: 'Path', description: 'Bezier path with box-relative nodes, paints and trim animation.', defaultSize: { width: 600, height: 400 },
    fields: [
      { kind: 'pathNodes', key: 'nodes', label: 'Nodes' },
      { kind: 'boolean', key: 'closed', label: 'Closed' },
      { kind: 'paint', key: 'fill', label: 'Fill', allowNone: true },
      { kind: 'paint', key: 'stroke', label: 'Stroke' },
      { kind: 'number', key: 'strokeWidth', label: 'Stroke width', min: 0, max: 200, step: 1, animatable: true },
      { kind: 'select', key: 'lineCap', label: 'Line cap', options: ['butt', 'round', 'square'].map(value => ({ value, label: value })) },
      { kind: 'select', key: 'lineJoin', label: 'Line join', options: ['miter', 'round', 'bevel'].map(value => ({ value, label: value })) },
      ...['trimStart', 'trimEnd', 'trimOffset'].map(key => ({ kind: 'number' as const, key, label: key, min: 0, max: 1, step: 0.01, animatable: true as const })),
    ],
    defaultProps: { nodes: [{ x: 0, y: 300, out: { x: 200, y: 300 } }, { x: 600, y: 100, in: { x: 400, y: 100 } }], closed: false, fill: 'none', stroke: '#F8FAFC', strokeWidth: 8, lineCap: 'round', lineJoin: 'round', trimStart: 0, trimEnd: 1, trimOffset: 0 },
  },
  group: { type: 'group', label: 'Group', description: 'Local coordinate and timing container; children are clipped to its lifetime.', defaultSize: { width: 600, height: 400 }, fields: [{ kind: 'boolean', key: 'clip', label: 'Clip' }], defaultProps: { clip: false } },
  instance: { type: 'instance', label: 'Instance', description: 'Playback of a reusable composition.', defaultSize: { width: 600, height: 400 }, fields: [{ kind: 'composition', key: 'compositionId', label: 'Composition' }, { kind: 'number', key: 'timeOffset', label: 'Time offset', min: -100000, max: 100000, step: 1, integer: true }, { kind: 'boolean', key: 'loop', label: 'Loop' }], defaultProps: { compositionId: '', timeOffset: 0, loop: false } },
  text: {
    type: 'text',
    label: 'Text',
    description: 'Headline, label or paragraph with an optional built-in reveal.',
    defaultSize: { width: 900, height: 160 },
    fields: [
      { kind: 'multiline', key: 'text', label: 'Text', maxLength: 500 },
      fontFamilyField,
      { kind: 'number', key: 'fontSize', label: 'Size', min: 8, max: 400, step: 1, integer: true, animatable: true },
      fontWeightField,
      { kind: 'color', key: 'color', label: 'Colour', animatable: true },
      {
        kind: 'select',
        key: 'align',
        label: 'Align',
        options: [
          { value: 'left', label: 'Left' },
          { value: 'center', label: 'Centre' },
          { value: 'right', label: 'Right' },
        ],
      },
      { kind: 'number', key: 'lineHeight', label: 'Line height', min: 0.6, max: 3, step: 0.05 },
      { kind: 'number', key: 'letterSpacing', label: 'Tracking (px)', min: -20, max: 40, step: 0.5, animatable: true },
      {
        kind: 'select',
        key: 'reveal',
        label: 'Reveal',
        options: [
          { value: 'none', label: 'None' },
          { value: 'fadeUp', label: 'Fade up' },
          { value: 'typewriter', label: 'Typewriter' },
          { value: 'wordStagger', label: 'Word stagger' },
          ...['charStagger', 'lineStagger', 'charFadeUp', 'scaleIn', 'blurIn'].map(value => ({ value, label: value })),
        ],
      },
      { kind: 'number', key: 'revealStagger', label: 'Stagger frames', min: 0, max: 30, step: 1, integer: true, optional: true },
      { kind: 'select', key: 'revealOrder', label: 'Reveal order', options: ['forward', 'reverse', 'center', 'edges'].map(value => ({ value, label: value })), optional: true },
      { kind: 'select', key: 'revealEasing', label: 'Reveal easing', options: ['linear', 'easeIn', 'easeOut', 'easeInOut', 'backOut', 'easeInCubic', 'easeOutCubic', 'easeInOutCubic', 'easeOutExpo', 'easeInOutExpo', 'hold'].map(value => ({ value, label: value })), optional: true },
      { kind: 'number', key: 'revealDurationInFrames', label: 'Reveal frames', min: 0, max: 300, step: 1, integer: true },
    ],
    defaultProps: {
      text: 'Headline',
      fontFamily: 'Inter',
      fontSize: 96,
      fontWeight: 700,
      color: '#FFFFFF',
      align: 'left',
      lineHeight: 1.1,
      letterSpacing: 0,
      reveal: 'fadeUp',
      revealDurationInFrames: 20,
      revealStagger: 2,
      revealOrder: 'forward',
      revealEasing: 'easeOut',
    },
  },
  shape: {
    type: 'shape',
    label: 'Shape',
    description: 'Rectangle or ellipse with fill, stroke and corner radius.',
    defaultSize: { width: 400, height: 400 },
    fields: [
      {
        kind: 'select',
        key: 'shape',
        label: 'Shape',
        options: [
          { value: 'rect', label: 'Rectangle' },
          { value: 'ellipse', label: 'Ellipse' },
        ],
      },
      { kind: 'paint', key: 'fill', label: 'Fill', allowNone: true, animatable: true },
      { kind: 'paint', key: 'stroke', label: 'Stroke', allowNone: true, animatable: true },
      { kind: 'number', key: 'strokeWidth', label: 'Stroke width', min: 0, max: 100, step: 1, animatable: true },
      { kind: 'number', key: 'cornerRadius', label: 'Corner radius', min: 0, max: 1000, step: 1, animatable: true },
    ],
    defaultProps: { shape: 'rect', fill: '#3B82F6', stroke: 'none', strokeWidth: 0, cornerRadius: 24 },
  },
  logo: {
    type: 'logo',
    label: 'SVG logo',
    description: 'Vector logo from an SVG asset.',
    defaultSize: { width: 400, height: 160 },
    fields: [
      { kind: 'asset', key: 'assetId', label: 'Logo file', assetKinds: ['svg'] },
      {
        kind: 'select',
        key: 'fit',
        label: 'Fit',
        options: [
          { value: 'contain', label: 'Contain' },
          { value: 'cover', label: 'Cover' },
        ],
      },
    ],
    defaultProps: { assetId: '', fit: 'contain' },
  },
  image: {
    type: 'image',
    label: 'Image',
    description: 'Raster image (PNG/JPEG/WebP) from an asset.',
    defaultSize: { width: 960, height: 540 },
    fields: [
      { kind: 'asset', key: 'assetId', label: 'Image file', assetKinds: ['image', 'svg'] },
      {
        kind: 'select',
        key: 'fit',
        label: 'Fit',
        options: [
          { value: 'cover', label: 'Cover' },
          { value: 'contain', label: 'Contain' },
        ],
      },
      { kind: 'number', key: 'cornerRadius', label: 'Corner radius', min: 0, max: 500, step: 1, animatable: true },
      { kind: 'boolean', key: 'shadow', label: 'Drop shadow' },
    ],
    defaultProps: { assetId: '', fit: 'cover', cornerRadius: 16, shadow: true },
  },
  uiCard: {
    type: 'uiCard',
    label: 'UI card',
    description: 'Product UI card with title, metric and list rows that build in.',
    defaultSize: { width: 640, height: 420 },
    fields: [
      { kind: 'text', key: 'title', label: 'Title', maxLength: 80 },
      { kind: 'text', key: 'subtitle', label: 'Subtitle', maxLength: 120 },
      { kind: 'text', key: 'metricLabel', label: 'Metric label', maxLength: 40 },
      { kind: 'text', key: 'metricValue', label: 'Metric value', maxLength: 24 },
      { kind: 'multiline', key: 'items', label: 'Rows (one per line)', maxLength: 400 },
      { kind: 'color', key: 'accentColor', label: 'Accent', animatable: true },
      { kind: 'color', key: 'background', label: 'Background', animatable: true },
      { kind: 'color', key: 'textColor', label: 'Text colour', animatable: true },
      { kind: 'number', key: 'cornerRadius', label: 'Corner radius', min: 0, max: 120, step: 1 },
      {
        kind: 'select',
        key: 'buildIn',
        label: 'Build-in',
        options: [
          { value: 'none', label: 'None' },
          { value: 'stagger', label: 'Stagger rows' },
        ],
      },
    ],
    defaultProps: {
      title: 'Dashboard',
      subtitle: 'Last 30 days',
      metricLabel: 'Revenue',
      metricValue: '$48.2k',
      items: 'First row\nSecond row\nThird row',
      accentColor: '#22C55E',
      background: '#111827',
      textColor: '#F9FAFB',
      cornerRadius: 28,
      buildIn: 'stagger',
    },
  },
  chatBubble: {
    type: 'chatBubble',
    label: 'Chat bubble',
    description: 'Message bubble with optional typing indicator before the text appears.',
    defaultSize: { width: 720, height: 160 },
    fields: [
      { kind: 'multiline', key: 'text', label: 'Message', maxLength: 400 },
      {
        kind: 'select',
        key: 'sender',
        label: 'Side',
        options: [
          { value: 'user', label: 'User (right)' },
          { value: 'assistant', label: 'Assistant (left)' },
        ],
      },
      { kind: 'text', key: 'senderName', label: 'Sender name', maxLength: 40 },
      { kind: 'color', key: 'bubbleColor', label: 'Bubble', animatable: true },
      { kind: 'color', key: 'textColor', label: 'Text colour', animatable: true },
      { kind: 'number', key: 'fontSize', label: 'Size', min: 12, max: 120, step: 1, integer: true },
      { kind: 'boolean', key: 'typing', label: 'Typing indicator first' },
      { kind: 'number', key: 'typingDurationInFrames', label: 'Typing frames', min: 0, max: 300, step: 1, integer: true },
    ],
    defaultProps: {
      text: 'Hello!',
      sender: 'assistant',
      senderName: 'Assistant',
      bubbleColor: '#1F2937',
      textColor: '#F9FAFB',
      fontSize: 36,
      typing: true,
      typingDurationInFrames: 24,
    },
  },
  video: {
    type: 'video',
    label: 'Video',
    description: 'Video clip from an uploaded file (MP4, WebM or MOV): trim in-point, speed, volume, loop and fit. Its soundtrack plays with it unless muted or detached.',
    defaultSize: { width: 960, height: 540 },
    fields: [
      { kind: 'asset', key: 'assetId', label: 'Video file', assetKinds: ['video'] },
      { kind: 'number', key: 'trimStartFrames', label: 'Trim in', min: 0, max: 10_000_000, step: 1, integer: true },
      { kind: 'number', key: 'playbackRate', label: 'Speed', min: 0.25, max: 4, step: 0.05 },
      { kind: 'number', key: 'volume', label: 'Volume', min: 0, max: 1, step: 0.01, animatable: true },
      { kind: 'boolean', key: 'muted', label: 'Muted' },
      { kind: 'boolean', key: 'loop', label: 'Loop' },
      {
        kind: 'select',
        key: 'fit',
        label: 'Fit',
        options: [
          { value: 'cover', label: 'Cover' },
          { value: 'contain', label: 'Contain' },
        ],
      },
      { kind: 'number', key: 'cornerRadius', label: 'Corner radius', min: 0, max: 1000, step: 1, animatable: true },
    ],
    defaultProps: { assetId: '', trimStartFrames: 0, playbackRate: 1, volume: 1, muted: false, loop: false, fit: 'cover', cornerRadius: 0 },
  },
};

/** Element types offered to users and agents (insert lists, the agent guide). */
export const ELEMENT_TYPES = Object.keys(COMPONENTS) as ElementType[];

export function getComponent(type: ElementType): ComponentDefinition {
  return COMPONENTS[type];
}

/** Timing maxima represent the same seconds at every project frame rate. */
export function componentFields(type: ElementType, fps: number): readonly FieldDescriptor[] {
  return COMPONENTS[type].fields.map(field => field.kind === 'number' && ['revealStagger', 'revealDurationInFrames', 'typingDurationInFrames'].includes(field.key)
    ? { ...field, max: Math.round(field.max * fps / 30) }
    : field);
}
