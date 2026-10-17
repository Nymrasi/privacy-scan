import { test } from 'node:test';
import assert from 'node:assert/strict';
import { behavioralFingerprint, hourHistogram, quietestWindow, utcOffsetFromQuiet, isRound } from '../src/detectors/behavioral-fingerprint.ts';
import { cexExposure } from '../src/detectors/cex-exposure.ts';
import { crossChain, bridgeMatches } from '../src/detectors/cross-chain.ts';
import { fundingReuse } from '../src/detectors/funding-reuse.ts';
import { linkedWallets } from '../src/detectors/linked-wallets.ts';
import { counterparties } from '../src/detectors/context.ts';
import { publicIdentity } from '../src/detectors/public-identity.ts';
import { recurringCounterparties } from '../src/detectors/recurring-counterparties.ts';
import { A, ctx, hist, ME, T0, tx } from './helpers.ts';
import type { Finding } from '../src/types.ts';

const BINANCE = '0x28c6c06298d514db089934071355e5743bf21d60';
const ids = (fs: Finding[]) => fs.map((f) => f.id).sort();

function noOwnershipClaims(fs: Finding[]) {
  for (const f of fs) {
    assert.ok(f.confidence >= 0 && f.confidence <= 1, `${f.id} confidence in range`);
    assert.doesNotMatch(f.explanation, /\b(is|are) (your|owned by you)\b|you own (this|that|these) wallet/i, `${f.id} must not claim ownership`);
    assert.doesNotMatch(f.title + f.explanation, /\u2014|\u00b7/, `${f.id} has no em dash or middle dot`);
    for (const r of f.related ?? []) assert.ok(r.confidence > 0 && r.confidence < 1, 'a link is never certain');
  }
}

test('linked_wallets: back and forth with a person-held wallet', async () => {
  const P = A(5);
  const rows = [
    tx({ to: P, amount: 1 }), tx({ to: P, amount: 0.5 }), tx({ from: P, to: ME, amount: 0.7 }), tx({ from: P, to: ME, amount: 0.2 }),
    tx({ to: A(6), amount: 1, isCall: true }), // a contract
  ];
  const fs = await linkedWallets.run(ctx([hist(1, rows)]));
  assert.deepEqual(ids(fs), ['linked_wallets.back_and_forth']);
  assert.equal(fs[0].related![0].address, P);
  assert.ok(fs[0].related![0].confidence >= 0.5);
  noOwnershipClaims(fs);
});

test('linked_wallets: one-way traffic or an exchange is not a link', async () => {
  const rows = [tx({ to: A(5), amount: 1 }), tx({ to: A(5), amount: 1 }), tx({ to: A(5), amount: 1 }), tx({ to: BINANCE, amount: 1 }), tx({ from: BINANCE, to: ME, amount: 1 }), tx({ from: BINANCE, to: ME, amount: 1 })];
  const fs = await linkedWallets.run(ctx([hist(1, rows)]));
  assert.equal(fs.length, 0);
});

test('cex_exposure + linked_wallets: a detected deposit address and its other sender', async () => {
  const DEP = A(7), SIB = A(8);
  const rows = [tx({ from: BINANCE, to: ME, amount: 2 }), tx({ to: DEP, amount: 1 }), tx({ to: DEP, amount: 0.5 })];
  const lookup = async (_c: any, action: string, addr: string) => {
    if (addr !== DEP) return null;
    if (action === 'tokentx') return [];
    return [
      tx({ from: SIB, to: DEP, amount: 0.3, dir: 'in' }), tx({ from: ME, to: DEP, amount: 1, dir: 'in' }),
      tx({ from: DEP, to: BINANCE, amount: 1.79, dir: 'out' }),
    ];
  };
  const c = ctx([hist(1, rows)], { lookup });
  const cex = await cexExposure.run(c);
  assert.deepEqual(ids(cex), ['cex_exposure.deposit_address', 'cex_exposure.direct', 'cex_exposure.funded_by_cex']);
  const dep = cex.find((f) => f.id === 'cex_exposure.deposit_address')!;
  assert.equal(dep.severity, 'critical');
  assert.match(dep.explanation, /forwards what it receives to Binance/);
  const linked = await linkedWallets.run(c);
  const sd = linked.find((f) => f.id === 'linked_wallets.shared_deposit')!;
  assert.equal(sd.related![0].address, SIB);
  noOwnershipClaims([...cex, ...linked]);
});

test('cex_exposure: no lookups (offline pass) still reports labelled exchange traffic', async () => {
  const fs = await cexExposure.run(ctx([hist(1, [tx({ to: BINANCE, amount: 1 })])]));
  assert.deepEqual(ids(fs), ['cex_exposure.direct']);
  assert.equal(fs[0].severity, 'low');
});

test('funding_reuse: funder that funded 3 other wallets around the same time', async () => {
  const F = A(9);
  const rows = [tx({ from: F, to: ME, amount: 0.05, block: 500 }), tx({ to: A(50), amount: 0.01 })];
  const lookup = async (_c: any, action: string, addr: string, q: any) => {
    assert.equal(addr, F);
    assert.ok(q.startblock < 500 && q.endblock > 500, 'window around the funding block');
    return [A(21), A(22), A(23), ME].map((to) => tx({ from: F, to, amount: 0.05, dir: 'out' }));
  };
  const fs = await fundingReuse.run(ctx([hist(1, rows)], { lookup }));
  const f = fs.find((x) => x.id === 'funding_reuse.shared_funder')!;
  assert.ok(!fs.some((x) => x.id === 'funding_reuse.same_funder_multichain'), 'one chain is not several');
  assert.equal(f.severity, 'high');
  assert.equal(f.related!.length, 3);
  assert.ok(f.related!.every((r) => r.confidence < f.confidence));
  noOwnershipClaims(fs);
});

test('funding_reuse: a busy funder on two chains is a service: no sibling links, and it does not tie the chains together', async () => {
  const F = A(9);
  const h1 = hist(1, [tx({ from: F, to: ME, amount: 0.05 }), tx({ to: A(60), amount: 0.01 })]);
  const h2 = hist(8453, [tx({ chainId: 8453, from: F, to: ME, amount: 0.05 }), tx({ chainId: 8453, to: A(60), amount: 0.01 })]);
  const lookup = async () => Array.from({ length: 1000 }, (_, i) => tx({ from: F, to: A(1000 + i), amount: 0.01, dir: 'out' }));
  const fs = await fundingReuse.run(ctx([h1, h2], { lookup }));
  assert.deepEqual(ids(fs), ['funding_reuse.busy_funder']);
  assert.ok(fs.every((f) => !f.related?.length));
});

