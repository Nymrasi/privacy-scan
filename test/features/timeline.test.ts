// Privacy timeline: a synthetic history whose three drops are known in advance. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { privacyTimeline, rankDrops, topMove, type TimelineDrop } from '../../src/features/timeline.ts';
import type { Finding } from '../../src/types.ts';
import { rerun } from '../../src/features/replay.ts';
import type { ChainHistory, Transfer } from '../../src/history.ts';
import type { LookupCall, ScanSession } from '../../src/session.ts';
import { chainHist, mkSession } from './fixtures.ts';
import { A, ME } from '../helpers.ts';

const LISTED_DEPOSIT = '0x000f9f5f6db6d63bb64bb55d58272a1ce660fd90'; // Binance deposit address in the open label list (dawsbot/eth-labels, MIT)
const F = A(0xf1), W = A(0xf2), P = A(0xf3);
const ts = (iso: string) => Date.parse(iso) / 1000;

let seq = 0;
function t(p: Partial<Transfer> & { from: string; to: string; timestamp: number }): Transfer {
  seq++;
  return {
    chainId: p.chainId ?? 1, hash: '0x' + (0xd000 + seq).toString(16).padStart(64, '0'), block: 100000 + seq * 100, timestamp: p.timestamp,
    from: p.from, to: p.to, kind: 'native', amount: p.amount ?? 0.1, symbol: 'ETH', dir: p.from === ME ? 'out' : 'in', failed: false,
    gasLimit: 21000, isCall: p.isCall ?? false, ...(p.methodId ? { methodId: p.methodId } : {}),
  };
}

function history(rows: Transfer[], extra: Partial<ChainHistory> = {}): ChainHistory {
  return chainHist(ME, 1, rows, extra);
}

/** Funded by a wallet that funded nobody else; a deposit on 2 Mar; a fresh wallet funded on 9 Jul; a third transfer with P on 1 Oct. */
function story(profile: Partial<ScanSession['profile']> = {}, extraRows: Transfer[] = []) {
  seq = 0;
  const fund = t({ from: F, to: ME, amount: 2, timestamp: ts('2025-01-10T10:00:00Z') });
  const rows = [
    fund,
    t({ from: ME, to: A(0x51), amount: 0, isCall: true, methodId: '0x095ea7b3', timestamp: ts('2025-02-03T10:00:00Z') }),
    t({ from: ME, to: LISTED_DEPOSIT, amount: 0.73, timestamp: ts('2025-03-02T14:00:00Z') }),
    t({ from: ME, to: A(0x52), amount: 0, isCall: true, methodId: '0xa9059cbb', timestamp: ts('2025-03-01T08:00:00Z') }),
    t({ from: ME, to: W, amount: 0.21, timestamp: ts('2025-07-09T09:00:00Z') }),
    t({ from: P, to: ME, amount: 0.05, timestamp: ts('2025-08-12T09:00:00Z') }),
    t({ from: ME, to: P, amount: 0.04, timestamp: ts('2025-09-15T09:00:00Z') }),
    t({ from: ME, to: P, amount: 0.03, timestamp: ts('2025-10-01T09:00:00Z') }),
    ...extraRows,
  ];
  const q50 = { sort: 'desc' as const, offset: 50 };
  const call = (address: string, action: 'txlist' | 'tokentx', q: object, rows: Transfer[]): LookupCall => ({ chainId: 1, action, address, q, rows: Promise.resolve(rows) });
  const funderQ = { sort: 'desc' as const, offset: 200, filter: 'from' as const, startblock: 0, endblock: 9e9 };
  const lookups = [
    call(F, 'txlist', funderQ, [{ ...fund, dir: 'out' }]),
    call(W, 'txlist', q50, [{ ...rows[4], dir: 'in' }]),
    call(W, 'tokentx', q50, []),
    call(LISTED_DEPOSIT, 'txlist', q50, []),
    call(LISTED_DEPOSIT, 'tokentx', q50, []),
  ];
  const s = mkSession(ME, [history(rows)], { lookups, profile });
  return { s, rows };
}

