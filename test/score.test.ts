import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreFindings, rawImpact, bandFor, DETECTOR_CAPS, LINK_LEVELS, linkLevel, NAMING_RULES, RULES_VERSION } from '../src/score.ts';
import type { Finding } from '../src/types.ts';
import { FIXTURES } from '../src/mock.ts';

const f = (id: string, detector: Finding['detector'], severity: Finding['severity'], confidence: number): Finding => ({
  id, key: id, detector, severity, confidence, scoreImpact: 0, rawImpact: 0, title: id, explanation: '', evidence: [], chains: [1],
});

test('raw impact is severity points times confidence, rounded, negative', () => {
  assert.equal(rawImpact('critical', 1), -22);
  assert.equal(rawImpact('high', 0.5), -7);
  assert.equal(rawImpact('info', 1), 0);
  assert.equal(rawImpact('low', 0.1), 0);
  assert.equal(rawImpact('medium', 2), -8); // confidence clamps to 1
});

test('no findings scores 100, private', () => {
  const s = scoreFindings([]);
  assert.equal(s.score, 100);
  assert.equal(s.band, 'private');
});

test('cap per detector: costliest counts first, the rest costs 0, sum still matches', () => {
  const s = scoreFindings([f('a', 'cex_exposure', 'critical', 1), f('b', 'cex_exposure', 'medium', 1)]);
  assert.equal(s.breakdown.byDetector.cex_exposure, -DETECTOR_CAPS.cex_exposure);
  const a = s.findings.find((x) => x.id === 'a')!, b = s.findings.find((x) => x.id === 'b')!;
  assert.equal(a.scoreImpact, -20);
  assert.equal(b.rawImpact, -8);
  assert.equal(b.scoreImpact, 0);
  assert.deepEqual(s.breakdown.capped, ['cex_exposure']);
  assert.equal(100 + s.findings.reduce((x, y) => x + y.scoreImpact, 0), s.score);
});

test('score floors at 0 and the invariant holds', () => {
  const all = (['public_identity', 'linked_wallets', 'funding_reuse', 'cex_exposure', 'cross_chain', 'behavioral_fingerprint', 'recurring_counterparties'] as const)
    .flatMap((d, i) => [f(`${d}.1`, d, 'critical', 1), f(`${d}.2`, d, 'critical', 1), f(`${d}.3`, d, 'high', 0.9 - i * 0.01)]);
  const s = scoreFindings(all);
  assert.equal(s.score, 0);
  assert.equal(s.band, 'exposed');
  assert.equal(s.findings.reduce((x, y) => x + y.scoreImpact, 0), -100);
  assert.equal(Object.values(s.breakdown.byDetector).reduce((a, b) => a + b, 0), -100);
  for (const x of s.findings) assert.ok(x.scoreImpact <= 0 && x.scoreImpact >= x.rawImpact);
});

test('named-wallet ceiling: a public name caps the score at 34 and the naming finding absorbs the rest', () => {
  const s = scoreFindings([f('public_identity.public_label', 'public_identity', 'critical', 1), f('cross_chain.x', 'cross_chain', 'low', 1)]);
  assert.equal(s.score, 34);
  assert.equal(s.band, 'exposed');
  assert.equal(s.breakdown.ceiling, 34);
  const n = s.findings.find((x) => x.id === 'public_identity.public_label')!;
  assert.equal(n.rawImpact, -22);
  assert.equal(n.scoreImpact, -62);
  assert.equal(100 + s.findings.reduce((a, x) => a + x.scoreImpact, 0), 34);
  // Below the ceiling nothing changes; a weak naming signal does not trigger it.
  assert.equal(scoreFindings([f('public_identity.public_label', 'public_identity', 'critical', 0.5)]).score, 89);
});

test('1.4.0: a primary ENS name is no ceiling any more (an ENS name can be made up); a public label still is', () => {
  const ens = scoreFindings([f('public_identity.ens_reverse', 'public_identity', 'medium', 1), f('cross_chain.x', 'cross_chain', 'low', 1)]);
  assert.equal(ens.score, 100 - 8 - 4);
  assert.equal(ens.breakdown.ceiling, undefined);
  // Whatever its severity, the ENS rule alone never caps the score: the ceiling is for public labels only.
  assert.equal(scoreFindings([f('public_identity.ens_reverse', 'public_identity', 'critical', 1)]).score, 78);
  assert.deepEqual(NAMING_RULES, ['public_identity.public_label']);
  const label = scoreFindings([f('public_identity.public_label', 'public_identity', 'critical', 1), f('public_identity.ens_reverse', 'public_identity', 'medium', 1)]);
  assert.equal(label.score, 34);
  assert.equal(label.breakdown.ceiling, 34);
  assert.equal(RULES_VERSION, '1.5.0');
});

test('bands', () => {
  assert.equal(bandFor(80), 'private');
  assert.equal(bandFor(79), 'moderate');
  assert.equal(bandFor(60), 'moderate');
  assert.equal(bandFor(59), 'traceable');
  assert.equal(bandFor(35), 'traceable');
  assert.equal(bandFor(34), 'exposed');
});

test('fixtures obey the invariant', () => {
  for (const r of Object.values(FIXTURES)) {
    assert.equal(100 + r.findings.reduce((a, x) => a + x.scoreImpact, 0), r.score);
    assert.equal(r.band, bandFor(r.score));
  }
});

test('link levels: likely at 0.70 and up, possible at 0.45 and up, else weak (the edges are inclusive)', () => {
  assert.deepEqual(LINK_LEVELS, { likely: 0.7, possible: 0.45 });
  assert.equal(linkLevel(0.95), 'likely');
  assert.equal(linkLevel(0.7), 'likely');
  assert.equal(linkLevel(0.69), 'possible');
  assert.equal(linkLevel(0.45), 'possible');
  assert.equal(linkLevel(0.44), 'weak');
  assert.equal(linkLevel(0), 'weak');
});

test('every fixture uses only rule ids the engine can emit, and carries keys and link levels', async () => {
  const { readdirSync, readFileSync } = await import('node:fs');
  const engine = new Set<string>();
  for (const f of readdirSync(new URL('../src/detectors/', import.meta.url))) {
    for (const m of readFileSync(new URL(`../src/detectors/${f}`, import.meta.url), 'utf8').matchAll(/id: '([a-z_]+\.[a-z_]+)'/g)) engine.add(m[1]);
  }
  for (const [name, r] of Object.entries(FIXTURES)) {
    for (const f of r.findings) {
      assert.ok(engine.has(f.id), `${name}: ${f.id} is not a rule of the engine`);
      assert.equal(typeof f.key, 'string');
    }
    for (const w of r.linkedWallets) assert.equal(w.level, linkLevel(w.confidence), `${name}: level of ${w.address}`);
    assert.ok(Array.isArray(r.incomplete), `${name}: incomplete`);
  }
});

test('the worked example: a capped detector, and the counted points add up to the score', () => {
  const r = FIXTURES['worked-example'];
  assert.equal(r.score, 30);
  assert.deepEqual(r.breakdown.capped, ['linked_wallets']);
  const lw = r.findings.filter((f) => f.detector === 'linked_wallets');
  assert.equal(lw.reduce((a, f) => a + f.scoreImpact, 0), -DETECTOR_CAPS.linked_wallets);
  assert.equal(100 + r.findings.reduce((a, f) => a + f.scoreImpact, 0), r.score);
});
