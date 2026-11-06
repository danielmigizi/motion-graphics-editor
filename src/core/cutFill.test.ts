import { describe, expect, it } from 'vitest';
import { cutDraftProject } from './cutCards';
import { CUT_CARDS, cutCard } from './cutCatalog';
import { fillCut, fillCutSlots, fitCopy, leadingPhrase, twoLines } from './cutFill';
import type { SiteCopy } from './siteCopy';
import { validateProject } from './validate';

const FULL: SiteCopy = {
  url: 'https://acme.dev/',
  domain: 'acme.dev',
  product: 'Acme Ledger',
  headline: 'Close your books in a day',
  subhead: 'Acme Ledger reconciles every account overnight. Built for growing teams.',
  valueProps: [
    { title: 'Automatic reconciliation', body: 'Every bank line matched to its invoice.' },
    { title: 'Audit-ready reports', body: 'One click exports what your auditor asks for.' },
    { title: 'Works with your bank' },
  ],
  stat: { value: '4×', label: 'Teams close faster with Acme' },
  price: '$29/mo',
  cta: 'Start free',
  quote: { text: 'We closed March in a single afternoon.', name: 'Dana Ruiz', role: 'CFO at Fieldnote' },
};

const BARE: SiteCopy = { url: 'https://plainco.io', domain: 'plainco.io', product: 'Plainco', headline: 'Hello there', valueProps: [] };

describe('fillCutSlots', () => {
  it('puts the site’s own copy into the slots it has words for', () => {
    const f = fillCutSlots(cutCard('hook.big-number')!, FULL);
    expect(f.values).toMatchObject({ stat: '4×', label: 'Teams close faster with Acme', kicker: 'ACME LEDGER' });
    expect(f.fromSite).toEqual(expect.arrayContaining(['stat', 'label', 'kicker']));
    // No delta on the page: the sample's stays, flagged.
    expect(f.missing).toEqual(['chip']);
  });

  it('never invents a number, a person or a quote', () => {
    const big = fillCutSlots(cutCard('hook.big-number')!, BARE);
    expect(big.values.stat).toBe(cutCard('hook.big-number')!.slots.stat.sample);
    expect(big.missing).toEqual(expect.arrayContaining(['stat', 'label', 'chip']));
    const quote = fillCutSlots(cutCard('proof.customer-quote')!, { ...FULL, quote: undefined });
    // With no customer on the page the quote becomes the brand speaking, signed by the brand.
    expect(quote.values).toMatchObject({ quote: FULL.subhead, name: 'Acme Ledger', role: 'acme.dev' });
    expect(quote.missing).toEqual([]);
  });

  it('uses a real quote with its person when the page has one', () => {
    expect(fillCutSlots(cutCard('proof.customer-quote')!, FULL).values).toMatchObject({ quote: FULL.quote!.text, name: 'Dana Ruiz', role: 'CFO at Fieldnote' });
  });

  it('fills lists from value props in proofs only', () => {
    const trio = fillCutSlots(cutCard('proof.feature-trio')!, FULL);
    expect(trio.values.features.split('\n')).toEqual(['Automatic reconciliation: Every bank line matched to its invoice.', 'Audit-ready reports: One click exports what your auditor asks for.', 'Works with your bank']);
    const strike = cutCard('hook.chore-strike');
    if (strike) expect(fillCutSlots(strike, FULL).fromSite).not.toContain('items');
  });

  it('leaves no sample product name outside slots it flags', () => {
    for (const card of CUT_CARDS) {
      const f = fillCutSlots(card, FULL);
      for (const [name, value] of Object.entries(f.values)) {
        if (/brieflet/i.test(value)) expect(f.missing, `${card.id}.${name}`).toContain(name);
      }
      expect([...f.fromSite, ...f.kept, ...f.missing].sort()).toEqual(Object.keys(card.slots).sort());
    }
  });

  it('builds every card into a valid project with full or bare copy', () => {
    for (const copy of [FULL, BARE]) {
      const { slots } = fillCut(CUT_CARDS, copy);
      for (const card of CUT_CARDS) expect(validateProject(cutDraftProject([card], { slots })).ok, card.id).toBe(true);
    }
  });
});

describe('fitting copy', () => {
  it('splits a headline into two balanced lines', () => {
    expect(twoLines('Close your books in a day')).toBe('Close your\nbooks in a day');
    expect(twoLines('Hi there')).toBe('Hi there');
  });

  it('cuts long copy at a sentence, then at whole words', () => {
    const slot = { kind: 'text' as const, doc: '', sample: '', maxChars: 20 };
    expect(fitCopy('Short and sweet. Then a lot more words follow here.', slot)).toBe('Short and sweet.');
    expect(fitCopy('One very long sentence that keeps on going without stopping', slot)).toBe('One very long sentence');
  });
});

describe('whole copy before cut copy', () => {
  const text = (maxChars: number) => ({ kind: 'text' as const, doc: '', sample: '', maxChars });
  const LINEAR: SiteCopy = {
    url: 'https://linear.app/',
    domain: 'linear.app',
    product: 'Linear',
    headline: 'The system for product development',
    subhead: 'Purpose-built for planning and building products with AI agents.',
    valueProps: [{ title: 'Planning and monitoring', body: 'Plan and navigate from idea to launch.' }],
  };

  it('takes a shorter whole line from the site instead of cutting the subhead mid-sentence (Linear)', () => {
    const f = fillCutSlots(cutCard('cta.logo-sting')!, LINEAR);
    expect(f.values.tagline).toBe('The system for product development');
    expect(f.values.tagline).not.toBe('Purpose-built for planning and building');
  });

  it('keeps the whole subhead where it fits', () => {
    expect(fitCopy([LINEAR.subhead, LINEAR.headline], text(64))).toBe(LINEAR.subhead);
  });

  it('takes a whole sentence of a longer line before anything shorter', () => {
    expect(fitCopy(['Close your books in a day. Then reconcile every account overnight, automatically.', 'Short line'], text(24))).toBe('Close your books in a day.');
  });

  it('cuts at a clause, never mid-phrase, when no whole line fits', () => {
    expect(fitCopy(['Purpose-built for planning and building products with AI agents.'], text(30))).toBe('Purpose-built for planning');
    expect(leadingPhrase('Ship faster, review less, and sleep through Fridays', 30)).toBe('Ship faster, review less');
    expect(leadingPhrase('The fastest way to plan the week with your team', 24)).toBe('The fastest way');
    // A clause ending on an article or preposition is not a phrase.
    expect(leadingPhrase('Plans for the next quarter', 12)).toBeNull();
  });

  it('falls back to whole words only when there is no clause to stop at', () => {
    expect(fitCopy(['Supercalifragilistic expialidocious onomatopoeia everywhere'], text(20))).toBe('Supercalifragilistic');
  });

  it('drops whole list items from the end instead of cutting one', () => {
    const list = { kind: 'list' as const, doc: '', sample: 'a\nb\nc', maxChars: 40 };
    expect(fitCopy('Automatic reconciliation\nAudit-ready reports\nWorks with your bank', list)).toBe('Automatic reconciliation\nAudit-ready reports');
  });

  it('balances a one-line headline over two lines in a lines slot', () => {
    expect(fillCutSlots(cutCard('hook.mask-rise-claim')!, LINEAR).values.claim).toBe('The system for\nproduct development');
  });
});
