// Base and Polygon PoS on a server: Alchemy's Transfers API as their keyed second source. A server meets Cloudflare's wall on both explorers, and Blockscout PRO's free plan no longer serves
// them (402 "Featured chain 8453 requires one of the following plans", measured 2026-10-17). The bot and the ASI
// agent pass `keyedAlts: ['alchemy']` when their relay holds the key; the site never does, so the browser
// reads exactly as before. No network: Alchemy, the relay and the explorers are fakes.
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { CHAIN_BY_ID, CHAINS, chainForRoad, keyed } from '../src/chains.ts';
import { fundingReuse } from '../src/detectors/funding-reuse.ts';
import { fetchChain } from '../src/history.ts';
import { scan } from '../src/index.ts';
import { accountList } from '../src/sources/explorer.ts';
import { clearSessionCache, createHttp, resetHostState, type Http } from '../src/sources/http.ts';
import { handle, resetRelayState, rewrite, rpcProblem, scrub, targetProblem, type ProxyEnv } from '../proxy/proxy.ts';
import { A, ctx, hist, ME as DME, tx } from './helpers.ts';

beforeEach(() => { clearSessionCache(); resetHostState(); resetRelayState(); });

const ME = '0x4444444444444444444444444444444444444444';
const FRIEND = '0x3333333333333333333333333333333333333333';
const ROUTER = '0x7777777777777777777777777777777777777777';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const T = 1_750_000_000;
const RELAY = 'https://relay.test/p';
const ALCHEMY_LIMIT = (name: string) => `${name} is read through Alchemy: calldata and the explorer's labels are not listed, so contracts are only recognised by their tokens. Funder checks around a date are not available here.`;

const hash = (n: number) => '0x' + n.toString(16).padStart(64, '0');
const wei = (x: number) => BigInt(Math.round(x * 1e6)) * 10n ** 12n;
/** One Alchemy transfer object, as `alchemy_getAssetTransfers` returns it with `withMetadata: true`. */
function transfer(category: string, block: number, from: string, to: string, amount: bigint, o: { token?: string; decimals?: string | null; symbol?: string; id?: string } = {}) {
  return {
    uniqueId: o.id ?? `${hash(block)}:${category}`, category, blockNum: '0x' + block.toString(16), hash: hash(block), from, to,
    value: Number(amount) / 1e18, asset: o.symbol ?? 'ETH', erc721TokenId: null, erc1155Metadata: null, tokenId: null,
    rawContract: { value: '0x' + amount.toString(16), address: o.token ?? null, decimal: o.decimals === undefined ? '0x12' : o.decimals },
    metadata: { blockTimestamp: new Date((T + block) * 1000).toISOString() },
  };
}

/** The wallet on Base: in, out, a contract call without value, a send to itself, a token, an internal transfer. */
const BASE_ROWS = [
  transfer('external', 100, FRIEND, ME, wei(0.5)),
  transfer('external', 110, ME, FRIEND, wei(0.2)),
  transfer('external', 120, ME, ROUTER, 0n),
  transfer('external', 130, ME, ME, wei(0.01)),
  transfer('erc20', 140, FRIEND, ME, 100_000_000n, { token: USDC, decimals: '0x6', symbol: 'USDC', id: `${hash(140)}:log:0x3` }),
  transfer('internal', 150, ROUTER, ME, wei(0.05), { id: `${hash(150)}:internal:0` }),
];
const POLYGON_ROWS = [
  transfer('external', 200, FRIEND, ME, wei(3), { symbol: 'POL' }),
  transfer('external', 210, ME, FRIEND, wei(1), { symbol: 'POL' }),
];

type Seen = { url: string; inner?: string; body?: any };
interface Server {
  rows?: Record<string, any[]>;
  /** The relay holds no Alchemy key: it answers 503 nokey. */
  noKey?: boolean;
  /** An Alchemy error per `<network>:<category>`. */
  errors?: Record<string, string>;
  /** Page size Alchemy uses at most (it may give fewer rows than maxCount, with a pageKey). */
  page?: number;
  /** Nonce per RPC host word ('base', 'polygon'). */
  nonce?: Record<string, number>;
  /** The browser: Blockscout answers directly. A server: its wall (403) and PRO's 402 through the relay. */
  browser?: boolean;
}

