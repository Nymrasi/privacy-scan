// The three mock results (bad, average, good), produced by the REAL detectors and score formula on
// synthetic histories, like fixtures/worked-example.json. No network. Every address is synthetic,
// except the public exchange hot wallets used as counterparties (Binance 14, Coinbase 10).
// scripts/make-fixtures.ts writes them; test/fixtures.test.ts fails when a committed fixture is not
// what the engine gives today, so a fixture can never claim a number the rules cannot produce.
import { CHAIN_BY_ID, defaultChainIds } from '../src/chains.ts';
import type { DetectorContext, Profile } from '../src/detectors/context.ts';
import { analyzeRecipients } from '../src/detectors/deposits.ts';
import { DETECTOR_LIST } from '../src/detectors/index.ts';
import { poisoningWarning } from '../src/detectors/poisoning.ts';
import { fundingOf, type ChainHistory, type Transfer } from '../src/history.ts';
import { assemble } from '../src/scan.ts';
import { createHttp } from '../src/sources/http.ts';
import type { ChainCoverage, ScanResult } from '../src/types.ts';

/**
 * The only name in any fixture. `.example` is reserved by IANA for documentation (RFC 2606, RFC 6761)
 * and never delegated in DNS, so no ENS name (a .eth name, or a DNS name brought into ENS) can ever be
 * it: the example points at nobody, now or later. A .eth name of 1 or 2 characters is only blocked by
 * the registrar's current 3-character minimum, which the ENS DAO could change. (2026-10-16: the earlier
 * name turned out to be a real, registered ENS name.)
 */
export const EXAMPLE_NAME = 'alice.example';
const BINANCE14 = '0x28c6c06298d514db089934071355e5743bf21d60';
const COINBASE10 = '0xa9d1e08c7793af67e9d92fe308d5697fb81d3e43';
const T0 = 1_756_944_000; // 2025-09-04 00:00 UTC, the start of every story (hours below are UTC hours)
const DAY = 86400;

/** Deterministic pseudo-random numbers (mulberry32), so the same code gives the same fixtures. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One wallet's story: transfers on chains, seen from that wallet, with lookups of other addresses. */
function story(me: string, seed: number) {
  const r = rng(seed);
  let seq = 0;
  const hash = () => '0x' + (seed * 1000 + ++seq).toString(16).padStart(64, 'f');
  const blockOf = (chainId: number, ts: number) => 18_000_000 + Math.floor((ts - T0 + 400 * DAY) / ((CHAIN_BY_ID.get(chainId)!.id === 1 ? 12 : 2)));
  /** A moment on day `d` at a UTC hour in [from, to): never the same gap twice, so no fixed rhythm. */
  const at = (d: number, from = 7, to = 23) => T0 + d * DAY + Math.floor((from + r() * (to - from)) * 3600);
  /** A transfer seen from `self` (the scanned wallet, or a looked-up address). */
  const t = (self: string, p: Partial<Transfer> & { from: string; to: string; timestamp: number }): Transfer => {
    const chainId = p.chainId ?? 1;
    return {
      chainId, hash: hash(), block: blockOf(chainId, p.timestamp), kind: 'native', amount: 0.1, symbol: CHAIN_BY_ID.get(chainId)!.native,
      dir: p.from === self ? (p.to === self ? 'self' : 'out') : 'in', failed: false,
      gasPrice: Math.round((0.8 + r() * 30) * 1e4) / 1e4, gasLimit: 21000, isCall: false, ...p,
    };
  };
  return { me, r, at, t, mine: (p: Partial<Transfer> & { from: string; to: string; timestamp: number }) => t(me, p) };
}

