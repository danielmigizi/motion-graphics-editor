// Sample project: 24 s at 30 fps, three scenes, text, SVG logo, image,
// animated UI card, chat bubbles, music bed and a scene-anchored sound effect.
//
// IDs below are part of the test/verification contract — keep them stable.

import { COMPONENTS } from '../core/components';
import type { AnimationTrack, Element, ElementType, Project, Transform } from '../core/types';

const FPS = 30;

function el(
  id: string,
  type: ElementType,
  name: string,
  transform: Partial<Transform> & Pick<Transform, 'x' | 'y' | 'width' | 'height'>,
  props: Record<string, unknown>,
  timing: { startFrame: number; durationInFrames: number },
  tracks: AnimationTrack[] = [],
): Element {
  return {
    id,
    type,
    name,
    startFrame: timing.startFrame,
    durationInFrames: timing.durationInFrames,
    visible: true,
    transform: { rotation: 0, scale: 1, opacity: 1, ...transform },
    props: { ...COMPONENTS[type].defaultProps, ...props },
    tracks,
  };
}

const fadeIn = (frames = 15): AnimationTrack => ({
  property: 'opacity',
  keyframes: [
    { frame: 0, value: 0, easing: 'easeOut' },
    { frame: frames, value: 1, easing: 'linear' },
  ],
});

const slideUp = (distance = 60, frames = 20): AnimationTrack => ({
  property: 'y',
  keyframes: [
    { frame: 0, value: distance, easing: 'easeOut' },
    { frame: frames, value: 0, easing: 'linear' },
  ],
});

// Palette: one indigo accent family on deep navy.
const C = {
  canvas: '#080B14',
  scene: '#0A0E1A',
  sceneAlt: '#0B1020',
  text: '#F4F6FB',
  muted: '#9AA5C0',
  accent: '#5C7CFA',
  accentDeep: '#3B5BDB',
  accentSoft: '#A5B4FC',
  surface: '#10162A',
  surfaceAlt: '#182038',
};