test('the three biggest drops are the deposit, the funded wallet and the third transfer with one wallet, each with its tx', async () => {
  const { s, rows } = story();
  const scan = await rerun(s);
  const tl = await privacyTimeline(s, scan, { now: ts('2025-12-31T12:00:00Z') });
  assert.deepEqual(tl.drops.map((d) => [d.tx.hash, d.ruleId, d.delta]), [
    [rows[2].hash, 'cex_exposure.deposit_address', -20],
    [rows[4].hash, 'linked_wallets.funded_by_you', -8],
    [rows[7].hash, 'linked_wallets.back_and_forth', -4],
  ]);
  for (const d of tl.drops) {
    assert.equal(d.to - d.from, d.delta, 'a drop is the step between two replays');
    assert.ok(d.periodDelta <= d.delta, 'its period lost at least that much');
    assert.match(d.tx.url ?? '', /^https:\/\/eth\.blockscout\.com\/tx\/0x/);
  }
  assert.equal(tl.drops[0].change, 'new');
  const last = tl.points.at(-1)!;
  assert.equal(last.score, scan.score, 'the last point is exactly the scan result');
  assert.equal(tl.points.reduce((sum, p, i) => (i ? sum + p.score - tl.points[i - 1].score : sum), 0), last.score - tl.points[0].score, 'the steps add up');
  assert.equal(tl.points[0].kind, 'start');
  assert.ok(tl.points.every((p, i) => !i || p.t >= tl.points[i - 1].t), 'chronological');
  assert.equal(tl.stats.skippedLookups, 0);
});

test('zero requests: every network call fails, and none is made', async () => {
  const calls: string[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (u: unknown) => { calls.push(String(u)); throw new Error('no network in this test'); }) as typeof fetch;
  try {
    const { s } = story();
    // A recipient the scan never looked up: skipped and counted, never asked.
    s.histories[0].txs.push(t({ from: ME, to: A(0x77), amount: 0.33, timestamp: ts('2025-11-02T09:00:00Z') }));
    const tl = await privacyTimeline(s, await rerun(s));
    assert.ok(tl.stats.skippedLookups >= 1);
    assert.ok(tl.points.length > 3);
  } finally {
    globalThis.fetch = orig;
  }
  assert.equal(calls.length, 0);
});

test('a public name has no date: it counts from today only, as a last point of its own', async () => {
  const { s } = story({ ens: 'someone.eth' });
  const scan = await rerun(s);
  const tl = await privacyTimeline(s, scan);
  assert.ok(tl.undated.includes('public_identity.ens_reverse'));
  const today = tl.points.at(-1)!;
  assert.equal(today.kind, 'today');
  assert.equal(today.score, scan.score);
  // 1.4.0: an ENS name is no ceiling. It costs its own 8 points, from today only.
  assert.equal(scan.findings.find((f) => f.id === 'public_identity.ens_reverse')!.scoreImpact, -8);
  assert.equal(tl.points.at(-2)!.score - today.score, 8, 'the name lowers the score from today only');
  assert.ok(tl.points.filter((p) => p.kind !== 'today').every((p) => p.score > today.score), 'and never back in time');
});

test('a primary name set in the read history is dated by that transaction', async () => {
  const setName = t({ from: ME, to: '0xa58e81fe9b61b5c3fe2afd33cf304c454abfc7cb', amount: 0, isCall: true, methodId: '0xc47f0027', timestamp: ts('2025-05-20T12:00:00Z') });
  const { s } = story({ ens: 'someone.eth' }, [setName]);
  const scan = await rerun(s);
  const tl = await privacyTimeline(s, scan);
  assert.equal(tl.namedAt, setName.timestamp);
  assert.ok(!tl.undated.includes('public_identity.ens_reverse'));
  // 1.4.0: the name costs its 8 points from the transaction that set it, no ceiling.
  const before = tl.points.filter((p) => p.t < setName.timestamp).at(-1)!;
  const after = tl.points.find((p) => p.t >= setName.timestamp)!;
  assert.equal(before.score - after.score, 8);
  assert.ok(tl.points.filter((p) => p.t >= setName.timestamp).every((p) => p.score < before.score));
  assert.equal(tl.points.at(-1)!.score, scan.score);
});

test('a cut history: the unread middle is a gap with no points in it', async () => {
  const { s } = story();
  s.histories[0] = { ...s.histories[0], truncated: true, txs: s.histories[0].txs.filter((x) => x.timestamp >= ts('2025-06-01T00:00:00Z')) };
  const tl = await privacyTimeline(s, await rerun(s));
  assert.ok(tl.gap);
  assert.equal(tl.gap!.from, ts('2025-01-10T10:00:00Z'), 'from the first funds');
  assert.equal(tl.gap!.to, ts('2025-07-09T09:00:00Z'), 'to the oldest transaction read');
  assert.ok(tl.points.every((p) => p.t <= tl.gap!.from || p.t >= tl.gap!.to), 'no point inside the gap');
  assert.ok(tl.points.some((p) => p.t === tl.gap!.to), 'the line starts again where the read history starts');
  assert.ok(!tl.drops.some((d) => d.t > tl.gap!.from && d.t < tl.gap!.to));
});

