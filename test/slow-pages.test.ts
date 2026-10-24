// Arbitrum One's Blockscout took 9 to 22 s for one page of token transfers (its transactions 1 s).
// Two things went wrong at once: both 15 s tries of a page fell off, and a list whose third page failed threw its
// first two pages away (vitalik.eth: 100 read rows, Arbitrum One read with no tokens at all).
// A: a later page that fails keeps the pages already read; the chain is partial with a gap in the tokens (or the
//    transactions), so the scan still has a score.
// B: a chain whose explorer is slow on that one list waits longer for a page, once (ChainDef.tokenPageMs).
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { scan } from '../src/index.ts';
import { accountList } from '../src/sources/explorer.ts';
import { clearSessionCache, createHttp, HttpError, resetHostState } from '../src/sources/http.ts';
import { CHAINS, CHAIN_BY_ID, type ChainDef } from '../src/chains.ts';

beforeEach(() => { clearSessionCache(); resetHostState(); });

const ME = '0x2222222222222222222222222222222222222222';
const OTHER = '0x3333333333333333333333333333333333333333';
const chainOf = (id: number, host: string, extra: Partial<ChainDef> = {}): ChainDef =>
  ({ id, name: `Test chain ${id}`, native: 'ETH', source: { kind: 'blockscout', api: `https://${host}.test` }, rpc: `https://${host}-rpc.test/`, explorer: `https://${host}.test`, defaultOn: false, ...extra });
/** A chain without a slow list. */
const PLAIN = chainOf(990101, 'plain');
/** A chain whose token pages get 300 ms, once. */
const SLOW = chainOf(990102, 'slowtok', { tokenPageMs: 300 });
/** The same explorer with a wait longer than its page takes. */
const SLOW_OK = chainOf(990103, 'slowtok', { tokenPageMs: 1500 });
for (const c of [PLAIN, SLOW, SLOW_OK]) CHAIN_BY_ID.set(c.id, c);

interface World {
  /** Pages per list of the address itself (50 rows each). */
  pages?: { transactions?: number; 'token-transfers'?: number };
  /** This page of this list answers 400 (a refusal that is not retried). */
  fail?: { list: 'transactions' | 'token-transfers'; page: number };
  /** Every token page takes this long, ms. */
  tokenMs?: number;
}

function world(w: World, log: string[]) {
  return (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    log.push(url);
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      const ours = /(plain|slowtok)-rpc\.test/.test(url);
      return json((Array.isArray(body) ? body : [body]).map((c: any) => ({
        id: c.id, jsonrpc: '2.0',
        result: c.method === 'eth_getCode' ? '0x' : !ours ? '0x0' : c.method === 'eth_getTransactionCount' ? '0x7' : '0xde0b6b3a7640000',
      })));
    }
    if (/\/api\/v2\/addresses\/0x[0-9a-f]{40}$/.test(url)) return json({ is_contract: false, public_tags: [], metadata: null });
    if (url.includes('bens.services.blockscout.com')) return json(url.includes('addresses:lookup') ? { items: [] } : {});
    const m = url.match(/^https:\/\/(plain|slowtok)\.test\/api\/v2\/addresses\/(0x[0-9a-f]{40})\/([a-z-]+)/);
    if (!m) return json({ items: [], next_page_params: null });
    const [, host, who, list] = m;
    if (who !== ME || list === 'internal-transactions') return json({ items: [], next_page_params: null });
    const page = Number(new URL(url).searchParams.get('page_n') ?? 1);
    if (list === 'token-transfers' && w.tokenMs) {
      await new Promise<void>((res, rej) => {
        const t = setTimeout(res, w.tokenMs);
        init?.signal?.addEventListener('abort', () => { clearTimeout(t); rej(new DOMException('The operation timed out.', 'TimeoutError')); }, { once: true });
      });
    }
    if (w.fail && w.fail.list === list && w.fail.page === page) return json({ message: 'refused' }, 400);
    const pages = w.pages?.[list as 'transactions'] ?? 1;
    const chain = host === 'plain' ? PLAIN.id : SLOW.id;
    const items = Array.from({ length: 50 }, (_, i) => {
      const k = (page - 1) * 50 + i, block = 100_000 - k, out = k % 2 === 0;
      const base = { block_number: block, timestamp: new Date((1_750_000_000 - k * 3600) * 1000).toISOString(), from: { hash: out ? ME : OTHER, is_contract: false }, to: { hash: out ? OTHER : ME, is_contract: false } };
      return list === 'transactions'
        ? { ...base, hash: '0x' + (chain * 1000 + k).toString(16).padStart(64, '0'), value: '1000000000000000', status: 'ok', raw_input: '0x' }
        : { ...base, transaction_hash: '0x' + (chain * 2000 + k).toString(16).padStart(64, '0'), total: { value: '1000000', decimals: '6' }, token: { address_hash: '0x' + '77'.repeat(20), symbol: 'USDC', decimals: '6' } };
    });
    return json({ items, next_page_params: page < pages ? { block_number: 100_000 - page * 50, index: 0, page_n: page + 1 } : null });
  }) as typeof fetch;
}

