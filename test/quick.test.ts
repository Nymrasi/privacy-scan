// An address that is no person (a contract, a service, a bot) gets a card
// without a score, so it reads only the newest page of each chain (history.ts QUICK_ROWS). Read in full, such
// an address took 20 to 60 s on the 30 known wallets. A person is read in full as before, and the result of
// a no-person scan is the same however early or late the scan learned what it is.
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { scan } from '../src/index.ts';
import { ALT_INTERNAL_AFTER_MS, fetchChain, QUICK_LIMIT, QUICK_ROWS } from '../src/history.ts';
import { clearSessionCache, createHttp, resetHostState } from '../src/sources/http.ts';
import { CHAIN_BY_ID, esFree, type ChainDef } from '../src/chains.ts';
import type { ScanResult } from '../src/types.ts';

beforeEach(() => { clearSessionCache(); resetHostState(); });

const PERSON = '0x2222222222222222222222222222222222222222';
const CONTRACT = '0x4444444444444444444444444444444444444444';
const BOT = '0x5555555555555555555555555555555555555555';
const TAGGED = '0x6666666666666666666666666666666666666666';
/** Binance 14, in the bundled exchange list. */
const BINANCE14 = '0x28c6c06298d514db089934071355e5743bf21d60';
const OTHER = '0x3333333333333333333333333333333333333333';
/** A chain read from Etherscan V2 without a key, one request per 5 s: in this file only, no chain in the register reads it so now. */
const PACED: ChainDef = { id: 990001, name: 'Paced test chain', native: 'ETH', source: esFree(990001), rpc: 'https://paced-rpc.test/', explorer: 'https://paced.test', defaultOn: false };
CHAIN_BY_ID.set(PACED.id, PACED);

interface World {
  me: string;
  /** Chain ids whose quick check shows code. */
  code?: number[];
  /** Nonce on every active chain. */
  nonce?: number;
  /** The rows tag the address itself as an exchange (Blockscout's own slug). */
  ownSlug?: string;
  /** Delay of a chain's quick check, ms by chain id (a late signal). */
  rpcMs?: Record<number, number>;
  /** The internal list never answers (only an abort ends it). */
  hangInternal?: boolean;
}

/** Ethereum and Base on Blockscout, three pages of 50 transactions and two of tokens each, one internal page. */
function world(w: World, log: string[]) {
  return (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    log.push(url);
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      const chain = url.includes('base-rpc') ? 8453 : url.includes('ethereum-rpc') ? 1 : url.includes('paced-rpc') ? PACED.id : 0;
      const active = chain !== 0;
      if (w.rpcMs?.[chain]) await new Promise((r) => setTimeout(r, w.rpcMs![chain]));
      return json(body.map((c: any) => ({
        id: c.id,
        result: c.method === 'eth_getCode' ? ((w.code ?? []).includes(chain) ? '0x6080604052' : '0x')
          : !active ? '0x0' : c.method === 'eth_getTransactionCount' ? '0x' + (w.nonce ?? 7).toString(16) : '0xde0b6b3a7640000',
      })));
    }
    if (/\/api\/v2\/addresses\/0x[0-9a-f]{40}$/.test(url)) return json({ is_contract: false, public_tags: [], metadata: null });
    if (url.includes('bens.services.blockscout.com')) return json(url.includes('addresses:lookup') ? { items: [] } : {});
    if (url.includes('api.routescan.io')) return json({ status: '0', message: 'No transactions found', result: [] });
    // The paced chain: Etherscan V2 without a key, three rows of the address's own.
    if (url.startsWith('https://api.etherscan.io/v2/api?')) {
      return json({ status: '1', message: 'OK', result: [0, 1, 2].map((k) => ({ blockNumber: String(5000 - k), timeStamp: String(1_750_000_000 - k * 3600), hash: '0x' + (990001000 + k).toString(16).padStart(64, '0'), from: w.me, to: OTHER, value: '1000000000000000', gas: '21000', gasPrice: '1000000000', input: '0x', isError: '0', contractAddress: '0x' + '77'.repeat(20), tokenDecimal: '6', tokenSymbol: 'USDC' })) });
    }
    const m = url.match(/^https:\/\/(eth|base)\.blockscout\.com\/api\/v2\/addresses\/0x[0-9a-f]{40}\/([a-z-]+)/);
    if (!m) throw new Error('unexpected url in test: ' + url);
    const chain = m[1] === 'eth' ? 1 : 8453, list = m[2];
    const page = Number(new URL(url).searchParams.get('page_n') ?? 1);
    const me = { hash: w.me, is_contract: (w.code ?? []).includes(chain), ...(w.ownSlug ? { metadata: { tags: [{ slug: w.ownSlug, tagType: 'generic', name: 'Exchange' }] } } : {}) };
    const other = { hash: OTHER, is_contract: false };
    if (list === 'internal-transactions') {
      if (w.hangInternal) return new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }));
      return json({ items: [{ block_number: 900, timestamp: '2026-01-01T00:00:00Z', transaction_hash: '0x' + 'ab'.repeat(32), from: other, to: me, value: '1000', success: true, type: 'call' }], next_page_params: null });
    }
    const pages = list === 'transactions' ? 3 : 2;
    const items = Array.from({ length: 50 }, (_, i) => {
      const k = (page - 1) * 50 + i, block = 100_000 - k, out = k % 2 === 0;
      const base = { block_number: block, timestamp: new Date((1_750_000_000 - k * 3600) * 1000).toISOString(), from: out ? me : other, to: out ? other : me };
      return list === 'transactions'
        ? { ...base, hash: '0x' + (chain * 1000 + k).toString(16).padStart(64, '0'), value: '1000000000000000', gas_limit: '21000', gas_price: '1000000000', raw_input: '0x', status: 'ok' }
        : { ...base, transaction_hash: '0x' + (chain * 2000 + k).toString(16).padStart(64, '0'), total: { value: '1000000', decimals: '6' }, token: { address_hash: '0x' + '77'.repeat(20), symbol: 'USDC', decimals: '6', exchange_rate: '1', holders_count: '1000' } };
    });
    return json({ items, next_page_params: page < pages ? { block_number: 100_000 - page * 50, index: 0, page_n: page + 1 } : null });
  }) as typeof fetch;
}