export const sampleProject: Project = {
  schemaVersion: 3,
  id: 'prj_sample',
  name: 'Relay launch demo',
  revision: 1,
  fps: FPS,
  width: 1920,
  height: 1080,
  backgroundColor: C.canvas,
  assets: {
    ast_logo: { id: 'ast_logo', kind: 'svg', name: 'Relay logo', src: 'assets/logo.svg', mimeType: 'image/svg+xml', width: 480, height: 140 },
    ast_screenshot: { id: 'ast_screenshot', kind: 'image', name: 'Product screenshot', src: 'assets/product-screenshot.png', mimeType: 'image/png', width: 1600, height: 1000 },
    ast_music: { id: 'ast_music', kind: 'audio', name: 'Music bed', src: 'assets/music-bed.wav', mimeType: 'audio/wav', durationInFrames: 24 * FPS },
    ast_whoosh: { id: 'ast_whoosh', kind: 'audio', name: 'Whoosh', src: 'assets/whoosh.wav', mimeType: 'audio/wav', durationInFrames: 20 },
  },
  scenes: [
    {
      id: 'scn_intro',
      name: 'Intro',
      durationInFrames: 7 * FPS,
      backgroundColor: C.scene,
      locked: false,
      transitionIn: { type: 'fade', durationInFrames: 12 },
      elements: [
        el('el_intro_glow', 'shape', 'Glow', { x: 410, y: -10, width: 1100, height: 1100, opacity: 0.6 }, { shape: 'ellipse', fill: 'none', stroke: C.accent, strokeWidth: 2, cornerRadius: 0 }, { startFrame: 0, durationInFrames: 210 }, [
          { property: 'scale', keyframes: [{ frame: 0, value: 0.7, easing: 'easeOut' }, { frame: 120, value: 1, easing: 'linear' }] },
          fadeIn(40),
        ]),
        el('el_intro_logo', 'logo', 'Logo', { x: 780, y: 285, width: 360, height: 105 }, { assetId: 'ast_logo' }, { startFrame: 0, durationInFrames: 210 }, [fadeIn(20), slideUp(32, 26)]),
        el('el_intro_headline', 'text', 'Headline', { x: 260, y: 441, width: 1400, height: 250 }, { text: 'Updates your team\nactually reads', fontSize: 120, lineHeight: 1.02, letterSpacing: -3, color: C.text, align: 'center', reveal: 'wordStagger', revealDurationInFrames: 34 }, { startFrame: 20, durationInFrames: 190 }),
        el('el_intro_sub', 'text', 'Subhead', { x: 460, y: 739, width: 1000, height: 56 }, { text: 'Relay turns release notes into a two-minute brief.', fontSize: 38, fontWeight: 400, lineHeight: 1.3, color: C.muted, align: 'center', reveal: 'fadeUp', revealDurationInFrames: 22 }, { startFrame: 60, durationInFrames: 150 }),
      ],
    },
    {
      id: 'scn_product',
      name: 'Product',
      durationInFrames: 9 * FPS,
      backgroundColor: C.sceneAlt,
      locked: false,
      transitionIn: { type: 'slide', durationInFrames: 15 },
      elements: [
        el('el_product_headline', 'text', 'Headline', { x: 140, y: 140, width: 1040, height: 84 }, { text: 'Every change, summarised', fontSize: 64, lineHeight: 1.1, letterSpacing: -1.5, color: C.text, reveal: 'fadeUp', revealDurationInFrames: 20 }, { startFrame: 0, durationInFrames: 270 }),
        el('el_product_image', 'image', 'Screenshot', { x: 140, y: 278, width: 1040, height: 650 }, { assetId: 'ast_screenshot', fit: 'cover', cornerRadius: 18, shadow: true }, { startFrame: 10, durationInFrames: 260 }, [fadeIn(18), slideUp(70, 30)]),
        el('el_product_card', 'uiCard', 'Weekly brief card', { x: 1240, y: 278, width: 540, height: 366 }, { title: 'Weekly brief', subtitle: 'Platform team · Week 41', metricLabel: 'Read rate', metricValue: '92%', items: 'Billing retries shipped\nSearch latency −38%\nSSO onboarding live', accentColor: C.accent, background: C.surface, textColor: C.text, cornerRadius: 22, buildIn: 'stagger' }, { startFrame: 40, durationInFrames: 230 }, [fadeIn(14), { property: 'x', keyframes: [{ frame: 0, value: 80, easing: 'easeOut' }, { frame: 22, value: 0, easing: 'linear' }] }]),
        el('el_product_chat_user', 'chatBubble', 'Chat — question', { x: 1240, y: 690, width: 540, height: 100 }, { text: 'What changed in billing?', sender: 'user', senderName: 'Maya', bubbleColor: C.accentDeep, textColor: C.text, fontSize: 28, typing: false }, { startFrame: 120, durationInFrames: 150 }, [fadeIn(10), slideUp(24, 12)]),
        el('el_product_chat_ai', 'chatBubble', 'Chat — answer', { x: 1240, y: 802, width: 540, height: 140 }, { text: 'Failed payments now retry automatically for 72 hours.', sender: 'assistant', senderName: 'Relay', bubbleColor: C.surfaceAlt, textColor: C.text, fontSize: 28, typing: true, typingDurationInFrames: 30 }, { startFrame: 160, durationInFrames: 110 }, [fadeIn(10), slideUp(24, 12)]),
      ],
    },
    {
      id: 'scn_outro',
      name: 'Outro',
      durationInFrames: 8 * FPS,
      backgroundColor: C.scene,
      locked: false,
      transitionIn: { type: 'fade', durationInFrames: 15 },
      elements: [
        el('el_outro_logo', 'logo', 'Logo', { x: 750, y: 357, width: 420, height: 122 }, { assetId: 'ast_logo' }, { startFrame: 0, durationInFrames: 240 }, [
          fadeIn(20),
          { property: 'scale', keyframes: [{ frame: 0, value: 0.88, easing: 'backOut' }, { frame: 30, value: 1, easing: 'linear' }] },
        ]),
        el('el_outro_headline', 'text', 'Headline', { x: 360, y: 539, width: 1200, height: 96 }, { text: 'Start your free trial', fontSize: 80, lineHeight: 1.1, letterSpacing: -2, color: C.text, align: 'center', reveal: 'fadeUp', revealDurationInFrames: 22 }, { startFrame: 30, durationInFrames: 210 }),
        el('el_outro_url', 'text', 'URL', { x: 560, y: 667, width: 800, height: 56 }, { text: 'relay.example', fontFamily: 'Space Grotesk', fontSize: 40, fontWeight: 500, lineHeight: 1.2, color: C.accentSoft, align: 'center', reveal: 'typewriter', revealDurationInFrames: 24 }, { startFrame: 60, durationInFrames: 180 }),
      ],
    },
  ],
  compositions: {},
  markers: [],
  audio: [
    { id: 'aud_music', assetId: 'ast_music', name: 'Music bed', startFrame: 0, trimStartFrames: 0, durationInFrames: 24 * FPS, volume: 0.6, fadeInFrames: 15, fadeOutFrames: 45 },
    { id: 'aud_whoosh', assetId: 'ast_whoosh', name: 'Whoosh', sceneId: 'scn_product', startFrame: 0, trimStartFrames: 0, durationInFrames: 20, volume: 0.9, fadeInFrames: 0, fadeOutFrames: 0 },
  ],
};
