// Compare: can two wallets be linked? Synthetic sessions, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareWallets } from '../../src/features/compare.ts';
import type { Transfer } from '../../src/history.ts';
import type { LookupCall, ScanSession } from '../../src/session.ts';
import { sessionFrom } from './fixtures.ts';
import { A, T0 } from '../helpers.ts';

const WA = '0xaaaa00000000000000000000000000000000aaaa';
const WB = '0xbbbb00000000000000000000000000000000bbbb';
const BINANCE = '0x28c6c06298d514db089934071355e5743bf21d60';
const LISTED_DEPOSIT = '0x000f9f5f6db6d63bb64bb55d58272a1ce660fd90'; // Binance deposit address in the open label list (dawsbot/eth-labels, MIT)

let seq = 0;
/** A transfer as seen by `me`. */
function t(me: string, p: Partial<Transfer> & { from: string; to: string }): Transfer {
  seq++;
  return {
    chainId: p.chainId ?? 1, hash: '0x' + seq.toString(16).padStart(64, '0'), block: p.block ?? 1000 + seq, timestamp: p.timestamp ?? T0 + seq * 600,
    from: p.from, to: p.to, kind: p.kind ?? 'native', amount: p.amount ?? 0.1, symbol: p.symbol ?? 'ETH',
    dir: p.from === me ? (p.to === me ? 'self' : 'out') : 'in', failed: false, gasLimit: p.gasLimit ?? 21000, isCall: p.isCall ?? false,
    ...(p.methodId ? { methodId: p.methodId } : {}), ...(p.cp ? { cp: p.cp } : {}), ...(p.token ? { token: p.token } : {}),
  };
}

function session(me: string, rows: Transfer[], lookups: LookupCall[] = [], profile: Partial<ScanSession['profile']> = {}, nonces: Record<string, number | null> = {}): ScanSession {
  return sessionFrom(me, rows, { lookups, profile, nonces });
}

/** The same transaction as seen by the other wallet (same hash, other direction). */
const seen = (x: Transfer, me: string): Transfer => ({ ...x, dir: x.from === me ? 'out' : 'in' });

const funded = (me: string) => t(me, { from: BINANCE, to: me, amount: 1, timestamp: T0 - 9 * 86400 });

test('a shared exchange deposit address: Likely, with the deposit address as the reason', async () => {
  const a = session(WA, [funded(WA), t(WA, { from: WA, to: LISTED_DEPOSIT, amount: 0.5 })]);
  const b = session(WB, [funded(WB), t(WB, { from: WB, to: LISTED_DEPOSIT, amount: 0.7 })]);
  const c = await compareWallets(a, b);
  assert.equal(c.level, 'likely');
  assert.equal(c.confidence, 0.8);
  assert.equal(c.reasons[0].kind, 'shared_deposit');
  assert.equal(c.reasons[0].evidence[0].address, LISTED_DEPOSIT);
  assert.match(c.reasons[0].text, /Binance deposit address/);
  assert.deepEqual(c.reasons[0].trail, { kind: 'via', role: 'deposit', address: LISTED_DEPOSIT, chainId: 1, label: 'Binance deposit' });
});

test('no relation: no link found, with the coverage of both, never "not linked"', async () => {
  const a = session(WA, [funded(WA), t(WA, { from: WA, to: A(0x301), amount: 0.4 })]);
  const b = session(WB, [funded(WB), t(WB, { from: WB, to: A(0x302), amount: 0.6, chainId: 8453 })]);
  const c = await compareWallets(a, b);
  assert.equal(c.level, null);
  assert.equal(c.confidence, 0);
  assert.deepEqual(c.reasons, []);
  assert.deepEqual([c.coverage.read.a, c.coverage.read.b], [1, 2]);
});

test('A sent the first funds of B: funded_by_you at 0.60, and the same transfer is not counted twice', async () => {
  const pay = t(WA, { from: WA, to: WB, amount: 0.25, timestamp: T0 });
  const a = session(WA, [funded(WA), pay]);
  const b = session(WB, [seen(pay, WB), t(WB, { from: WB, to: A(0x401), amount: 0.1, isCall: true })]);
  const c = await compareWallets(a, b);
  assert.deepEqual(c.reasons.map((r) => [r.kind, r.confidence]), [['funded', 0.6]]);
  assert.deepEqual(c.reasons[0].trail, { kind: 'flow', aToB: 1, bToA: 0, chains: [1] }, 'A paid B: one transfer from A to B');
  assert.equal(c.confidence, 0.6);
  assert.equal(c.level, 'possible');
});