/** Alchemy as its docs describe it: one side per call, `excludeZeroValue` true unless false, metadata only on request. */
function alchemyAnswer(net: string, body: any, s: Server) {
  const p = body.params[0];
  const cat = p.category[0];
  const err = s.errors?.[`${net}:${cat}`];
  if (err) return { jsonrpc: '2.0', id: body.id, error: { code: -32602, message: err } };
  const lo = parseInt(p.fromBlock ?? '0x0', 16);
  const hi = p.toBlock === undefined || p.toBlock === 'latest' ? Infinity : parseInt(p.toBlock, 16);
  let rows = (s.rows?.[net] ?? []).filter((x) => p.category.includes(x.category) && parseInt(x.blockNum, 16) >= lo && parseInt(x.blockNum, 16) <= hi);
  if (p.fromAddress) rows = rows.filter((x) => x.from === String(p.fromAddress).toLowerCase());
  if (p.toAddress) rows = rows.filter((x) => x.to === String(p.toAddress).toLowerCase());
  if (p.excludeZeroValue !== false) rows = rows.filter((x) => BigInt(x.rawContract.value) > 0n);
  rows.sort((a, b) => parseInt(a.blockNum, 16) - parseInt(b.blockNum, 16));
  if (p.order === 'desc') rows.reverse();
  if (p.withMetadata !== true) rows = rows.map(({ metadata: _m, ...x }) => x);
  const start = p.pageKey ? Number(p.pageKey) : 0;
  const n = Math.min(parseInt(p.maxCount ?? '0x3e8', 16), s.page ?? 1000);
  const page = rows.slice(start, start + n);
  return { jsonrpc: '2.0', id: body.id, result: { transfers: page, ...(start + n < rows.length ? { pageKey: String(start + n) } : {}) } };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

function serverFetch(log: Seen[], s: Server) {
  return (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    if (url.startsWith(`${RELAY}?u=`)) {
      const inner = decodeURIComponent(url.split('?u=')[1]);
      log.push({ url, inner, body });
      const u = new URL(inner);
      if (u.host.endsWith('.g.alchemy.com')) {
        if (s.noKey) return json({ error: 'not configured' }, 503, { 'x-nymra-relay': 'nokey' });
        if (u.pathname !== '/v2/' || init?.method !== 'POST') return json({ error: 'path not allowed' }, 400);
        return json(alchemyAnswer(u.host.split('.')[0], body, s));
      }
      // Blockscout through the relay is PRO, which serves neither chain on the free plan.
      return json({ message: `Featured chain ${u.host.startsWith('base') ? 8453 : 137} requires one of the following plans: Builder, Business, Pro` }, 402);
    }
    log.push({ url, body });
    const u = new URL(url);
    if (init?.method === 'POST' && /publicnode\.com$/.test(u.host)) {
      const n = u.host.startsWith('base') ? s.nonce?.base ?? 0 : u.host.startsWith('polygon') ? s.nonce?.polygon ?? 0 : 0;
      return json(body.map((c: any) => ({ jsonrpc: '2.0', id: c.id, result: c.method === 'eth_getTransactionCount' ? '0x' + n.toString(16) : c.method === 'eth_getCode' ? '0x' : '0x5' })));
    }
    if (u.host === 'base.blockscout.com' || u.host === 'polygon.blockscout.com') {
      if (!s.browser) return new Response('<!doctype html><title>Just a moment...</title>', { status: 403, headers: { 'content-type': 'text/html' } });
      if (u.pathname.endsWith('/transactions')) {
        const item = { block_number: 1000, timestamp: new Date(T * 1000).toISOString(), hash: hash(1000), from: { hash: FRIEND, is_contract: false }, to: { hash: ME, is_contract: false }, value: '1000000000000000', gas_limit: '21000', gas_price: '1000000000', raw_input: '0x', status: 'ok' };
        return json({ items: [item], next_page_params: null });
      }
      return json({ items: [], next_page_params: null });
    }
    if (u.host === 'eth.blockscout.com') return json({ is_contract: false, public_tags: [], metadata: null });
    if (u.host === 'bens.services.blockscout.com') return json(u.pathname.endsWith('addresses:lookup') ? { items: [] } : {});
    return json({ error: 'not in this test' }, 404);
  }) as typeof fetch;
}

