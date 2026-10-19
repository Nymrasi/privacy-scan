// End to end through scan() with a fake fetch: no network.
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { scan, isAddress } from '../src/index.ts';
import { clearSessionCache, resetHostState } from '../src/sources/http.ts';
import { decodeString, encodeText } from '../src/sources/identity.ts';
import type { ScanProgress, ScanResult } from '../src/types.ts';

const ME = '0x2222222222222222222222222222222222222222';
const FRIEND = '0x3333333333333333333333333333333333333333';
const BINANCE = '0x28c6c06298d514db089934071355e5743bf21d60';
const A9 = '0x9999999999999999999999999999999999999999';

function encString(s: string) {
  const hex = Buffer.from(s).toString('hex');
  return '0x' + (32).toString(16).padStart(64, '0') + s.length.toString(16).padStart(64, '0') + hex.padEnd(64, '0');
}

// Every test starts with an empty session cache and no remembered rate-limit windows.
beforeEach(() => { clearSessionCache(); resetHostState(); });

let n = 0;
const raw = (from: string, to: string, eth: number, ts: number, input = '0x') => ({
  blockNumber: String(1000 + ++n), timeStamp: String(ts), hash: '0x' + n.toString(16).padStart(64, '0'), from, to,
  value: BigInt(Math.round(eth * 1e18)).toString(), gas: '21000', gasPrice: '1000000000', input, isError: '0', txreceipt_status: '1', methodId: input.slice(0, 10),
});

// Blockscout v2 item for a transaction.
const v2 = (from: string, to: string, eth: number, ts: number, extra: Record<string, unknown> = {}) => ({
  block_number: 1000 + ++n, timestamp: new Date(ts * 1000).toISOString(), hash: '0x' + n.toString(16).padStart(64, '0'),
  from: { hash: from, is_contract: false }, to: { hash: to, is_contract: false }, value: BigInt(Math.round(eth * 1e18)).toString(),
  gas_limit: '21000', gas_price: '1000000000', raw_input: '0x', status: 'ok', ...extra,
});

function fakeFetch(log: string[]) {
  return (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    log.push(url);
    const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      if (url.includes('ethereum-rpc') && body[0]?.method === 'eth_call') {
        return json(body.map((c: any, i: number) => ({ id: c.id, result: i === 0 ? encString('someone_x') : '0x' })));
      }
      const active = url.includes('ethereum-rpc') || url.includes('base-rpc');
      // A wallet (no code) that sent 2 transactions and holds some ETH on Ethereum and Base.
      return json(body.map((c: any) => ({ id: c.id, result: c.method === 'eth_getCode' ? '0x' : !active ? '0x0' : c.method === 'eth_getTransactionCount' ? '0x2' : '0x5' })));
    }
    if (/\/api\/v2\/addresses\/0x[0-9a-f]{40}$/.test(url)) return json({ is_contract: false, ens_domain_name: 'someone.eth', public_tags: [], metadata: null });
    if (url.includes('addresses:lookup')) return json({ items: [] });
    if (/bens\.services\.blockscout\.com\/api\/v1\/1\/addresses\/0x[0-9a-f]{40}$/.test(url)) return json({ domain: { name: 'someone.eth', resolved_address: { hash: url.slice(-42) } }, resolved_domains_count: 1 });
    if (url.includes('/domains/')) return json({ id: '0x' + 'ab'.repeat(32), resolver_address: { hash: '0x' + 'cd'.repeat(20) } });
    if (url.startsWith('https://base.blockscout.com')) return json({ message: 'Too many requests' }, 429, { 'x-ratelimit-reset': '3000000' });
    if (url.startsWith('https://proxy.test/')) {
      const inner = new URL(decodeURIComponent(url.split('?u=')[1]));
      if (inner.pathname.endsWith('/transactions')) return json({ items: [v2(ME, FRIEND, 0.3, 1_750_000_500)], next_page_params: null });
      return json({ items: [], next_page_params: null });
    }
    if (url.startsWith('https://eth.blockscout.com/api/v2/addresses/')) {
      const path = new URL(url).pathname;
      if (path.endsWith('/transactions')) return json({ items: [
        v2(BINANCE, ME, 1, 1_750_000_000, { from: { hash: BINANCE, is_contract: false, metadata: { tags: [{ slug: 'exchange', tagType: 'generic', name: 'Exchange' }] } } }),
        v2(ME, FRIEND, 0.5, 1_750_000_100), v2(FRIEND, ME, 0.2, 1_750_000_200), v2(ME, FRIEND, 0.1, 1_750_000_300),
      ].reverse(), next_page_params: null });
      return json({ items: [], next_page_params: null });
    }
    throw new Error('unexpected url in test: ' + url);
  }) as typeof fetch;
}

test('scan(): streams, prechecks, falls back to the proxy on a long 429, and keeps the invariant', async () => {
  const log: string[] = [];
  const events: ScanProgress[] = [];
  const r = await scan(ME, { chainIds: [1, 8453, 10, 56], fetch: fakeFetch(log), fallbackProxy: 'https://proxy.test/p', onProgress: (e) => events.push(e) });

  assert.equal(events[0].type, 'start');
  assert.equal(events.at(-1)!.type, 'done');
  assert.ok(events.some((e) => e.type === 'partial'), 'partial results streamed');
  const firstPartial = events.findIndex((e) => e.type === 'partial');
  assert.ok(firstPartial < events.findIndex((e) => e.type === 'done'));

  const cov = Object.fromEntries(r.coverage.map((c) => [c.chainId, c]));
  assert.equal(cov[1].status, 'scanned');
  assert.equal(cov[8453].status, 'scanned', 'Base read through the fallback proxy');
  assert.equal(cov[10].status, 'no_activity', 'OP skipped by the nonce + balance check');
  assert.equal(cov[56].status, 'no_activity', 'BNB: the public RPC check finds it empty, no relay needed');
  assert.ok(!log.some((u) => u.startsWith('https://explorer.optimism.io')), 'no explorer call for an empty chain');
  assert.equal(log.filter((u) => u.startsWith('https://base.blockscout.com')).length, 3, 'a long 429 is not retried');

  assert.equal(r.identity.ens, 'someone.eth');
  const ids = r.findings.map((f) => f.id);
  for (const id of ['public_identity.ens_reverse', 'public_identity.ens_records', 'cex_exposure.funded_by_cex', 'linked_wallets.back_and_forth', 'cross_chain.multichain_presence']) {
    assert.ok(ids.includes(id), `has ${id}`);
  }
  assert.equal(100 + r.findings.reduce((a, f) => a + f.scoreImpact, 0), r.score);
  assert.equal(r.linkedWallets[0].address, FRIEND);
  assert.equal(r.status, 'complete');
});

test('scan(): rejects a non-address', async () => {
  await assert.rejects(scan('vitalik.eth'), /Not an EVM address/);
  assert.ok(isAddress('0x' + 'a'.repeat(40)) && !isAddress('0x' + 'a'.repeat(39)));
});

test('scan(): the holder gate locks deep findings but keeps the score', async () => {
  const open = await scan(ME, { chainIds: [1], fetch: fakeFetch([]) });
  const gated = await scan(ME, { chainIds: [1], fetch: fakeFetch([]), gate: { threshold: 1000, holderBalance: 10 } });
  assert.equal(open.score, gated.score);
  const deep = gated.findings.filter((f) => f.title === 'Deep finding');
  assert.ok(deep.length > 0);
  assert.ok(deep.every((f) => f.evidence.length === 0 && !f.related));
  assert.equal(gated.linkedWallets.length, 0);
});

test('ENS text() calldata and string decoding', () => {
  const data = encodeText('0x' + '11'.repeat(32), 'com.twitter');
  assert.equal(data.slice(0, 10), '0x59d1d43c');
  assert.equal((data.length - 2) / 2, 4 + 32 * 4);
  assert.equal(decodeString(encString('hello')), 'hello');
  assert.equal(decodeString('0x'), '');
});