test('funding_reuse: two funders on two chains each make ONE finding for the rule, with both funders as evidence and no address in the title', async () => {
  const F = A(9), G = A(10);
  const used = (chainId: number, from: string) => [tx({ chainId, from, to: ME, amount: 0.05 }), tx({ chainId, to: A(60), amount: 0.01 })];
  const hs = [hist(1, used(1, F)), hist(8453, used(8453, F)), hist(10, used(10, G)), hist(42161, used(42161, G))];
  const fs = (await fundingReuse.run(ctx(hs))).filter((f) => f.id === 'funding_reuse.same_funder_multichain');
  assert.equal(fs.length, 1, 'one finding per rule (SCHEMA: a stable id per rule)');
  assert.equal(fs[0].key, 'funding_reuse.same_funder_multichain');
  assert.equal(fs[0].title, '2 funders each funded you on several chains');
  assert.doesNotMatch(fs[0].title + fs[0].explanation, /0x[0-9a-f]/i, 'no address in the title or the text: they travel to the share card');
  assert.deepEqual(fs[0].evidence.filter((e) => e.kind === 'address').map((e) => e.address).sort(), [F, G]);
  assert.deepEqual([...fs[0].chains].sort((a, b) => a - b), [1, 10, 8453, 42161]);
  const one = (await fundingReuse.run(ctx(hs.slice(0, 2)))).find((f) => f.id === 'funding_reuse.same_funder_multichain')!;
  assert.equal(one.title, 'Same funder on 2 chains');
});

test('funding_reuse: a CEX funder is not reuse (cex_exposure reports it)', async () => {
  const h = hist(1, [tx({ from: BINANCE, to: ME, amount: 1 }), tx({ to: A(60), amount: 0.5 })]);
  assert.equal(h.firstFunding?.from, BINANCE, 'the exchange paid for the first transaction');
  const fs = await fundingReuse.run(ctx([h]));
  assert.equal(fs.length, 0);
  assert.ok((await cexExposure.run(ctx([h]))).some((f) => f.id === 'cex_exposure.funded_by_cex'));
});

test('recurring_counterparties: three wallets carry most transfers', async () => {
  const rows = [
    ...Array.from({ length: 6 }, () => tx({ to: A(31), amount: 0.1 })),
    ...Array.from({ length: 4 }, () => tx({ from: A(32), to: ME, amount: 0.1 })),
    ...Array.from({ length: 3 }, () => tx({ to: A(33), amount: 0.1 })),
    tx({ to: A(34), amount: 0.1 }), tx({ to: A(35), amount: 0.1 }),
  ];
  const fs = await recurringCounterparties.run(ctx([hist(1, rows)]));
  assert.equal(fs.length, 1);
  assert.equal(fs[0].severity, 'medium');
  assert.equal(fs[0].evidence[0].address, A(31));
});

test('cross_chain: presence and a bridge match', async () => {
  const out = tx({ amount: 0.8, timestamp: T0, isCall: true, to: A(77) });
  const inn = tx({ chainId: 8453, kind: 'internal', from: A(78), to: ME, amount: 0.7985, timestamp: T0 + 240 });
  const used = tx({ chainId: 8453, to: A(79), amount: 0.1, timestamp: T0 + 600 });
  const fs = await crossChain.run(ctx([hist(1, [out]), hist(8453, [inn, used]), hist(10, [])]));
  assert.deepEqual(ids(fs), ['cross_chain.bridge_match', 'cross_chain.multichain_presence']);
  assert.equal(fs.find((f) => f.id === 'cross_chain.multichain_presence')!.severity, 'low');
  // Bridged there but never used it: the bridge still matches; the chain is "received only", not active.
  const only = await crossChain.run(ctx([hist(1, [out]), hist(8453, [inn])]));
  assert.deepEqual(ids(only), ['cross_chain.bridge_match', 'cross_chain.received_only']);
});

test('cross_chain: bridgeMatches rejects wrong order, big loss, same chain', () => {
  const o = tx({ amount: 1, timestamp: T0 });
  assert.equal(bridgeMatches([o], [tx({ chainId: 10, from: A(1), to: ME, amount: 0.99, timestamp: T0 - 10 })]).length, 0);
  assert.equal(bridgeMatches([o], [tx({ chainId: 10, from: A(1), to: ME, amount: 0.9, timestamp: T0 + 60 })]).length, 0);
  assert.equal(bridgeMatches([o], [tx({ chainId: 1, from: A(1), to: ME, amount: 0.999, timestamp: T0 + 60 })]).length, 0);
  assert.equal(bridgeMatches([o], [tx({ chainId: 10, from: A(1), to: ME, amount: 0.999, timestamp: T0 + 60 })]).length, 1);
});

test('behavioral: time zone from a quiet night window', async () => {
  // Active 07:00-22:00 at UTC+2, i.e. 05:00-20:00 UTC; quiet 20:00-05:00 UTC.
  const day = 86400, base = 1_750_032_000 - (1_750_032_000 % day);
  const rows = [];
  for (let d = 0; d < 20; d++) for (const h of [5, 8, 12, 16, 19]) rows.push(tx({ to: A(40 + (d % 3)), amount: 0.0123, timestamp: base + d * day + h * 3600 }));
  const fs = await behavioralFingerprint.run(ctx([hist(1, rows)]));
  const tz = fs.find((f) => f.id === 'behavioral_fingerprint.timezone')!;
  assert.ok(tz, 'timezone found');
  assert.match(tz.explanation, /between UTC\+[1-2] and UTC\+[3-4]\b/);
  assert.equal(String(tz.evidence[0].value).split(',').length, 24);
});

test('behavioral: round amounts, fixed gas limit across methods, fixed schedule', async () => {
  const rows = Array.from({ length: 12 }, (_, i) => tx({ to: A(60), amount: [0.5, 1, 0.25][i % 3], isCall: true, gasLimit: 350000, methodId: ['0xaaaaaaaa', '0xbbbbbbbb'][i % 2], timestamp: T0 + i * 86400 }));
  const fs = await behavioralFingerprint.run(ctx([hist(1, rows)]));
  assert.deepEqual(ids(fs), ['behavioral_fingerprint.fixed_gas', 'behavioral_fingerprint.fixed_timing', 'behavioral_fingerprint.round_amounts']);
  assert.equal(fs.find((f) => f.id === 'behavioral_fingerprint.fixed_gas')!.title, 'You use the same gas setting every time', 'the gas-limit rule, not the gas-price one');
});

test('behavioral helpers', () => {
  assert.deepEqual(hourHistogram([0, 3600, 3600 * 25]), [1, 2, ...new Array(22).fill(0)]);
  const h = new Array(24).fill(10); for (const x of [22, 23, 0, 1, 2, 3]) h[x] = 0;
  assert.deepEqual(quietestWindow(h), { start: 22, len: 6, share: 0 });
  assert.equal(utcOffsetFromQuiet(22, 6), 2);
  assert.equal(utcOffsetFromQuiet(4, 6), -4);
  assert.equal(quietestWindow(new Array(24).fill(5)).len, 0);
  assert.ok(isRound(tx({ amount: 0.5 })) && isRound(tx({ amount: 1.5 })) && isRound(tx({ amount: 20 })));
  assert.ok(!isRound(tx({ amount: 0.123 })) && !isRound(tx({ amount: 1.37 })));
  assert.ok(isRound(tx({ kind: 'token', symbol: 'USDC', amount: 100 })) && !isRound(tx({ kind: 'token', symbol: 'USDC', amount: 99.5 })));
});