const alchemyCalls = (log: Seen[]) => log.filter((x) => x.inner && new URL(x.inner).host.endsWith('.g.alchemy.com'));
const touches = (log: Seen[], host: string) => log.some((x) => x.url.includes(host) || (x.inner ?? '').includes(host));

// ---------- the register ----------

test('register: Base and Polygon PoS, the two chains a server cannot read, get Alchemy as a keyed second source; no other chain does', () => {
  const withAlt = CHAINS.filter((c) => c.keyedAlt).map((c) => [c.id, c.keyedAlt!.kind, c.keyedAlt!.api]);
  assert.deepEqual(withAlt, [[8453, 'alchemy', 'https://base-mainnet.g.alchemy.com/v2/'], [137, 'alchemy', 'https://polygon-mainnet.g.alchemy.com/v2/']]);
  for (const c of CHAINS) if (c.keyedAlt) assert.ok(keyed(c.keyedAlt), `${c.name}: the key lives in the relay, never in the scan`);
  // Their own source stays Blockscout: that is what the browser reads.
  assert.equal(CHAIN_BY_ID.get(8453)!.source.kind, 'blockscout');
  assert.equal(CHAIN_BY_ID.get(137)!.source.kind, 'blockscout');
});

test('chainForRoad: the very same chain unless the scan says the relay holds that key', () => {
  const base = CHAIN_BY_ID.get(8453)!, eth = CHAIN_BY_ID.get(1)!;
  assert.equal(chainForRoad(base), base);
  assert.equal(chainForRoad(base, []), base);
  assert.equal(chainForRoad(eth, ['alchemy']), eth, 'a chain without a keyed second source is untouched');
  const road = chainForRoad(base, ['alchemy']);
  assert.equal(road.source, base.keyedAlt);
  assert.equal(road.alt, undefined);
  assert.deepEqual(road.limits, [ALCHEMY_LIMIT('Base')]);
  assert.equal(base.source.kind, 'blockscout', 'the register itself is not changed');
});

// ---------- the browser road ----------

test('browser road: without keyedAlts Base and Polygon read their own Blockscout, exactly as before, and nothing goes to Alchemy', async () => {
  const runs: string[][] = [];
  for (const opts of [{}, { keyedAlts: [] }]) {
    clearSessionCache(); resetHostState();
    const log: Seen[] = [];
    const r = await scan(ME, { chainIds: [8453, 137], fetch: serverFetch(log, { browser: true, nonce: { base: 0, polygon: 0 } }), fallbackProxy: RELAY, cache: false, ...opts });
    for (const id of [8453, 137]) {
      const c = r.coverage.find((x) => x.chainId === id)!;
      assert.equal(c.source, 'blockscout', `${c.name} reads its own explorer`);
      assert.equal(c.status, 'scanned');
      assert.ok(!c.limitations.some((l) => l.includes('Alchemy')));
    }
    assert.ok(!touches(log, 'alchemy.com'), 'no request to Alchemy, direct or through the relay');
    runs.push(log.map((x) => `${x.url} ${x.body ? JSON.stringify(x.body) : ''}`).sort());
  }
  assert.deepEqual(runs[1], runs[0], 'an empty keyedAlts asks exactly what no option asks');
});

// ---------- the server road with the key ----------

