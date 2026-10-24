// Link Graph: from one wallet, the links to other wallets hop after hop. Synthetic sessions, no network:
// each "scan" is a replay of a session, held under its result the way a real scan holds it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assembleGraph, linkGraph, MAX_CONFIDENCE, scanLinks, type GraphLink, type LinkGraph } from '../../src/features/link-graph.ts';
import { compareWallets } from '../../src/features/compare.ts';
import { rerun } from '../../src/features/replay.ts';
import { sessionOf } from '../../src/session.ts';
import type { Transfer } from '../../src/history.ts';
import { keepSession } from '../../src/session.ts';
import type { ScanResult } from '../../src/types.ts';
import { sessionFrom } from './fixtures.ts';
import { A, T0 } from '../helpers.ts';

const R = '0x1000000000000000000000000000000000000001'; // the first wallet
const C1 = '0x2000000000000000000000000000000000000002';
const C2 = '0x3000000000000000000000000000000000000003';
const W = '0x4000000000000000000000000000000000000004';
const G1 = '0x5000000000000000000000000000000000000005';
const G2 = '0x6000000000000000000000000000000000000006';
const H = '0x7000000000000000000000000000000000000007';
const BINANCE = '0x28c6c06298d514db089934071355e5743bf21d60';
const LISTED_DEPOSIT = '0x000f9f5f6db6d63bb64bb55d58272a1ce660fd90'; // Binance deposit address in the open label list

let seq = 0;
const rows = new Map<string, Transfer[]>();
/** One transfer, put in the history of both its ends, as each of them sees it. */
function pay(from: string, to: string, amount = 0.1) {
  seq++;
  const base: Omit<Transfer, 'dir'> = {
    chainId: 1, hash: '0x' + seq.toString(16).padStart(64, '0'), block: 1000 + seq, timestamp: T0 + seq * 600,
    from, to, kind: 'native', amount, symbol: 'ETH', failed: false, gasLimit: 21000, isCall: false,
  };
  for (const me of [from, to]) rows.set(me, [...(rows.get(me) ?? []), { ...base, dir: me === from ? 'out' : 'in' }]);
}
/** n transfers out of `a` to `b` and m back, alternating. */
function both(a: string, b: string, n: number, m: number) {
  for (let i = 0; i < Math.max(n, m); i++) {
    if (i < n) pay(a, b, 0.11 + i / 100);
    if (i < m) pay(b, a, 0.21 + i / 100);
  }
}

// Every wallet first gets coins from an exchange, so no two share a person as funder.
for (const w of [R, C1, C2, W, G1, G2, H]) pay(BINANCE, w, 1);
both(R, C1, 3, 2); // 0.61, Possible
both(R, C2, 2, 2); // 0.59
both(R, W, 2, 1); // 0.49
both(C1, G1, 4, 3); // 0.73, Likely
both(C2, G2, 2, 2); // 0.59
both(G1, H, 3, 2); // 0.61
pay(C1, LISTED_DEPOSIT, 0.5); // C1 and C2 pay into one exchange deposit address: a link only Compare sees
pay(C2, LISTED_DEPOSIT, 0.7);

const results = new Map<string, ScanResult>();
async function resultOf(me: string): Promise<ScanResult> {
  let r = results.get(me);
  if (r) return r;
  const s = sessionFrom(me, rows.get(me) ?? []);
  r = await rerun(s);
  keepSession(r, s);
  results.set(me, r);
  return r;
}

function reader() {
  const asked: string[] = [];
  return { asked, read: async (a: string) => { asked.push(a); return resultOf(a); } };
}
const node = (g: LinkGraph, a: string) => g.nodes.find((n) => n.address === a);
const link = (g: LinkGraph, x: string, y: string) => g.links.find((l) => (l.a === x && l.b === y) || (l.a === y && l.b === x));