test('public_identity: ENS name, records, labels, contract note', async () => {
  const fs = await publicIdentity.run(ctx([], { profile: { ens: 'someone.eth', ensRecords: { 'com.twitter': 'someone', url: 'https://x.example' }, ownedNames: ['other.eth'], tags: ['Some Fund'] } }));
  assert.deepEqual(ids(fs), ['public_identity.ens_records', 'public_identity.ens_reverse', 'public_identity.owned_names', 'public_identity.public_label']);
  // 1.4.0: an ENS name can be made up, so a bare primary name is medium; its records with real handles stay high.
  assert.equal(fs.find((f) => f.id === 'public_identity.ens_reverse')!.severity, 'medium');
  assert.equal(fs.find((f) => f.id === 'public_identity.ens_records')!.severity, 'high');
  assert.equal(fs.find((f) => f.id === 'public_identity.owned_names')!.severity, 'low');
  assert.equal(fs.find((f) => f.id === 'public_identity.public_label')!.severity, 'critical');
  const c = await publicIdentity.run(ctx([], { profile: { isContract: true, contractName: 'USDC' } }));
  assert.deepEqual(ids(c), ['public_identity.is_contract']);
  assert.equal(c[0].severity, 'info');
});

test('an empty wallet produces nothing', async () => {
  const c = ctx([hist(1, []), hist(8453, [])]);
  for (const d of [behavioralFingerprint, cexExposure, crossChain, fundingReuse, linkedWallets, publicIdentity, recurringCounterparties]) {
    assert.deepEqual(await d.run(c), [], d.id);
  }
});

test('linked_wallets: a fresh wallet whose first funds came from you', async () => {
  const KID = A(88);
  const rows = [tx({ from: A(1), to: ME, amount: 3 }), tx({ to: KID, amount: 0.2, block: 700 })];
  const lookup = async (_c: any, action: string, addr: string) => {
    if (addr !== KID || action !== 'txlist') return action === 'tokentx' ? [] : null;
    return [tx({ from: ME, to: KID, amount: 0.2, block: 700, dir: 'in' }), tx({ from: KID, to: A(90), amount: 0.1, block: 800, isCall: true, dir: 'out' })];
  };
  const fs = await linkedWallets.run(ctx([hist(1, rows)], { lookup }));
  const f = fs.find((x) => x.id === 'linked_wallets.funded_by_you')!;
  assert.ok(f);
  assert.equal(f.related![0].address, KID);
  noOwnershipClaims(fs);
});

// ---------- precision: a service is never a link ----------
const RELAYER = '0x15652636f3898f550b257b89926d5566821c32e1'; // Across Protocol: Relayer 2 (eth-labels)
const MEVBOT = '0x000000000000001d48ffbd0c0da7c129137a9c55'; // MEV Bot (eth-labels)
const tagged = { isContract: false, tags: ['Relay: Solver'], slugs: [], scam: false };
const linksOf = (fs: Finding[]) => fs.flatMap((f) => f.related ?? []);

test('precision: a funder on the bundled service list (a bridge relayer) gets no lookup and makes no link', async () => {
  let looked = 0;
  const lookup = async () => { looked++; return [A(21), A(22)].map((to) => tx({ from: RELAYER, to, amount: 0.05, dir: 'out' })); };
  const hs = [hist(1, [tx({ from: RELAYER, to: ME, amount: 0.05 })]), hist(8453, [tx({ chainId: 8453, from: RELAYER, to: ME, amount: 0.05 })])];
  const fs = await fundingReuse.run(ctx(hs, { lookup }));
  assert.equal(looked, 0);
  assert.deepEqual(linksOf(fs), []);
  assert.ok(!fs.some((f) => f.id === 'funding_reuse.same_funder_multichain'), 'a relayer on two chains does not tie them together');
});

test('precision: a funder the explorer tags (a solver) is a service too', async () => {
  let looked = 0;
  const lookup = async () => { looked++; return []; };
  const funding = { ...tx({ from: A(77), to: ME, amount: 0.05 }), cp: tagged };
  const h = hist(1, [funding, tx({ to: A(60), amount: 0.01 })]);
  assert.equal(h.firstFunding?.from, A(77));
  const fs = await fundingReuse.run(ctx([h], { lookup }));
  assert.equal(looked, 0);
  assert.deepEqual(linksOf(fs), []);
});

test('precision: siblings that are services or contracts are not linked; a funder of more than 40 wallets is a distributor', async () => {
  const F = A(9);
  const rows = [tx({ from: F, to: ME, amount: 0.05, block: 500 }), tx({ to: A(60), amount: 0.01 })];
  const few = async () => [
    tx({ from: F, to: A(21), amount: 0.05, dir: 'out' }),
    { ...tx({ from: F, to: A(22), amount: 0.05, dir: 'out' }), cp: { isContract: true } },
    tx({ from: F, to: MEVBOT, amount: 0.05, dir: 'out' }),
  ];
  const a = await fundingReuse.run(ctx([hist(1, rows)], { lookup: few }));
  assert.deepEqual(linksOf(a).map((r) => r.address), [A(21)], 'only the person-held sibling');
  const many = async () => Array.from({ length: 45 }, (_, i) => tx({ from: F, to: A(100 + i), amount: 0.05, dir: 'out' }));
  const b = await fundingReuse.run(ctx([hist(1, rows)], { lookup: many }));
  assert.deepEqual(linksOf(b), []);
  assert.ok(b.some((f) => f.id === 'funding_reuse.busy_funder'));
});

test('precision: back and forth with a service (bot on the list, or explorer-tagged) is not a link', async () => {
  for (const [who, cp] of [[MEVBOT, undefined], [A(55), tagged]] as const) {
    const rows = [
      tx({ to: who, amount: 0.5 }), { ...tx({ from: who, to: ME, amount: 0.2 }), ...(cp ? { cp } : {}) }, tx({ to: who, amount: 0.1 }), tx({ to: who, amount: 0.3 }),
    ];
    const fs = await linkedWallets.run(ctx([hist(1, rows)]));
    assert.ok(!fs.some((f) => f.id === 'linked_wallets.back_and_forth'), `no link with ${who}`);
  }
});

test('precision: a contract or service paying into your deposit address is not "another wallet"', async () => {
  const DEP = A(400);
  const rows = [tx({ to: DEP, amount: 1 }), tx({ to: DEP, amount: 2 })];
  const lookup = async (_c: any, action: string) => action === 'txlist' ? [
    tx({ from: DEP, to: BINANCE, amount: 3, dir: 'out' }),
    { ...tx({ from: A(401), to: DEP, amount: 1, dir: 'in' }), cp: { isContract: true } },
    tx({ from: MEVBOT, to: DEP, amount: 1, dir: 'in' }),
    tx({ from: A(402), to: DEP, amount: 1, dir: 'in' }),
  ] : [];
  const fs = await linkedWallets.run(ctx([hist(1, rows)], { lookup }));
  const f = fs.find((x) => x.id === 'linked_wallets.shared_deposit')!;
  assert.deepEqual(f.related!.map((r) => r.address), [A(402)]);
});

