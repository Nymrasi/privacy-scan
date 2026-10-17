// Builds fixtures/worked-example.json: the docs' worked example of the score, produced by the REAL
// detectors and score formula on a small synthetic history (no network). Every address is synthetic.
// Run: node scripts/make-example.ts   (prints the table that RULES.md shows)
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { CHAIN_BY_ID } from '../src/chains.ts';
import type { DetectorContext } from '../src/detectors/context.ts';
import { DETECTOR_LIST } from '../src/detectors/index.ts';
import { fundingOf, type ChainHistory, type Transfer } from '../src/history.ts';
import { assemble } from '../src/scan.ts';
import { createHttp } from '../src/sources/http.ts';

// Synthetic addresses from a hash, so nobody holds or uses them. Small ones like 0x...00f1 are used:
// on 2026-10-16 each had 20 to 452 token transfers on Ethereum, and 0x...00b1 had sent 5 transactions.
const A = (n: number) => '0x' + createHash('sha256').update(`nymra worked example ${n}`).digest('hex').slice(0, 40);
const ME = '0x7e5f0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b';
const FUNDER = A(0xf1), FRIEND = A(0xf2), DEPOSIT = A(0xd1), COSENDER = A(0xd2), FRESH = A(0xb1);
const BINANCE = '0x28c6c06298d514db089934071355e5743bf21d60';
const T0 = 1_757_000_000;
let seq = 0;

function t(p: Partial<Transfer>): Transfer {
  const from = p.from ?? ME, to = p.to ?? A(0x99);
  seq++;
  return {
    chainId: p.chainId ?? 1, hash: '0x' + seq.toString(16).padStart(64, 'e'), block: p.block ?? 20_000_000 + seq * 100, timestamp: p.timestamp ?? T0 + seq * 5400,
    from, to, kind: 'native', amount: p.amount ?? 0.1, symbol: 'ETH', dir: from === ME ? 'out' : 'in', failed: false,
    gasPrice: 1 + (seq % 7) / 3, gasLimit: 21000, isCall: false, ...p,
  } as Transfer;
}
function hist(chainId: number, rows: Transfer[]): ChainHistory {
  const chain = CHAIN_BY_ID.get(chainId)!;
  const txs = rows.filter((r) => r.kind === 'native');
  const own = txs.filter((r) => r.from === ME).sort((a, b) => a.block - b.block);
  return {
    chain, txs, tokens: [], internal: [], ownCount: own.length, firstOwn: own[0], firstFunding: fundingOf(own[0], rows), truncated: false,
    coverage: { chainId, name: chain.name, status: 'scanned', source: 'blockscout', txCount: txs.length, tokenTransferCount: 0, internalTransfers: 'full', truncated: false, limitations: [], missing: [], durationMs: 900, firstSeen: Math.min(...rows.map((r) => r.timestamp)), lastSeen: Math.max(...rows.map((r) => r.timestamp)) },
  };
}

// Ethereum: first funds from FUNDER, two-way traffic with FRIEND, payments into an exchange deposit address.
const eth = hist(1, [
  t({ from: FUNDER, to: ME, amount: 0.4, block: 20_000_000 }),
  t({ to: FRIEND, amount: 0.15 }), t({ from: FRIEND, to: ME, amount: 0.07 }), t({ to: FRIEND, amount: 0.12 }),
  t({ from: FRIEND, to: ME, amount: 0.031 }), t({ to: FRIEND, amount: 0.0577 }),
  t({ to: DEPOSIT, amount: 0.1337 }), t({ to: DEPOSIT, amount: 0.0919 }),
  t({ to: FRESH, amount: 0.05 }),
]);
// Base: first funds from the same FUNDER.
const base = hist(8453, [t({ chainId: 8453, from: FUNDER, to: ME, amount: 0.02, block: 34_000_000 }), t({ chainId: 8453, to: A(0x77), amount: 0.004, block: 34_000_100 })]);

// What the lookups would find on the explorer: FUNDER paid three other fresh wallets the same day;
// DEPOSIT forwards everything to Binance and also received from COSENDER; FRESH got its first funds from you.
const lookup: DetectorContext['lookup'] = async (chain, action, address) => {
  if (action !== 'txlist' || chain.id !== 1) return [];
  if (address === FUNDER) return [A(0xa1), A(0xa2), A(0xa3), ME].map((to, i) => t({ from: FUNDER, to, amount: 0.4, block: 20_000_000 + i, dir: 'out' }));
  if (address === FRESH) return [t({ from: ME, to: FRESH, amount: 0.05, dir: 'in' }), t({ from: FRESH, to: A(0xc1), amount: 0.01, dir: 'out' })];
  if (address === DEPOSIT) return [
    t({ from: DEPOSIT, to: BINANCE, amount: 0.22, dir: 'out' }),
    t({ from: ME, to: DEPOSIT, amount: 0.1337, dir: 'in' }), t({ from: COSENDER, to: DEPOSIT, amount: 0.5, dir: 'in' }), t({ from: COSENDER, to: DEPOSIT, amount: 0.3, dir: 'in' }),
  ];
  return [];
};

const ctx: DetectorContext = {
  me: ME, histories: [eth, base], http: createHttp({ fetch: (() => { throw new Error('offline'); }) as any, cache: null }),
  profile: { isContract: false, ensRecords: {}, ownedNames: [], tags: [] }, lookup, nonces: async () => new Map(), memo: new Map(),
};
const findings = (await Promise.all(DETECTOR_LIST.map((d) => d.run(ctx)))).flat();
const r = assemble(ME, findings, [eth.coverage, base.coverage], ctx.profile, Date.now() - 4200, '2026-10-16T00:00:00.000Z', 'complete', {}, []);
r.durationMs = 4200;
writeFileSync(new URL('../fixtures/worked-example.json', import.meta.url), JSON.stringify(r, null, 2) + '\n');

const pts: Record<string, number> = { info: 0, low: 4, medium: 8, high: 14, critical: 22 };
console.log('| finding | severity | confidence | raw | counted |\n|---|---|---|---|---|');
for (const f of r.findings) console.log(`| \`${f.id}\` | ${f.severity} (${pts[f.severity]}) | ${f.confidence.toFixed(2)} | ${f.rawImpact} | ${f.scoreImpact} |`);
console.log(`\nscore ${r.score} (${r.band}); sum of counted ${r.findings.reduce((a, f) => a + f.scoreImpact, 0)}; capped: ${r.breakdown.capped.join(', ') || 'none'}`);
console.log('links:', r.linkedWallets.map((w) => `${w.address.slice(0, 8)} ${w.confidence} ${w.level} (${w.reasons.join(' + ')})`).join('; '));
