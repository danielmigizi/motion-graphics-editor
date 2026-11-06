// Fail on new findings; record the one reviewed, unpatched development-only
// chain instead of downgrading the linter or ignoring every future dev issue.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
const run = spawnSync('npm', ['audit', '--json'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
let audit;
try { audit = JSON.parse(run.stdout); } catch { throw new Error('Could not obtain a valid npm dependency audit.'); }
if (run.error || ![0, 1].includes(run.status) || audit.error || !audit.metadata?.vulnerabilities || !audit.vulnerabilities) {
  throw new Error('The dependency audit could not complete.');
}
const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
const names = new Set(['braces', 'micromatch', 'fast-glob', 'globby', 'stylelint']);
const advisory = 'https://github.com/advisories/GHSA-vfj7-8cjw-p6xm';
const rejected = [];
for (const [name, finding] of Object.entries(audit.vulnerabilities)) {
  const known = names.has(name) && finding.severity === 'high' && finding.nodes?.length > 0 &&
    finding.nodes.every(path => lock.packages[path]?.dev === true) && finding.via?.length > 0 &&
    finding.via.every(via => typeof via === 'string' ? names.has(via) : via.url === advisory);
  if (!known) rejected.push(name);
}
console.log(JSON.stringify(audit.metadata.vulnerabilities));
if (rejected.length) {
  console.error(`Unreviewed dependency findings: ${rejected.join(', ')}`);
  process.exitCode = 1;
} else if (audit.metadata.vulnerabilities.total) {
  console.warn(`Known development-only Stylelint/braces findings remain; see SECURITY.md and ${advisory}.`);
} else {
  console.log('No known dependency advisories.');
}