test('precision: recurring counterparties leave services out', async () => {
  const rows = [...Array.from({ length: 12 }, () => tx({ to: MEVBOT, amount: 0.1 })), tx({ to: A(31), amount: 0.1 }), tx({ to: A(32), amount: 0.1 })];
  const fs = await recurringCounterparties.run(ctx([hist(1, rows)]));
  assert.ok(!fs.some((f) => f.evidence.some((e) => e.address === MEVBOT)));
});

// ---------- tests added for mutants that survived the first mutation run (npm run mutate) ----------

test('linked_wallets: a fresh wallet whose first funds came from someone else is not "funded by you"', async () => {
  const W = A(500);
  const rows = [tx({ to: W, amount: 0.3 })];
  const lookup = async (_c: any, action: string) => action === 'txlist'
    ? [tx({ from: A(501), to: W, amount: 1, dir: 'in', block: 10 }), tx({ from: ME, to: W, amount: 0.3, dir: 'in', block: 20 })]
    : [];
  const fs = await linkedWallets.run(ctx([hist(1, rows)], { lookup }));
  assert.ok(!fs.some((f) => f.id === 'linked_wallets.funded_by_you'));
});

test('linked_wallets: a deposit address with more than 6 senders is omnibus: medium, weak links', async () => {
  const DEP = A(410);
  const rows = [tx({ to: DEP, amount: 1 })];
  const senders = Array.from({ length: 7 }, (_, i) => tx({ from: A(420 + i), to: DEP, amount: 1, dir: 'in' }));
  const lookup = async (_c: any, action: string) => action === 'txlist' ? [tx({ from: DEP, to: BINANCE, amount: 8, dir: 'out' }), ...senders] : [];
  const fs = await linkedWallets.run(ctx([hist(1, rows)], { lookup }));
  const f = fs.find((x) => x.id === 'linked_wallets.shared_deposit')!;
  assert.equal(f.severity, 'medium');
  assert.equal(f.confidence, 0.3);
  assert.ok(f.related!.every((r) => r.confidence < 0.45), 'weak links only');
});

test('funding_reuse: a funder with 200 transactions in the window is busy, even when it paid only a few wallets', async () => {
  const F = A(9);
  const rows = [tx({ from: F, to: ME, amount: 0.05, block: 500 }), tx({ to: A(60), amount: 0.01 })];
  const lookup = async () => Array.from({ length: 200 }, (_, i) => tx({ from: F, to: A(30 + (i % 5)), amount: 0.01, dir: 'out' }));
  const fs = await fundingReuse.run(ctx([hist(1, rows)], { lookup }));
  assert.deepEqual(ids(fs), ['funding_reuse.busy_funder']);
});

test('cross_chain: medium from 4 chains', async () => {
  const hs = [1, 8453, 10, 42161].map((c) => hist(c, [tx({ chainId: c, amount: 0.1, to: A(70 + c % 50) })]));
  const fs = await crossChain.run(ctx(hs));
  assert.equal(fs.find((f) => f.id === 'cross_chain.multichain_presence')!.severity, 'medium');
});

test('behavioral: activity around the clock (a bot) gives no time zone', async () => {
  const rows = Array.from({ length: 48 }, (_, i) => tx({ to: A(61), amount: 0.013, timestamp: T0 + i * 3600 + 7 }));
  const fs = await behavioralFingerprint.run(ctx([hist(1, rows)]));
  assert.ok(!fs.some((f) => f.id === 'behavioral_fingerprint.timezone'));
});

test('behavioral: a few round amounts (under 40%) are not a fingerprint', async () => {
  const amounts = [0.5, 1, 0.1234, 0.2377, 0.3141, 0.4442, 0.5763, 0.6611];
  const rows = amounts.map((amount, i) => tx({ to: A(62), amount, timestamp: T0 + i * 7777 }));
  const fs = await behavioralFingerprint.run(ctx([hist(1, rows)]));
  assert.ok(!fs.some((f) => f.id === 'behavioral_fingerprint.round_amounts'));
});

test('recurring_counterparties: spread over many wallets (top 3 under 40%) is not a circle', async () => {
  const rows = [
    ...Array.from({ length: 4 }, () => tx({ to: A(31), amount: 0.1 })),
    ...Array.from({ length: 16 }, (_, i) => tx({ to: A(100 + i), amount: 0.1 })),
  ];
  const fs = await recurringCounterparties.run(ctx([hist(1, rows)]));
  assert.deepEqual(fs, []);
});

test('counterparties: one seen only through NodeReal (no calldata) is not a person, unless it sent us a transaction', () => {
  const blindOut = { ...tx({ chainId: 56, to: A(700), amount: 0.2 }), blind: true, isCall: undefined };
  const blindIn = { ...tx({ chainId: 56, from: A(701), to: ME, amount: 0.2 }), blind: true, isCall: undefined };
  const m = counterparties(ctx([hist(56, [blindOut, blindIn])]));
  assert.equal(m.get(A(700))!.contractLike, true, 'a router or a pool, as far as we know');
  assert.equal(m.get(A(701))!.contractLike, false, 'it signed a transaction to us: a wallet');
});

test('behavioral: 3 quiet hours are too short to be a night: no time zone', async () => {
  const hours = Array.from({ length: 24 }, (_, h) => h).filter((h) => h < 2 || h > 4); // silent 02:00 to 05:00 UTC
  const rows = Array.from({ length: 63 }, (_, i) => tx({ to: A(63), amount: 0.013, timestamp: T0 - (T0 % 86400) + Math.floor(i / hours.length) * 86400 + hours[i % hours.length] * 3600 + 60 }));
  const fs = await behavioralFingerprint.run(ctx([hist(1, rows)]));
  assert.ok(!fs.some((f) => f.id === 'behavioral_fingerprint.timezone'));
});

// ---------- address poisoning (seen for real on a Revolut deposit address, 2026-10-16) ----------
const USDT = '0xdac17f958d2ee523a2206206994597c13d831ec7';
const FAKE = '0xef3ee10d31000000000000000000000000000001';
// A look-alike of ME (0x1111...1111): same first 4 and last 4 hex characters.
const MIMIC = '0x1111' + 'ab'.repeat(16) + '1111';