test('scan(): Ethereum switches to Routescan when Blockscout refuses', async () => {
  const log: string[] = [];
  const base = fakeFetch(log);
  const f = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('https://eth.blockscout.com/api/v2/addresses/') && !/0x[0-9a-f]{40}$/.test(url)) { log.push(url); return new Response('{"message":"Too many requests"}', { status: 429, headers: { 'x-ratelimit-reset': '3000000' } }); }
    if (url.startsWith('https://api.routescan.io/v2/network/mainnet/evm/1/')) {
      log.push(url);
      const a = new URL(url).searchParams.get('action');
      return new Response(JSON.stringify(a === 'txlist' ? { status: '1', message: 'OK', result: [raw(BINANCE, ME, 1, 1_750_000_000), raw(ME, FRIEND, 0.5, 1_750_000_900)].reverse() } : { status: '0', message: 'No transactions found', result: [] }), { status: 200 });
    }
    return base(input, init);
  }) as typeof fetch;
  const r = await scan(ME, { chainIds: [1], fetch: f });
  const eth = r.coverage.find((c) => c.chainId === 1)!;
  assert.equal(eth.status, 'scanned');
  assert.equal(eth.source, 'routescan');
  assert.equal(log.filter((u) => /eth\.blockscout\.com\/api\/v2\/addresses\/0x[0-9a-f]{40}\//.test(u)).length, 3, 'the three lists start together, each refused once, then the switch');
  assert.ok(r.findings.some((x) => x.id === 'cex_exposure.funded_by_cex'));
});

test('Blockscout v2 paging: follows next_page_params, honours the block window and the row cap', async () => {
  const { accountList } = await import('../src/sources/explorer.ts');
  const { createHttp } = await import('../src/sources/http.ts');
  const { CHAIN_BY_ID } = await import('../src/chains.ts');
  const urls: string[] = [];
  const page = (start: number) => ({ items: Array.from({ length: 50 }, (_, i) => ({ block_number: start - i, timestamp: '2026-01-01T00:00:00Z', hash: '0x' + (start - i).toString(16), from: { hash: ME }, to: { hash: FRIEND }, value: '1', raw_input: '0x', status: 'ok' })), next_page_params: { block_number: start - 49, index: 0 } });
  const http = createHttp({ fetch: (async (u: string) => { urls.push(u); const b = Number(new URL(u).searchParams.get('block_number') ?? 1001) - 1; return new Response(JSON.stringify(page(b))); }) as any });
  const rows = await accountList(http, CHAIN_BY_ID.get(1)!, 'txlist', ME, { offset: 120 });
  assert.equal(rows.length, 120);
  assert.equal(urls.length, 3);
  const win = await accountList(http, CHAIN_BY_ID.get(1)!, 'txlist', ME, { offset: 500, endblock: 899, startblock: 830, filter: 'from' });
  assert.equal(win[0].blockNumber, '899');
  assert.ok(win.every((r) => Number(r.blockNumber) >= 830 && Number(r.blockNumber) <= 899));
  assert.equal(win.length, 70);
  assert.match(urls.at(-1)!, /filter=from/);
});

// ---------- reliability: repeated scans from one IP ----------

/** Wraps the fake explorer: `hook` may answer a URL itself (return a Response) or pass (return undefined). */
function hooked(hook: (url: string, nth: number) => Response | undefined, log: string[] = []) {
  const base = fakeFetch(log);
  const seen = new Map<string, number>();
  return (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const k = url.replace(/\?.*$/, '');
    const nth = (seen.get(k) ?? 0) + 1;
    seen.set(k, nth);
    return hook(url, nth) ?? base(input, init);
  }) as typeof fetch;
}
const limited = (resetMs: number) => new Response('{"message":"Too many requests"}', { status: 429, headers: { 'x-ratelimit-reset': String(resetMs), 'x-ratelimit-remaining': '0' } });
const PROFILE = /eth\.blockscout\.com\/api\/v2\/addresses\/0x[0-9a-f]{40}$/;

test('scan(): a 429 on the profile call is waited out, so the ENS name and its points stay', async () => {
  const f = hooked((url, nth) => (PROFILE.test(url) && nth === 1 ? limited(800) : undefined));
  const r = await scan(ME, { chainIds: [1], fetch: f });
  assert.equal(r.identity.ens, 'someone.eth');
  assert.ok(r.findings.some((x) => x.id === 'public_identity.ens_reverse'));
  assert.equal(r.status, 'complete');
  assert.deepEqual(r.incomplete, []);
  assert.ok(r.stats!.waitedMs >= 800, 'it waited for the window');
});

test('scan(): when the explorer keeps refusing the profile, BENS still gives the name, and the result says what is missing', async () => {
  // A bot check on the profile URL only (a 429 would close the whole host, lists included).
  const wall = () => new Response('<html><title>Just a moment...</title></html>', { status: 403, headers: { 'content-type': 'text/html' } });
  const f = hooked((url) => (PROFILE.test(url) ? wall() : undefined));
  const r = await scan(ME, { chainIds: [1], fetch: f });
  assert.equal(r.identity.ens, 'someone.eth', 'primary name from BENS');
  assert.ok(r.findings.some((x) => x.id === 'public_identity.ens_reverse'), 'the name and its points still apply');
  assert.equal(r.status, 'partial');
  assert.deepEqual(r.incomplete.map((g) => g.part), ['identity']);
  assert.match(r.incomplete[0].reason, /bot check/);
  assert.ok(!r.incomplete[0].reason.includes(ME), 'never the address');
});

test('scan(): a chain that keeps refusing is listed as missing, never scored as if complete', async () => {
  const f = hooked((url) => (url.startsWith('https://base.blockscout.com') ? limited(3_000_000) : undefined));
  const r = await scan(ME, { chainIds: [1, 8453], fetch: f });
  assert.equal(r.status, 'partial');
  const base = r.incomplete.find((g) => g.chainId === 8453)!;
  assert.equal(base.part, 'chain');
  assert.equal(base.reason, 'Base: rate limit reached');
  assert.equal(r.coverage.find((c) => c.chainId === 8453)!.status, 'error');
});

test('scan(): the same data gives the same result, whatever order the chains answer in', async () => {
  const runs: string[] = [];
  for (let i = 0; i < 4; i++) {
    clearSessionCache(); resetHostState();
    const base = fakeFetch([]);
    // Each run answers the chains in a different order.
    const f = (async (input: string | URL, init?: RequestInit) => {
      await new Promise((r) => setTimeout(r, ((String(input).length * (i + 3)) % 7) * 3));
      return base(input, init);
    }) as typeof fetch;
    const r = await scan(ME, { chainIds: [1, 8453, 10], fetch: f, fallbackProxy: 'https://proxy.test/p' });
    runs.push(JSON.stringify({ score: r.score, keys: r.findings.map((x) => `${x.key}:${x.scoreImpact}`), linked: r.linkedWallets, status: r.status }));
  }
  assert.equal(new Set(runs).size, 1, runs.join('\n'));
});

test('scan(): a second scan of the same wallet in the same page reads the cache: same result, no requests', async () => {
  const log: string[] = [];
  const a = await scan(ME, { chainIds: [1], fetch: fakeFetch(log) });
  const n = log.length;
  const b = await scan(ME, { chainIds: [1], fetch: fakeFetch(log) });
  assert.equal(log.length, n, 'no new requests');
  assert.equal(b.stats!.requests, 0);
  assert.ok(b.stats!.cached > 0);
  assert.equal(b.score, a.score);
  assert.deepEqual(b.findings.map((x) => x.key), a.findings.map((x) => x.key));
  const c = await scan(ME, { chainIds: [1], fetch: fakeFetch(log), cache: false });
  assert.ok(log.length > n, 'cache: false reads again');
  assert.equal(c.score, a.score);
});

