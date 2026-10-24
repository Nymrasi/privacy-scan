// The fix plan and winBack: every number must come out of scoreFindings. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { adviceFor, fixPlan, FIX_TEXT, FRESH_WALLET, learnMoreFor, NOW_RULES, VIEWER_TEXT, whatIf, winBack } from '../../src/features/fix-plan.ts';
import { FIXTURES } from '../../src/mock.ts';
import { DETECTORS, scoreFindings } from '../../src/score.ts';
import type { DetectorId, Finding, ScanResult, Severity } from '../../src/types.ts';

function f(id: string, severity: Severity, confidence: number, key = id): Finding {
  return { id, key, detector: id.split('.')[0] as DetectorId, severity, confidence, scoreImpact: 0, rawImpact: 0, title: id, explanation: '', evidence: [], chains: [1] };
}
function result(fs: Finding[]): Pick<ScanResult, 'findings' | 'score' | 'breakdown'> {
  const s = scoreFindings(fs);
  return { findings: s.findings, score: s.score, breakdown: s.breakdown };
}

test('winBack on fixtures/bad.json: clearing the primary name wins back exactly what scoreFindings gives', () => {
  const bad = FIXTURES.bad;
  const without = scoreFindings(bad.findings.filter((x) => x.id !== 'public_identity.ens_reverse'));
  // fixtures/bad.json from the real detectors, rules 1.4.0: score 36 (it was 22 while an ENS name was critical), 44 without its primary name.
  assert.equal(bad.score, 36);
  assert.equal(without.score, 44);
  assert.equal(winBack(bad), without.score - bad.score);
  assert.equal(winBack(bad), 8);
  const plan = fixPlan(bad);
  assert.equal(plan.winBack, 8);
  assert.equal(plan.scoreAfter, 44);
  assert.equal(plan.top?.id, 'public_identity.ens_reverse');
  assert.equal(plan.top?.gain, 8);
});

test('winBack on the other fixtures: nothing there can be undone today', () => {
  assert.equal(winBack(FIXTURES.average), 0);
  assert.equal(winBack(FIXTURES.good), 0);
  const plan = fixPlan(FIXTURES.average);
  assert.equal(plan.counts.now, 0);
  // Nothing to undo: the top action is the costliest habit, not the funding that is already on chain.
  assert.equal(plan.top?.id, 'funding_reuse.shared_funder');
  assert.equal(plan.items.at(-1)?.id, 'cex_exposure.funded_by_cex');
});

test('1.4.0: clearing an ENS name wins back its own points (no ceiling); under a public label the ceiling still holds it', () => {
  const r = result([f('public_identity.ens_reverse', 'medium', 1), f('cross_chain.multichain_presence', 'low', 1)]);
  assert.equal(r.score, 88, 'an ENS name is no ceiling');
  assert.equal(winBack(r), 8, 'clearing the name gives back its 8 points, no more');
  const withLabel = result([f('public_identity.ens_reverse', 'medium', 1), f('public_identity.public_label', 'critical', 1), f('cross_chain.multichain_presence', 'low', 1)]);
  assert.equal(withLabel.score, 34, 'a public label still caps the score');
  assert.equal(winBack(withLabel), 0, 'a public label cannot be removed, so the ceiling stays');
  const item = fixPlan(withLabel).items.find((i) => i.id === 'public_identity.ens_reverse')!;
  assert.equal(item.gain, 0);
  assert.equal(item.heldBy, 'ceiling');
});

test('clearing the primary name also clears its records and makes an owned name cost more', () => {
  const fs = [f('public_identity.ens_reverse', 'medium', 1), f('public_identity.ens_records', 'high', 0.95), f('public_identity.owned_names', 'low', 0.9), f('linked_wallets.back_and_forth', 'high', 0.8)];
  const r = result(fs);
  // 8 + 13 + 4 + 11: the name, its records, an owned name and a back and forth partner.
  assert.equal(r.score, 100 - 8 - 13 - 4 - 11);
  // Without the name: owned_names is medium (8 x 0.9 = 7), back and forth 14 x 0.8 = 11.
  assert.equal(whatIf(r.findings, ['public_identity.ens_reverse']), 100 - 7 - 11);
  assert.equal(winBack(r), 100 - 7 - 11 - r.score);
  // Removing only the records keeps the name: the records' own 13 points come back (1.4.0: no ceiling holds them).
  assert.equal(whatIf(r.findings, ['public_identity.ens_records']), r.score + 13);
});