test('poisoning: a fake token cannot write "you sent" or "you received" into the history', async () => {
  const P = A(800);
  // P signed one plain transaction to us (so it is a person-held wallet); the rest are token events.
  const signedIn = tx({ from: P, to: ME, amount: 0.01 });
  const rows = [
    signedIn,
    // fake events: not signed by the wallet, an unpriced "USDT" clone
    { ...tx({ kind: 'token', to: P, amount: 500, symbol: 'USDT', token: FAKE }), priced: false },
    { ...tx({ kind: 'token', to: P, amount: 700, symbol: 'USDT', token: FAKE }), priced: false },
  ];
  const fs = await linkedWallets.run(ctx([hist(1, rows)]));
  assert.ok(!fs.some((f) => f.id === 'linked_wallets.back_and_forth'), 'no link from fake events');
  const real = [
    signedIn,
    { ...tx({ kind: 'token', to: P, amount: 500, symbol: 'USDT', token: USDT }), priced: true },
    { ...tx({ kind: 'token', to: P, amount: 300, symbol: 'USDT', token: USDT }), priced: true },
  ];
  const ok = await linkedWallets.run(ctx([hist(1, real)]));
  assert.ok(ok.some((f) => f.id === 'linked_wallets.back_and_forth'), 'the same flows in real USDT do link');
});

test('poisoning: a look-alike of the wallet, or of a busier counterparty, is never a person', () => {
  const FRIEND = '0x2222' + '00'.repeat(16) + '2222';
  const FRIEND_MIMIC = '0x2222' + 'cd'.repeat(16) + '2222';
  const rows = [
    tx({ to: FRIEND, amount: 0.5 }), tx({ from: FRIEND, to: ME, amount: 0.2 }), tx({ to: FRIEND, amount: 0.1 }),
    tx({ from: FRIEND_MIMIC, to: ME, amount: 0.000001 }), tx({ from: MIMIC, to: ME, amount: 0.000001 }),
  ];
  const m = counterparties(ctx([hist(1, rows)]));
  assert.equal(m.get(FRIEND)!.poison, undefined);
  assert.equal(m.get(FRIEND_MIMIC)!.poison, true);
  assert.equal(m.get(MIMIC)!.poison, true);
});

test('poisoning: fake-token mirrors and look-alikes on your deposit address are not "other wallets"', async () => {
  const DEP = A(430);
  const rows = [{ ...tx({ kind: 'token', to: DEP, amount: 1700, symbol: 'USDT', token: USDT }), priced: true }];
  const M1 = '0x5555' + '01'.repeat(16) + 'beef', M2 = '0x5555' + '02'.repeat(16) + 'beef';
  const lookup = async (_c: any, action: string) => action === 'tokentx' ? [
    { ...tx({ kind: 'token', from: DEP, to: BINANCE, amount: 1700, symbol: 'USDT', token: USDT, dir: 'out' }), priced: true },
    { ...tx({ kind: 'token', from: MIMIC, to: DEP, amount: 1700, symbol: 'ՍՏⅮТ', token: FAKE, dir: 'in' }), priced: false },
    { ...tx({ kind: 'token', from: A(431), to: DEP, amount: 1700, symbol: 'USDT', token: FAKE, dir: 'in' }), priced: false },
    { ...tx({ kind: 'token', from: M1, to: DEP, amount: 10, symbol: 'USDT', token: USDT, dir: 'in' }), priced: true },
    { ...tx({ kind: 'token', from: M2, to: DEP, amount: 10, symbol: 'USDT', token: USDT, dir: 'in' }), priced: true },
    { ...tx({ kind: 'token', from: A(432), to: DEP, amount: 900, symbol: 'USDT', token: USDT, dir: 'in' }), priced: true },
  ] : [];
  const c = ctx([hist(1, rows)], { lookup });
  const fs = await linkedWallets.run(c);
  const f = fs.find((x) => x.id === 'linked_wallets.shared_deposit')!;
  assert.deepEqual(f.related!.map((r) => r.address), [A(432)], 'only the real, distinct co-sender');
  const { analyzeRecipients } = await import('../src/detectors/deposits.ts');
  const w = poisoningWarning(c, await analyzeRecipients(c))!;
  assert.ok(w.lookalikes.some((x) => x.address === MIMIC && x.imitates === ME), 'the look-alike that paid into your deposit address is in the warning');
});

test('shared deposit: each deposit address keeps its own confidence (an omnibus one never borrows a private one\'s)', async () => {
  const D1 = A(440), D2 = A(441);
  const rows = [tx({ to: D1, amount: 1 }), tx({ to: D1, amount: 1 }), tx({ to: D2, amount: 1 })];
  const lookup = async (_c: any, action: string, addr: string) => {
    if (action !== 'txlist') return [];
    if (addr === D1) return [tx({ from: D1, to: BINANCE, amount: 2, dir: 'out' }), tx({ from: A(450), to: D1, amount: 1, dir: 'in' }), tx({ from: A(450), to: D1, amount: 1, dir: 'in' })];
    return [tx({ from: D2, to: BINANCE, amount: 9, dir: 'out' }), ...Array.from({ length: 8 }, (_, i) => tx({ from: A(460 + i), to: D2, amount: 1, dir: 'in' }))];
  };
  const fs = await linkedWallets.run(ctx([hist(1, rows)], { lookup }));
  const rel = fs.find((x) => x.id === 'linked_wallets.shared_deposit')!.related!;
  assert.equal(rel.find((r) => r.address === A(450))!.confidence, 0.7);
  assert.ok(rel.filter((r) => r.address !== A(450)).every((r) => r.confidence <= 0.3), 'the omnibus senders stay weak');
});

// ---------- gifts and dust are not funding, and not activity ----------
import { fundingOf, l1Alias, type ChainHistory } from '../src/history.ts';

test('funding: vitalik.eth on Base, the 0.016 ETH that paid, never the sprinkler dust that came three months later', () => {
  // His recorded Base history before his first own transaction (block 11,406,618, a call, value 0, gas almost free).
  const REAL = '0x2bb625b4b1000000000000000000000000000001', SPRINKLER = '0xd9d5024ee742d5603ec433f3f90e9825967588fc';
  const day = 86400, t0 = 1_699_000_000;
  const rows = [
    tx({ from: A(720), to: ME, amount: 0.0001, block: 6_780_015, timestamp: t0 }),
    tx({ from: A(721), to: ME, amount: 0.000001, block: 7_184_804, timestamp: t0 + 10 * day }),
    tx({ from: REAL, to: ME, amount: 0.0160831, block: 7_270_041, timestamp: t0 + 12 * day }),
    tx({ from: A(722), to: ME, amount: 0.00001, block: 10_315_614, timestamp: t0 + 82 * day }),
    tx({ from: A(723), to: ME, amount: 0.000005, block: 11_228_009, timestamp: t0 + 103 * day }),
    tx({ from: A(724), to: ME, amount: 0.00003004, block: 11_228_960, timestamp: t0 + 103 * day + 1900 }),
    tx({ from: A(724), to: ME, amount: 0.0000297, block: 11_236_367, timestamp: t0 + 104 * day }),
    tx({ from: SPRINKLER, to: ME, amount: 0.00000292, block: 11_342_876, timestamp: t0 + 106 * day }),
  ];
  const first = tx({ to: A(725), amount: 0, block: 11_406_618, timestamp: t0 + 108 * day, gasLimit: 213_524, gasPrice: 0.005, isCall: true });
  assert.equal(fundingOf(first, [...rows, first])?.from, REAL, 'the earliest transfer of at least 10% of what came in that alone could pay');
});