/** A chain history the way history.ts builds one, with the coverage a real scan writes for it. */
function hist(me: string, chainId: number, rows: Transfer[], durationMs: number): ChainHistory {
  const chain = CHAIN_BY_ID.get(chainId)!;
  const sorted = [...rows].sort((a, b) => b.block - a.block);
  const txs = sorted.filter((x) => x.kind === 'native'), tokens = sorted.filter((x) => x.kind === 'token'), internal = sorted.filter((x) => x.kind === 'internal');
  const own = txs.filter((x) => x.from === me).sort((a, b) => a.block - b.block);
  const firstFunding = fundingOf(own[0], sorted);
  const ts = sorted.map((x) => x.timestamp);
  const coverage: ChainCoverage = {
    chainId, name: chain.name, status: 'scanned', source: chain.source.kind, txCount: txs.length, tokenTransferCount: tokens.length,
    internalTransfers: chain.traces === false ? 'none' : 'full', truncated: false, limitations: [...(chain.limits ?? [])], missing: [],
    precheck: { sent: own.length, holds: true }, firstSeen: Math.min(...ts, ...(firstFunding ? [firstFunding.timestamp] : [])), lastSeen: Math.max(...ts), durationMs,
  };
  return { chain, txs, tokens, internal, nonce: own.length, code: false, ownCount: own.length, firstOwn: own[0], firstFunding, truncated: false, coverage };
}

/** Every other default chain, as the quick RPC check leaves it: nothing sent, nothing held. */
function quiet(active: ChainHistory[]): ChainCoverage[] {
  const seen = new Set(active.map((h) => h.chain.id));
  return defaultChainIds().filter((id) => !seen.has(id)).map((id) => {
    const c = CHAIN_BY_ID.get(id)!;
    return {
      chainId: id, name: c.name, status: 'no_activity', source: c.source.kind, txCount: 0, tokenTransferCount: 0,
      internalTransfers: c.traces === false ? 'none' : 'full', truncated: false,
      limitations: [...(c.limits ?? []), `Quick check only: no transaction sent and no ${c.native} held. Tokens that were only received are not listed.`],
      missing: [], precheck: { sent: 0, holds: false }, durationMs: 140,
    };
  });
}

async function run(me: string, histories: ChainHistory[], profile: Partial<Profile>, lookup: DetectorContext['lookup'], nonces: Record<string, number>, durationMs: number): Promise<ScanResult> {
  const ctx: DetectorContext = {
    me, histories, http: createHttp({ fetch: (() => { throw new Error('offline'); }) as any, cache: null }),
    profile: { isContract: false, ensRecords: {}, ownedNames: [], tags: [], ...profile },
    lookup, nonces: async (items) => new Map(items.filter((i) => nonces[i.address] !== undefined).map((i) => [i.address, nonces[i.address]])),
    memo: new Map(),
  };
  const findings = (await Promise.all(DETECTOR_LIST.map((d) => d.run(ctx)))).flat();
  // The same steps as scan(): detectors, then the address-poisoning warning, then the result.
  const warning = poisoningWarning(ctx, await analyzeRecipients(ctx));
  const r = assemble(me, findings, [...histories.map((h) => h.coverage), ...quiet(histories)], ctx.profile, 0, '2026-10-16T01:30:00.000Z', 'complete', {}, [], warning ? [warning] : []);
  r.durationMs = durationMs;
  return r;
}