test('funding in a long history: unknown when the first own transaction is older than what was read, or the oldest page fails', async () => {
  const { fetchChain } = await import('../src/history.ts');
  const { createHttp } = await import('../src/sources/http.ts');
  const { CHAIN_BY_ID } = await import('../src/chains.ts');
  const lim = { maxTx: 3, maxToken: 3, maxInternal: 3, noPrecheck: true };
  const run = (oldest: () => Response) => fetchChain(createHttp({ fetch: (async (u: string) => {
    if (u.includes('/transactions') && u.includes('order=asc')) return oldest();
    if (u.includes('/transactions')) return new Response(JSON.stringify({ items: [v2(ME, FRIEND, 0.1, 1_750_000_900, { block_number: 900 }), v2(ME, FRIEND, 0.1, 1_750_000_800, { block_number: 800 }), v2(FRIEND, ME, 2, 1_750_000_700, { block_number: 700 })], next_page_params: null }));
    return new Response(JSON.stringify({ items: [], next_page_params: null }));
  }) as any, cache: null }), CHAIN_BY_ID.get(1)!, ME, lim);
  // The oldest page holds only what others sent: the first transaction this wallet signed lies in between.
  const between = await run(() => new Response(JSON.stringify({ items: [v2(FRIEND, ME, 5, 1_740_000_000, { block_number: 10 }), v2(A9, ME, 1, 1_740_000_100, { block_number: 11 })], next_page_params: null })));
  assert.equal(between.firstFunding, undefined);
  assert.ok(between.coverage.limitations.some((l) => /older than what was read/.test(l)));
  // The oldest page fails: the first funding is unknown, and the result says so.
  const failed = await run(() => new Response('{"message":"bad request"}', { status: 400 }));
  assert.equal(failed.firstFunding, undefined, 'the 2 ETH before the oldest own transaction read is no known funder');
  assert.ok(failed.coverage.missing.some((m) => /^oldest transactions/.test(m)));
});

test('funding: unknown when the oldest internal page of a long history fails (an older contract payout may have paid)', async () => {
  const { fetchChain } = await import('../src/history.ts');
  const { createHttp } = await import('../src/sources/http.ts');
  const { CHAIN_BY_ID } = await import('../src/chains.ts');
  const ok = (result: unknown[]) => new Response(JSON.stringify({ status: '1', message: 'OK', result }));
  const internal = (i: number) => ({ blockNumber: String(5000 + i), timeStamp: String(1_750_100_000 + i), hash: '0x' + (7000 + i).toString(16).padStart(64, '0'), from: '0x' + '77'.repeat(20), to: ME, value: '1000', isError: '0', type: 'call' });
  const f = (async (u: string) => {
    const q = new URL(u).searchParams;
    if (q.get('action') === 'txlistinternal' && q.get('sort') === 'asc') return new Response('{"status":"0","message":"NOTOK","result":"rate limit"}', { status: 400 });
    if (q.get('action') === 'txlistinternal') return ok([0, 1, 2].map(internal));
    // raw() numbers blocks in the order rows are made: the incoming one first, so it lies before the first own transaction.
    if (q.get('action') === 'txlist') return ok([raw(FRIEND, ME, 1, 1_750_000_100), raw(ME, FRIEND, 0.1, 1_750_000_900)].reverse());
    return new Response(JSON.stringify({ status: '0', message: 'No transactions found', result: [] }));
  }) as any;
  // Avalanche reads through Routescan, which can list internal transfers oldest first.
  const h = await fetchChain(createHttp({ fetch: f, cache: null }), CHAIN_BY_ID.get(43114)!, ME, { maxTx: 10, maxToken: 10, maxInternal: 3, noPrecheck: true });
  assert.ok(h.coverage.missing.some((m) => /^oldest transactions/.test(m)), h.coverage.missing.join('; '));
  assert.equal(h.firstFunding, undefined, 'the 1 AVAX before it is no known funder: an older payout may have paid');
});

test('the internal transfers get more time than Base needs for a long history (59 s measured in a full scan)', async () => {
  const { INTERNAL_TIMEOUT_MS } = await import('../src/history.ts');
  assert.ok(INTERNAL_TIMEOUT_MS >= 59_263 * 1.5, `${INTERNAL_TIMEOUT_MS} ms`);
});

test('on a tight time limit (the bot and the ASI agent: 65 s inside a 75 s hard stop) a slow internal list gives up in time: a partial result, never a scan stopped from outside with its funder checks lost', async () => {
  const base = fakeFetch([]);
  // Ethereum's internal list of this wallet never answers (vitalik.eth and orbiter1 in the bot: over 75 s).
  const f = (async (input: string | URL, init?: RequestInit) => {
    if (String(input).includes(`/addresses/${ME}/internal-transactions`)) {
      return new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'TimeoutError')), { once: true }));
    }
    return base(input, init);
  }) as typeof fetch;
  const t0 = Date.now();
  const r = await scan(ME, { chainIds: [1], fetch: f, cache: false, timeLimitMs: 4000, signal: AbortSignal.timeout(5500) });
  assert.ok(Date.now() - t0 < 5500, `done in ${Date.now() - t0} ms, before the hard stop`);
  assert.ok(!r.incomplete.some((g) => g.part === 'aborted' || g.part === 'lookups'), JSON.stringify(r.incomplete.map((g) => g.part)));
  assert.ok(r.coverage[0].missing.some((m) => /^internal transfers \(timed out\)/.test(m)), JSON.stringify(r.coverage[0].missing));
  assert.equal(r.status, 'partial');
});

test('a slow internal list on Ethereum is asked from its second keyless source (Routescan) too, and the first answer counts; a fast one never is', async () => {
  const { fetchChain } = await import('../src/history.ts');
  const { createHttp } = await import('../src/sources/http.ts');
  const { CHAIN_BY_ID } = await import('../src/chains.ts');
  const rsInternal = { status: '1', message: 'OK', result: [
    { blockNumber: '2001', timeStamp: '1750000400', hash: '0x' + 'a1'.repeat(32), from: FRIEND, to: ME, value: '20000000000000000', isError: '0', type: 'call' },
    { blockNumber: '2000', timeStamp: '1750000300', hash: '0x' + 'a2'.repeat(32), from: FRIEND, to: ME, value: '10000000000000000', isError: '0', type: 'call' },
  ] };
  const world = (slow: boolean | 'fails', log: string[]) => (async (u: string, init?: RequestInit) => {
    log.push(u);
    if (u.startsWith('https://eth.blockscout.com') && u.includes('/internal-transactions')) {
      if (slow === 'fails') return new Response('{"message":"bad request"}', { status: 400, headers: { 'content-type': 'application/json' } });
      // Blockscout on a heavy wallet: over 90 s for page 1 (orbiter1, nick.eth, measured 2026-10-17). Fast here when not slow.
      if (!slow) return new Promise<Response>((r) => setTimeout(() => r(new Response(JSON.stringify({ items: [], next_page_params: null }))), 50));
      return new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'TimeoutError')), { once: true }));
    }
    if (u.startsWith('https://api.routescan.io/') && u.includes('action=txlistinternal')) return new Response(JSON.stringify(rsInternal));
    return new Response(JSON.stringify({ items: [], next_page_params: null }));
  }) as any;
  const lim = (extra = {}) => ({ maxTx: 500, maxToken: 250, maxInternal: 50, noPrecheck: true, sideBy: Date.now() + 3000, altInternalAfterMs: 100, ...extra });
  const slowLog: string[] = [];
  const t0 = Date.now();
  const h = await fetchChain(createHttp({ fetch: world(true, slowLog), cache: null }), CHAIN_BY_ID.get(1)!, ME, lim());
  assert.ok(Date.now() - t0 < 2500, `read in ${Date.now() - t0} ms, not after the slow list gave up`);
  assert.equal(h.internal.length, 2, 'the internal transfers come from the second source');
  assert.equal(h.coverage.internalTransfers, 'full');
  assert.deepEqual(h.coverage.missing, []);
  const fastLog: string[] = [];
  const g = await fetchChain(createHttp({ fetch: world(false, fastLog), cache: null }), CHAIN_BY_ID.get(1)!, ME, lim({ altInternalAfterMs: 1000 }));
  assert.equal(g.coverage.internalTransfers, 'full');
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(!fastLog.some((u) => u.startsWith('https://api.routescan.io/')), 'a fast Blockscout answer never asks the second source');
  // A first list that fails asks the second at once, without waiting for the delay.
  const t1 = Date.now();
  const k = await fetchChain(createHttp({ fetch: world('fails', []), cache: null }), CHAIN_BY_ID.get(1)!, ME, lim({ altInternalAfterMs: 5000 }));
  assert.equal(k.internal.length, 2);
  assert.ok(Date.now() - t1 < 2000, `read in ${Date.now() - t1} ms after a failed first list`);
});