test('funding: what paid for the first own transaction, by the rule (RULES 1.3.0)', () => {
  const SPAM = A(700), GIFT = A(701), REAL = A(702);
  const day = 86400;
  const dust = tx({ from: SPAM, to: ME, amount: 0.00001, timestamp: T0, block: 100 });
  const gift = tx({ from: GIFT, to: ME, amount: 0.5, timestamp: T0 + day, block: 200 });
  const real = tx({ from: REAL, to: ME, amount: 0.2, timestamp: T0 + 40 * day, block: 300 });
  const first = tx({ to: A(703), amount: 0.15, timestamp: T0 + 41 * day, block: 400, gasPrice: 20, gasLimit: 21000 });
  // Nothing leaves a wallet before its first signature: the 0.5 was still there, and it came first.
  assert.equal(fundingOf(first, [dust, gift, real, first])?.from, GIFT, 'of two that could each have paid, the earliest');
  assert.equal(fundingOf(first, [dust, real, first])?.from, REAL);
  assert.equal(fundingOf(undefined, [dust, gift, real]), undefined, 'never signed here: no funder at all');
  // Too small to pay for it (value 0.15 plus gas): dust is never the funder.
  const small = tx({ from: SPAM, to: ME, amount: 0.001, timestamp: T0 + 40 * day, block: 350 });
  assert.equal(fundingOf(first, [small, first]), undefined);
  // Several small deposits, none of which could pay on its own: unknown.
  const parts = [1, 2, 3, 4, 5].map((i) => tx({ from: A(710 + i), to: ME, amount: 0.04, timestamp: T0 + i * day, block: 100 + i }));
  assert.equal(fundingOf(first, [...parts, first]), undefined);
  // Enough to pay, but under 10% of everything that came in before: a sprinkle beside the real money.
  const big = tx({ from: REAL, to: ME, amount: 3, timestamp: T0 + 2 * day, block: 120 });
  const sprinkle = tx({ from: SPAM, to: ME, amount: 0.2, timestamp: T0 + day, block: 110 });
  assert.equal(fundingOf(first, [sprinkle, big, first])?.from, REAL);
  // After the first transaction: not its funding.
  const later = tx({ from: REAL, to: ME, amount: 1, timestamp: T0 + 42 * day, block: 500 });
  assert.equal(fundingOf(first, [later, first]), undefined);
  // Its own deposit from L1 (Arbitrum shows the L1 sender aliased): it funded itself, there is no third funder.
  const own = tx({ from: l1Alias(ME), to: ME, amount: 0.5, timestamp: T0 + 40 * day, block: 300 });
  assert.equal(fundingOf(first, [own, first]), undefined);
  assert.equal(l1Alias('0xb8c2c29ee19d8307cb7255e1cd9cbde883a267d5'), '0xc9d3c29ee19d8307cb7255e1cd9cbde883a278e6', "nick.eth's Arbitrum \"funder\" is its own L1 address");
});

test('A1 activity: a chain where the wallet only received is "received only", never "active"', async () => {
  const used = (c: number) => hist(c, [tx({ chainId: c, from: A(710), to: ME, amount: 0.1 }), tx({ chainId: c, to: A(711), amount: 0.05 })]);
  const gifted = (c: number) => hist(c, [tx({ chainId: c, from: A(712), to: ME, amount: 0.0001 }), { ...tx({ chainId: c, kind: 'token', from: A(713), to: ME, amount: 5, symbol: 'ecAVAX', token: A(714) }), priced: false }]);
  const fs = await crossChain.run(ctx([used(1), used(8453), gifted(43114), gifted(81457), gifted(324)]));
  const pres = fs.find((f) => f.id === 'cross_chain.multichain_presence')!;
  assert.equal(pres.title, 'Active on 2 chains with one address');
  const ro = fs.find((f) => f.id === 'cross_chain.received_only')!;
  assert.equal(ro.severity, 'info');
  assert.deepEqual(ro.chains, [43114, 81457, 324]);
  // No funding finding on a chain the wallet never used, whoever sent to it.
  const fr = await fundingReuse.run(ctx([used(1), gifted(43114), gifted(324)]));
  assert.ok(fr.every((f) => f.chains.every((c) => c === 1)));
  // A nonce from the chain counts as activity even when the explorer list shows nothing signed.
  const viaRpc = hist(137, [tx({ chainId: 137, from: A(715), to: ME, amount: 1 })], { nonce: 23 });
  const fs2 = await crossChain.run(ctx([used(1), viaRpc]));
  const ev = fs2.find((f) => f.id === 'cross_chain.multichain_presence')!.evidence;
  assert.deepEqual(ev.map((e) => e.text), ['Ethereum: 1 transaction sent', 'Polygon PoS: 23 transactions sent'], 'the chain\'s own count, never a page limit');
});

// ---------- a service is never a link, also when no list names it (its own transaction count) ----------
test('A2: a back and forth partner, a deposit co-sender or a funder with 2,000+ transactions is a service', async () => {
  const MAKER = A(720), SIS = A(721);
  const rows = [
    tx({ to: MAKER, amount: 0.5 }), tx({ from: MAKER, to: ME, amount: 0.49 }), tx({ to: MAKER, amount: 0.3 }),
    tx({ to: SIS, amount: 0.5 }), tx({ from: SIS, to: ME, amount: 0.2 }), tx({ to: SIS, amount: 0.1 }),
  ];
  const nonces = { [MAKER]: 893_736, [SIS]: 14 };
  const fs = await linkedWallets.run(ctx([hist(1, rows)], { nonces }));
  const bf = fs.find((f) => f.id === 'linked_wallets.back_and_forth')!;
  assert.deepEqual(bf.related!.map((r) => r.address), [SIS], 'the bridge maker is gone, the sister stays');
  // A partner that never signed anything (nonce 0) can only "send" through a forged token event.
  const ghost = await linkedWallets.run(ctx([hist(1, rows)], { nonces: { [MAKER]: 0, [SIS]: 0 } }));
  assert.ok(!ghost.some((f) => f.id === 'linked_wallets.back_and_forth'));
  // Unknown (offline pass, failed check): kept, as before.
  assert.equal((await linkedWallets.run(ctx([hist(1, rows)]))).find((f) => f.id === 'linked_wallets.back_and_forth')!.related!.length, 2);

  // A funder with 2,000+ transactions: busy, and no window lookup is spent on it.
  const F = A(722);
  let looked = 0;
  const h1 = hist(1, [tx({ from: F, to: ME, amount: 0.05 }), tx({ to: A(60), amount: 0.01 })]);
  const h2 = hist(8453, [tx({ chainId: 8453, from: F, to: ME, amount: 0.05 }), tx({ chainId: 8453, to: A(60), amount: 0.01 })]);
  const fr = await fundingReuse.run(ctx([h1, h2], { nonces: { [F]: 600_656 }, lookup: async () => { looked++; return []; } }));
  assert.equal(looked, 0);
  assert.deepEqual(ids(fr), ['funding_reuse.busy_funder']);
});