test('server road with the key: Base and Polygon read through Alchemy via the relay, never Blockscout, and no key in what the scan sends', async () => {
  const log: Seen[] = [];
  const r = await scan(ME, { chainIds: [8453, 137], keyedAlts: ['alchemy'], fetch: serverFetch(log, { rows: { 'base-mainnet': BASE_ROWS, 'polygon-mainnet': POLYGON_ROWS }, nonce: { base: 3, polygon: 1 } }), fallbackProxy: RELAY, relay: RELAY, cache: false });
  const base = r.coverage.find((x) => x.chainId === 8453)!, pol = r.coverage.find((x) => x.chainId === 137)!;
  assert.deepEqual([base.status, base.source, base.txCount, base.tokenTransferCount, base.internalTransfers, base.missing], ['scanned', 'alchemy', 4, 1, 'full', []]);
  assert.deepEqual([pol.status, pol.source, pol.txCount, pol.tokenTransferCount, pol.missing], ['scanned', 'alchemy', 2, 0, []]);
  assert.ok(base.limitations.includes(ALCHEMY_LIMIT('Base')));
  assert.ok(pol.limitations.includes(ALCHEMY_LIMIT('Polygon PoS')));
  assert.equal(base.firstSeen, T + 100);
  assert.equal(base.lastSeen, T + 150, 'timestamps come from Alchemy (withMetadata)');
  assert.ok(!touches(log, 'base.blockscout.com') && !touches(log, 'polygon.blockscout.com'), 'Blockscout always refuses a server here, so it is not asked');
  assert.ok(!r.incomplete.some((g) => g.chainId === 8453 || g.chainId === 137));
  const calls = alchemyCalls(log);
  assert.ok(calls.length >= 9, `${calls.length} Alchemy calls`);
  for (const c of calls) {
    assert.ok(c.inner === 'https://base-mainnet.g.alchemy.com/v2/' || c.inner === 'https://polygon-mainnet.g.alchemy.com/v2/', `the path carries no key: ${c.inner}`);
    assert.equal(c.body.method, 'alchemy_getAssetTransfers');
    const p = c.body.params[0];
    assert.equal(p.excludeZeroValue, false, 'contract calls without value are listed');
    assert.equal(p.withMetadata, true);
    assert.equal(p.category.length, 1);
    assert.equal(+!!p.fromAddress + +!!p.toAddress, 1, 'one side per call: both together mean "from A to B"');
  }
  // The wallet's own three lists on each chain, each from both sides.
  for (const net of ['base-mainnet', 'polygon-mainnet']) for (const cat of ['external', 'erc20', 'internal']) for (const side of ['fromAddress', 'toAddress']) {
    assert.ok(calls.some((c) => c.inner!.includes(net) && c.body.params[0].category[0] === cat && c.body.params[0][side] === ME), `${net} ${cat} ${side}`);
  }
});

test('fetchChain on Alchemy: both sides merged newest first, a send to itself once, values from rawContract, no calldata (blind)', async () => {
  const log: Seen[] = [];
  const http = createHttp({ fetch: serverFetch(log, { rows: { 'base-mainnet': BASE_ROWS }, nonce: { base: 3 } }), relay: RELAY, cache: null });
  const h = await fetchChain(http, chainForRoad(CHAIN_BY_ID.get(8453)!, ['alchemy']), ME, { maxTx: 500, maxToken: 250, maxInternal: 50 });
  assert.deepEqual(h.txs.map((t) => [t.block, t.dir, t.amount, t.timestamp]), [[130, 'self', 0.01, T + 130], [120, 'out', 0, T + 120], [110, 'out', 0.2, T + 110], [100, 'in', 0.5, T + 100]]);
  assert.ok(h.txs.every((t) => t.blind === true && t.isCall === undefined), 'whether a row was a contract call is unknown');
  assert.deepEqual(h.tokens.map((t) => [t.block, t.token, t.symbol, t.amount, t.dir]), [[140, USDC, 'USDC', 100, 'in']]);
  assert.deepEqual(h.internal.map((t) => [t.block, t.from, t.amount, t.kind]), [[150, ROUTER, 0.05, 'internal']]);
  assert.equal(h.ownCount, 3);
  assert.equal(h.firstOwn?.block, 110);
  assert.equal(h.coverage.source, 'alchemy');
});