test('history: Blockscout cannot sort internal transfers oldest first, so a full internal page is a stated limit, not a failure', async () => {
  const { fetchChain } = await import('../src/history.ts');
  const { createHttp } = await import('../src/sources/http.ts');
  const { CHAIN_BY_ID } = await import('../src/chains.ts');
  const urls: string[] = [];
  const item = (i: number) => ({ block_number: 2000 - i, timestamp: '2026-01-01T00:00:00Z', transaction_hash: '0x' + i.toString(16).padStart(64, '0'), from: { hash: FRIEND, is_contract: true }, to: { hash: ME }, value: '1000', success: true, type: 'call' });
  const f = (async (u: string) => {
    urls.push(u);
    if (u.includes('/internal-transactions')) {
      if (u.includes('order=asc')) return new Response('{"errors":[{"detail":"Unexpected field: order"}]}', { status: 422 });
      return new Response(JSON.stringify({ items: Array.from({ length: 50 }, (_, i) => item(i)), next_page_params: { block_number: 1950, index: 0 } }));
    }
    return new Response(JSON.stringify({ items: [], next_page_params: null }));
  }) as any;
  const h = await fetchChain(createHttp({ fetch: f, cache: null }), CHAIN_BY_ID.get(1)!, ME, { maxTx: 500, maxToken: 250, maxInternal: 50, noPrecheck: true });
  assert.ok(!urls.some((u) => u.includes('internal-transactions') && u.includes('order=asc')), 'the unsupported query is not sent');
  assert.equal(h.coverage.status, 'scanned');
  assert.deepEqual(h.coverage.missing, []);
  assert.ok(h.coverage.limitations.some((l) => /newest internal transfers/.test(l)));
});

// ---------- BNB Smart Chain through the relay (a keyed source), Linea keyless ----------

/** When each keyless Etherscan V2 request went out (ms since epoch). */
const etherscanAt: number[] = [];
/** Etherscan V2 rows for Linea: a friend sent 0.2 ETH, the wallet sent 0.1 back. */
function lineaAnswer(url: string): Response {
  const q = new URL(url).searchParams;
  assert.equal(q.get('chainid'), '59144');
  assert.equal(q.get('apikey'), null, 'the scan never sends a key');
  if (q.get('action') === 'txlist') return new Response(JSON.stringify({ status: '1', message: 'OK-Missing/Invalid API Key, rate limit of 1/5sec applied', result: [raw(FRIEND, ME, 0.2, 1_750_000_000), raw(ME, FRIEND, 0.1, 1_750_000_300)].reverse() }));
  return new Response(JSON.stringify({ status: '0', message: 'No transactions found', result: [] }));
}

/** `pre`: the quick check's [nonce, balance] per chain; default a wallet that sent 1 transaction and holds nothing. */
function keyedFetch(log: string[], o: { relayKeys: boolean; quota?: boolean; pre?: { bsc?: [string, string]; linea?: [string, string] } }) {
  const base = fakeFetch(log);
  return (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === 'POST' && (url.includes('bsc-rpc') || url.includes('linea-rpc'))) {
      log.push(url);
      const [nonce, balance] = (url.includes('bsc-rpc') ? o.pre?.bsc : o.pre?.linea) ?? ['0x1', '0x0'];
      const body = JSON.parse(String(init.body));
      return new Response(JSON.stringify(body.map((c: any) => ({ id: c.id, result: c.method === 'eth_getTransactionCount' ? nonce : c.method === 'eth_getCode' ? '0x' : balance }))));
    }
    if (url.startsWith('https://api.etherscan.io/v2/api?')) {
      log.push(url);
      etherscanAt.push(Date.now());
      return lineaAnswer(url);
    }
    if (url.startsWith('https://site.test/p?u=')) {
      log.push(url);
      return new Response('{"error":"the relay answers on nymra.si only"}', { status: 403, headers: { 'content-type': 'application/json' } });
    }
    if (url.startsWith('https://relay.test/p?u=')) {
      log.push(url);
      const inner = decodeURIComponent(url.split('?u=')[1]);
      if (o.quota) return new Response('{"error":"quota","message":"The relay has spent its daily quota. It resets at 00:00 UTC."}', { status: 503, headers: { 'content-type': 'application/json', 'x-nymra-relay': 'quota' } });
      if (!o.relayKeys) return new Response('{"error":"not configured"}', { status: 503, headers: { 'content-type': 'application/json', 'x-nymra-relay': 'nokey' } });
      if (inner.startsWith('https://bsc-mainnet.nodereal.io/')) {
        const p = JSON.parse(String(init!.body)).params[0];
        const transfers = p.category[0] === 'external'
          ? [{ category: 'external', blockNum: '0x2a', from: FRIEND, to: ME, value: '0x16345785d8a0000', asset: 'BNB', hash: '0x' + 'b1'.repeat(32), blockTimeStamp: 1750000000, gasPrice: '0x3b9aca00', receiptsStatus: 1 },
             { category: 'external', blockNum: '0x2b', from: ME, to: FRIEND, value: '0x6f05b59d3b20000', asset: 'BNB', hash: '0x' + 'b2'.repeat(32), blockTimeStamp: 1750000100, gasPrice: '0x3b9aca00', receiptsStatus: 1 }]
          : [{ category: '20', blockNum: '0x2c', from: ME, to: '0x' + '55'.repeat(20), value: '0xde0b6b3a7640000', asset: 'USDT', hash: '0x' + 'b3'.repeat(32), contractAddress: '0x55d398326f99059ff775485246999027b3197955', decimal: '0x12', blockTimeStamp: '0x684c9d10', receiptsStatus: 1 }];
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { pageKey: '', transfers } }));
      }
      if (inner.startsWith('https://api.etherscan.io/v2/api')) return lineaAnswer(inner);
    }
    return base(input, init);
  }) as typeof fetch;
}

test('BNB without a relay key: skipped, never a failed read; where the wallet sent transactions the result is partial (part skipped)', async () => {
  const log: string[] = [];
  const r = await scan(ME, { chainIds: [1, 56], fetch: keyedFetch(log, { relayKeys: false }), relay: 'https://relay.test/p' });
  const c = r.coverage.find((x) => x.chainId === 56)!;
  assert.equal(c.status, 'skipped');
  assert.deepEqual(c.precheck, { sent: 1, holds: false });
  assert.ok(c.limitations.some((l) => /is read through the Nymra relay, which has no key for it\.$/.test(l)));
  // the score does not cover a chain the wallet used. A key is not a rate limit, so it is no failed read either.
  assert.equal(r.status, 'partial');
  assert.deepEqual(r.incomplete.map((g) => [g.part, g.chainId]), [['skipped', 56]]);
  assert.equal(r.incomplete[0].reason, 'BNB Smart Chain: not read, although this wallet sent 1 transaction here (the Nymra relay has no key for this chain)');
  assert.ok(!r.coverage.some((c) => c.status === 'error'), 'never a failed read');
  const none = await scan(ME, { chainIds: [56], fetch: keyedFetch([], { relayKeys: true }), cache: false });
  assert.equal(none.coverage[0].status, 'skipped', 'no relay at all: skipped as well');
  assert.deepEqual(none.incomplete.map((g) => g.part), ['skipped']);
});