test('A2: a deposit co-sender with 2,000+ transactions, or one that never sent anything, is not "another wallet"', async () => {
  const DEP = A(730), BOT = A(731), GHOST = A(732), SIS = A(733);
  const rows = [tx({ to: DEP, amount: 1 }), tx({ to: DEP, amount: 2 })];
  const lookup = async (_c: any, action: string) => action === 'txlist' ? [
    tx({ from: DEP, to: BINANCE, amount: 3, dir: 'out' }),
    tx({ from: BOT, to: DEP, amount: 1, dir: 'in' }), tx({ from: GHOST, to: DEP, amount: 1, dir: 'in' }), tx({ from: SIS, to: DEP, amount: 1, dir: 'in' }),
  ] : [];
  const fs = await linkedWallets.run(ctx([hist(1, rows)], { lookup, nonces: { [BOT]: 63_355, [GHOST]: 0, [SIS]: 9 } }));
  assert.deepEqual(fs.find((x) => x.id === 'linked_wallets.shared_deposit')!.related!.map((r) => r.address), [SIS]);
});

// ---------- look-alikes are a warning, never a link ----------
import { lookalike } from '../src/detectors/context.ts';
import { poisoningWarning } from '../src/detectors/poisoning.ts';

test('A3 look-alikes: 4+4, 3+4 and 4+3 equal hex characters; 3+3 or a different middle only is not one', () => {
  const real = '0x983f20a7bd9ec265f153531f708dae48b8404689';
  assert.ok(lookalike('0x983193ae29d39586c4e9863ca7f168505e404689', real), '3 + 4 (seen on nick.eth, 2026-10-16)');
  assert.ok(lookalike('0xad3f44649757a3f8399584f368e56cbc192083d2', '0xad3fffee131aaf9fe1038d921d66652c192083d2'), '4 + 9');
  assert.ok(lookalike('0x983f000000000000000000000000000000000689', real), '4 + 3');
  assert.ok(!lookalike('0x9830000000000000000000000000000000000689', real), '3 + 3 is chance');
  assert.ok(!lookalike(real, real), 'an address does not imitate itself');
});

test('A3: the look-alikes of the wallet and of a counterparty go into one warning, with what each imitates', async () => {
  const FRIEND = '0x2222' + '00'.repeat(16) + '2222';
  const FRIEND_MIMIC = '0x2222' + 'cd'.repeat(16) + '2222';
  const MIMIC = '0x1111' + 'ab'.repeat(16) + '1111';
  const rows = [
    tx({ to: FRIEND, amount: 0.5 }), tx({ from: FRIEND, to: ME, amount: 0.2 }), tx({ to: FRIEND, amount: 0.1 }),
    tx({ from: FRIEND_MIMIC, to: ME, amount: 0.000001 }), tx({ from: MIMIC, to: ME, amount: 0.000001 }),
  ];
  const c = ctx([hist(1, rows)]);
  const w = poisoningWarning(c)!;
  assert.equal(w.id, 'address_poisoning');
  assert.deepEqual(w.lookalikes.map((x) => [x.address, x.imitates]).sort(), [[FRIEND_MIMIC, FRIEND], [MIMIC, ME]].sort());
  assert.ok(w.evidence.every((e) => e.text.includes(e.address!)), 'the full address is in the text, never a short form');
  assert.doesNotMatch(w.title + w.explanation, /—|·/);
  const fs = await linkedWallets.run(c);
  assert.ok(fs.every((f) => !(f.related ?? []).some((r) => r.address === MIMIC || r.address === FRIEND_MIMIC)));
});

test('A3: of two look-alikes with the same traffic, the one seen first is the original', () => {
  const X = '0x7037' + 'a1'.repeat(16) + 'f7c1', Y = '0x7037' + '12'.repeat(16) + 'f7c1';
  const rows = [tx({ from: X, to: ME, amount: 0.3, timestamp: T0 }), tx({ from: Y, to: ME, amount: 0.3, timestamp: T0 + 60 })];
  const m = counterparties(ctx([hist(1, rows)]));
  assert.equal(m.get(X)!.poison, undefined);
  assert.equal(m.get(Y)!.imitates, X);
});

test('A3: a look-alike of the wallet never reaches linkedWallets, whatever a detector returns', async () => {
  const { assemble } = await import('../src/scan.ts');
  const MIMIC2 = '0x1111' + 'ef'.repeat(16) + '1111';
  const f = { id: 'linked_wallets.back_and_forth', key: 'linked_wallets.back_and_forth', detector: 'linked_wallets' as const, severity: 'high' as const, confidence: 0.8, scoreImpact: 0, rawImpact: 0, title: 't', explanation: 'e', evidence: [], chains: [1],
    related: [{ address: MIMIC2, confidence: 0.8, reasons: ['back and forth transfers'], chainIds: [1] }, { address: A(740), confidence: 0.6, reasons: ['back and forth transfers'], chainIds: [1] }] };
  const r = assemble(ME, [f], [], null, Date.now(), new Date().toISOString(), 'complete', {});
  assert.deepEqual(r.linkedWallets.map((x) => x.address), [A(740)]);
});

test('A3: a fake token sent TO you is not a transfer from that wallet (no back and forth from it)', async () => {
  const P = A(750);
  const rows = [
    tx({ to: P, amount: 0.4 }), tx({ to: P, amount: 0.2 }),
    { ...tx({ kind: 'token', from: P, to: ME, amount: 900, symbol: 'USDT', token: A(751) }), priced: false, holders: 3 },
  ];
  assert.ok(!(await linkedWallets.run(ctx([hist(1, rows)]))).some((f) => f.id === 'linked_wallets.back_and_forth'));
  const real = [rows[0], rows[1], { ...rows[2], priced: true }];
  assert.ok((await linkedWallets.run(ctx([hist(1, real)]))).some((f) => f.id === 'linked_wallets.back_and_forth'), 'the same flow in a real token does link');
});

test('funding_reuse: a contract or a tagged service that paid your first transaction on two chains does not tie them together', async () => {
  const S = A(760);
  for (const make of [
    (c: number) => ({ ...tx({ chainId: c, kind: 'internal', from: S, to: ME, amount: 0.05 }) }),
    (c: number) => ({ ...tx({ chainId: c, from: S, to: ME, amount: 0.05 }), cp: { tags: ['Some Bridge: Relayer'] } }),
  ]) {
    const hs = [1, 8453].map((c) => hist(c, [make(c), tx({ chainId: c, to: A(761), amount: 0.01 })]));
    assert.ok(hs.every((h) => h.firstFunding?.from === S));
    const fs = await fundingReuse.run(ctx(hs));
    assert.ok(!fs.some((f) => f.id === 'funding_reuse.same_funder_multichain'));
  }
});