test('back and forth: the engine formula (3 out, 2 in = 0.61)', async () => {
  const rows = (me: string) => [
    t(me, { from: WA, to: WB, amount: 0.11 }), t(me, { from: WB, to: WA, amount: 0.12 }), t(me, { from: WA, to: WB, amount: 0.13 }),
    t(me, { from: WB, to: WA, amount: 0.14 }), t(me, { from: WA, to: WB, amount: 0.15 }),
  ];
  seq -= 5; // the same five transfers on both sides
  const ra = rows(WA);
  seq -= 5;
  const rb = rows(WB);
  const c = await compareWallets(session(WA, [funded(WA), ...ra]), session(WB, [funded(WB), ...rb]));
  const d = c.reasons.find((r) => r.kind === 'direct')!;
  assert.equal(d.confidence, Math.round(Math.min(0.85, 0.35 + 0.08 * 2 + 0.02 * 5) * 100) / 100);
  assert.equal(d.level, 'possible');
  assert.deepEqual(d.trail, { kind: 'flow', aToB: 3, bToA: 2, chains: [1] });

  // Only one way (three payments, none back): a visible trail, but weak.
  const fa = funded(WA), fb = funded(WB); // first funds before the payments, by block as on a real chain
  const one = [0.31, 0.32, 0.33].map((amount) => t(WA, { from: WA, to: WB, amount }));
  const w = await compareWallets(session(WA, [fa, ...one]), session(WB, [fb, ...one.map((x) => seen(x, WB))]));
  assert.deepEqual(w.reasons.map((r) => [r.kind, r.confidence, r.level]), [['direct', 0.3, 'weak']]);
  assert.deepEqual(w.reasons[0].trail, { kind: 'flow', aToB: 3, bToA: 0, chains: [1] });
});

/** The wallet's first own transaction: a contract call, so its funding is what paid for it (RULES 1.2.0). */
const use = (me: string, timestamp: number) => t(me, { from: me, to: A(0xc0de), amount: 0, isCall: true, methodId: '0x095ea7b3', timestamp });

test('the same first funder: Possible within 3 days with its sibling count, Weak when far apart', async () => {
  const F = A(0x501);
  const q = { sort: 'desc' as const, offset: 200, filter: 'from' as const, startblock: 0, endblock: 99999 };
  const fundA = { from: F, to: WA, amount: 1, timestamp: T0 }, fundB = { from: F, to: WB, amount: 1, timestamp: T0 + 3600 };
  const rows = [t(F, fundA), t(F, fundB), t(F, { from: F, to: A(0x502), amount: 1, timestamp: T0 + 7200 })];
  const rec: LookupCall = { chainId: 1, action: 'txlist', address: F, q, rows: Promise.resolve(rows) };
  const sA = () => session(WA, [t(WA, fundA), use(WA, T0 + 600)], [rec]);
  const c = await compareWallets(sA(), session(WB, [t(WB, fundB), use(WB, T0 + 4000)]));
  const r = c.reasons.find((x) => x.kind === 'shared_funder')!;
  assert.equal(r.confidence, Math.round(0.75 * 0.75 * 100) / 100, 'k = 2 other wallets: 0.75, times 0.75 for a sibling link');
  assert.equal(c.level, 'possible', "a shared funder alone stays Possible: the engine's own calibration");
  assert.deepEqual(r.trail, { kind: 'via', role: 'funder', address: F, chainId: 1 });

  const late = { from: F, to: WB, amount: 1, timestamp: T0 + 40 * 86400 };
  const far = await compareWallets(sA(), session(WB, [t(WB, late), use(WB, T0 + 40 * 86400 + 600)]));
  const rf = far.reasons.find((x) => x.kind === 'shared_funder')!;
  assert.deepEqual([rf.confidence, rf.level, rf.weak], [0.3, 'weak', true]);
  // Ten days apart is already far: only within 3 days does the funder count at full strength.
  const tenDays = { from: F, to: WB, amount: 1, timestamp: T0 + 10 * 86400 };
  const ten = (await compareWallets(sA(), session(WB, [t(WB, tenDays), use(WB, T0 + 10 * 86400 + 600)]))).reasons.find((x) => x.kind === 'shared_funder')!;
  assert.deepEqual([ten.confidence, ten.weak], [0.3, true]);
  assert.match(ten.text, /10 days apart, which makes it weaker/);

  // RULES 1.2.0: coins that arrived where a wallet never signed anything are not its funding.
  const idle = await compareWallets(sA(), session(WB, [t(WB, fundB)]));
  assert.ok(!idle.reasons.some((x) => x.kind === 'shared_funder'), 'B never sent: it has no funder');
  // A service or a bot funds crowds: by its own count of sent transactions, or more than 40 wallets in the window.
  const svc = await compareWallets(session(WA, [t(WA, fundA), use(WA, T0 + 600)], [rec], {}, { [`1:${F}`]: 2500 }), session(WB, [t(WB, fundB), use(WB, T0 + 4000)]));
  assert.ok(!svc.reasons.some((x) => x.kind === 'shared_funder'), 'a funder with 2,500 sent transactions is a service');
  const crowd = [...rows, ...Array.from({ length: 41 }, (_, i) => t(F, { from: F, to: A(0x9000 + i), amount: 1, timestamp: T0 + 100 + i }))];
  const dist = await compareWallets(session(WA, [t(WA, fundA), use(WA, T0 + 600)], [{ ...rec, rows: Promise.resolve(crowd) }]), session(WB, [t(WB, fundB), use(WB, T0 + 4000)]));
  assert.ok(!dist.reasons.some((x) => x.kind === 'shared_funder'), 'a funder of 43 wallets in the window is a distributor');
  // 200 sends around the funding is a bot, even when they went to few wallets (here: contract calls).
  const busy = [...rows, ...Array.from({ length: 197 }, (_, i) => t(F, { from: F, to: A(0x777), amount: 0, isCall: true, timestamp: T0 + 200 + i }))];
  const bot = await compareWallets(session(WA, [t(WA, fundA), use(WA, T0 + 600)], [{ ...rec, rows: Promise.resolve(busy) }]), session(WB, [t(WB, fundB), use(WB, T0 + 4000)]));
  assert.ok(!bot.reasons.some((x) => x.kind === 'shared_funder'), 'a funder with 200 sends in the window is a crowd, not a link');
});

