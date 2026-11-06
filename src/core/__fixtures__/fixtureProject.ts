// Frozen copy of the Wave-1 sample used as a stable test fixture. The real
// sample (src/sample/sampleProject.ts) evolves for looks; tests must not.

// Sample project: 24 s at 30 fps, three scenes, text, SVG logo, image,
// animated UI card, chat bubbles, music bed and a scene-anchored sound effect.
//
// IDs below are part of the test/verification contract — keep them stable.

import { COMPONENTS } from '../components';
import type { AnimationTrack, Element, ElementType, Project, Transform } from '../types';

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

export const fixtureProject: Project = {
  schemaVersion: 3,
  id: 'prj_sample',
  name: 'Relay launch demo',
  revision: 1,
  fps: FPS,
  width: 1920,
  height: 1080,
  backgroundColor: '#0B0F1A',
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
      backgroundColor: '#0B0F1A',
      locked: false,
      transitionIn: { type: 'fade', durationInFrames: 12 },
      elements: [
        el('el_intro_glow', 'shape', 'Glow', { x: 560, y: 140, width: 800, height: 800, opacity: 0.35 }, { shape: 'ellipse', fill: '#3B5BDB', cornerRadius: 0 }, { startFrame: 0, durationInFrames: 210 }, [
          { property: 'scale', keyframes: [{ frame: 0, value: 0.6, easing: 'easeOut' }, { frame: 90, value: 1, easing: 'linear' }] },
        ]),
        el('el_intro_logo', 'logo', 'Logo', { x: 720, y: 300, width: 480, height: 140 }, { assetId: 'ast_logo' }, { startFrame: 0, durationInFrames: 210 }, [fadeIn(20), slideUp(40, 24)]),
        el('el_intro_headline', 'text', 'Headline', { x: 260, y: 520, width: 1400, height: 140 }, { text: 'Updates your team actually reads', fontSize: 104, align: 'center', reveal: 'wordStagger', revealDurationInFrames: 30 }, { startFrame: 20, durationInFrames: 190 }),
        el('el_intro_sub', 'text', 'Subhead', { x: 460, y: 690, width: 1000, height: 60 }, { text: 'Relay turns release notes into a two-minute brief.', fontSize: 40, fontWeight: 400, color: '#A5B4FC', align: 'center', reveal: 'fadeUp' }, { startFrame: 60, durationInFrames: 150 }),
      ],
    },
    {
      id: 'scn_product',
      name: 'Product',
      durationInFrames: 9 * FPS,
      backgroundColor: '#0F172A',
      locked: false,
      transitionIn: { type: 'slide', durationInFrames: 15 },
      elements: [
        el('el_product_headline', 'text', 'Headline', { x: 120, y: 100, width: 900, height: 120 }, { text: 'Every change, summarised', fontSize: 72, reveal: 'fadeUp' }, { startFrame: 0, durationInFrames: 270 }),
        el('el_product_image', 'image', 'Screenshot', { x: 120, y: 260, width: 960, height: 600 }, { assetId: 'ast_screenshot' }, { startFrame: 10, durationInFrames: 260 }, [fadeIn(20), slideUp(80, 30)]),
        el('el_product_card', 'uiCard', 'Weekly brief card', { x: 1180, y: 160, width: 620, height: 420 }, { title: 'Weekly brief', subtitle: 'Platform team', metricLabel: 'Read rate', metricValue: '92%', items: 'Billing retries shipped\nSearch latency −38%\nNew SSO onboarding' }, { startFrame: 40, durationInFrames: 230 }, [fadeIn(15), { property: 'x', keyframes: [{ frame: 0, value: 120, easing: 'easeOut' }, { frame: 24, value: 0, easing: 'linear' }] }]),
        el('el_product_chat_user', 'chatBubble', 'Chat — question', { x: 1180, y: 640, width: 620, height: 110 }, { text: 'What changed in billing?', sender: 'user', senderName: 'Maya', bubbleColor: '#3B5BDB', typing: false }, { startFrame: 120, durationInFrames: 150 }, [fadeIn(10), slideUp(30, 12)]),
        el('el_product_chat_ai', 'chatBubble', 'Chat — answer', { x: 1180, y: 780, width: 620, height: 140 }, { text: 'Failed payments now retry automatically for 72 hours.', sender: 'assistant', senderName: 'Relay', typing: true, typingDurationInFrames: 30 }, { startFrame: 160, durationInFrames: 110 }, [fadeIn(10), slideUp(30, 12)]),
      ],
    },
    {
      id: 'scn_outro',
      name: 'Outro',
      durationInFrames: 8 * FPS,
      backgroundColor: '#0B0F1A',
      locked: false,
      transitionIn: { type: 'fade', durationInFrames: 15 },
      elements: [
        el('el_outro_logo', 'logo', 'Logo', { x: 720, y: 330, width: 480, height: 140 }, { assetId: 'ast_logo' }, { startFrame: 0, durationInFrames: 240 }, [
          fadeIn(20),
          { property: 'scale', keyframes: [{ frame: 0, value: 0.85, easing: 'backOut' }, { frame: 30, value: 1, easing: 'linear' }] },
        ]),
        el('el_outro_headline', 'text', 'Headline', { x: 360, y: 520, width: 1200, height: 100 }, { text: 'Start your free trial', fontSize: 72, align: 'center', reveal: 'fadeUp' }, { startFrame: 30, durationInFrames: 210 }),
        el('el_outro_url', 'text', 'URL', { x: 560, y: 650, width: 800, height: 60 }, { text: 'relay.example', fontSize: 40, fontWeight: 500, color: '#A5B4FC', align: 'center', fontFamily: 'IBM Plex Mono', reveal: 'typewriter', revealDurationInFrames: 24 }, { startFrame: 60, durationInFrames: 180 }),
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