test('A3: three look-alikes of one counterparty all point at the original, never at each other', () => {
  const REAL = '0x8cc6' + '47'.repeat(16) + '519a', P1 = '0x8cc6' + 'f7'.repeat(16) + '519a', P2 = '0x8cc6' + 'f6'.repeat(16) + '519a';
  // You paid REAL 1000 USDC; 17 minutes later P1 sent you dust, a month later P2 (seen on orbiter1, 2026-10-16).
  const rows = [
    tx({ from: P2, to: ME, amount: 0.00001, timestamp: T0 + 33 * 86400 }),
    tx({ from: P1, to: ME, amount: 0.00001, timestamp: T0 + 17 * 60 }),
    tx({ to: REAL, amount: 1000, timestamp: T0 }),
  ]; // listed newest first, as the explorer does
  const m = counterparties(ctx([hist(1, rows)]));
  assert.equal(m.get(REAL)!.poison, undefined);
  assert.equal(m.get(P1)!.imitates, REAL);
  assert.equal(m.get(P2)!.imitates, REAL);
});

// ---------- wallets that only received, a chain that failed, precompiles ----------
test('a wallet the funder paid that never sent a transaction there is no sibling', async () => {
  const F = A(9), SENDS = A(31), GIFTED = A(32);
  const rows = [tx({ from: F, to: ME, amount: 0.05, block: 500 }), tx({ to: A(50), amount: 0.01 })];
  const lookup = async () => [SENDS, GIFTED, ME].map((to) => tx({ from: F, to, amount: 0.05, dir: 'out' }));
  const fs = await fundingReuse.run(ctx([hist(1, rows)], { lookup, nonces: { [SENDS]: 4, [GIFTED]: 0 } }));
  const f = fs.find((x) => x.id === 'funding_reuse.shared_funder')!;
  assert.deepEqual(f.related!.map((r) => r.address), [SENDS]);
  assert.equal(f.confidence, 0.55, 'one other wallet now');
});

test('a fresh wallet you funded that never sent anything itself is only a weak link', async () => {
  const IDLE = A(81), USED = A(82);
  const rows = [tx({ from: A(80), to: ME, amount: 1, block: 100 }), tx({ to: IDLE, amount: 0.05, block: 200 }), tx({ to: USED, amount: 0.07, block: 300 })];
  const lookup = async (_c: any, action: string, addr: string) => (action !== 'txlist' ? [] : [tx({ from: ME, to: addr, amount: 0.05, dir: 'in', block: addr === IDLE ? 200 : 300 })]);
  const fs = await linkedWallets.run(ctx([hist(1, rows)], { lookup, nonces: { [IDLE]: 0, [USED]: 3 } }));
  const f = fs.find((x) => x.id === 'linked_wallets.funded_by_you')!;
  assert.equal(f.related!.find((r) => r.address === IDLE)!.confidence, 0.3);
  assert.equal(f.related!.find((r) => r.address === USED)!.confidence, 0.6);
  assert.equal(f.confidence, 0.6);
});

test('when the funding on a chain the wallet used could not be read, no shared funder is picked from another chain', async () => {
  const F1 = A(41), F2 = A(42);
  const rh = hist(4663, [tx({ chainId: 4663, from: F1, to: ME, amount: 0.04, block: 900 }), tx({ chainId: 4663, to: A(51), amount: 0.01, block: 901 })]);
  const base = hist(8453, [tx({ chainId: 8453, from: F2, to: ME, amount: 0.05, block: 700 }), tx({ chainId: 8453, to: A(52), amount: 0.01, block: 701 })]);
  const lookup = async (_c: any, _a: string, addr: string) => (addr === F1
    ? [A(61), A(62), ME].map((to) => tx({ chainId: 4663, from: F1, to, amount: 0.04, dir: 'out' }))
    : Array.from({ length: 34 }, (_, i) => tx({ chainId: 8453, from: F2, to: A(300 + i), amount: 0.05, dir: 'out' })));
  const full = await fundingReuse.run(ctx([rh, base], { lookup }));
  assert.deepEqual(full.find((x) => x.id === 'funding_reuse.shared_funder')!.chains, [4663], 'the funder with the fewest other wallets');
  // Robinhood Chain fails: its funding is unknown, and Base must not quietly take its place.
  const failed: ChainHistory = { ...rh, txs: [], tokens: [], internal: [], ownCount: 0, firstOwn: undefined, firstFunding: undefined,
    coverage: { ...rh.coverage, status: 'error', error: 'explorer error', txCount: 0, precheck: { sent: 2, holds: true } } };
  const part = await fundingReuse.run(ctx([failed, base], { lookup }));
  assert.ok(!part.some((x) => ['funding_reuse.shared_funder', 'funding_reuse.unique_funder', 'funding_reuse.busy_funder'].includes(x.id)), ids(part).join(', '));
  // A failed chain where the quick check saw nothing sent holds nothing back.
  const empty: ChainHistory = { ...failed, coverage: { ...failed.coverage, precheck: { sent: 0, holds: false } } };
  assert.ok((await fundingReuse.run(ctx([empty, base], { lookup }))).some((x) => x.id === 'funding_reuse.shared_funder'));
  // A gap in the explorer's index is the same every scan: it holds nothing back (hop581's sybil links stay).
  const gap: ChainHistory = { ...failed, coverage: { ...failed.coverage, status: 'partial', error: undefined, missing: ['transactions (the explorer lists none of the 138 this address sent here)'] } };
  assert.ok((await fundingReuse.run(ctx([gap, base], { lookup }))).some((x) => x.id === 'funding_reuse.shared_funder'));
});

test('precompiles and system contracts are never look-alikes', () => {
  assert.equal(lookalike('0x0000000000000000000000000000000000000001', '0x0000000000000000000000000000000000008001'), false, 'ecrecover and a ZKsync system contract');
  assert.ok(lookalike('0x983193ae29d39586c4e9863ca7f168505e404689', '0x983f20a7a0000000000000000000000000004689'), 'a real one still is');
});

test('the poisoning warning of a contract or a service speaks of "this address", never "you"', async () => {
  const { poisoningWarning } = await import('../src/detectors/poisoning.ts');
  const MIMIC = ME.slice(0, 6) + '9'.repeat(32) + ME.slice(-4);
  const h = hist(1, [tx({ from: A(10), to: ME, amount: 1 }), tx({ to: A(11), amount: 0.1 }), tx({ from: MIMIC, to: ME, amount: 0.000001 })]);
  const person = poisoningWarning(ctx([h]))!;
  assert.match(person.title, /in your history$/);
  const c = ctx([h]);
  c.thirdPerson = true;
  const service = poisoningWarning(c)!;
  assert.equal(service.title, "A look-alike address is in this address's history");
  assert.ok(![service.title, service.explanation, ...service.evidence.map((e) => e.text)].some((t) => /\b(you|your)\b/i.test(t)), service.explanation);
});