test('the relay\'s daily quota is spent: BNB is skipped until 00:00 UTC, the score covers the rest, partial, never a failed read', async () => {
  const r = await scan(ME, { chainIds: [1, 56], fetch: keyedFetch([], { relayKeys: true, quota: true }), relay: 'https://relay.test/p' });
  const c = r.coverage.find((x) => x.chainId === 56)!;
  assert.equal(c.status, 'skipped');
  assert.equal(c.skipReason, 'quota');
  assert.ok(c.limitations.some((l) => /whose daily quota is spent\. It comes back at 00:00 UTC/.test(l)));
  assert.ok(!r.coverage.some((c) => c.status === 'error'), 'no failed read, so the site gives a score');
  assert.equal(r.status, 'partial');
  assert.deepEqual(r.incomplete.map((g) => g.part), ['skipped']);
  assert.equal(r.incomplete[0].reason, "BNB Smart Chain: not read, although this wallet sent 1 transaction here (the Nymra relay's daily quota is spent; it comes back at 00:00 UTC)");
  assert.ok(r.findings.length > 0, 'the rest is scored');
  const nokey = await scan(ME, { chainIds: [56], fetch: keyedFetch([], { relayKeys: false }), relay: 'https://relay.test/p', cache: false });
  assert.equal(nokey.coverage[0].skipReason, 'no_key');
});

test('a keyless chain that only fell back to the relay and met its spent quota stays a failed read (its explorer answers again after its window)', async () => {
  const base = fakeFetch([]);
  const f = (async (input: string | URL, init?: RequestInit) => (String(input).startsWith('https://proxy.test/')
    ? new Response('{"error":"quota"}', { status: 503, headers: { 'content-type': 'application/json', 'x-nymra-relay': 'quota' } })
    : base(input, init))) as typeof fetch;
  const r = await scan(ME, { chainIds: [1, 8453], fetch: f, fallbackProxy: 'https://proxy.test/p', cache: false });
  const b = r.coverage.find((c) => c.chainId === 8453)!;
  assert.equal(b.status, 'error');
  assert.equal(b.skipReason, undefined);
  assert.deepEqual(r.incomplete.find((g) => g.chainId === 8453), { part: 'chain', chainId: 8453, name: 'Base', reason: "Base: the relay's daily quota is spent" });
});

test('BNB without a relay key where the wallet only holds BNB: a gap that says so; an empty Linea: no gap and no relay call', async () => {
  const log: string[] = [];
  const r = await scan(ME, { chainIds: [56, 59144], fetch: keyedFetch(log, { relayKeys: false, pre: { bsc: ['0x0', '0x2386f26fc10000'], linea: ['0x0', '0x0'] } }), relay: 'https://relay.test/p' });
  const bnb = r.coverage.find((x) => x.chainId === 56)!, linea = r.coverage.find((x) => x.chainId === 59144)!;
  assert.equal(bnb.status, 'skipped');
  assert.deepEqual(bnb.precheck, { sent: 0, holds: true });
  assert.equal(linea.status, 'no_activity');
  assert.deepEqual(linea.precheck, { sent: 0, holds: false });
  assert.ok(!log.some((u) => u.startsWith('https://relay.test/p') && decodeURIComponent(u).includes('chainid=59144')), 'an empty chain costs no relay call');
  assert.deepEqual(r.incomplete.map((g) => [g.part, g.chainId, g.reason]), [['skipped', 56, 'BNB Smart Chain: not read, although this wallet holds BNB here (the Nymra relay has no key for this chain)']]);
  assert.equal(r.status, 'partial');
});

test('collectIncomplete: a skipped chain is a gap only where the quick check saw the wallet there', async () => {
  const { collectIncomplete } = await import('../src/scan.ts');
  const row = (precheck?: { sent: number; holds: boolean }) => ({
    chainId: 56, name: 'BNB Smart Chain', status: 'skipped' as const, source: 'nodereal' as const, txCount: 0, tokenTransferCount: 0,
    internalTransfers: 'not_fetched' as const, truncated: false, limitations: [], missing: [], durationMs: 0, ...(precheck ? { precheck } : {}),
  });
  assert.deepEqual(collectIncomplete([row()], [], [], false), [], 'no quick check (a chain outside the register): no gap');
  assert.deepEqual(collectIncomplete([row({ sent: 0, holds: false })], [], [], false), []);
  assert.equal(collectIncomplete([row({ sent: 3, holds: true })], [], [], false)[0].reason, 'BNB Smart Chain: not read, although this wallet sent 3 transactions here (the Nymra relay has no key for this chain)');
});

