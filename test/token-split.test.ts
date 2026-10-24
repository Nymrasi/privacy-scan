// Base's Blockscout took 8 to 17 s for one page of an address's token transfers (both directions at
// once) and 1 to 10 s for a page of one direction (filter=to, filter=from); a scan of vitalik.eth on nymra.si lost
// Base's whole token list to two 15 s timeouts. A chain with ChainDef.tokenSplit reads the two directions side by
// side and merges them. The merge must be the same list Blockscout gives for both: the same rows, the same order
// (newest block first, then log index), a transfer to itself once. Measured on 2026-10-24 for two real wallets on Base
// (250 and 207 rows over 5 pages): the merge was equal to the list of both, row for row.
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { accountList } from '../src/sources/explorer.ts';
import { clearSessionCache, createHttp, HttpError, resetHostState } from '../src/sources/http.ts';
import { CHAINS, type ChainDef } from '../src/chains.ts';

beforeEach(() => { clearSessionCache(); resetHostState(); });

const ME = '0x2222222222222222222222222222222222222222';
const A = '0x3333333333333333333333333333333333333333';
const chainOf = (extra: Partial<ChainDef> = {}): ChainDef =>
  ({ id: 990301, name: 'Split test chain', native: 'ETH', source: { kind: 'blockscout', api: 'https://split.test' }, explorer: 'https://split.test', defaultOn: false, ...extra });
const SPLIT = chainOf({ tokenSplit: true });
const WHOLE = chainOf();

/** One token transfer as Blockscout lists it. */
interface T { block: number; log: number; from: string; to: string }
const side = (a: string) => ({ hash: a, is_contract: false });
const item = (t: T) => ({
  block_number: t.block, log_index: t.log, timestamp: new Date((1_700_000_000 + t.block) * 1000).toISOString(),
  transaction_hash: '0x' + (t.block * 1000 + t.log).toString(16).padStart(64, '0'), from: side(t.from), to: side(t.to),
  total: { value: '1000000', decimals: '6' }, token: { address_hash: '0x' + '77'.repeat(20), symbol: 'USDC', decimals: '6' },
});

/** A history: a mix of in, out and to itself, several in one block, newest block first. */
function history(n: number): T[] {
  const out: T[] = [];
  for (let i = 0; i < n; i++) {
    const block = 100_000 - Math.floor(i / 3), log = 9 - (i % 3);
    const kind = (i * 7) % 5;
    out.push(kind === 0 ? { block, log, from: ME, to: ME } : kind < 3 ? { block, log, from: A, to: ME } : { block, log, from: ME, to: A });
  }
  return out;
}