// ---------- never a score from half a history ----------

test('half a history is never a score: a gap against the nonce, a list Alchemy refuses, a relay without the key', async () => {
  // Alchemy lists 2 of the 10 transactions the chain says this wallet sent: the chain is not read.
  const few = [transfer('external', 300, ME, FRIEND, wei(0.1)), transfer('external', 301, ME, FRIEND, wei(0.1))];
  let r = await scan(ME, { chainIds: [8453], keyedAlts: ['alchemy'], fetch: serverFetch([], { rows: { 'base-mainnet': few }, nonce: { base: 10 } }), relay: RELAY, cache: false });
  let c = r.coverage[0];
  assert.equal(c.status, 'partial');
  assert.deepEqual(c.missing, ['transactions (the explorer lists 2 of the 10 this address sent here)']);
  assert.deepEqual(r.incomplete.map((g) => [g.part, g.chainId]), [['chain', 8453]]);
  assert.equal(r.status, 'partial');

  // The internal list refused: partial, the part named.
  clearSessionCache();
  r = await scan(ME, { chainIds: [8453], keyedAlts: ['alchemy'], fetch: serverFetch([], { rows: { 'base-mainnet': BASE_ROWS }, nonce: { base: 3 }, errors: { 'base-mainnet:internal': 'internal transfers are not supported on this network' } }), relay: RELAY, cache: false });
  c = r.coverage[0];
  assert.equal(c.status, 'partial');
  assert.equal(c.internalTransfers, 'not_fetched');
  assert.deepEqual(r.incomplete.map((g) => [g.part, g.chainId]), [['internal', 8453]]);

  // A relay that does not hold the key: skipped with the reason, as BNB without NodeReal's key.
  clearSessionCache();
  r = await scan(ME, { chainIds: [8453], keyedAlts: ['alchemy'], fetch: serverFetch([], { noKey: true, nonce: { base: 3 } }), relay: RELAY, cache: false });
  c = r.coverage[0];
  assert.deepEqual([c.status, c.skipReason], ['skipped', 'no_key']);
  assert.deepEqual(r.incomplete.map((g) => [g.part, g.chainId]), [['skipped', 8453]]);
});

// ---------- the list itself ----------

/** A stand-in Http that answers like Alchemy and records each call. */
function stubHttp(s: Server, calls: { url: string; body: any; via?: string }[]): Http {
  return {
    count: 0, cached: 0, waitedMs: 0, byKind: {}, budgetLeft: () => 600,
    async getJson(url: string, init?: RequestInit, call: { via?: string } = {}) {
      const body = JSON.parse(String(init?.body));
      calls.push({ url, body, via: call.via });
      return alchemyAnswer(new URL(url).host.split('.')[0], body, s);
    },
  } as Http;
}