// ---------- the name and labels are hard gaps, the side lists of a name are not ----------
test('scan(): the other ENS names and the records of the name are side lists: part names, never identity', async () => {
  const wall = () => new Response('<html><title>Just a moment...</title></html>', { status: 403, headers: { 'content-type': 'text/html' } });
  const f = hooked((url) => (url.includes('addresses:lookup') || url.includes('/domains/') ? wall() : undefined));
  const r = await scan(ME, { chainIds: [1], fetch: f });
  assert.equal(r.identity.ens, 'someone.eth');
  assert.ok(r.findings.some((x) => x.id === 'public_identity.ens_reverse'), 'the name and its points stand');
  assert.equal(r.status, 'partial');
  assert.deepEqual(r.incomplete.map((g) => [g.part, g.name]), [['names', 'Other ENS names'], ['names', 'ENS records']]);
  assert.match(r.incomplete[0].reason, /^Other ENS names of this address could not be read \(/);
  assert.match(r.incomplete[1].reason, /^ENS records could not be read \(/);
});

// ---------- a service's own address is not a person's wallet ----------
test('identity.service: an exchange wallet, a deposit address, a bridge relayer, a bot and a market maker are services; a person is not', async () => {
  const { serviceIdentity } = await import('../src/index.ts');
  assert.deepEqual(serviceIdentity(BINANCE), { kind: 'exchange', entity: 'Binance' });
  assert.deepEqual(serviceIdentity('0x000f9f5f6db6d63bb64bb55d58272a1ce660fd90'), { kind: 'deposit', entity: 'Binance' });
  assert.deepEqual(serviceIdentity('0x19e34d09c2664d4f0829b1431ea73dac1b2bea93'), { kind: 'bridge', entity: 'Axelar' }, 'Axelar: Relayer (Legacy)');
  assert.deepEqual(serviceIdentity('0x199d5ed7f45f4ee35960cf22eade2076e95b253f'), { kind: 'bot' }, 'bloXroute builder: bots carry no name');
  assert.deepEqual(serviceIdentity('0xdbf5e9c5206d0db70a90108bf936da60221dc080'), { kind: 'market maker', entity: 'Wintermute' });
  assert.equal(serviceIdentity('0xd8da6bf26964af9d7eed9e03e53415d37aa96045'), undefined, 'vitalik.eth is a person');
  const r = await scan(BINANCE, { chainIds: [1], fetch: fakeFetch([]) });
  assert.deepEqual(r.identity.service, { kind: 'exchange', entity: 'Binance' });
  const p = await scan(ME, { chainIds: [1], fetch: fakeFetch([]), cache: false });
  assert.ok(!('service' in p.identity), 'absent for a person');
});

// ---------- The wallet's own explorer tags: the address page has none (metadata null, 2026-10-16), its rows do ----------
test('scan(): the wallet\'s own side of its rows gives its explorer tags: a name tag is a public label, an exchange tag a service; the other side\'s tags never', async () => {
  const own = { tags: [
    { slug: 'some-fund-3', tagType: 'name', name: 'Some Fund 3' },
    { slug: 'exchange', tagType: 'generic', name: 'Exchange' },
    { slug: 'warpcast-account', tagType: 'classifier', name: 'Farcaster' },
  ] };
  const binance = { tags: [{ slug: 'binance-14', tagType: 'name', name: 'Binance 14' }, { slug: 'exchange', tagType: 'generic', name: 'Exchange' }] };
  const rows = (self: unknown) => [
    v2(ME, BINANCE, 0.5, 1_750_000_100, { from: { hash: ME, is_contract: false, ...(self ? { metadata: self } : {}) }, to: { hash: BINANCE, is_contract: false, metadata: binance } }),
    v2(FRIEND, ME, 0.2, 1_750_000_200),
  ];
  const run = (self: unknown) => scan(ME, { chainIds: [1], cache: false, fetch: hooked((url) => (url.includes(`/api/v2/addresses/${ME}/transactions`) ? new Response(JSON.stringify({ items: rows(self), next_page_params: null })) : undefined)) });
  const tagged = await run(own);
  assert.deepEqual(tagged.identity.labels, ['Some Fund 3']);
  assert.deepEqual(tagged.identity.service, { kind: 'exchange' });
  assert.ok(tagged.findings.some((f) => f.id === 'public_identity.public_label'));
  const plain = await run(null);
  assert.deepEqual(plain.identity.labels, [], 'the exchange it sent to is not its name');
  assert.ok(!('service' in plain.identity));
  assert.ok(!plain.findings.some((f) => f.id === 'public_identity.public_label'));
});

test('serviceByTags: only explorer tags that say "service" outright (slug sets as Blockscout gave them, 2026-10-16)', async () => {
  const { serviceByTags } = await import('../src/detectors/context.ts');
  assert.deepEqual(serviceByTags(['bitget-deposit', 'deposit-address', 'bitget-dep']), { kind: 'deposit' }, 'Bitget deposit address');
  assert.deepEqual(serviceByTags(['binance-hot-wallet', 'hot-wallet', 'exchange', 'binance-14', 'binance'], 'Binance'), { kind: 'exchange', entity: 'Binance' }, 'Binance 14');
  assert.deepEqual(serviceByTags(['jaredfromsubway-mev-bot-2', 'mev-bot', 'jaredfromsubway']), { kind: 'bot' });
  for (const person of [['vitalik-buterin', 'warpcast-account', 'gitcoin-grantee', 'vb-5'], ['nicksdjohnson-0xb8c2', 'beacon-depositor', 'dao-voter'], ['ens-wallet', 'contract-deployer', 'ens'], ['jaredfromsubwayeth', 'poisoning-address', 'phish--hack']]) {
    assert.equal(serviceByTags(person), undefined, person.join(' '));
  }
});

test('BNB through the relay (NodeReal), and Linea straight even when the relay holds an Etherscan key: read, normalised, never a key in the scan', async () => {
  const log: string[] = [];
  const r = await scan(ME, { chainIds: [56, 59144], fetch: keyedFetch(log, { relayKeys: true }), relay: 'https://relay.test/p' });
  // Linea stays with each visitor (2026-10-19): read keyless and paced, never through the relay's one Etherscan key, so a
  // launch's crowd does not share that key; it reads only a gap in Polygon's index.
  assert.ok(log.some((u) => u.startsWith('https://api.etherscan.io/') && u.includes('chainid=59144')), 'Linea straight');
  assert.ok(!log.some((u) => u.startsWith('https://relay.test/p') && decodeURIComponent(u).includes('chainid=59144')), 'and never through the relay');
  assert.ok(log.some((u) => u.startsWith('https://relay.test/p') && decodeURIComponent(u).includes('nodereal')), 'BNB through the relay');
  const bnb = r.coverage.find((x) => x.chainId === 56)!;
  const linea = r.coverage.find((x) => x.chainId === 59144)!;
  assert.equal(bnb.status, 'scanned');
  assert.equal(bnb.source, 'nodereal');
  assert.equal(bnb.txCount, 2);
  assert.equal(bnb.tokenTransferCount, 1);
  assert.equal(bnb.internalTransfers, 'none');
  assert.equal(linea.status, 'scanned');
  assert.equal(linea.source, 'etherscan');
  assert.ok(log.every((u) => !/apikey=|nodereal\.io\/v1\/[a-z0-9]/i.test(u)), 'no key anywhere in what the scan sends');
  assert.ok(!r.findings.some((f) => f.id === 'linked_wallets.back_and_forth' && f.related?.some((x) => x.address === '0x' + '55'.repeat(20))), 'a token recipient seen only through NodeReal is not a person');
});

test('on a site whose relay refuses this page (nymra.pages.dev answers 403), BNB is skipped like a relay without a key: a partial score, never a failed read', async () => {
  const log: string[] = [];
  const r = await scan(ME, { chainIds: [1, 56], fetch: keyedFetch(log, { relayKeys: false }), fallbackProxy: 'https://site.test/p', cache: false });
  const bnb = r.coverage.find((x) => x.chainId === 56)!;
  assert.equal(bnb.status, 'skipped');
  assert.equal(bnb.skipReason, 'no_key');
  assert.ok(!r.coverage.some((c) => c.status === 'error'), 'no failed read: the site shows a score');
  assert.equal(r.status, 'partial');
  assert.deepEqual(r.incomplete.map((g) => [g.part, g.chainId]), [['skipped', 56]]);
  assert.ok(r.findings.length > 0, 'the rest is scored');
  assert.ok(log.filter((u) => u.startsWith('https://site.test/p')).length <= 2, 'the refusing relay is asked by the two lists that start together, then never again');
});

test('Linea is read without any key or relay: Etherscan V2 straight from the page, its requests at least 5 s apart', async () => {
  const log: string[] = [];
  etherscanAt.length = 0;
  const r = await scan(ME, { chainIds: [59144], fetch: keyedFetch(log, { relayKeys: false }), cache: false });
  const linea = r.coverage[0];
  assert.equal(linea.status, 'scanned');
  assert.equal(linea.source, 'etherscan');
  assert.equal(linea.txCount, 2);
  assert.deepEqual(r.incomplete, []);
  assert.equal(r.status, 'complete');
  assert.ok(etherscanAt.length >= 3, `${etherscanAt.length} Etherscan requests`);
  const at = [...etherscanAt].sort((a, b) => a - b);
  for (let i = 1; i < at.length; i++) assert.ok(at[i] - at[i - 1] >= 5000, `requests ${at[i] - at[i - 1]} ms apart`);
});

test('NodeReal rows: hex and decimal fields, block timestamps in any form', async () => {
  const { noderealRow } = await import('../src/sources/explorer.ts');
  const a = noderealRow('txlist', { blockNum: '0x10', blockTimeStamp: '0x684c9d10', from: '0xAA', to: '0xBB', value: '0x0de0b6b3a7640000', hash: '0x1', gasPrice: '0x3b9aca00', receiptsStatus: 0 });
  assert.deepEqual([a.blockNumber, a.timeStamp, a.value, a.gasPrice, a.isError, a.from, a._blind], ['16', String(0x684c9d10), '1000000000000000000', '1000000000', '1', '0xaa', true]);
  const b = noderealRow('tokentx', { blockNum: 17, blockTimeStamp: '2026-01-01T00:00:00Z', value: '5', decimal: '0x12', asset: 'USDT', contractAddress: '0xCC' });
  assert.deepEqual([b.blockNumber, b.timeStamp, b.value, b.tokenDecimal, b.tokenSymbol, b.contractAddress], ['17', '1767225600', '5', '18', 'USDT', '0xcc']);
});

// ---------- a gap in the explorer's index is never "no activity" ----------
test('A6: the chain says the wallet sent 23 transactions, the explorer lists none: partial, never no_activity', async () => {
  const f = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      return new Response(JSON.stringify(body.map((c: any) => ({ id: c.id, result: c.method === 'eth_getTransactionCount' ? '0x17' : c.method === 'eth_getBalance' ? '0x2386f26fc10000' : '0x' }))));
    }
    if (url.includes('/api/v2/addresses/')) return new Response(JSON.stringify(/0x[0-9a-f]{40}$/.test(url) ? { is_contract: false } : { items: [], next_page_params: null }));
    return new Response(JSON.stringify({ items: [] }));
  }) as typeof fetch;
  const r = await scan(ME, { chainIds: [137], fetch: f, cache: false });
  const poly = r.coverage[0];
  assert.equal(poly.status, 'partial');
  assert.ok(poly.missing.includes('transactions (the explorer lists none of the 23 this address sent here)'));
  assert.equal(r.status, 'partial');
  assert.ok(r.incomplete.some((i) => i.part === 'chain' && i.chainId === 137 && /lists none of the 23/.test(i.reason)));
  // A contract on that chain: its nonce counts contracts it created, so an empty list is no gap.
  const g = (async (input: string | URL, init?: RequestInit) => {
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      return new Response(JSON.stringify(body.map((c: any) => ({ id: c.id, result: c.method === 'eth_getTransactionCount' ? '0x1' : c.method === 'eth_getBalance' ? '0x0' : '0x6080604052' }))));
    }
    return f(input, init);
  }) as typeof fetch;
  const c = await scan(ME, { chainIds: [137], fetch: g, cache: false });
  assert.equal(c.coverage[0].status, 'no_activity');
  // And it is a contract, not a wallet with a score. The identity read only sees chain 1.
  assert.equal(c.addressType, 'contract');
});