interface World {
  rows: T[];
  /** This direction's page fails ('to:2' = the second page of filter=to). */
  fail?: string;
  /** Pages of filter=to take this long, ms. */
  toMs?: number;
}
function world(w: World, log: string[]) {
  return (async (input: string | URL) => {
    const url = new URL(String(input));
    log.push(url.search);
    const dir = url.searchParams.get('filter');
    const page = Number(url.searchParams.get('page_n') ?? 1);
    if (w.fail === `${dir}:${page}`) return new Response(JSON.stringify({ message: 'refused' }), { status: 400, headers: { 'content-type': 'application/json' } });
    if (dir === 'to' && w.toMs) await new Promise((r) => setTimeout(r, w.toMs));
    const mine = w.rows.filter((t) => dir === 'to' ? t.to === ME : dir === 'from' ? t.from === ME : true);
    const items = mine.slice((page - 1) * 50, page * 50).map(item);
    return new Response(JSON.stringify({ items, next_page_params: page * 50 < mine.length ? { block_number: 1, index: 0, page_n: page + 1 } : null }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}
const read = (c: ChainDef, w: World, offset = 250, log: string[] = []) =>
  accountList(createHttp({ fetch: world(w, log), cache: null, retries: 0 }), c, 'tokentx', ME, { offset });
const keys = (rows: any[]) => rows.map((r) => `${r.blockNumber}:${r.logIndex}:${r.from}>${r.to}`);

test('the merge of the two directions is the list of both: same rows, same order, a transfer to itself once', async () => {
  for (const n of [0, 7, 49, 50, 120, 400]) {
    const whole = await read(WHOLE, { rows: history(n) });
    const split = await read(SPLIT, { rows: history(n) });
    assert.deepEqual(keys(split), keys(whole), `${n} transfers`);
    assert.equal(split.cut, undefined, `${n}: nothing cut`);
  }
});

test('it asks each direction with its filter, and a chain without tokenSplit asks the list of both as before', async () => {
  const log: string[] = [], plain: string[] = [];
  await read(SPLIT, { rows: history(10) }, 250, log);
  await read(WHOLE, { rows: history(10) }, 250, plain);
  assert.deepEqual(log.map((s) => new URLSearchParams(s).get('filter')).sort(), ['from', 'to']);
  assert.ok(log.every((s) => new URLSearchParams(s).get('type') === 'ERC-20'));
  assert.deepEqual(plain.map((s) => new URLSearchParams(s).get('filter')), [null]);
});

test('the directions run side by side: a slow one does not wait for the other', async () => {
  const t0 = Date.now();
  await read(SPLIT, { rows: history(30), toMs: 300 });
  assert.ok(Date.now() - t0 < 550, `took ${Date.now() - t0} ms for one slow page of 300 ms`);
});

test('a short read (the card of a service: 50 rows) is the newest 50 of the list of both', async () => {
  const whole = await read(WHOLE, { rows: history(400) }, 50);
  const split = await read(SPLIT, { rows: history(400) }, 50);
  assert.deepEqual(keys(split), keys(whole));
});

test('a direction whose later page fails bounds the list: nothing older than its last row, and the list is cut', async () => {
  const all = await read(WHOLE, { rows: history(400) });
  const split = await read(SPLIT, { rows: history(400), fail: 'to:2' });
  assert.equal(split.cut, true);
  assert.ok(split.length > 0 && split.length < 250, `${split.length} rows`);
  // What was kept is exactly the newest part of the list of both: a prefix, without a hole.
  assert.deepEqual(keys(split), keys(all).slice(0, split.length));
});

/** Mostly transfers in, one out in ten: the direction `from` reaches far further back per page than `to`. */
const lopsided = (n: number): T[] => history(n).map((t, i) => (i % 10 === 0 ? { ...t, from: ME, to: A } : { ...t, from: A, to: ME }));

test('a direction that stops early (the scan learned it is no person) bounds the list too: a prefix, never a hole, and not cut', async () => {
  const all = await read(WHOLE, { rows: lopsided(800) });
  let pages = 0;
  const fetch = world({ rows: lopsided(800) }, []);
  const http = createHttp({ fetch: (async (u: string | URL, i?: RequestInit) => { pages++; return fetch(u, i); }) as typeof globalThis.fetch, cache: null, retries: 0 });
  // Stops a direction before its second page: each direction reads one page of 50.
  const split = await accountList(http, SPLIT, 'tokentx', ME, { offset: 250, stop: () => true });
  assert.equal(pages, 2);
  assert.ok(split.length >= 50 && split.length < 100, `${split.length} rows: the 50 of from reach past the bound`);
  assert.deepEqual(keys(split), keys(all).slice(0, split.length));
  assert.equal(split.cut, undefined, 'a stop is no time limit: the list of both is not cut there either');
});

test('a direction whose first page fails fails the list, as the list of both would', async () => {
  await assert.rejects(read(SPLIT, { rows: history(40), fail: 'from:1' }), (e) => e instanceof HttpError && e.status === 400);
});

test('the register splits the token list on Base and Arbitrum One only', () => {
  assert.deepEqual(CHAINS.filter((c) => c.tokenSplit).map((c) => c.id), [8453, 42161]);
});