const run = (c: ChainDef, w: World, log: string[] = []) => scan(ME, { chainIds: [c.id], fetch: world(w, log), cache: false });
const tokenAsks = (log: string[]) => log.filter((u) => u.includes('/token-transfers'));

test('A: a list whose third page is refused keeps its first two pages, marked cut', async () => {
  const http = createHttp({ fetch: world({ pages: { 'token-transfers': 5 }, fail: { list: 'token-transfers', page: 3 } }, []), cache: null });
  const rows = await accountList(http, PLAIN, 'tokentx', ME, { offset: 250 });
  assert.equal(rows.length, 100);
  assert.equal(rows.cut, true);
});

test('A: a list whose first page is refused still fails: there is nothing to keep', async () => {
  const http = createHttp({ fetch: world({ pages: { 'token-transfers': 5 }, fail: { list: 'token-transfers', page: 1 } }, []), cache: null });
  await assert.rejects(accountList(http, PLAIN, 'tokentx', ME, { offset: 250 }), (e) => e instanceof HttpError && e.status === 400);
});

test('A: a list that is no longer wanted stops as before: an abort is never kept as a cut list', async () => {
  const stop = new AbortController();
  const fetch = world({ pages: { 'token-transfers': 5 } }, []);
  let n = 0;
  const http = createHttp({ fetch: (async (u: string | URL, init?: RequestInit) => { if (++n === 2) stop.abort(); return fetch(u, init); }) as typeof globalThis.fetch, cache: null });
  await assert.rejects(accountList(http, PLAIN, 'tokentx', ME, { offset: 250, signal: stop.signal }), (e) => e instanceof HttpError && e.kind === 'aborted');
});

test('A: in a scan, a token list cut by a failed page counts its rows, and the chain is partial with a gap in the tokens only', async () => {
  const r = await run(PLAIN, { pages: { 'token-transfers': 5 }, fail: { list: 'token-transfers', page: 3 } });
  const c = r.coverage.find((x) => x.chainId === PLAIN.id)!;
  assert.equal(c.tokenTransferCount, 100);
  assert.equal(c.status, 'partial');
  assert.equal(c.truncated, true);
  assert.deepEqual(c.missing, ['older token transfers (time limit)']);
  assert.ok(c.limitations.includes('Many token transfers on a slow explorer: the newest 100 were read in the time limit.'), JSON.stringify(c.limitations));
  assert.ok(!c.limitations.some((l) => /^Long history/.test(l)), 'a cut token list says nothing about the transactions');
  assert.deepEqual(r.incomplete.map((g) => g.part), ['tokens']);
  assert.notEqual(r.score, null, 'a gap in the tokens gives a partial score');
});

test('A: in a scan, a transaction list cut by a failed page keeps its rows: the chain is partial, not unread, so there is a score', async () => {
  const r = await run(PLAIN, { pages: { transactions: 5 }, fail: { list: 'transactions', page: 4 } });
  const c = r.coverage.find((x) => x.chainId === PLAIN.id)!;
  assert.equal(c.status, 'partial');
  assert.equal(c.txCount, 150);
  assert.ok(c.missing.includes('older transactions (time limit)'), JSON.stringify(c.missing));
  assert.ok(!r.incomplete.some((g) => g.part === 'chain'), JSON.stringify(r.incomplete));
  assert.notEqual(r.score, null);
});

test('A: a list read in full is unchanged: no cut, no gap', async () => {
  const r = await run(PLAIN, { pages: { transactions: 2, 'token-transfers': 2 } });
  const c = r.coverage.find((x) => x.chainId === PLAIN.id)!;
  assert.equal(c.status, 'scanned');
  assert.equal(c.tokenTransferCount, 100);
  assert.deepEqual(c.missing, []);
  assert.deepEqual(r.incomplete, []);
});

test('B: a slow token page within the chain\'s wait is read (one ask)', async () => {
  const log: string[] = [];
  const r = await run(SLOW_OK, { tokenMs: 600 }, log);
  const c = r.coverage.find((x) => x.chainId === SLOW_OK.id)!;
  assert.equal(c.tokenTransferCount, 50);
  assert.deepEqual(c.missing, []);
  assert.equal(tokenAsks(log).length, 1);
});

test('B: a token page slower than the chain\'s wait is asked once, not twice, and then counts as not read', async () => {
  const log: string[] = [];
  const r = await run(SLOW, { tokenMs: 600 }, log);
  const c = r.coverage.find((x) => x.chainId === SLOW.id)!;
  assert.equal(c.tokenTransferCount, 0);
  assert.deepEqual(c.missing, ['token transfers (timed out)']);
  assert.equal(tokenAsks(log).length, 1, 'one try of tokenPageMs, never the usual second try');
});

test('B: the register gives Arbitrum One and Base a longer token page, 30 s: their slowest pages took 22 s (2026-10-23) and 17 s (2026-10-24)', () => {
  const slow = CHAINS.filter((c) => c.tokenPageMs !== undefined).map((c) => [c.id, c.tokenPageMs]);
  assert.deepEqual(slow, [[8453, 30_000], [42161, 30_000]]);
});