test('order: today first by points won, then habits by points, then what is already on chain; info left out', () => {
  const r = result([
    f('public_identity.ens_reverse', 'critical', 1),
    f('behavioral_fingerprint.wallet_software', 'low', 0.9),
    f('cex_exposure.deposit_address', 'critical', 0.92),
    f('linked_wallets.back_and_forth', 'high', 0.7),
    f('behavioral_fingerprint.round_amounts', 'low', 0.5),
    f('funding_reuse.same_funder_multichain', 'medium', 0.85, 'funding_reuse.same_funder_multichain:0xa'),
    f('funding_reuse.same_funder_multichain', 'medium', 0.85, 'funding_reuse.same_funder_multichain:0xb'),
    f('funding_reuse.unique_funder', 'info', 0.8),
  ]);
  const plan = fixPlan(r);
  assert.deepEqual(plan.items.map((i) => i.kind), ['now', 'now', 'habit', 'habit', 'habit', 'permanent']);
  assert.deepEqual(plan.items.slice(0, 2).map((i) => i.id), ['public_identity.ens_reverse', 'behavioral_fingerprint.wallet_software']);
  assert.ok(plan.items[0].gain! > plan.items[1].gain!);
  const habits = plan.items.filter((i) => i.kind === 'habit');
  for (let i = 1; i < habits.length; i++) assert.ok(habits[i - 1].points <= habits[i].points, 'habits: costliest first');
  const multi = plan.items.find((i) => i.id === 'funding_reuse.same_funder_multichain')!;
  assert.equal(multi.findings.length, 2, 'one item per rule');
  assert.ok(!plan.items.some((i) => i.id === 'funding_reuse.unique_funder'));
  assert.deepEqual(plan.counts, { now: 2, habit: 3, permanent: 1 });
  assert.equal(plan.items.find((i) => i.id === 'cex_exposure.deposit_address')!.learnMore, '/docs/findings/cex-exposure/#how-to-reduce-it');
});

test('advice: one entry for every rule the detectors can fire, plain text without em dash or middle dot', () => {
  const src = readdirSync(new URL('../../src/detectors/', import.meta.url)).map((n) => readFileSync(new URL(`../../src/detectors/${n}`, import.meta.url), 'utf8')).join('\n');
  const ids = [...new Set([...src.matchAll(/id: '([a-z_]+\.[a-z_]+)'/g)].map((m) => m[1]))];
  assert.equal(ids.length, 25);
  for (const id of ids) assert.ok(adviceFor(id), `advice for ${id}`);
  for (const d of DETECTORS) assert.match(learnMoreFor(d), /^\/docs\/findings\/[a-z-]+\/#how-to-reduce-it$/);
  assert.deepEqual([...NOW_RULES].sort(), ['behavioral_fingerprint.wallet_software', 'public_identity.ens_records', 'public_identity.ens_reverse']);
  const all = JSON.stringify([FIX_TEXT, VIEWER_TEXT, FRESH_WALLET, ids.map(adviceFor)]);
  assert.doesNotMatch(all, /[—·–]/);
  assert.doesNotMatch(all, /(?<!not )\b(makes?|will make|become) (you |a wallet |it )?anonymous|mixer|tornado/i, 'never promise anonymity, never point to a mixer');
  assert.match(FIX_TEXT.honest, /does not make a wallet anonymous/);
  for (const id of ids) {
    const a = adviceFor(id)!;
    for (const w of a.who) assert.ok(w in VIEWER_TEXT, `${id}: viewer ${w}`);
    if (a.kind !== 'info') assert.ok(a.steps.length >= 1 && a.action.length <= 80, `${id}: an action and its steps`);
  }
});