test('accountList on Alchemy: pages until enough, newest first across both sides, one side and a block window for a funder check, oldest first', async () => {
  const chain = chainForRoad(CHAIN_BY_ID.get(8453)!, ['alchemy']);
  const rows = [
    ...[10, 12, 14, 16, 18].map((b) => transfer('external', b, ME, FRIEND, wei(0.1))),
    ...[11, 13, 15, 17, 19].map((b) => transfer('external', b, FRIEND, ME, wei(0.1))),
  ];
  const calls: { url: string; body: any; via?: string }[] = [];
  const s: Server = { rows: { 'base-mainnet': rows }, page: 2 };
  const newest = await accountList(stubHttp(s, calls), chain, 'txlist', ME, { sort: 'desc', offset: 3 });
  assert.deepEqual(newest.map((x: any) => Number(x.blockNumber)), [19, 18, 17]);
  assert.ok(calls.every((c) => c.via === 'relay' && c.url === 'https://base-mainnet.g.alchemy.com/v2/'));
  assert.ok(calls.some((c) => c.body.params[0].pageKey), 'a second page is asked when the first has too few rows');
  assert.ok(calls.every((c) => c.body.params[0].fromBlock === '0x0' && c.body.params[0].toBlock === 'latest' && c.body.params[0].order === 'desc'));

  calls.length = 0;
  const oldest = await accountList(stubHttp(s, calls), chain, 'txlist', ME, { sort: 'asc', offset: 4 });
  assert.deepEqual(oldest.map((x: any) => Number(x.blockNumber)), [10, 11, 12, 13]);
  assert.ok(calls.every((c) => c.body.params[0].order === 'asc'));

  calls.length = 0;
  const sent = await accountList(stubHttp(s, calls), chain, 'txlist', ME, { sort: 'desc', offset: 50, filter: 'from', startblock: 12, endblock: 16 });
  assert.deepEqual(sent.map((x: any) => Number(x.blockNumber)), [16, 14, 12]);
  assert.ok(calls.every((c) => c.body.params[0].fromAddress === ME && c.body.params[0].toAddress === undefined), 'only the sender side');
  assert.ok(calls.every((c) => c.body.params[0].fromBlock === '0xc' && c.body.params[0].toBlock === '0x10'));

  calls.length = 0;
  const tok = await accountList(stubHttp({ rows: { 'base-mainnet': BASE_ROWS } }, calls), chain, 'tokentx', ME, { offset: 10 });
  assert.deepEqual(calls.map((c) => c.body.params[0].category), [['erc20'], ['erc20']]);
  assert.deepEqual(tok.map((x: any) => [x.contractAddress, x.tokenDecimal, x.tokenSymbol, x.value]), [[USDC, '6', 'USDC', '100000000']]);
  calls.length = 0;
  await accountList(stubHttp({ rows: { 'base-mainnet': BASE_ROWS } }, calls), chain, 'txlistinternal', ME, { offset: 10 });
  assert.deepEqual(calls.map((c) => c.body.params[0].category), [['internal'], ['internal']]);
});

test('accountList on Alchemy: an error answer is a failed read, never an empty list', async () => {
  const chain = chainForRoad(CHAIN_BY_ID.get(137)!, ['alchemy']);
  await assert.rejects(accountList(stubHttp({ errors: { 'polygon-mainnet:internal': 'not supported' } }, []), chain, 'txlistinternal', ME, { offset: 5 }), /Polygon PoS: not supported/);
});

// ---------- the detectors ----------

test('funding_reuse: no funder check on a source without calldata (Alchemy, like NodeReal): a paid contract call would look like a sibling', async () => {
  const F = A(9);
  const rows = [tx({ chainId: 8453, from: F, to: DME, amount: 0.05, block: 500 }), tx({ chainId: 8453, to: A(50), amount: 0.01 })];
  let asked = 0;
  const lookup = async () => { asked++; return [A(21), A(22), A(23)].map((to) => tx({ chainId: 8453, from: F, to, amount: 0.05, dir: 'out' })); };
  const alchemy = chainForRoad(CHAIN_BY_ID.get(8453)!, ['alchemy']);
  const fs = await fundingReuse.run(ctx([hist(8453, rows, { chain: alchemy })], { lookup }));
  assert.equal(asked, 0);
  assert.ok(!fs.some((f) => f.id === 'funding_reuse.shared_funder'));
  // The same history read from Blockscout does get its funder check.
  const fs2 = await fundingReuse.run(ctx([hist(8453, rows)], { lookup }));
  assert.equal(asked, 1);
  assert.ok(fs2.some((f) => f.id === 'funding_reuse.shared_funder'));
});

// ---------- the relay ----------

const AL = 'alcht_TESTkey-123_abc';
const BOT = 'bot-secret-token-1';
const ENV: ProxyEnv = { ALCHEMY_API_KEY: AL, BOT_TOKEN: BOT };
const TRANSFERS = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'alchemy_getAssetTransfers', params: [{ fromAddress: ME, category: ['external'], withMetadata: true, excludeZeroValue: false, maxCount: '0x1' }] });
const asBot = (target: string, o: { method?: string; body?: string } = {}) => new Request(`https://relay.invalid/p?u=${encodeURIComponent(target)}`, {
  method: o.method ?? 'POST', headers: { authorization: `Bearer ${BOT}`, 'content-type': 'application/json' }, body: (o.method ?? 'POST') === 'POST' ? o.body ?? TRANSFERS : undefined,
});