test('the scan of one wallet: each linked wallet with its reasons and the transactions behind them', async () => {
  const m = await scanLinks(await resultOf(R));
  const c1 = m.get(C1)!;
  assert.equal(c1.confidence, 0.61);
  assert.equal(c1.level, 'possible');
  assert.equal(c1.read, 'one');
  assert.equal(c1.reasons[0].ruleId, 'linked_wallets.back_and_forth');
  assert.match(c1.reasons[0].text, /sent to 0x2000\.\.\.0002 3 times and received from it 2 times, on Ethereum/);
  const txs = c1.reasons[0].evidence.filter((e) => e.kind === 'tx');
  assert.equal(txs.length, 5, 'all five transfers between the two, each with its hash');
  assert.ok(txs.every((e) => e.url?.startsWith('https://') && e.url.includes(e.txHash!)), 'each transfer links to the explorer');
  assert.deepEqual(txs.map((e) => e.timestamp), [...txs.map((e) => e.timestamp)].sort((a, b) => a! - b!), 'oldest first');
  assert.ok(!m.has(BINANCE) && !m.has(LISTED_DEPOSIT), 'an exchange and a deposit address are never linked wallets');
});

test('grow: reads one hop by itself, shows the next, and every likelihood falls with each hop', async () => {
  const rd = reader();
  const run = linkGraph(await resultOf(R), { read: rd.read });
  const g = await run.grow();
  assert.deepEqual(rd.asked.sort(), [C1, C2, W].sort(), 'the three wallets one hop away, nothing further');
  assert.equal(node(g, R)!.state, 'start');
  assert.equal(node(g, R)!.reach, null);
  for (const a of [C1, C2, W]) assert.equal(node(g, a)!.state, 'read');
  for (const a of [G1, G2]) assert.deepEqual([node(g, a)!.state, node(g, a)!.hop, node(g, a)!.stop], ['unread', 2, 'depth']);
  assert.equal(node(g, H), undefined, 'three hops away: not in the graph until G1 is read');
  // Reach is the product along the strongest path, so it never rises with a hop.
  assert.equal(node(g, G1)!.via, C1);
  assert.equal(node(g, G1)!.reach, Math.round(0.61 * 0.73 * 100) / 100);
  assert.equal(node(g, G1)!.level, 'possible', 'the word goes with the number shown: 45% is Possible');
  assert.ok(node(g, G1)!.reach! < 0.61 && node(g, G2)!.level === 'weak', 'a Likely link behind a Possible one makes a weaker path (G2: 0.59 times 0.59)');
  for (const n of g.nodes) if (n.via) assert.ok(n.reach! <= node(g, n.via)!.reach! || n.via === R, `${n.address} is no more likely than the wallet before it`);
  // Both ends read: Compare weighed the pair, with the transfers as proof.
  const rc1 = link(g, R, C1)!;
  assert.equal(rc1.read, 'both');
  assert.equal(rc1.a, R, 'a link points away from the first wallet');
  assert.ok(rc1.reasons[0].evidence.some((e) => e.kind === 'tx' && e.url));
  // One end read: the scan's own link.
  assert.equal(link(g, C1, G1)!.read, 'one');
  assert.equal(link(g, C1, G1)!.confidence, 0.73);
  assert.equal(g.reads, 4);
  assert.equal(g.running, false);
});

test('a link neither scan listed: two wallets one hop out pay into the same deposit address', async () => {
  const g = await linkGraph(await resultOf(R), { read: reader().read }).grow();
  const l = link(g, C1, C2)!;
  assert.ok(l, 'Compare ties C1 and C2 together');
  assert.equal(l.read, 'both');
  assert.equal(l.reasons[0].ruleId, 'linked_wallets.shared_deposit');
  assert.equal(l.level, 'likely');
  assert.equal(l.reasons[0].evidence[0].address, LISTED_DEPOSIT);
  // A second road does not make the direct one weaker: C2 keeps its own strongest path.
  assert.equal(node(g, C2)!.via, R);
});

test('follow: one more wallet by hand, past the depth; its links come in one hop further', async () => {
  const rd = reader();
  const run = linkGraph(await resultOf(R), { read: rd.read });
  await run.grow();
  const g = await run.follow(G1);
  assert.equal(node(g, G1)!.state, 'read');
  assert.deepEqual([node(g, H)!.hop, node(g, H)!.state, node(g, H)!.stop], [3, 'unread', 'depth']);
  assert.ok(node(g, H)!.reach! < node(g, G1)!.reach!);
  await assert.rejects(run.follow(A(0xdead)), /not in the graph/);
});