const opts = (w: World, log: string[], extra = {}) => ({ chainIds: [1, 8453], fetch: world(w, log), cache: false as const, ...extra });
const asked = (log: string[], host: string, list: string) => log.filter((u) => u.startsWith(`https://${host}.blockscout.com/`) && u.includes(`/${list}`));
/** What a result says, without the clock. */
const shape = (r: ScanResult) => ({
  type: r.addressType, service: r.identity.service ?? null, score: r.score, status: r.status,
  findings: r.findings.map((f) => f.key).sort(),
  coverage: r.coverage.map(({ durationMs, ...c }) => c),
});

test('a contract reads the newest page of each chain only: no second page, no internal transfers waited for, the quick line in its coverage', { timeout: 15_000 }, async () => {
  const log: string[] = [];
  const t0 = Date.now();
  const r = await scan(CONTRACT, opts({ me: CONTRACT, code: [8453], hangInternal: true }, log));
  assert.ok(Date.now() - t0 < 5000, `done in ${Date.now() - t0} ms, without waiting for a hanging internal list`);
  assert.equal(r.addressType, 'contract');
  assert.equal(asked(log, 'base', 'transactions').length, 1, 'Base: the newest page of transactions only');
  assert.equal(asked(log, 'base', 'internal-transactions').length, 0, 'Base knew before its lists began: no internal list');
  for (const c of r.coverage.filter((x) => x.status !== 'no_activity')) {
    assert.equal(c.txCount, QUICK_ROWS, `${c.name}: ${QUICK_ROWS} transactions`);
    assert.equal(c.tokenTransferCount, 0, `${c.name}: no token list where there are transactions`);
    assert.equal(c.internalTransfers, 'not_fetched');
    assert.ok(c.limitations.includes(QUICK_LIMIT), `${c.name}: ${JSON.stringify(c.limitations)}`);
    assert.deepEqual(c.missing, []);
    assert.equal(c.status, 'scanned');
    assert.equal(c.firstSeen, undefined, 'no first date from the newest page alone');
  }
  assert.equal(r.status, 'complete');
});

test('a person is read in full, as before: every page, the internal list and the oldest page', { timeout: 15_000 }, async () => {
  const log: string[] = [];
  const r = await scan(PERSON, opts({ me: PERSON }, log));
  assert.equal(r.addressType, 'eoa');
  assert.equal(asked(log, 'eth', 'transactions').length, 3);
  assert.equal(asked(log, 'base', 'token-transfers').length, 2);
  assert.equal(asked(log, 'base', 'internal-transactions').length, 1);
  for (const c of r.coverage.filter((x) => x.status !== 'no_activity')) {
    assert.equal(c.txCount, 150);
    assert.equal(c.tokenTransferCount, 100);
    assert.ok(!c.limitations.includes(QUICK_LIMIT));
  }
});