// ---------- bad: a public name, a Binance deposit address shared with another wallet, a friend it trades with, 5 chains, a clear time zone ----------
async function bad(): Promise<ScanResult> {
  const ME = '0x7a3f9c1e2b4d5a6c8e0f1a2b3c4d5e6f7a8b9c0d';
  const SIB = '0x5e1d2c3b4a59687766554433221100ffeeddccbb';     // also pays into the deposit address
  const FRIEND = '0x9a8b7c6d5e4f30211203f4e5d6c7b8a9fa0b1c2d';  // back and forth
  const DEPOSIT = '0x3c2b1a0f9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b'; // forwards to Binance
  const s = story(ME, 1);
  const shops = Array.from({ length: 9 }, (_, i) => '0x' + (0x61 + i).toString(16).repeat(20));
  const eth: Transfer[] = [s.mine({ from: BINANCE14, to: ME, amount: 2.4381, timestamp: s.at(0) })];
  // 14 deposits into the same address, spread over months.
  for (let i = 0; i < 14; i++) eth.push(s.mine({ from: ME, to: DEPOSIT, amount: +(0.05 + s.r() * 0.9).toFixed(4), timestamp: s.at(3 + i * 9) }));
  // Two-way with one friend: 3 out, 2 in.
  for (const [i, out] of [[0, true], [1, false], [2, true], [3, false], [4, true]] as const) {
    eth.push(out ? s.mine({ from: ME, to: FRIEND, amount: +(0.02 + s.r() * 0.3).toFixed(4), timestamp: s.at(10 + i * 17) })
      : s.mine({ from: FRIEND, to: ME, amount: +(0.01 + s.r() * 0.2).toFixed(4), timestamp: s.at(11 + i * 17) }));
  }
  // Payments to nine different wallets, and two withdrawals to Binance.
  shops.forEach((a, i) => eth.push(s.mine({ from: ME, to: a, amount: +(0.003 + s.r() * 0.08).toFixed(4), timestamp: s.at(5 + i * 13) })));
  eth.push(s.mine({ from: ME, to: BINANCE14, amount: 0.7712, timestamp: s.at(140) }), s.mine({ from: BINANCE14, to: ME, amount: 0.3297, timestamp: s.at(151) }));
  // The same address on four more chains, each funded from Binance or Coinbase. Not BNB Smart Chain: it
  // needs the relay's key, and a demo must not show a chain a scan may not read.
  const on = (chainId: number, funder: string, start: number, n: number) => {
    const rows = [s.mine({ chainId, from: funder, to: ME, amount: +(0.04 + s.r() * 0.2).toFixed(4), timestamp: s.at(start) })];
    for (let i = 0; i < n; i++) rows.push(s.mine({ chainId, from: ME, to: shops[(i + chainId) % shops.length], amount: +(0.001 + s.r() * 0.02).toFixed(4), timestamp: s.at(start + 2 + i * 5) }));
    return rows;
  };
  const histories = [
    hist(ME, 1, eth, 2100),
    hist(ME, 8453, on(8453, COINBASE10, 20, 5), 1300),
    hist(ME, 42161, on(42161, BINANCE14, 33, 4), 1100),
    hist(ME, 10, on(10, BINANCE14, 47, 3), 900),
    hist(ME, 4663, on(4663, COINBASE10, 61, 3), 800),
  ];
  // What the explorer shows for the deposit address: it forwards everything to Binance, and SIB pays in too.
  const lookup: DetectorContext['lookup'] = async (chain, action, address) => {
    if (action !== 'txlist' || chain.id !== 1 || address !== DEPOSIT) return [];
    const d = story(DEPOSIT, 11);
    return [
      d.mine({ from: DEPOSIT, to: BINANCE14, amount: 3.9104, timestamp: d.at(60) }), d.mine({ from: DEPOSIT, to: BINANCE14, amount: 4.0177, timestamp: d.at(120) }),
      d.mine({ from: ME, to: DEPOSIT, amount: 0.4122, timestamp: d.at(40) }), d.mine({ from: SIB, to: DEPOSIT, amount: 1.2063, timestamp: d.at(45) }), d.mine({ from: SIB, to: DEPOSIT, amount: 0.8519, timestamp: d.at(99) }),
    ];
  };
  return run(ME, histories, { ens: EXAMPLE_NAME }, lookup, { [SIB]: 23, [FRIEND]: 61, [DEPOSIT]: 3 }, 9200);
}