test('the read limit: the most likely first, the rest marked as waiting on the limit', async () => {
  const rd = reader();
  const g = await linkGraph(await resultOf(R), { read: rd.read, limits: { reads: 2 } }).grow();
  assert.deepEqual(rd.asked, [C1], 'C1 (0.61) before C2 (0.59) and W (0.49)');
  assert.equal(node(g, C2)!.stop, 'limit');
  assert.equal(node(g, W)!.stop, 'limit');
  const run = linkGraph(await resultOf(R), { read: rd.read, limits: { reads: 1, maxReads: 1 } });
  await run.grow();
  await assert.rejects(run.follow(C1), /limit/);
});

test('a weak link is shown but not followed', async () => {
  const rd = reader();
  const g = await linkGraph(await resultOf(R), { read: rd.read, limits: { follow: 0.6 } }).grow();
  assert.deepEqual(rd.asked, [C1], 'only the link of 0.61 is at least 0.6');
  assert.equal(node(g, C2)!.stop, 'weak');
  assert.equal(node(g, W)!.stop, 'weak');
});

test('a stopped graph keeps what it read and reads nothing more', async () => {
  const ac = new AbortController();
  const asked: string[] = [];
  const run = linkGraph(await resultOf(R), { signal: ac.signal, read: async (a) => { asked.push(a); ac.abort(); throw new Error('stopped'); } });
  const g = await run.grow();
  assert.ok(asked.length <= 2, 'at most the reads that had started');
  assert.equal(g.running, false);
  assert.equal(node(g, R)!.state, 'start');
});

test('a failed read keeps the link the other scan saw, marked failed', async () => {
  const g = await linkGraph(await resultOf(R), { read: async (a) => { if (a === W) throw new Error('explorer down'); return resultOf(a); } }).grow();
  assert.equal(node(g, W)!.state, 'failed');
  assert.equal(link(g, R, W)!.read, 'one');
});

test("a public tag on the first wallet does not make Compare's silence a verdict: its own scan reads it as a person", async () => {
  const T = '0x8000000000000000000000000000000000000008', U = '0x9000000000000000000000000000000000000009';
  pay(BINANCE, T, 1);
  pay(BINANCE, U, 1);
  both(T, U, 3, 2);
  // In U's rows the explorer tags T, as it tags a known exploiter: Compare then calls T "a tagged service".
  rows.set(U, rows.get(U)!.map((t) => (t.from === T || t.to === T ? { ...t, cp: { tags: ['Famous Exploiter'] } } : t)));
  const sT = sessionFrom(T, rows.get(T)!), sU = sessionFrom(U, rows.get(U)!);
  const rT = await rerun(sT), rU = await rerun(sU);
  keepSession(rT, sT);
  keepSession(rU, sU);
  assert.equal((await compareWallets(sT, sU)).notPersonal.a, 'a tagged service (Famous Exploiter)');
  const g = await linkGraph(rT, { read: async () => rU }).grow();
  assert.equal(node(g, U)!.state, 'read');
  assert.equal(link(g, T, U)!.confidence, 0.61, "T's own scan linked U: that link stands");
});

test('onChange: every read starts and ends with a graph to draw', async () => {
  const seen: LinkGraph[] = [];
  await linkGraph(await resultOf(R), { read: reader().read, onChange: (g) => seen.push(g) }).grow();
  assert.ok(seen.some((g) => g.running && g.nodes.some((n) => n.state === 'reading')));
  assert.equal(seen.at(-1)!.running, false);
});

/* ---------- assembleGraph on its own: the rules that hold whatever the scans say ---------- */

const fake = (address: string, extra: Partial<ScanResult> = {}): ScanResult => ({
  schemaVersion: 1, address, scannedAt: '', durationMs: 0, status: 'complete', addressType: 'eoa', score: 50, band: 'traceable',
  breakdown: { base: 100, byDetector: {} as never, capped: [] }, findings: [], linkedWallets: [], warnings: [], identity: { labels: [] },
  coverage: [], incomplete: [], engine: { name: 'nymra-privacy-scan', version: '0', rulesVersion: '0' }, ...extra,
});
const lk = (a: string, b: string, confidence: number): GraphLink => ({ a, b, confidence, level: 'likely', reasons: [], read: 'one', chainIds: [1] });
const parts = (o: Partial<Parameters<typeof assembleGraph>[0]>) => assembleGraph({
  start: R, results: new Map([[R, fake(R)]]), links: new Map(), pairs: new Map(), reading: new Set(), failed: new Set(),
  limits: { depth: 2, perWallet: 6, follow: 0.45, reach: 0.3, reads: 7, maxReads: 16, nodes: 40, together: 2 }, ...o,
});