test('RULES 1.2.0: a service, a busy wallet and a look-alike are never a link; gaps travel with the answer', async () => {
  const flows = [{ from: WA, to: WB, amount: 0.21 }, { from: WB, to: WA, amount: 0.22 }, { from: WA, to: WB, amount: 0.23 }];
  const pair = (b: string, nb?: number) => {
    const base = seq;
    const ra = flows.map((p) => t(WA, { ...p, to: p.to === WB ? b : p.to, from: p.from === WB ? b : p.from }));
    seq = base;
    const rb = flows.map((p) => t(b, { ...p, to: p.to === WB ? b : p.to, from: p.from === WB ? b : p.from }));
    const sb = session(b, rb);
    if (nb !== undefined) sb.histories[0].nonce = nb;
    return [session(WA, ra), sb] as const;
  };
  const plain = await compareWallets(...pair(WB));
  assert.equal(plain.reasons[0]?.kind, 'direct', 'the control: three transfers between two quiet wallets');

  const busy = await compareWallets(...pair(WB, 2400));
  assert.deepEqual(busy.busy, [{ wallet: 'b', chainId: 1, sent: 2400 }]);
  assert.equal(busy.level, null, '2,400 sent transactions on Ethereum: a service or a bot there, so nothing on Ethereum links them');

  const ex = await compareWallets(...pair('0x28c6c06298d514db089934071355e5743bf21d60'));
  assert.match(ex.notPersonal.b ?? '', /^an exchange wallet \(Binance\)$/);
  assert.deepEqual([ex.level, ex.reasons.length], [null, 0]);

  const fake = WA.slice(0, 6) + '1'.repeat(32) + WA.slice(-4);
  const look = await compareWallets(...pair(fake));
  assert.deepEqual([look.lookalike, look.level, look.reasons.length], [true, null, 0], 'a look-alike is address poisoning, never a link');

  // Token events "from" a wallet that never signed anything on that chain: forged, never back and forth.
  const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'; // a real token: its events are kept as real transfers
  const tok = (from: string, to: string, me: string) => t(me, { from, to, kind: 'token', symbol: 'USDC', amount: 25, token: USDC });
  const forged = await compareWallets(session(WA, [tok(WA, A(0x8888), WA), tok(A(0x8888), WA, WA), tok(WA, A(0x8888), WA)]), session(A(0x8888), [tok(WA, A(0x8888), A(0x8888))]));
  assert.ok(!forged.reasons.some((x) => x.kind === 'direct'), 'neither signed anything on Ethereum: token events alone are no trail');
  const real = await compareWallets(session(WA, [use(WA, T0), tok(WA, A(0x8888), WA), tok(A(0x8888), WA, WA)]), session(A(0x8888), [tok(WA, A(0x8888), A(0x8888)), tok(A(0x8888), WA, A(0x8888))]));
  assert.deepEqual(real.reasons.filter((x) => x.kind === 'direct').map((x) => x.title), [`${WA.slice(0, 6)}...${WA.slice(-4)} sent to 0x0000...8888`], 'only the side that signed counts');
  // A plain transaction is its sender's own signature: it counts even where that wallet's scan shows none.
  const sent = tok(WA, A(0x8888), WA);
  const signedTx = await compareWallets(session(WA, [use(WA, T0), sent, t(WA, { from: A(0x8888), to: WA, amount: 0.2 })]), session(A(0x8888), [seen(sent, A(0x8888))]));
  const dp = signedTx.reasons.find((x) => x.kind === 'direct')!;
  assert.equal(dp.title, 'One transfer each way between them');
  assert.match(dp.text, /^1 transfer from 0xaaaa\.\.\.aaaa to 0x0000\.\.\.8888 and 1 back, on Ethereum\./);

  const [sa, sb] = pair(A(0x7777));
  sb.incomplete.push({ part: 'chain', chainId: 8453, name: 'Base', reason: 'Base: rate limit reached' });
  const gap = await compareWallets(sa, sb);
  assert.deepEqual(gap.gaps.b.map((g) => g.part), ['chain']);
});