test('the same contract gives the same result when the scan learns late that it is one', { timeout: 15_000 }, async () => {
  const early = await scan(CONTRACT, opts({ me: CONTRACT, code: [1] }, []));
  // Ethereum's quick check (it holds the code) answers only after Base has read all of its pages, while Base's
  // internal list hangs and Base has no second source for it: once the scan knows, that list is not waited for.
  const lateLog: string[] = [];
  const t0 = Date.now();
  const late = await scan(CONTRACT, opts({ me: CONTRACT, code: [1], rpcMs: { 1: 400 }, hangInternal: true }, lateLog));
  assert.ok(Date.now() - t0 < 5000, `done in ${Date.now() - t0} ms, not after the hanging list`);
  assert.equal(asked(lateLog, 'base', 'transactions').length, 3, 'Base read in full before the scan knew');
  assert.equal(asked(lateLog, 'base', 'internal-transactions').length, 1, 'its internal list was on its way');
  assert.deepEqual(shape(late), shape(early));
});

test('a bot by its count of transactions, a service by the explorer\'s own tag, an exchange from the bundled list: all read quick', { timeout: 15_000 }, async () => {
  const botLog: string[] = [];
  const bot = await scan(BOT, opts({ me: BOT, nonce: 60_000 }, botLog));
  assert.equal(bot.identity.service?.kind, 'bot');
  assert.equal(asked(botLog, 'eth', 'transactions').length, 1);
  assert.ok(bot.coverage.every((c) => c.status === 'no_activity' || c.limitations.includes(QUICK_LIMIT)));

  const tagLog: string[] = [];
  const tagged = await scan(TAGGED, opts({ me: TAGGED, ownSlug: 'exchange' }, tagLog));
  assert.equal(tagged.identity.service?.kind, 'exchange');
  // The first page shows the tag; a page already on its way may still come, never the whole list.
  assert.ok(asked(tagLog, 'eth', 'transactions').length < 3, `${asked(tagLog, 'eth', 'transactions').length} pages`);
  assert.ok(tagged.coverage.every((c) => c.status === 'no_activity' || c.txCount === QUICK_ROWS));

  const cexLog: string[] = [];
  const cex = await scan(BINANCE14, opts({ me: BINANCE14 }, cexLog));
  assert.equal(cex.identity.service?.kind, 'exchange');
  assert.equal(asked(cexLog, 'eth', 'internal-transactions').length, 0, 'known from the start: no internal list at all');
  assert.equal(asked(cexLog, 'eth', 'transactions').length, 1);
  assert.equal(asked(cexLog, 'eth', 'token-transfers').length, 1);
});

test('readAll reads a contract in full', { timeout: 15_000 }, async () => {
  const log: string[] = [];
  const r = await scan(CONTRACT, opts({ me: CONTRACT, code: [8453] }, log, { readAll: true }));
  assert.equal(r.addressType, 'contract');
  assert.equal(asked(log, 'base', 'transactions').length, 3);
  assert.ok(r.coverage.every((c) => !c.limitations.includes(QUICK_LIMIT)));
});

test('a stalled internal list on Ethereum asks its second source after 3 s, not 12', { timeout: 15_000 }, async () => {
  assert.equal(ALT_INTERNAL_AFTER_MS, 3000);
  const log: string[] = [];
  const t0 = Date.now();
  const h = await fetchChain(createHttp({ fetch: world({ me: PERSON, hangInternal: true }, log), cache: null }), CHAIN_BY_ID.get(1)!, PERSON, { maxTx: 500, maxToken: 250, maxInternal: 50, noPrecheck: true, sideBy: Date.now() + 60_000 });
  const ms = Date.now() - t0;
  assert.ok(ms >= ALT_INTERNAL_AFTER_MS - 100 && ms < 5000, `read in ${ms} ms`);
  assert.ok(log.some((u) => u.includes('api.routescan.io') && u.includes('txlistinternal')), 'Routescan was asked');
  assert.equal(h.coverage.internalTransfers, 'full');
});

test('an exchange active on a paced keyless chain reads its newest transactions there in one turn, and no token list takes a turn from them', { timeout: 30_000 }, async () => {
  const log: string[] = [];
  const r = await scan(BINANCE14, { chainIds: [PACED.id], fetch: world({ me: BINANCE14 }, log), cache: false });
  assert.equal(r.identity.service?.kind, 'exchange');
  const calls = log.filter((u) => u.startsWith('https://api.etherscan.io/'));
  assert.equal(calls.length, 1, calls.join('\n'));
  assert.match(calls[0], /action=txlist/);
  assert.equal(r.coverage[0].txCount, 3);
});