test('never certain: a path is at most MAX_CONFIDENCE, also when one link says more', () => {
  const g = parts({ links: new Map([[R, new Map([[C1, lk(R, C1, 0.99)]])]]) });
  assert.equal(node(g, C1)!.reach, MAX_CONFIDENCE);
  assert.ok(MAX_CONFIDENCE < 1);
});

test('a wallet that turns out to be a service or a contract is never a link, and the graph does not run through it', () => {
  const results = new Map([[R, fake(R)], [C1, fake(C1, { identity: { labels: [], service: { kind: 'exchange', entity: 'Binance' } } })], [C2, fake(C2, { addressType: 'contract', identity: { labels: [], contract: { chains: [1] } } })]]);
  const g = parts({
    results,
    links: new Map([[R, new Map([[C1, lk(R, C1, 0.8)], [C2, lk(R, C2, 0.7)]])], [C1, new Map([[G1, lk(C1, G1, 0.9)]])]]),
  });
  assert.deepEqual(g.nodes.map((n) => n.address), [R]);
  assert.deepEqual(g.links, []);
  assert.deepEqual(g.notPersonal.map((x) => [x.address, x.what]), [[C1, 'an exchange wallet (Binance)'], [C2, 'a contract']]);
});

test('Compare has the last word on a pair both read: no link found removes the scan\'s link', () => {
  const g = parts({
    results: new Map([[R, fake(R)], [C1, fake(C1)]]),
    links: new Map([[R, new Map([[C1, lk(R, C1, 0.6)]])]]),
    pairs: new Map([[`${R}|${C1}`, null]]),
  });
  assert.equal(link(g, R, C1), undefined);
});

test('a big graph keeps its most likely wallets, and links only between wallets it kept', () => {
  const many = new Map(Array.from({ length: 12 }, (_, i) => { const a = A(0x100 + i); return [a, lk(R, a, 0.5 + i / 100)] as const; }));
  const g = parts({ links: new Map([[R, many]]), limits: { depth: 2, perWallet: 20, follow: 0.45, reach: 0.3, reads: 7, maxReads: 16, nodes: 5, together: 2 } });
  assert.equal(g.nodes.length, 5);
  assert.deepEqual(g.nodes.slice(1).map((n) => n.reach), [0.61, 0.6, 0.59, 0.58]);
  assert.ok(g.links.every((l) => g.nodes.some((n) => n.address === l.b)));
  const six = parts({ links: new Map([[R, many]]) });
  assert.equal(six.nodes.length, 7, 'the start and its six strongest links (perWallet)');
});

test('every link points away from the first wallet, whichever scan wrote it', () => {
  const g = parts({ links: new Map([[R, new Map([[C1, lk(C1, R, 0.7)]])], [C1, new Map([[G1, lk(G1, C1, 0.6)]])]]) });
  assert.deepEqual(g.links.map((l) => [l.a, l.b]), [[R, C1], [C1, G1]]);
});

test("Compare takes the caller's replay: one replay per wallet for the whole graph, not one per pair", async () => {
  const asked: string[] = [];
  const again = (s: Parameters<typeof rerun>[0]) => { asked.push(s.me); return rerun(s); };
  await compareWallets(sessionOf(await resultOf(R))!, sessionOf(await resultOf(C1))!, { rerun: again });
  assert.deepEqual(asked, [R, C1]);
});

/* ---------- Exchange deposit addresses: recognised, named only where Nymra can show it ---------- */

test('a listed deposit address two read wallets pay into: one deposit in the graph, named by the list, never a wallet of it', async () => {
  const g = await linkGraph(await resultOf(R), { read: reader().read }).grow();
  const d = g.deposits.find((x) => x.address === LISTED_DEPOSIT)!;
  assert.ok(d, 'the deposit address is in the graph');
  assert.equal(d.entity, 'Binance');
  assert.equal(d.how, 'label');
  assert.deepEqual(d.users.map((u) => u.address).sort(), [C1, C2].sort());
  assert.ok(d.users.every((u) => u.evidence.some((e) => e.kind === 'tx' && e.url?.includes(e.txHash!))), 'each payment in links to the explorer');
  assert.equal(d.confidence, 0.92);
  assert.equal(d.level, 'likely');
  assert.match(d.evidence[0].text, /^Listed as a Binance deposit address in the open exchange labels Nymra carries$/);
  assert.ok(!g.nodes.some((n) => n.address === LISTED_DEPOSIT || n.address === BINANCE), 'a deposit address and an exchange wallet carry no path');
  assert.ok(!g.deposits.some((x) => x.address === BINANCE), "the exchange's own wallet is no deposit address");
  assert.ok(g.deposits.every((x) => x.confidence <= MAX_CONFIDENCE));
});