test('relay: the Alchemy key goes in the path of the two Alchemy hosts, only when it is set, and is cut out of every answer', async () => {
  for (const net of ['base-mainnet', 'polygon-mainnet']) {
    const up = rewrite(new URL(`https://${net}.g.alchemy.com/v2/`), ENV);
    assert.equal(up.url.href, `https://${net}.g.alchemy.com/v2/${AL}`);
    assert.equal(up.keyed, 'alchemy');
    assert.deepEqual(up.headers, {});
    assert.equal(rewrite(new URL(`https://${net}.g.alchemy.com/v2/`), {}).keyed, null);
  }
  assert.equal(scrub(`{"error":"bad key ${AL}"}`, ENV), '{"error":"bad key [redacted]"}');
  const real = globalThis.fetch;
  const seen: string[] = [];
  globalThis.fetch = (async (input: any) => { seen.push(String(input)); return json({ jsonrpc: '2.0', id: 1, result: { transfers: [], echo: `/v2/${AL}` } }); }) as typeof fetch;
  try {
    const ok = await handle(asBot('https://base-mainnet.g.alchemy.com/v2/'), ENV);
    assert.equal(ok.status, 200);
    assert.ok(!(await ok.text()).includes(AL), 'the key never goes back');
    assert.deepEqual(seen, [`https://base-mainnet.g.alchemy.com/v2/${AL}`]);
    const none = await handle(asBot('https://polygon-mainnet.g.alchemy.com/v2/'), { BOT_TOKEN: BOT });
    assert.equal(none.status, 503);
    assert.equal(none.headers.get('x-nymra-relay'), 'nokey');
    assert.equal(seen.length, 1, 'without the key nothing goes upstream');
  } finally {
    globalThis.fetch = real;
  }
});

test('relay: an Alchemy host takes only the transfer list, by POST, on /v2/; no other host takes that call', async () => {
  const base = 'https://base-mainnet.g.alchemy.com/v2/';
  assert.equal(targetProblem('POST', new URL(base)), null);
  assert.equal(targetProblem('GET', new URL(base)), 'method not allowed');
  assert.equal(targetProblem('POST', new URL('https://base-mainnet.g.alchemy.com/v2/somebody-elses-key')), 'path not allowed');
  assert.equal(targetProblem('POST', new URL('https://eth-mainnet.g.alchemy.com/v2/')), 'host not allowed', 'only the chains that need it');
  assert.equal(rpcProblem(TRANSFERS, true), null);
  for (const m of ['eth_getBalance', 'eth_getTransactionCount', 'eth_call', 'alchemy_getTokenBalances', 'eth_sendRawTransaction']) {
    assert.equal(rpcProblem(JSON.stringify({ jsonrpc: '2.0', id: 1, method: m, params: [] }), true), 'method not allowed', m);
  }
  assert.equal(rpcProblem(JSON.stringify([JSON.parse(TRANSFERS), JSON.parse(TRANSFERS)]), true), null, 'a batch of transfer lists');
  assert.equal(rpcProblem(TRANSFERS), 'method not allowed', 'a public RPC never gets the transfer list');
  assert.equal(rpcProblem(TRANSFERS, false), 'method not allowed');
  const real = globalThis.fetch;
  let upstream = 0;
  globalThis.fetch = (async () => { upstream++; return json({}); }) as typeof fetch;
  try {
    const bad = await handle(asBot(base, { body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: [ME, 'latest'] }) }), ENV);
    assert.equal(bad.status, 400);
    const other = await handle(asBot('https://base-rpc.publicnode.com/', { body: TRANSFERS }), ENV);
    assert.equal(other.status, 400);
    const get = await handle(asBot(base, { method: 'GET' }), ENV);
    assert.equal(get.status, 405);
    assert.equal(upstream, 0);
  } finally {
    globalThis.fetch = real;
  }
});
