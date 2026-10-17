// Writes fixtures/{bad,average,good}.json: mock scan results for the website, the bot and the
// graphics, produced by the real detectors and score formula on synthetic histories (scripts/fixtures.ts).
// Run: node scripts/make-fixtures.ts after a rule changes; test/fixtures.test.ts fails until you do.
import { writeFileSync } from 'node:fs';
import { buildFixtures } from './fixtures.ts';

for (const [name, r] of Object.entries(await buildFixtures())) {
  writeFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), JSON.stringify(r, null, 2) + '\n');
  console.log(name, r.score, r.band, r.findings.length, 'findings', r.linkedWallets.map((w) => `${w.address.slice(0, 8)} ${w.confidence}`).join(', '));
}
