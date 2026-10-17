// Replaying a scan from its session: same result, no request, a moved block window still matches.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { replayLookup, replayNonces, rerun } from '../../src/features/replay.ts';
import { CHAIN_BY_ID } from '../../src/chains.ts';
import type { ScanSession } from '../../src/session.ts';
import { A, hist, ME, T0, tx } from '../helpers.ts';
import { mkSession } from './fixtures.ts';

const ETH = CHAIN_BY_ID.get(1)!;
const FUNDER = A(0xf00);

function session(): ScanSession {
  const rows = [tx({ from: FUNDER, to: ME, amount: 1, timestamp: T0, block: 5000 }), tx({ to: A(0x61), amount: 0.2, timestamp: T0 + 100, block: 5010 })];
  const q = { sort: 'desc' as const, offset: 200, filter: 'from' as const, startblock: 4000, endblock: 6000 };
  const sib = [tx({ from: FUNDER, to: A(0x62), amount: 1, timestamp: T0 + 50, dir: 'out' }), tx({ from: FUNDER, to: A(0x63), amount: 1, timestamp: T0 + 60, dir: 'out' })];
  return mkSession(ME, [hist(1, rows)], { lookups: [{ chainId: 1, action: 'txlist', address: FUNDER, q, rows: Promise.resolve(sib) }] });
}

test('replayLookup: the recorded answer, also when the block window moved; anything else is skipped and noted', async () => {
  const s = session();
  const { lookup, missed } = replayLookup(s);
  const moved = await lookup(ETH, 'txlist', FUNDER, { sort: 'desc', offset: 200, filter: 'from', startblock: 4100, endblock: 5900 });
  assert.equal(moved?.length, 2, 'same question, other window: the recorded rows');
  assert.equal(await lookup(ETH, 'txlist', A(0x61), { sort: 'desc', offset: 50 }), null);
  assert.deepEqual([...missed], [`1|txlist|${A(0x61)}`]);
  assert.equal(await lookup(ETH, 'tokentx', FUNDER, { sort: 'desc', offset: 200, filter: 'from' }), null, 'another list is another question');
});

test('rerun: the funder record gives the same shared-funder finding, with no network at all', async () => {
  const s = session();
  const calls: string[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (u: unknown) => { calls.push(String(u)); throw new Error('no network'); }) as typeof fetch;
  try {
    const r = await rerun(s);
    const f = r.findings.find((x) => x.id === 'funding_reuse.shared_funder');
    assert.ok(f, 'shared funder from the record');
    assert.deepEqual(f!.related!.map((x) => x.address).sort(), [A(0x62), A(0x63)].sort());
    assert.equal(100 + r.findings.reduce((a, x) => a + x.scoreImpact, 0), r.score);
  } finally {
    globalThis.fetch = orig;
  }
  assert.equal(calls.length, 0);
});

test('rerun of a partial scan is just as partial, and keeps the address-poisoning warning', async () => {
  // A look-alike of this wallet sent it a zero transfer: the warning, never a link.
  const fake = ME.slice(0, 6) + 'e'.repeat(33) + ME.slice(-3);
  const rows = [tx({ from: FUNDER, to: ME, amount: 1, timestamp: T0, block: 5000 }), tx({ to: A(0x61), amount: 0.2, timestamp: T0 + 100, block: 5010 }), tx({ from: fake, to: ME, amount: 0, timestamp: T0 + 200, block: 5020 })];
  const gap = { part: 'chain' as const, chainId: 8453, name: 'Base', reason: 'Base: rate limit reached' };
  const s = mkSession(ME, [hist(1, rows)], { incomplete: [gap] });
  const r = await rerun(s);
  assert.equal(r.status, 'partial');
  assert.deepEqual(r.incomplete, [gap]);
  assert.deepEqual(r.warnings.flatMap((w) => w.lookalikes.map((l) => [l.address, l.imitates])), [[fake, ME]]);
  assert.equal((await rerun(mkSession(ME, [hist(1, rows)]))).status, 'complete');
});

test('replayNonces: a count the feature read itself answers, the record answers the rest, an unchecked address stays unknown', async () => {
  const s = mkSession(ME, [hist(1, [tx({ from: FUNDER, to: ME, amount: 1, timestamp: T0, block: 5000 })])], { nonces: { [`1:${FUNDER}`]: 3 } });
  const dest = A(0x77);
  const n = await replayNonces(s, [[`1:${dest}`, 9]])([{ address: FUNDER, chainId: 1 }, { address: dest, chainId: 1 }, { address: A(0x78), chainId: 1 }]);
  assert.deepEqual([...n.entries()].sort(), [[FUNDER, 3], [dest, 9]].sort());
  assert.equal((await replayNonces(s)([{ address: dest, chainId: 1 }])).size, 0, 'without the feature\'s own read it is unknown, never guessed');
});

test('rerun of a bot (50,000+ sent on a chain, rules 1.3.0 A12) replays as a bot: no link rules, the same as the scan', async () => {
  // Back and forth with one wallet: for a person that is a link; for a bot it is traffic.
  const P = A(0x91);
  const rows = [tx({ from: FUNDER, to: ME, amount: 1, timestamp: T0, block: 5000 })];
  for (let i = 0; i < 6; i++) rows.push(tx({ to: P, amount: 0.11 + i / 100, timestamp: T0 + 1000 * i + 100, block: 5010 + 2 * i }), tx({ from: P, to: ME, amount: 0.12 + i / 100, timestamp: T0 + 1000 * i + 500, block: 5011 + 2 * i }));
  const person = hist(1, rows);
  const bot = { ...person, coverage: { ...person.coverage, precheck: { sent: 60_000, holds: true } } };
  const asPerson = await rerun(mkSession(ME, [person]));
  assert.ok(asPerson.findings.some((f) => f.id.startsWith('linked_wallets.')), 'a person with six round trips has a link finding');
  const asBot = await rerun(mkSession(ME, [bot]));
  assert.ok(!asBot.findings.some((f) => f.id.startsWith('linked_wallets.') || f.id.startsWith('funding_reuse.')), 'a bot gets no link rules in a replay either');
  assert.equal(asBot.identity.service?.kind, 'bot');
});
