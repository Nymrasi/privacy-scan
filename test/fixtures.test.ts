// The mock results must be what the engine gives: a fixture never claims a number the rules cannot produce.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildFixtures, EXAMPLE_NAME } from '../scripts/fixtures.ts';

test('fixtures/bad, average and good are exactly what the real detectors give today (else: node scripts/make-fixtures.ts)', async () => {
  const built = await buildFixtures();
  for (const name of ['bad', 'average', 'good'] as const) {
    const committed = JSON.parse(readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), 'utf8'));
    assert.deepEqual(committed, JSON.parse(JSON.stringify(built[name])), `fixtures/${name}.json is stale`);
  }
  // 1.4.0: the bad example's ENS name is medium and no ceiling, so it reads 36, traceable (22, exposed, before).
  assert.equal(built.bad.band, 'traceable');
  assert.equal(built.average.band, 'moderate');
  assert.equal(built.good.band, 'private');
});

test('fixtures name nobody: the only name in any fixture is alice.example, under the reserved .example (it can never exist)', () => {
  assert.match(EXAMPLE_NAME, /^[a-z0-9-]+\.example$/);
  for (const name of ['bad', 'average', 'good', 'worked-example']) {
    const raw = readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), 'utf8');
    const ens = JSON.parse(raw).identity.ens;
    assert.ok(ens === undefined || ens === EXAMPLE_NAME, `fixtures/${name}.json: identity.ens ${ens}`);
    // Every name-like word outside the explorer links: a .eth name, or any DNS name ENS could import.
    const words = [...raw.replace(/https?:\/\/[^"\s]+/g, '').matchAll(/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:eth|example|xyz|com|org|net|io|app|box|art|club|nft|crypto|wallet)\b/gi)].map((m) => m[0].toLowerCase());
    assert.deepEqual([...new Set(words)].filter((w) => w !== EXAMPLE_NAME), [], `fixtures/${name}.json names someone`);
  }
});
