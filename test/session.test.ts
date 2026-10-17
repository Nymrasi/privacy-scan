// The scan session (session.ts) and the replay flag the features build on. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeNonces } from '../src/detectors/context.ts';
import { analyzeFunders } from '../src/detectors/funding-reuse.ts';
import { analyzeRecipients } from '../src/detectors/deposits.ts';
import { DETECTOR_LIST } from '../src/detectors/index.ts';
import { runDetectors, scan } from '../src/scan.ts';
import { lookupKey, sessionOf, type Lookup } from '../src/session.ts';
import { scoreFindings } from '../src/score.ts';
import type { ScanProgress } from '../src/types.ts';
import { A, ctx, hist, ME as HME, tx } from './helpers.ts';

const ME = '0x2222222222222222222222222222222222222222';
const FUNDER = '0x4444444444444444444444444444444444444444';
const SIB = '0x5555555555555555555555555555555555555555';
const FRESH = '0x6666666666666666666666666666666666666666';
const FRIEND = '0x3333333333333333333333333333333333333333';

let n = 0;
const v2 = (from: string, to: string, eth: number, ts: number) => ({
  block_number: 1000 + ++n, timestamp: new Date(ts * 1000).toISOString(), hash: '0x' + n.toString(16).padStart(64, '0'),
  from: { hash: from, is_contract: false }, to: { hash: to, is_contract: false }, value: BigInt(Math.round(eth * 1e18)).toString(),
  gas_limit: '21000', gas_price: '1000000000', raw_input: '0x', status: 'ok',
});

/** Ethereum only: an EOA funder who also funded a sibling, and a fresh wallet we funded. */
function fakeFetch(log: string[]) {
  const T = 1_750_000_000;
  const mine = [v2(FUNDER, ME, 1, T), v2(ME, FRESH, 0.2, T + 600), v2(ME, FRIEND, 0.1, T + 900), v2(FRIEND, ME, 0.1, T + 1200), v2(ME, FRIEND, 0.1, T + 1500)].reverse();
  const funder = [v2(FUNDER, ME, 1, T), v2(FUNDER, SIB, 1, T + 300)].reverse();
  const fresh = [v2(ME, FRESH, 0.2, T + 600)];
  return (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    log.push(url);
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      const active = url.includes('ethereum-rpc');
      return json(body.map((c: any) => ({ id: c.id, result: active ? '0x5' : '0x0' })));
    }
    if (/\/api\/v2\/addresses\/0x[0-9a-f]{40}$/.test(url)) return json({ is_contract: false, public_tags: [], metadata: null });
    if (url.includes('addresses:lookup')) return json({ items: [] });
    const m = url.match(/eth\.blockscout\.com\/api\/v2\/addresses\/(0x[0-9a-f]{40})\/(\w[\w-]*)/);
    if (m) {
      const [, who, list] = m;
      const rows = list !== 'transactions' ? [] : who === ME ? mine : who === FUNDER ? funder : who === FRESH ? fresh : [];
      return json({ items: rows, next_page_params: null });
    }
    throw new Error('unexpected url in test: ' + url);
  }) as typeof fetch;
}

test('session: the final result keeps what the scan read; partial results keep nothing', async () => {
  const log: string[] = [];
  const events: ScanProgress[] = [];
  const r = await scan(ME, { chainIds: [1, 10], fetch: fakeFetch(log), onProgress: (e) => events.push(e) });
  const s = sessionOf(r);
  assert.ok(s, 'final result has a session');
  assert.equal(s.me, ME);
  assert.deepEqual(s.histories.map((h) => h.chain.id).sort(), [1, 10]);
  assert.equal(s.histories.find((h) => h.chain.id === 1)!.txs.length, 5);
  const partials = events.filter((e) => e.type === 'partial');
  assert.ok(partials.length > 0);
  for (const e of partials) assert.equal(sessionOf((e as any).result), undefined, 'partial results carry no session');
  assert.equal(sessionOf(structuredClone(r)), undefined, 'a copy is not the scan');

  // Every lookup the detectors made is recorded with its answer.
  const calls = [...s.lookups.values()];
  assert.ok(calls.some((c) => c.address === FUNDER && c.action === 'txlist'), 'funder lookup recorded');
  assert.ok(calls.some((c) => c.address === FRESH && c.action === 'txlist'), 'recipient lookup recorded');
  const fresh = await calls.find((c) => c.address === FRESH && c.action === 'txlist')!.rows;
  assert.equal(fresh![0].from, ME);
  assert.ok(r.findings.some((f) => f.id === 'linked_wallets.funded_by_you'));
  assert.ok(r.findings.some((f) => f.id === 'funding_reuse.shared_funder'));
  // So is every nonce check: the funder's (a service or a person?) with its answer.
  assert.equal(await s.nonces.get(`1:${FUNDER}`), 5);
});

test('session: replaying the record with no network gives the same result', async () => {
  const log: string[] = [];
  const r = await scan(ME, { chainIds: [1, 10], fetch: fakeFetch(log) });
  const s = sessionOf(r)!;
  const before = log.length;
  let asked = 0;
  const lookup: Lookup = (chain, action, address, q) => {
    const c = s.lookups.get(lookupKey(chain.id, action, address, q));
    if (c) return c.rows;
    asked++;
    return Promise.resolve(null);
  };
  const c = { ...ctx(s.histories, { profile: s.profile, lookup }), me: s.me, replay: true, nonces: makeNonces(ctx([]).http, () => undefined, undefined, new Map(s.nonces)) };
  const again = scoreFindings(await runDetectors(DETECTOR_LIST, c, s.histories.map((h) => h.coverage)));
  assert.equal(again.score, r.score);
  assert.deepEqual(again.findings.map((f) => f.key).sort(), r.findings.map((f) => f.key).sort());
  assert.equal(asked, 0, 'every question the replay asks was asked by the scan');
  assert.equal(log.length, before, 'no request');
});

test('replay: every recipient with a recorded answer is checked, not only the top five', async () => {
  // Seven fresh wallets, each funded once by us; the live scan checks five of them.
  const ws = Array.from({ length: 7 }, (_, i) => A(0x700 + i));
  const rows = ws.map((w, i) => tx({ to: w, amount: 0.1 + i / 100 }));
  const known: Lookup = async (_c, action, addr) => (action === 'tokentx' ? [] : [tx({ from: HME, to: addr, amount: 0.1, dir: 'in' })]);
  const live = await analyzeRecipients(ctx([hist(1, rows)], { lookup: known }));
  const replayed = await analyzeRecipients({ ...ctx([hist(1, rows)], { lookup: known }), replay: true });
  assert.equal(live.funded.length, 5, 'a live scan keeps to its candidate cap');
  assert.equal(replayed.funded.length, 7, 'a replay checks every candidate the record can answer');
});

test('replay: every funder is looked up, not only the first four', async () => {
  const chains = [1, 10, 8453, 42161, 137];
  const hs = chains.map((id, i) => hist(id, [tx({ chainId: id, from: A(0x800 + i), to: HME, amount: 1 }), tx({ chainId: id, to: A(0x900 + i), amount: 0.1, isCall: true })]));
  const seen = new Set<string>();
  const lookup: Lookup = async (_c, _a, addr) => { seen.add(addr); return []; };
  await analyzeFunders(ctx(hs, { lookup }));
  assert.equal(seen.size, 4, 'a live scan looks up four funders');
  seen.clear();
  await analyzeFunders({ ...ctx(hs, { lookup }), replay: true });
  assert.equal(seen.size, 5, 'a replay asks for every funder');
});