test('a shared funder plus back and forth: Likely, the confidences combine as 1 - (1 - a)(1 - b)', async () => {
  const F = A(0x601);
  const fundA = { from: F, to: WA, amount: 1, timestamp: T0 }, fundB = { from: F, to: WB, amount: 1, timestamp: T0 + 600 };
  const flows = [{ from: WA, to: WB, amount: 0.21 }, { from: WB, to: WA, amount: 0.22 }, { from: WA, to: WB, amount: 0.23 }];
  const base = seq;
  const ra = [t(WA, fundA), t(WA, fundB), ...flows.map((p) => t(WA, p))].filter((x) => x.to === WA || x.from === WA);
  seq = base;
  const rb = [t(WB, fundA), t(WB, fundB), ...flows.map((p) => t(WB, p))].filter((x) => x.to === WB || x.from === WB);
  const c = await compareWallets(session(WA, ra), session(WB, rb));
  const kinds = c.reasons.map((r) => r.kind).sort();
  assert.deepEqual(kinds, ['direct', 'shared_funder']);
  const expect = Math.round((1 - c.reasons.reduce((p, r) => p * (1 - r.confidence), 1)) * 100) / 100;
  assert.equal(c.confidence, expect);
  assert.equal(c.level, 'likely');
});

test('only a similar fingerprint: at most Weak 0.25, never Likely', async () => {
  const day = 86400;
  const calls = (me: string) => Array.from({ length: 30 }, (_, i) => t(me, {
    from: me, to: A(0x700 + (i % 4)), amount: 0, isCall: true, gasLimit: 250000, methodId: i % 2 ? '0x11111111' : '0x22222222',
    timestamp: T0 - (T0 % day) + (i % 15) * day + (8 + (i % 14)) * 3600,
  }));
  const c = await compareWallets(session(WA, [funded(WA), ...calls(WA)]), session(WB, [funded(WB), ...calls(WB)]));
  assert.deepEqual(c.reasons.map((r) => r.kind), ['fingerprint']);
  assert.ok(c.confidence <= 0.25);
  assert.equal(c.level, 'weak');
  assert.match(c.reasons[0].text, /Many people share habits/);
  assert.deepEqual(c.reasons[0].trail, { kind: 'habits' });
});

test('a bridge from one to the other: exact amounts Possible, round amounts only Weak', async () => {
  const out = { from: WA, to: A(0x801), amount: 0.4837, timestamp: T0 + 1000, chainId: 1 };
  const inn = { from: A(0x802), to: WB, amount: 0.4801, timestamp: T0 + 1300, chainId: 8453 };
  const c = await compareWallets(session(WA, [funded(WA), t(WA, out)]), session(WB, [funded(WB), t(WB, inn)]));
  const r = c.reasons.find((x) => x.kind === 'bridge')!;
  assert.deepEqual([r.confidence, r.level], [0.55, 'possible']);
  assert.deepEqual(r.trail, { kind: 'bridge', from: 'a', chains: [1, 8453] });
  const round = await compareWallets(session(WA, [funded(WA), t(WA, { ...out, amount: 0.5 })]), session(WB, [funded(WB), t(WB, { ...inn, amount: 0.4985 })]));
  const rr = round.reasons.find((x) => x.kind === 'bridge')!;
  assert.deepEqual([rr.confidence, rr.level, rr.weak], [0.25, 'weak', true]);
});

test('the same address is refused; no reason text claims ownership', async () => {
  const a = session(WA, [funded(WA)]);
  await assert.rejects(compareWallets(a, a), /same address/);
  const b = session(WB, [funded(WB), t(WB, { from: WB, to: LISTED_DEPOSIT, amount: 0.7 })]);
  const c = await compareWallets(session(WA, [funded(WA), t(WA, { from: WA, to: LISTED_DEPOSIT, amount: 0.5 })]), b);
  for (const r of c.reasons) {
    assert.doesNotMatch(r.title + r.text, /same owner|owned by|belongs to (you|him|her|them)\b|is your wallet/i);
    assert.doesNotMatch(r.title + r.text, /[—·]/);
    assert.ok(r.confidence > 0 && r.confidence < 1);
  }
});