// A gap in Polygon's own index (its Blockscout had 98% of its blocks on 2026-10-19, and none of nick.eth's 130 sent
// transactions): the chain is read once more from Etherscan V2 through the relay, and only a read that closes the
// gap counts. `etherscan`: what the relay answers for chainid 137 ('rows', 'one': a gap of its own, 'nokey').
function polygonGapFetch(log: string[], etherscan: 'rows' | 'one' | 'nokey', blockscoutSent = 0) {
  return (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      return new Response(JSON.stringify(body.map((c: any) => ({ id: c.id, result: c.method === 'eth_getTransactionCount' ? '0x5' : c.method === 'eth_getBalance' ? '0x2386f26fc10000' : '0x' }))));
    }
    if (url.startsWith('https://relay.test/p?u=')) {
      const inner = new URL(decodeURIComponent(url.split('?u=')[1]));
      log.push(`${inner.searchParams.get('chainid')} ${inner.searchParams.get('action')}`);
      assert.equal(inner.host, 'api.etherscan.io');
      assert.equal(inner.searchParams.get('chainid'), '137');
      if (etherscan === 'nokey') return new Response('{"error":"not configured"}', { status: 503, headers: { 'content-type': 'application/json', 'x-nymra-relay': 'nokey' } });
      if (inner.searchParams.get('action') !== 'txlist') return new Response(JSON.stringify({ status: '0', message: 'No transactions found', result: [] }));
      const sent = Array.from({ length: etherscan === 'rows' ? 5 : 1 }, (_, i) => raw(ME, FRIEND, 0.01, 1_750_000_000 + i * 600));
      return new Response(JSON.stringify({ status: '1', message: 'OK', result: [raw(FRIEND, ME, 1, 1_749_990_000), ...sent].reverse() }));
    }
    if (blockscoutSent && url.startsWith('https://polygon.blockscout.com') && new URL(url).pathname.endsWith('/transactions')) {
      return new Response(JSON.stringify({ items: Array.from({ length: blockscoutSent }, (_, i) => v2(ME, FRIEND, 0.01, 1_750_000_000 + i * 600)), next_page_params: null }));
    }
    if (url.includes('/api/v2/addresses/')) return new Response(JSON.stringify(/0x[0-9a-f]{40}$/.test(url) ? { is_contract: false } : { items: [], next_page_params: null }));
    return new Response(JSON.stringify({ items: [] }));
  }) as typeof fetch;
}

test('no gap in Polygon\'s index: the relay is never asked, so the shared key is spent only where it closes a gap', async () => {
  const log: string[] = [];
  const r = await scan(ME, { chainIds: [137], fetch: polygonGapFetch(log, 'rows', 5), relay: 'https://relay.test/p', cache: false });
  assert.equal(r.coverage[0].status, 'scanned');
  assert.deepEqual(log, []);
});

test('index gap on Polygon: read once more from Etherscan through the relay, and the gap closes', async () => {
  const log: string[] = [];
  const r = await scan(ME, { chainIds: [137], fetch: polygonGapFetch(log, 'rows'), relay: 'https://relay.test/p', cache: false });
  const poly = r.coverage[0];
  assert.equal(poly.status, 'scanned');
  assert.deepEqual(poly.missing, []);
  assert.ok(poly.txCount >= 6, `the Etherscan rows are read: ${poly.txCount}`);
  assert.ok(poly.limitations.includes("Polygon PoS's own explorer lists none of the 5 transactions this address sent here, so this chain was read from Etherscan."));
  assert.ok(!r.incomplete.some((i) => i.chainId === 137), 'no gap left on Polygon');
  assert.ok(log.some((l) => l === '137 txlist'), 'Etherscan V2 was asked for chain 137');
});

test('index gap on Polygon, and the relay holds no Etherscan key or there is no relay: the gap stays as read', async () => {
  const log: string[] = [];
  const nokey = await scan(ME, { chainIds: [137], fetch: polygonGapFetch(log, 'nokey'), relay: 'https://relay.test/p', cache: false });
  assert.equal(nokey.coverage[0].status, 'partial');
  assert.ok(nokey.coverage[0].missing.includes('transactions (the explorer lists none of the 5 this address sent here)'));
  assert.ok(nokey.incomplete.some((i) => i.part === 'chain' && i.chainId === 137 && /lists none of the 5/.test(i.reason)));
  assert.notEqual(nokey.coverage[0].status, 'skipped', 'never skipped: the explorer did answer');
  const norelay = await scan(ME, { chainIds: [137], fetch: polygonGapFetch([], 'rows'), cache: false });
  assert.equal(norelay.coverage[0].status, 'partial');
  assert.ok(norelay.incomplete.some((i) => i.chainId === 137 && /lists none of the 5/.test(i.reason)));
});

test('index gap on Polygon, and Etherscan has a gap of its own: the first read and its gap stay', async () => {
  const r = await scan(ME, { chainIds: [137], fetch: polygonGapFetch([], 'one'), relay: 'https://relay.test/p', cache: false });
  assert.equal(r.coverage[0].status, 'partial');
  assert.ok(r.incomplete.some((i) => i.chainId === 137 && /lists none of the 5/.test(i.reason)));
  assert.ok(!r.coverage[0].limitations.some((l) => /read from Etherscan/.test(l)));
});

test('index gap on a chain without a gap source: no second read', async () => {
  const log: string[] = [];
  const r = await scan(ME, { chainIds: [8453], fetch: polygonGapFetch(log, 'rows'), relay: 'https://relay.test/p', cache: false });
  assert.equal(r.coverage[0].status, 'partial');
  assert.deepEqual(log, [], 'the relay was not asked');
});

// The identity read asks Blockscout for chain 1 only, so a contract that holds its code on
// another chain came through as a wallet and was given a Privacy Score (measured on WETH on Robinhood
// Chain and on Uniswap V4's Pool Manager on Base). Code on any chain the scan reads settles it.
test('a contract whose code is on another chain is a contract, not a wallet with a score', async () => {
  const codeOn = (code: string) => (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      return new Response(JSON.stringify(body.map((c: any) => ({
        id: c.id,
        result: c.method === 'eth_getTransactionCount' ? '0x5' : c.method === 'eth_getBalance' ? '0x2386f26fc10000' : code,
      }))));
    }
    // What the identity read sees on chain 1: this address has no code there.
    if (url.includes('/api/v2/addresses/')) {
      return new Response(JSON.stringify(/0x[0-9a-f]{40}$/.test(url) ? { is_contract: false } : { items: [], next_page_params: null }));
    }
    return new Response(JSON.stringify({ items: [] }));
  }) as typeof fetch;
  for (const chainId of [8453, 4663]) {
    const contract = await scan(ME, { chainIds: [chainId], fetch: codeOn('0x6080604052'), cache: false });
    assert.equal(contract.addressType, 'contract', `code on chain ${chainId} is a contract`);
  }
  const wallet = await scan(ME, { chainIds: [8453], fetch: codeOn('0x'), cache: false });
  assert.equal(wallet.addressType, 'eoa', 'no code anywhere stays a wallet');
  // An EIP-7702 account is a wallet that delegates to code, so it keeps its score.
  const delegated = await scan(ME, { chainIds: [8453], fetch: codeOn('0xef0100' + '11'.repeat(20)), cache: false });
  assert.equal(delegated.addressType, 'eoa', 'an EIP-7702 delegation is a wallet');
});

