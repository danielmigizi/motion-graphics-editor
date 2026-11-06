// Golden examples: reference projects that show the craft rules (craft v2).
// The agent skill cites them as few-shot examples; scripts/render-golden.ts
// renders their contact sheets to docs/golden/. Every scene stays alive
// through its hold (a push, a drift, a texture), heroes and screenshots use
// the frame, and no text meant to be read is under the video-safe minimums.

import { sceneStartFrames } from '../../core/timing';
import type { Project } from '../../core/types';
import { kineticPromo } from './kineticPromo';
import { productWalkthrough } from './productWalkthrough';
import { pulseReference } from './pulseReference';
import { saasLaunch } from './saasLaunch';

export interface GoldenExample {
  id: string;
  title: string;
  project: Project;
  /** Global frames for the contact sheet. */
  frames: number[];
  columns: number;
  /** What makes it good, for the skill. */
  notes: string[];
}

/** Two frames per scene: arriving (30 %) and settled just before the cut. */
function sheetFrames(project: Project, at: [number, number] = [0.3, 0.94]): number[] {
  const starts = sceneStartFrames(project);
  return project.scenes.flatMap((s, i) => at.map((f) => starts[i] + Math.round(f * (s.durationInFrames - 1))));
}

const saas = saasLaunch();
const kinetic = kineticPromo();
const walkthrough = productWalkthrough();
const pulse = pulseReference();

export const GOLDEN_EXAMPLES: GoldenExample[] = [
  {
    id: 'saas-launch',
    title: 'SaaS launch, 24 s, Snappy SaaS',
    project: saas,
    frames: sheetFrames(saas),
    columns: 4,
    notes: [
      'One idea per scene: hook → before/after → product → features → proof → brand.',
      'Every scene is a whole number of beats (15 frames at 120 BPM); markers sit on the cuts.',
      'Use the frame: the hook’s two lines are 156 px (cap height 10 % of the frame) on the left 58 % with a column of unread notes scrolling behind; the product screen is 78 % wide on a glow and bleeds off the bottom under the logo and headline.',
      'Never dead: the notes drift, every scene pushes in 3–4 % through its hold, the product scene keeps landing things (click, spotlight that dims the rest and lifts, callout, two chips).',
      'One hero per beat: the after panel steps the before back to 55 %; the screen yields to the cursor, ring and callout; the punchline lands word by word in the accent after the headline.',
      'Arrive apart: feature cards 5 frames apart in reading order, each card’s tile, title and line 3 frames behind it.',
      'End card composed from its first second: logo on a glow, line and button within 0.8 s of each other, then held alive.',
    ],
  },
  {
    id: 'kinetic-promo',
    title: 'Kinetic-type promo, 15 s, Editorial',
    project: kinetic,
    frames: sheetFrames(kinetic),
    columns: 4,
    notes: [
      'Type is the picture: one statement per scene, lines rising from behind their own masks.',
      'Keep the thread: “Less noise.” and “More signal.” share kicker, line position and the scrolling column of lines behind them, so the hard cut reads as a word swap.',
      'Never dead: the column scrolls, every statement pushes in slowly through its reading hold; the stat and quote scenes push too.',
      'Editorial personality: cubic in-out moves at 1.15× length; every scene holds its text for its reading time (words ÷ 3.5 + 0.5 s).',
      'Tracking tightens on the kickers (16 → 5 px) while they fade in; headlines never animate tracking.',
    ],
  },
  {
    id: 'product-walkthrough',
    title: 'Product walkthrough, 20 s, Playful Consumer',
    project: walkthrough,
    frames: sheetFrames(walkthrough),
    columns: 4,
    notes: [
      'Three steps cut as one take: the screen never moves; each cursor starts where the last click was; one continuous push (1 → 1.02 → 1.04 → 1.06 about the screen centre) runs across the cuts so no step holds dead.',
      'Cursor arcs (y eases out fast, x in-out), presses to 82 % and the ripple, ring and caption follow 2–9 frames apart; step 2 spotlights the summary (the rest dims to 60 % and lifts).',
      'The screen is 72 % of the width on a glow; the intro breathes on two drifting glows; the end card has its button from the first second.',
      'Captions under the screen carry the step number in mono and the action in the heading face.',
      'Playful personality: back-out arrivals with ≈10 % overshoot, 0.9× length, 5-frame staggers.',
    ],
  },
  {
    id: 'pulse-reference',
    title: 'Pulse house bar, 13.6 s — kit assemble + spring end card',
    project: pulse,
    // Kit pops / camera / collapse, then spring / type / pills.
    frames: [1, 4, 6, 8, 12, 18, 30, 50, 90, 140, 160, 180, 185, 187, 193, 209, 287, 321, 325, 360, 400],
    columns: 6,
    notes: [
      'House bar (Pulse): cream plate, mint + teal, Space Grotesk. Not a brand kit — original tiles and “Northline”.',
      'Kit assemble: tiles snap-pop 2–4 f with 1–4 f irregular stagger, then a 76 f ease-in-out camera push, then collapse to a card. Constant drift. No true hold.',
      'End card: mark springs 3×→1 over 10 f with a 4 f smear; wordmark pops 4 f; “Studio” types at 1 char/f; pills stagger 2–4 f. Cut is +3 f after the beat.',
      'Calm type at 3–4 % of frame height, lots of air. Critique thresholds come from the pack so these pops are not errors.',
    ],
  },
];