test('a deposit address found by its forward: named after the exchange it forwarded to, with that transfer as proof', async () => {
  const S1 = '0xa100000000000000000000000000000000000001', S2 = '0xa200000000000000000000000000000000000002';
  const SWEEP = '0xa300000000000000000000000000000000000003';
  for (const w of [S1, S2]) pay(BINANCE, w, 1);
  pay(S1, SWEEP, 0.4);
  pay(S1, SWEEP, 0.6);
  pay(S2, SWEEP, 0.3);
  pay(SWEEP, BINANCE, 1.3); // the deposit address forwards what came in to the exchange's own wallet
  const lookups = (s: string) => [
    { chainId: 1, action: 'txlist' as const, address: SWEEP, q: { sort: 'desc' as const, offset: 50 }, rows: Promise.resolve(rows.get(SWEEP)!) },
    { chainId: 1, action: 'tokentx' as const, address: SWEEP, q: { sort: 'desc' as const, offset: 50 }, rows: Promise.resolve([]) },
  ].filter(() => s);
  const res = new Map<string, ScanResult>();
  for (const w of [S1, S2]) {
    const s = sessionFrom(w, rows.get(w)!, { lookups: lookups(w), nonces: { [`1:${S1}`]: 3, [`1:${S2}`]: 1 } });
    const r = await rerun(s);
    keepSession(r, s);
    res.set(w, r);
  }
  const g = await linkGraph(res.get(S1)!, { read: async (a) => res.get(a)! }).grow();
  const d = g.deposits.find((x) => x.address === SWEEP)!;
  assert.ok(d, 'the forwarding address is a deposit address of the graph');
  assert.deepEqual([d.entity, d.how, d.confidence], ['Binance', 'sweep', 0.8]);
  assert.equal(d.evidence[0].kind, 'tx');
  assert.match(d.evidence[0].text, /^It forwarded 1\.3 ETH to a labelled Binance wallet$/);
  assert.ok(d.evidence[0].url?.includes(d.evidence[0].txHash!));
  assert.equal(d.evidence[1].address, BINANCE);
  assert.deepEqual(d.users.map((u) => [u.address, u.count]), [[S1, 2], [S2, 1]], 'the most payments first');
  const l = link(g, S1, S2)!;
  assert.ok(l, 'the two wallets that pay into it are linked');
  const why = l.reasons.find((r) => r.ruleId === 'linked_wallets.shared_deposit')!;
  assert.ok(why, 'with the shared deposit address as a reason');
  assert.equal(why.title, 'Both pay into the same Binance deposit address');
  assert.match(why.text, /An exchange that verified that account can put a name to both\.$/);
  assert.ok(why.confidence < 1 && l.confidence <= MAX_CONFIDENCE, 'a likelihood, never certain');
  // S2 not read: the deposit address still lists it, from what S1's scan saw paid in, and S1's scan names the exchange.
  const one = await linkGraph(res.get(S1)!, { read: async (a) => res.get(a)!, limits: { reads: 1 } }).grow();
  const d1 = one.deposits.find((x) => x.address === SWEEP)!;
  assert.deepEqual(d1.users.map((u) => [u.address, u.count]), [[S1, 2], [S2, 1]]);
  assert.ok(d1.users[1].evidence.some((e) => e.kind === 'tx' && e.text.includes('paid 0.3 ETH into it')), "S2's payment in, from the deposit address's own list");
  const why1 = link(one, S1, S2)!.reasons.find((r) => r.ruleId === 'linked_wallets.shared_deposit')!;
  assert.equal(link(one, S1, S2)!.read, 'one');
  assert.equal(why1.title, 'The same Binance deposit address');
  assert.match(why1.text, /the Binance deposit address 0xa300\.\.\.0003/);
  assert.ok(why1.evidence.some((e) => e.address === SWEEP && e.text === 'The Binance deposit address both paid into'));
});

