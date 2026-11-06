// Golden example 3 — a 20 s product walkthrough (Playful Consumer pack, craft v2).
// Three steps on one screen, cut together as one continuous take: the screen
// never moves between steps and each step's cursor starts where the last one
// clicked, so only the cursor, the highlight and the caption change. The
// screen sits on a glow and pushes in slowly through each step; the intro
// breathes on two drifting glows; the end card has a button from the start.

import { Draft, RELAY_ASSETS } from './draft';

/** Targets on the product screenshot, as fractions of it. */
const BRIEFS = { targetX: 0.077, targetY: 0.221, targetW: 0.134, targetH: 0.035 };
const SUMMARY = { targetX: 0.457, targetY: 0.244, targetW: 0.564, targetH: 0.122 };
const SEND = { targetX: 0.934, targetY: 0.139, targetW: 0.09, targetH: 0.037 };

export function productWalkthrough() {
  const d = new Draft({ id: 'prj_golden_walkthrough', name: 'Relay — how it works', pack: 'playful-consumer', assets: [RELAY_ASSETS.screenshot] });

  const intro = d.scene('Intro', 105);
  d.template(intro, 'backdrop', { kind: 'glow' });
  d.template(intro, 'kineticTitle', { kicker: 'HOW RELAY WORKS', lines: 'Forty PRs in.\nOne brief out.', accentLine: 2 });

  // One continuous push across the three steps (1 → 1.02 → 1.04 → 1.06 about the screen centre), so no step holds dead and the cuts stay invisible.
  const one = d.scene('Step 1 · Open', 135, { type: 'slide', durationInFrames: 12 });
  d.template(one, 'uiWalkthrough', { imageAssetId: 'ast_screenshot', ...BRIEFS, step: 1, label: 'Open this week’s brief', push: 1.02, pushFocus: 'screen' });

  const two = d.scene('Step 2 · Skim', 120);
  d.template(two, 'uiWalkthrough', { imageAssetId: 'ast_screenshot', ...SUMMARY, step: 2, label: 'Skim the two-minute summary', pushFrom: 1.02, push: 1.04, pushFocus: 'screen', screenEnter: 0, fromX: BRIEFS.targetX, fromY: BRIEFS.targetY, spotlight: 1 });

  const three = d.scene('Step 3 · Send', 135);
  d.template(three, 'uiWalkthrough', { imageAssetId: 'ast_screenshot', ...SEND, step: 3, label: 'Send it to the team', pushFrom: 1.04, push: 1.06, pushFocus: 'screen', screenEnter: 0, fromX: SUMMARY.targetX, fromY: SUMMARY.targetY });

  const outro = d.scene('Brand', 105, { type: 'fade', durationInFrames: 10 });
  d.template(outro, 'logoSting', { wordmark: 'relay', tagline: 'Your week in brief.', cta: 'Try it free' });
  return d.project;
}