// ---------- average: funded by Coinbase, a funder that funded one other wallet, a tool's gas limit, 3 chains ----------
async function average(): Promise<ScanResult> {
  const ME = '0x4b6e0c2a8f1d3e5b7a9c0e2f4a6b8d0c1e3f5a7b';
  const FUNDER = '0x8d0c1e3f5a7b4b6e0c2a8f1d3e5b7a9c0e2f4a6b';
  const OTHER = '0x1f2e3d4c5b6a79880716253443526170f8e9dacb'; // funded by FUNDER the same day
  const ROUTER = '0x6b75d8af000000000000000000000000000000c1', VAULT = '0x6b75d8af000000000000000000000000000000c2';
  const pals = ['0x2d4f6a8c0e1b3d5f7a9c2e4f6b8d0a1c3e5f7b9d', '0x3e5a7c9e1f2b4d6f8a0c3e5b7d9f1a2c4e6b8d0f', '0x4f6b8d0f2a3c5e7a9b1d4f6c8e0a2b3d5f7c9e1a'];
  const s = story(ME, 2);
  // Active 19 hours a day (05:00 to 24:00 UTC, every hour used): a short quiet run, so a weak time-zone hint.
  let k = 0;
  const when = (d: number) => { const h = 5 + ((k++ * 7) % 19); return s.at(d, h, h + 1); };
  const eth: Transfer[] = [s.mine({ from: COINBASE10, to: ME, amount: 0.8173, timestamp: s.at(0) })];
  // Contract calls from a trading tool: the same gas limit on two different functions.
  for (let i = 0; i < 16; i++) {
    eth.push(s.mine({ from: ME, to: i % 3 ? ROUTER : VAULT, amount: 0, timestamp: when(2 + i * 6), isCall: true, methodId: i % 3 ? '0x3593564c' : '0xb6b55f25', gasLimit: i % 4 === 3 ? 180000 + i * 1117 : 350000 }));
  }
  const base: Transfer[] = [s.mine({ chainId: 8453, from: FUNDER, to: ME, amount: 0.0617, timestamp: s.at(30) })];
  // Payments: one friend 4 times, another twice, a third once, and six other wallets.
  const to = [pals[0], pals[1], pals[0], pals[2], pals[0], pals[1], pals[0], ...Array.from({ length: 6 }, (_, i) => '0x' + (0x71 + i).toString(16).repeat(20))];
  to.forEach((a, i) => base.push(s.mine({ chainId: 8453, from: ME, to: a, amount: +(0.002 + s.r() * 0.03).toFixed(4), timestamp: when(31 + i * 4) })));
  const arb: Transfer[] = [s.mine({ chainId: 42161, from: COINBASE10, to: ME, amount: 0.0911, timestamp: s.at(80) })];
  for (let i = 0; i < 4; i++) arb.push(s.mine({ chainId: 42161, from: ME, to: ROUTER, amount: 0, timestamp: when(81 + i * 7), isCall: true, methodId: '0x3593564c', gasLimit: 410000 + i * 3001 }));
  const histories = [hist(ME, 1, eth, 1600), hist(ME, 8453, base, 1200), hist(ME, 42161, arb, 700)];
  // The funder on Base also paid one other fresh wallet that day.
  const lookup: DetectorContext['lookup'] = async (chain, action, address) => {
    if (action !== 'txlist' || chain.id !== 8453 || address !== FUNDER) return [];
    const f = story(FUNDER, 12);
    return [f.mine({ chainId: 8453, from: FUNDER, to: ME, amount: 0.0617, timestamp: base[0].timestamp }), f.mine({ chainId: 8453, from: FUNDER, to: OTHER, amount: 0.0583, timestamp: base[0].timestamp + 2900 })];
  };
  return run(ME, histories, {}, lookup, { [FUNDER]: 214, [OTHER]: 7, [pals[0]]: 140 }, 7600);
}

// ---------- good: one chain, a short history, a funder that funded nobody else ----------
async function good(): Promise<ScanResult> {
  const ME = '0x2c4e6a8b0d1f3a5c7e9b1d3f5a7c9e0b2d4f6a8c';
  const FUNDER = '0x7d9f1b3d5f7a9c1e3a5c7e9b1d3f5a7c9e0b2d4f';
  const s = story(ME, 3);
  const op: Transfer[] = [s.mine({ chainId: 10, from: FUNDER, to: ME, amount: 0.15, timestamp: s.at(0) })];
  // 4 of 8 round (0.01, 0.05, 0.02, 0.3): half, so a weak hint.
  const amounts = [0.01, 0.0137, 0.05, 0.00917, 0.0218, 0.02, 0.00634, 0.3];
  amounts.forEach((amount, i) => op.push(s.mine({ chainId: 10, from: ME, to: '0x' + (0x91 + i).toString(16).repeat(20), amount, timestamp: s.at(3 + i * 11) })));
  const histories = [hist(ME, 10, op, 700)];
  const lookup: DetectorContext['lookup'] = async (chain, action, address) => {
    if (action !== 'txlist' || address !== FUNDER) return [];
    const f = story(FUNDER, 13);
    return [f.mine({ chainId: 10, from: FUNDER, to: ME, amount: 0.15, timestamp: op[0].timestamp })];
  };
  return run(ME, histories, {}, lookup, { [FUNDER]: 12 }, 4100);
}

export async function buildFixtures(): Promise<{ bad: ScanResult; average: ScanResult; good: ScanResult }> {
  return { bad: await bad(), average: await average(), good: await good() };
}
