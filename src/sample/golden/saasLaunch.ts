// Golden example 1 — a 24 s SaaS launch (Snappy SaaS pack, craft v2).
// Problem → answer → product → features → proof → brand, one idea per scene,
// every scene a whole number of beats at 120 BPM (15 frames) so cuts land on
// the music. Nothing holds dead: the hook has a scrolling column of unread
// notes behind it, the product scene bleeds a 78 %-wide screen off the bottom
// and keeps landing chips, every other scene pushes in slowly until its cut.

import { Draft, RELAY_ASSETS } from './draft';

const fade = (frames: number) => ({ type: 'fade' as const, durationInFrames: frames });

export function saasLaunch() {
  const d = new Draft({ id: 'prj_golden_saas', name: 'Relay — launch', pack: 'snappy-saas', assets: [RELAY_ASSETS.logo, RELAY_ASSETS.screenshot, RELAY_ASSETS.music] });

  // Hook: the headline fills the left 58 % in two big lines; the punchline lands word by word in the accent; unread notes scroll behind.
  const hook = d.scene('Hook', 105);
  d.template(hook, 'backdrop', { kind: 'lines', side: 'right' });
  d.template(hook, 'kineticTitle', { kicker: 'LAST WEEK AT NORTHWIND', lines: '47 changes shipped.', sub: 'Nobody read them.', widthShare: 0.58 });

  const problem = d.scene('Before / after', 135);
  d.template(problem, 'beforeAfter', { before: 'Six standups, forty PR threads, one lost Friday', after: 'One brief, read in two minutes' });

  // Product: logo and headline over a screen that bleeds off the bottom; the cursor clicks Send, the rest dims, chips follow.
  const product = d.scene('Product', 150, fade(8));
  d.template(product, 'uiWalkthrough', { imageAssetId: 'ast_screenshot', title: 'Every merge, one weekly brief.', bleed: 1, spotlight: 1, targetX: 0.934, targetY: 0.139, targetW: 0.09, targetH: 0.037, label: 'Send the brief to the team', calloutSide: 'above', chips: '47 changes · 6 repos\n92% read rate' });

  const features = d.scene('Features', 135, fade(8));
  d.template(features, 'featureGrid', {
    kicker: 'WHAT’S IN THE BRIEF',
    title: 'Everything your team shipped, in one place',
    features: 'Plain-language summaries: Every merged PR, explained for humans.\nRead receipts: See who caught up, and who still needs to.\nGrouped by team: Payments, Search, Identity, each in its lane.\nShare anywhere: Slack, email or Notion, in one click.',
  });

  const proof = d.scene('Proof', 90, fade(8));
  d.template(proof, 'statReveal', { kicker: 'READ RATE', value: '92%', label: 'read the brief every week', chip: '+18 pts since launch' });

  // End card: logo, line and button all on screen within a second of each other, then held alive on a glow.
  const outro = d.scene('Brand', 105, fade(10));
  d.template(outro, 'logoSting', { logoAssetId: 'ast_logo', tagline: 'Your week in brief.', cta: 'Get early access' });

  d.music(RELAY_ASSETS.music, 720);
  // Cuts land on beats (every 15 frames at 120 BPM).
  for (const [frame, label] of [[105, 'Cut · beat 8'], [240, 'Cut · beat 17'], [390, 'Cut · beat 27'], [525, 'Cut · beat 36'], [615, 'Cut · beat 42']] as const) d.marker(frame, label);
  return d.project;
}