test('a long busy history stays fast and within its replay budget', async () => {
  seq = 0;
  const start = ts('2023-01-01T00:00:00Z');
  const rows = [t({ from: F, to: ME, amount: 5, timestamp: start })];
  for (let i = 0; i < 1500; i++) {
    const at = start + Math.floor(i * (3 * 365 * 86400) / 1500) + 3600;
    rows.push(i % 3 ? t({ from: ME, to: A(0x1000 + (i % 40)), amount: 0.01 + (i % 17) / 1000, timestamp: at }) : t({ from: A(0x1000 + (i % 40)), to: ME, amount: 0.02 + (i % 13) / 1000, timestamp: at }));
  }
  const s = mkSession(ME, [history(rows)]);
  const t0 = performance.now();
  const tl = await privacyTimeline(s, await rerun(s));
  const ms = performance.now() - t0;
  assert.ok(tl.points.length <= 40, `points ${tl.points.length}`);
  assert.ok(tl.stats.recomputations <= tl.points.length + 200, `replays ${tl.stats.recomputations}`);
  assert.ok(ms < 4000, `took ${Math.round(ms)} ms`);
  console.log(`timeline: 1500 transfers over 3 years, ${tl.points.length} points, ${tl.stats.recomputations} replays, ${Math.round(ms)} ms`);
});

test('the drop names the finding that moved most, and the list is ordered by the single biggest step', () => {
  const f = (key: string, scoreImpact: number): Finding => ({ id: key, key, detector: 'linked_wallets', severity: 'high', confidence: 0.7, scoreImpact, rawImpact: scoreImpact, title: key, explanation: '', evidence: [], chains: [1] });
  const moved = topMove([f('a', -20)], [f('a', -21), f('b', -8)]);
  assert.equal(moved?.f.key, 'b', 'a new 8-point finding beats an old one that grew by 1');
  assert.equal(moved?.isNew, true);
  const d = (delta: number, t: number) => ({ delta, t }) as TimelineDrop;
  assert.deepEqual(rankDrops([d(-4, 1), d(-10, 2), d(-6, 3)]).map((x) => x.delta), [-10, -6, -4]);
});

test('funding counts from the first transaction it paid for, and each moment counts only what was signed by then', async () => {
  seq = 0;
  const BINANCE = '0x28c6c06298d514db089934071355e5743bf21d60';
  const BASE_ID = 8453;
  // Ethereum: Binance pays on 10 Jan; the wallet first signs on 20 Jan (a contract call).
  const eth = [
    t({ from: BINANCE, to: ME, amount: 1, timestamp: ts('2025-01-10T10:00:00Z') }),
    t({ from: ME, to: A(0x51), amount: 0, isCall: true, methodId: '0x095ea7b3', timestamp: ts('2025-01-20T10:00:00Z') }),
    t({ from: ME, to: A(0x52), amount: 0, isCall: true, methodId: '0x095ea7b3', timestamp: ts('2025-06-20T10:00:00Z') }),
  ];
  // Base: coins arrive on 5 Feb, the wallet first sends there on 3 May. Today's chain count is 4.
  const base = [
    { ...t({ from: A(0x60), to: ME, amount: 0.5, timestamp: ts('2025-02-05T10:00:00Z') }), chainId: BASE_ID },
    { ...t({ from: ME, to: A(0x61), amount: 0.1, timestamp: ts('2025-05-03T10:00:00Z') }), chainId: BASE_ID },
  ];
  const s = mkSession(ME, [chainHist(ME, 1, eth), chainHist(ME, BASE_ID, base, { nonce: 4 })]);
  const scan = await rerun(s);
  assert.deepEqual(scan.findings.map((f) => [f.id, f.scoreImpact]), [['cex_exposure.funded_by_cex', -14], ['cex_exposure.direct', -4], ['cross_chain.multichain_presence', -4]]);
  const tl = await privacyTimeline(s, scan, { now: ts('2025-07-31T12:00:00Z') });
  const at = (iso: string) => tl.points.find((p) => p.t >= ts(iso))!.score;
  // 10 Jan: Binance's transfer is an exchange transfer (-4), but nothing is signed yet, so it is no funding.
  assert.equal(tl.points[0].score, 96);
  // The funding counts from the first transaction it paid for (20 Jan), and Base only from the first send there (3 May).
  assert.deepEqual(tl.drops.map((d) => [new Date(d.t * 1000).toISOString().slice(0, 10), d.ruleId, d.delta]), [
    ['2025-01-20', 'cex_exposure.funded_by_cex', -14],
    ['2025-05-03', 'cross_chain.multichain_presence', -4],
  ]);
  assert.equal(at('2025-04-30T00:00:00Z'), 82, "today's count of 4 on Base does not make Base active in April");
  assert.equal(at('2025-05-31T00:00:00Z'), 78);
});