test('a deposit address the explorer tags without naming the exchange: an exchange deposit, no name guessed', async () => {
  const U1 = '0xb100000000000000000000000000000000000001', TAGGED = '0xb200000000000000000000000000000000000002';
  pay(BINANCE, U1, 1);
  pay(U1, TAGGED, 0.5);
  const own = rows.get(U1)!.map((t) => (t.to === TAGGED ? { ...t, cp: { slugs: ['exchange', 'deposit'] } } : t));
  const s = sessionFrom(U1, own);
  const r = await rerun(s);
  keepSession(r, s);
  const g = await linkGraph(r, { read: async () => { throw new Error('nothing to read'); } }).grow();
  const d = g.deposits.find((x) => x.address === TAGGED)!;
  assert.ok(d);
  assert.equal(d.entity, undefined, 'no name: the tag gives none');
  assert.equal(d.how, 'label');
  assert.match(d.evidence[0].text, /^Tagged as an exchange deposit address by the public explorer$/);
});

test('assembleGraph: a deposit shows only with a wallet of the graph, never from a wallet that is no person; the list names it over a forward', () => {
  const dep = (address: string, users: string[], how: 'label' | 'sweep' = 'sweep', entity?: string, senders = 2) => ({
    address, chainId: 1 as const, how, confidence: 0.8, level: 'likely' as const, senders, shared: senders > 6, ...(entity ? { entity } : {}),
    users: users.map((a) => ({ address: a, count: 1, evidence: [] })), evidence: [{ kind: 'address' as const, text: how, address }],
  });
  const D1 = A(0xd1), D2 = A(0xd2), D3 = A(0xd3), D4 = A(0xd4);
  // C2 is a bridge (no person); W was read but no link reaches it, so it is not in the graph.
  const results = new Map([[R, fake(R)], [C1, fake(C1)], [C2, fake(C2, { identity: { labels: [], service: { kind: 'bridge' } } })], [W, fake(W)]]);
  const g = parts({
    results,
    links: new Map([[R, new Map([[C1, lk(R, C1, 0.7)]])]]),
    deposits: new Map([
      [R, [dep(D1, [R, G2], 'sweep', 'OKX'), dep(D3, [R], 'sweep', undefined, 9)]],
      [C1, [{ ...dep(D1, [C1], 'label', 'OKX'), users: [{ address: C1, count: 3, evidence: [] }] }]],
      [C2, [dep(D2, [C2, R])]],
      [W, [dep(D4, [W])]],
    ]),
  });
  assert.deepEqual(g.deposits.map((d) => d.address), [D1, D3], "D2 is a bridge's scan, D4's only wallet is not in the graph, G2 is not either");
  const d1 = g.deposits[0];
  assert.deepEqual(d1.users.map((u) => u.address), [C1, R], 'the most payments first');
  assert.deepEqual([d1.how, d1.evidence[0].text, d1.confidence], ['label', 'label', 0.92]);
  const d3 = g.deposits[1];
  assert.deepEqual([d3.entity, d3.shared, d3.confidence, d3.level], [undefined, true, 0.6, 'possible']);
});

test('an address one scan found to be a deposit address is never a wallet of the graph, also where another scan linked it', () => {
  const D = A(0xd5);
  const g = parts({
    results: new Map([[R, fake(R)], [C1, fake(C1)]]),
    links: new Map([[R, new Map([[C1, lk(R, C1, 0.7)]])], [C1, new Map([[D, lk(C1, D, 0.6)]])]]),
    deposits: new Map([[R, [{ address: D, chainId: 1, how: 'sweep', entity: 'Binance', confidence: 0.8, level: 'likely', senders: 2, shared: false, users: [{ address: R, count: 2, evidence: [] }, { address: C1, count: 1, evidence: [] }], evidence: [] }]]]),
  });
  assert.equal(node(g, D), undefined, 'no dot for it');
  assert.equal(link(g, C1, D), undefined, 'no line to it as a wallet');
  assert.deepEqual(g.deposits.map((d) => [d.address, d.users.length]), [[D, 2]], 'a square for it, with both wallets that pay in');
});
