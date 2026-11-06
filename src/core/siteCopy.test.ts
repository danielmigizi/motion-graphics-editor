import { describe, expect, it } from 'vitest';
import { extractSiteCopy, firstSentence, textOf } from './siteCopy';

const PAGE = `<!doctype html><html><head>
<title>Acme Ledger | Close your books in a day</title>
<meta name="description" content="Acme Ledger reconciles every account overnight, so finance closes the month in one day. Built for growing teams.">
<meta property="og:site_name" content="Acme Ledger">
<style>.hero{color:red}</style><script>window.stat = "99% fake"</script>
</head><body>
<nav><a href="/pricing">Pricing</a><a href="/blog">Blog</a><a href="/signup" class="btn">Start free</a></nav>
<main>
  <section class="hero">
    <h1>Close your books in a&nbsp;day</h1>
    <p>Acme Ledger reconciles every account overnight.</p>
    <a href="/signup">Start free</a> <a href="/demo">Book a demo</a>
  </section>
  <section>
    <p>Teams close 4x faster with Acme.</p>
    <p>Founded in 2019 by accountants.</p>
  </section>
  <h2>Pricing</h2>
  <h2>Automatic reconciliation</h2><p>Every bank line matched to its invoice before you wake up. More detail here.</p>
  <h3>Audit-ready reports</h3><p>One click exports what your auditor asks for.</p>
  <h3>Works with your bank</h3>
  <blockquote>“We closed March in a single afternoon.”<cite>Dana Ruiz, CFO at Fieldnote</cite></blockquote>
  <section><p>Plans from $29/mo per seat.</p></section>
</main>
<footer><a href="/careers">Careers</a> <p>© 2026 Acme</p></footer>
</body></html>`;

describe('extractSiteCopy', () => {
  const copy = extractSiteCopy(PAGE, 'https://www.acme.dev/');

  it('names the product and the domain', () => {
    expect(copy.domain).toBe('acme.dev');
    expect(copy.product).toBe('Acme Ledger');
  });

  it('reads the hero headline and subhead', () => {
    expect(copy.headline).toBe('Close your books in a day');
    expect(copy.subhead).toBe('Acme Ledger reconciles every account overnight, so finance closes the month in one day. Built for growing teams.');
  });

  it('lists value props with their first sentence, skipping navigation headings', () => {
    expect(copy.valueProps).toEqual([
      { title: 'Automatic reconciliation', body: 'Every bank line matched to its invoice before you wake up.' },
      { title: 'Audit-ready reports', body: 'One click exports what your auditor asks for.' },
      { title: 'Works with your bank' },
    ]);
  });

  it('finds a stat the page shows (not a year, not script text) and a price', () => {
    expect(copy.stat).toEqual({ value: '4×', label: 'Teams close faster with Acme' });
    expect(copy.price).toBe('$29/mo');
  });

  it('finds the call to action and a customer quote', () => {
    expect(copy.cta).toBe('Start free');
    expect(copy.quote).toEqual({ text: 'We closed March in a single afternoon.', name: 'Dana Ruiz', role: 'CFO at Fieldnote' });
  });

  it('leaves missing fields out instead of inventing them', () => {
    const bare = extractSiteCopy('<html><head><title>Plainco</title></head><body><main><h1>Hello there</h1></main></body></html>', 'https://plainco.io');
    expect(bare).toEqual({ url: 'https://plainco.io', domain: 'plainco.io', product: 'Plainco', headline: 'Hello there', valueProps: [] });
  });

  it('takes the headline from the page title without its brand part when there is no h1', () => {
    const copy = extractSiteCopy('<title>Linear – The system for product development</title><meta property="og:site_name" content="Linear">', 'https://linear.app');
    expect(copy.headline).toBe('The system for product development');
  });

  it('takes a price only when the page states it per period or seat', () => {
    expect(extractSiteCopy('<main><p>Fees from $0.01 per call</p></main>', 'https://x.dev').price).toBeUndefined();
    expect(extractSiteCopy('<main><p>Pro is €12 / month</p></main>', 'https://x.dev').price).toBe('€12 / month');
  });

  it('keeps a plus with the number and skips labels that trail off', () => {
    expect(extractSiteCopy('<main><p>Zapier serves over 100 million</p><p>150K+ users have their best day</p></main>', 'https://x.dev').stat).toEqual({ value: '150K+', label: 'users have their best day' });
  });

  it('ignores numbers in UI fragments that are not a stat', () => {
    const page = '<main><div>Worked for 1 min</div><div>karri · 4 min ago</div><div>Releases Linear App 1.688 ⋅ Jun 25</div><p>Saved 30% of review time</p></main>';
    expect(extractSiteCopy(page, 'https://x.dev').stat).toEqual({ value: '30%', label: 'Saved of review time' });
  });

  it('falls back to the domain name when the title has no brand', () => {
    expect(extractSiteCopy('<title>Welcome to the future of work today</title>', 'https://zentro.app').product).toBe('Zentro');
  });
});

describe('text helpers', () => {
  it('decodes entities and collapses whitespace', () => {
    expect(textOf('<b>Ship&nbsp;it</b>\n &amp; <i>rest</i> &#8212; ok')).toBe('Ship it & rest — ok');
  });
  it('takes the first sentence', () => {
    expect(firstSentence('One brief a week. Read in two minutes.')).toBe('One brief a week.');
    expect(firstSentence('No stop here')).toBe('No stop here');
  });
});