// ---------- no request the explorer refuses (v12 rules: no `order` on internal transfers, no items_count=0) ----------
test('A4: a whole scan with funder and deposit lookups sends nothing a strict Blockscout v12 refuses', async () => {
  const refused: string[] = [];
  const FUNDER = '0x4444444444444444444444444444444444444444', DEP = '0x5555555555555555555555555555555555555555';
  const base = fakeFetch([]);
  const strict = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const u = new URL(url);
    if (u.host === 'eth.blockscout.com' && u.pathname.startsWith('/api/v2/addresses/')) {
      const q = u.searchParams;
      const internal = u.pathname.endsWith('/internal-transactions');
      if ((internal && (q.has('order') || q.has('sort'))) || q.get('items_count') === '0' || [...q.keys()].some((k) => !['filter', 'type', 'sort', 'order', 'block_number', 'index', 'items_count'].includes(k))) {
        refused.push(url);
        return new Response('{"errors":[{"detail":"Unexpected field"}]}', { status: 422 });
      }
      const me = u.pathname.split('/')[4];
      if (u.pathname.endsWith('/transactions') && me === ME) {
        return new Response(JSON.stringify({ items: [
          v2(FUNDER, ME, 1, 1_750_000_000), v2(ME, DEP, 0.4, 1_750_000_100), v2(ME, DEP, 0.3, 1_750_000_200),
          ...Array.from({ length: 50 }, (_, i) => v2(ME, '0x' + (0x6000 + i).toString(16).padStart(40, '0'), 0.001, 1_750_001_000 + i, { raw_input: '0xa9059cbb' })),
        ].reverse(), next_page_params: null }));
      }
      if (u.pathname.endsWith('/internal-transactions') && me === ME) return new Response(JSON.stringify({ items: Array.from({ length: 50 }, (_, i) => ({ block_number: 2000 + i, timestamp: '2026-01-01T00:00:00Z', transaction_hash: '0x' + (0x9000 + i).toString(16).padStart(64, '0'), from: { hash: '0x' + '77'.repeat(20), is_contract: true }, to: { hash: ME }, value: '1', success: true })), next_page_params: { block_number: 1999, index: 0, items_count: 50 } }));
      if (u.pathname.endsWith('/transactions') && me === DEP) return new Response(JSON.stringify({ items: [v2(DEP, BINANCE, 0.7, 1_750_000_300), v2(ME, DEP, 0.4, 1_750_000_100)].reverse(), next_page_params: null }));
      if (u.pathname.endsWith('/transactions') && me === FUNDER) return new Response(JSON.stringify({ items: [v2(FUNDER, ME, 1, 1_750_000_000)], next_page_params: null }));
    }
    return base(input, init);
  }) as typeof fetch;
  const r = await scan(ME, { chainIds: [1], fetch: strict, cache: false });
  assert.deepEqual(refused, [], 'no request was refused');
  assert.ok(r.findings.some((f) => f.id === 'cex_exposure.deposit_address'), 'the deposit lookup ran');
  assert.ok(r.findings.some((f) => f.id.startsWith('funding_reuse.')), 'the funder lookup ran');
  assert.ok(!r.incomplete.some((i) => i.part === 'lookups'), 'and no lookup failed');
  assert.equal(r.status, 'complete', 'a full internal page is a stated limit, not a failed read');
  const { accountList } = await import('../src/sources/explorer.ts');
  const { createHttp } = await import('../src/sources/http.ts');
  const { CHAIN_BY_ID } = await import('../src/chains.ts');
  await assert.rejects(accountList(createHttp({ fetch: strict }), CHAIN_BY_ID.get(1)!, 'txlistinternal', ME, { sort: 'asc' }), /oldest first/);
  assert.deepEqual(refused, [], 'refused before it is sent');
});

// ---------- an exchange, a bot and an unused address are not a person's wallet ----------
/** Every text of a result that speaks to the reader as its owner ("you", "your"). */
const secondPerson = (r: ScanResult) => [
  ...r.findings.flatMap((f) => [f.title, f.explanation, ...f.evidence.map((e) => e.text)]),
  ...r.warnings.flatMap((w) => [w.title, w.explanation, ...w.evidence.map((e) => e.text)]),
].filter((t) => /\b(you|your|yours)\b/i.test(t));
test('A7: an exchange wallet gets only the identity and cross-chain rules: no personal findings, no links', async () => {
  const r = await scan(BINANCE, { chainIds: [1], fetch: fakeFetch([]), cache: false });
  assert.deepEqual(r.identity.service, { kind: 'exchange', entity: 'Binance' });
  assert.ok(r.findings.length > 0);
  assert.ok(r.findings.every((f) => f.detector === 'public_identity' || f.detector === 'cross_chain'), r.findings.map((f) => f.id).join(', '));
  assert.deepEqual(r.linkedWallets, []);
  // an exchange is not the reader's wallet: "This address carries a public label", never "your".
  assert.equal(r.findings.find((f) => f.id === 'public_identity.public_label')!.title, 'This address carries a public label');
  assert.deepEqual(secondPerson(r), []);
});

test('a contract is spoken of in the third person too; a person keeps "your"', async () => {
  const f = hooked((url) => (PROFILE.test(url) ? new Response(JSON.stringify({ is_contract: true, ens_domain_name: 'someone.eth', public_tags: [], metadata: null })) : undefined));
  const c = await scan(ME, { chainIds: [1], fetch: f, cache: false });
  assert.equal(c.addressType, 'contract');
  assert.equal(c.findings.find((x) => x.id === 'public_identity.ens_reverse')!.title, 'This address has a public name');
  assert.deepEqual(secondPerson(c), []);
  const person = await scan(ME, { chainIds: [1], fetch: fakeFetch([]), cache: false });
  assert.equal(person.findings.find((x) => x.id === 'public_identity.ens_reverse')!.title, 'Your wallet has a public name');
});

test('A12: an address that sent 50,000 transactions on one chain is a bot, not a person', async () => {
  const base = fakeFetch([]);
  const f = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === 'POST' && url.includes('ethereum-rpc') && JSON.parse(String(init.body))[0]?.method === 'eth_getTransactionCount') {
      return new Response(JSON.stringify(JSON.parse(String(init.body)).map((c: any) => ({ id: c.id, result: c.method === 'eth_getTransactionCount' ? '0x64a0e8' : c.method === 'eth_getCode' ? '0x' : '0x5' }))));
    }
    return base(input, init);
  }) as typeof fetch;
  const r = await scan(ME, { chainIds: [1], fetch: f, cache: false });
  assert.deepEqual(r.identity.service, { kind: 'bot' });
  assert.ok(r.findings.every((x) => x.detector === 'public_identity' || x.detector === 'cross_chain'));
  assert.deepEqual(r.linkedWallets, []);
  assert.deepEqual(secondPerson(r), []);
});

test('A11: an address never used on any chain read says so (unused), with no findings', async () => {
  const f = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
    if (init?.method === 'POST') return json(JSON.parse(String(init.body)).map((c: any) => ({ id: c.id, result: c.method === 'eth_getCode' ? '0x' : '0x0' })));
    if (url.includes('addresses:lookup')) return json({ items: [] });
    if (url.includes('bens.services.blockscout.com')) return json({ message: 'not found' }, 404);
    if (/\/api\/v2\/addresses\/0x[0-9a-f]{40}$/.test(url)) return json({ is_contract: false, ens_domain_name: null, public_tags: [], metadata: null });
    throw new Error('unexpected url: ' + url);
  }) as typeof fetch;
  const r = await scan('0x6a976e49d7adf63333a0829880bc4e2d7146a330', { chainIds: [1, 8453, 10], fetch: f, cache: false });
  assert.equal(r.unused, true);
  assert.deepEqual(r.findings, []);
  assert.equal(r.status, 'complete');
  const used = await scan(ME, { chainIds: [1], fetch: fakeFetch([]), cache: false });
  assert.ok(!('unused' in used));
});
