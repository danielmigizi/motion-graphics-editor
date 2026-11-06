// Golden example 2 — a 15 s kinetic-type promo (Editorial pack, craft v2).
// Type carries everything: one statement per beat, lines arriving apart from
// behind their masks, and a positional match cut ("Less noise." → "More
// signal." sit on the same line, so the cut reads as a word swap). A column
// of document lines scrolls behind the first two statements (the noise), and
// every scene pushes in slowly through its hold.

import { Draft } from './draft';

export function kineticPromo() {
  const d = new Draft({ id: 'prj_golden_kinetic', name: 'Relay — less noise', pack: 'editorial' });

  const one = d.scene('Less noise', 75);
  d.template(one, 'backdrop', { kind: 'lines', side: 'right' });
  d.template(one, 'kineticTitle', { kicker: 'RELAY · WEEKLY BRIEFS', lines: 'Less noise.', accentLine: 0, widthShare: 0.6 });

  // Same kicker, same line position, same texture: the cut swaps the word, the eye stays put.
  const two = d.scene('More signal', 75);
  d.template(two, 'backdrop', { kind: 'lines', side: 'right' });
  d.template(two, 'kineticTitle', { kicker: 'RELAY · WEEKLY BRIEFS', lines: 'More signal.', accentLine: 1, widthShare: 0.6 });

  const three = d.scene('Two minutes', 105, { type: 'fade', durationInFrames: 9 });
  d.template(three, 'statReveal', { kicker: 'EVERY MONDAY', value: '2 min', label: 'to read the whole week', chip: '47 PRs, one page' });

  const four = d.scene('Quote', 105, { type: 'fade', durationInFrames: 9 });
  d.template(four, 'testimonial', { quote: 'Finally, a changelog people actually read.', name: 'Jonah Okafor', role: 'Payments lead, Northwind' });

  const five = d.scene('Sign-off', 90, { type: 'fade', durationInFrames: 9 });
  d.template(five, 'kineticTitle', { kicker: 'RELAY.DEV', lines: 'Read less.\nShip more.', accentLine: 2 });
  return d.project;
}
