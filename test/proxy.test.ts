// The relay (proxy/proxy.ts): who may call it, where it may go, and that a key never leaves it.
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { handle, MAX_BODY, MIN_CREDITS, originAllowed, resetRelayState, rewrite, rpcProblem, scrub, targetProblem, type ProxyEnv } from '../proxy/proxy.ts';

const PRO = 'proapi_TESTKEY_abc123+/=';
const ES = 'ESKEY_9f8e7d';
const NR = 'nodereal-key-77';
const BOT = 'bot-secret-token-1';
const ENV: ProxyEnv = { BLOCKSCOUT_PRO_KEY: PRO, ETHERSCAN_API_KEY: ES, NODEREAL_API_KEY: NR, BOT_TOKEN: BOT };
const SITE = 'https://nymra.si';
const enc = (u: string) => encodeURIComponent(u);

type Seen = { url: string; init: RequestInit };
let seen: Seen[] = [];
let reply: (url: string, init: RequestInit) => Response = () => new Response('{"items":[]}', { headers: { 'content-type': 'application/json' } });
const realFetch = globalThis.fetch;
beforeEach(() => {
  resetRelayState();
  seen = [];
  reply = () => new Response('{"items":[]}', { headers: { 'content-type': 'application/json' } });
  globalThis.fetch = (async (input: any, init: RequestInit = {}) => { const url = String(input); seen.push({ url, init }); return reply(url, init); }) as typeof fetch;
});
process.on('exit', () => { globalThis.fetch = realFetch; });

function req(target: string, o: { origin?: string | null; method?: string; body?: string; auth?: string; ip?: string } = {}) {
  const headers: Record<string, string> = {};
  if (o.origin !== null) headers.origin = o.origin ?? SITE;
  if (o.auth) headers.authorization = o.auth;
  headers['cf-connecting-ip'] = o.ip ?? '203.0.113.7';
  if (o.body !== undefined) headers['content-type'] = 'application/json';
  return new Request(`https://nymra.si/p?u=${enc(target)}`, { method: o.method ?? (o.body !== undefined ? 'POST' : 'GET'), headers, body: o.body });
}
const ETH_V2 = 'https://eth.blockscout.com/api/v2/addresses/0x1111111111111111111111111111111111111111/transactions';

test('origins: our site, www and the Pages previews; nothing else; localhost only when switched on', () => {
  for (const o of ['https://nymra.si', 'https://www.nymra.si', 'https://nymra.pages.dev', 'https://4f2a9c1e.nymra.pages.dev', 'https://main.nymra.pages.dev']) assert.ok(originAllowed(o, {}), o);
  for (const o of [null, 'null', 'https://evil.example', 'https://nymra.si.evil.example', 'https://evilnymra.si', 'http://nymra.si', 'https://x.nymra.pages.dev.evil.example', 'https://a.b.nymra.pages.dev']) assert.ok(!originAllowed(o, {}), String(o));
  assert.ok(!originAllowed('http://localhost:5180', {}));
  assert.ok(originAllowed('http://localhost:5180', { ALLOW_LOCALHOST: '1' }));
  assert.ok(originAllowed('https://staging.example', { ALLOWED_ORIGINS: 'https://staging.example, https://x.example' }));
});

test('no CORS, ever: another website (even one of ours on another host) is refused, a preflight gets nothing', async () => {
  const r = await handle(req(ETH_V2, { origin: 'https://evil.example' }), ENV);
  assert.equal(r.status, 403);
  const none = await handle(req(ETH_V2, { origin: null }), ENV);
  assert.equal(none.status, 403, 'no origin and no bot token');
  const www = await handle(req(ETH_V2, { origin: 'https://www.nymra.si' }), ENV);
  assert.equal(www.status, 403, 'www calls its own /p, never this one');
  assert.equal(seen.length, 0);
  const pre = await handle(new Request('https://nymra.si/p', { method: 'OPTIONS', headers: { origin: SITE, 'access-control-request-method': 'POST' } }), ENV);
  assert.equal(pre.status, 405);
  const ok = await handle(req(ETH_V2), ENV);
  assert.equal(ok.status, 200);
  for (const res of [r, none, www, pre, ok]) for (const [k] of res.headers) assert.ok(!k.startsWith('access-control-'), `no ${k}`);
});

test('the site itself: a same-origin GET has no Origin header, so Sec-Fetch-Site counts, on our hosts only', async () => {
  const same = (host: string, site: string | null) => new Request(`https://${host}/p?u=${enc(ETH_V2)}`, { headers: site ? { 'sec-fetch-site': site } : {} });
  assert.equal((await handle(same('nymra.si', 'same-origin'), ENV)).status, 200);
  assert.equal((await handle(same('4f2a9c1e.nymra.pages.dev', 'same-origin'), ENV)).status, 200);
  assert.equal((await handle(same('nymra.si', 'cross-site'), ENV)).status, 403);
  assert.equal((await handle(same('nymra.si', null), ENV)).status, 403);
  assert.equal((await handle(same('evil.example', 'same-origin'), ENV)).status, 403, 'someone else hosting this handler');
});

test('the bot calls without an origin, with its token; a wrong token is refused', async () => {
  assert.equal((await handle(req(ETH_V2, { origin: null, auth: `Bearer ${BOT}` }), ENV)).status, 200);
  assert.equal((await handle(req(ETH_V2, { origin: null, auth: 'Bearer wrong-token-xx' }), ENV)).status, 403);
  assert.equal((await handle(req(ETH_V2, { origin: null, auth: `Bearer ${BOT}` }), { ...ENV, BOT_TOKEN: undefined })).status, 403, 'no token configured: no bot access');
});

test('targets: only register hosts over https, no user info, no redirects followed', async () => {
  for (const t of ['https://evil.example/api', 'http://eth.blockscout.com/api/v2/x', 'https://user:pw@eth.blockscout.com/api/v2/x', 'not a url']) {
    assert.equal((await handle(req(t), ENV)).status, 400, t);
  }
  assert.equal(seen.length, 0);
  await handle(req(ETH_V2), ENV);
  // 'manual', never 'error': Cloudflare's runtime throws on 'error', and Node does not. The relay refuses
  // the redirect itself (next test).
  assert.equal(seen[0].init.redirect, 'manual');
  assert.ok(seen[0].init.signal instanceof AbortSignal, 'every upstream call has a timeout');
});

test('a redirect upstream is refused, never followed: JSON 503 with x-nymra-relay redirect', async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    seen = [];
    reply = () => new Response('', { status, headers: { location: 'https://evil.example/stolen' } });
    const r = await handle(req(ETH_V2), ENV);
    assert.equal(r.status, 503, String(status));
    assert.equal(r.headers.get('x-nymra-relay'), 'redirect', String(status));
    assert.equal(r.headers.get('location'), null, String(status));
    assert.deepEqual(JSON.parse(await r.text()), { error: 'upstream redirect' });
    assert.equal(seen.length, 1, `${status}: asked once, the redirect not followed`);
  }
  // A runtime that answers 'manual' with an opaque redirect (status 0) is refused the same way.
  reply = () => ({ type: 'opaqueredirect', status: 0, ok: false, headers: new Headers(), body: null, text: async () => '' }) as unknown as Response;
  const opaque = await handle(req(ETH_V2), ENV);
  assert.equal(opaque.status, 503);
  assert.equal(opaque.headers.get('x-nymra-relay'), 'redirect');
});

test('an upstream that cannot be reached answers JSON 503 with the reason, never 502 or 504', async () => {
  reply = () => { throw new TypeError('fetch failed'); };
  const r = await handle(req(ETH_V2), ENV);
  assert.equal(r.status, 503);
  assert.equal(r.headers.get('x-nymra-relay'), 'unreachable');
  assert.deepEqual(JSON.parse(await r.text()), { error: 'upstream unreachable' });
});

test('the relay asks only for what Cloudflare runs, and never answers 502 or 504 itself', async () => {
  // A Node test cannot catch redirect 'error' at run time (Node accepts it, Cloudflare's runtime throws),
  // so the source is read. On a custom domain Cloudflare puts its own page over a 502 or 504.
  const src = await (await import('node:fs/promises')).readFile(new URL('../proxy/proxy.ts', import.meta.url), 'utf8');
  const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(code, /redirect\s*:\s*['"](error|follow)['"]/);
  assert.match(code, /redirect\s*:\s*'manual'/);
  assert.doesNotMatch(code, /json\(\s*50[24]\b|status\s*:\s*50[24]\b/);
});

test('Blockscout goes to the PRO API with the key in an Authorization header, never in the URL', () => {
  const u = rewrite(new URL(ETH_V2 + '?filter=from'), ENV);
  assert.equal(u.url.href, 'https://api.blockscout.com/1/api/v2/addresses/0x1111111111111111111111111111111111111111/transactions?filter=from');
  assert.equal(u.headers.authorization, `Bearer ${PRO}`);
  assert.ok(!u.url.href.includes(PRO));
  const base = rewrite(new URL('https://base.blockscout.com/api/v2/addresses/0xab/token-transfers'), ENV);
  assert.equal(base.url.pathname, '/8453/api/v2/addresses/0xab/token-transfers');
  const manta = rewrite(new URL('https://pacific-explorer.manta.network/api/v2/addresses/0xab'), ENV);
  assert.equal(manta.keyed, null, 'Manta is not on the PRO API: keyless');
  assert.equal(rewrite(new URL(ETH_V2), {}).keyed, null, 'no key: keyless');
  assert.equal(rewrite(new URL('https://eth.blockscout.com/api?module=account'), ENV).keyed, null, 'the old /api is never rewritten');
});

test('the key never comes back: an upstream that echoes its URL and headers is scrubbed, in every form', async () => {
  reply = (url, init) => new Response(JSON.stringify({ message: `bad request ${url}`, auth: (init.headers as any)?.authorization, enc: enc(url) }), { status: 400, headers: { 'content-type': 'application/json' } });
  const targets = [
    ETH_V2,
    'https://api.etherscan.io/v2/api?chainid=137&module=account&action=txlist&address=0xab',
  ];
  for (const t of targets) {
    const r = await handle(req(t), ENV);
    const text = await r.text();
    for (const k of [PRO, ES, NR, BOT, enc(PRO), enc(ES)]) assert.ok(!text.includes(k), `${t}: key leaked`);
    assert.ok(text.includes('[redacted]'), 'the echo was there and got cut');
    for (const [, v] of r.headers) for (const k of [PRO, ES, NR]) assert.ok(!v.includes(k));
  }
  const rpc = await handle(req('https://bsc-mainnet.nodereal.io/v1/', { body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'nr_getTransactionByAddress', params: [{}] }) }), ENV);
  assert.ok(!(await rpc.text()).includes(NR));
  assert.equal(seen.at(-1)!.url, `https://bsc-mainnet.nodereal.io/v1/${NR}`, 'NodeReal takes the key in the path (its only form)');
  assert.equal(scrub(`a ${PRO} b ${enc(PRO)} c`, ENV), 'a [redacted] b [redacted] c');
});

test('daily quota: below the threshold the relay stops spending the PRO key and says so', async () => {
  reply = () => new Response('{"items":[]}', { headers: { 'content-type': 'application/json', 'x-credits-remaining': String(MIN_CREDITS - 1) } });
  assert.equal((await handle(req(ETH_V2), ENV)).status, 200, 'this answer still goes back');
  const r = await handle(req(ETH_V2), ENV);
  assert.equal(r.status, 503);
  assert.equal(r.headers.get('x-nymra-relay'), 'quota');
  assert.match((await r.json()).message, /daily quota/);
  assert.equal(seen.length, 1, 'no upstream call once the quota is low');
  assert.equal((await handle(req('https://api.routescan.io/v2/network/mainnet/evm/43114/etherscan/api?module=account&action=txlist'), ENV)).status, 200, 'keyless roads keep working');
});

test('JSON-RPC: only the read calls the scan sends, a bounded batch, a body of at most 4 KB', async () => {
  const call = (method: string, params: unknown[] = []) => ({ jsonrpc: '2.0', id: 1, method, params });
  assert.equal(rpcProblem(JSON.stringify([call('eth_getTransactionCount'), call('eth_getBalance'), call('eth_getCode')])), null);
  assert.equal(rpcProblem(JSON.stringify(call('eth_sendRawTransaction'))), 'method not allowed');
  assert.equal(rpcProblem(JSON.stringify([call('eth_getBalance'), call('debug_traceTransaction')])), 'method not allowed');
  assert.equal(rpcProblem(JSON.stringify(Array.from({ length: 17 }, () => call('eth_getBalance')))), 'batch size');
  assert.equal(rpcProblem('{"x": "' + 'a'.repeat(4100) + '"}'), 'body too large');
  assert.equal(MAX_BODY, 4096);
  // eth_call only as an ENS text record read: any other contract call (a transfer, a swap quote, an
  // expensive view) is refused, so the relay is no free RPC for other sites.
  const to = '0x' + 'cd'.repeat(20);
  assert.equal(rpcProblem(JSON.stringify(call('eth_call', [{ to, data: '0xa9059cbb' + '00'.repeat(64) }, 'latest']))), 'call not allowed');
  assert.equal(rpcProblem(JSON.stringify(call('eth_call', [{ to }, 'latest']))), 'call not allowed');
  // The largest body the scan sends (the ENS records batch) fits.
  const { encodeText, IDENTITY_KEYS } = await import('../src/sources/identity.ts');
  const ens = JSON.stringify(IDENTITY_KEYS.map((k, i) => ({ jsonrpc: '2.0', id: i, method: 'eth_call', params: [{ to, data: encodeText('0x' + 'ab'.repeat(32), k) }, 'latest'] })));
  assert.ok(ens.length <= MAX_BODY, `ENS batch ${ens.length} bytes`);
  assert.equal(rpcProblem(ens), null);
  assert.equal(rpcProblem('not json'), 'not JSON');
  const r = await handle(req('https://ethereum-rpc.publicnode.com/', { body: JSON.stringify(call('eth_sendRawTransaction')) }), ENV);
  assert.equal(r.status, 400);
  assert.equal(seen.length, 0);
});

test('an upstream bot check comes back as JSON 503, never as its HTML page', async () => {
  reply = () => new Response('<!DOCTYPE html><title>Just a moment...</title>', { status: 403, headers: { 'content-type': 'text/html' } });
  const r = await handle(req(ETH_V2), {});
  assert.equal(r.status, 503);
  assert.equal(r.headers.get('content-type'), 'application/json');
  assert.equal(r.headers.get('x-nymra-relay'), 'blocked');
  assert.ok(!(await r.text()).includes('<'));
});

test('an upstream 429 passes its wait on as Retry-After; other quota counters do not pass', async () => {
  reply = () => new Response('{"message":"Too many requests"}', { status: 429, headers: { 'content-type': 'application/json', 'x-ratelimit-reset': '30000', 'x-ratelimit-remaining': '0' } });
  const r = await handle(req(ETH_V2), {});
  assert.equal(r.status, 429);
  assert.equal(r.headers.get('retry-after'), '30');
  assert.equal(r.headers.get('x-ratelimit-remaining'), null);
});

test('rate limit per caller: the binding when bound, else 300 a minute in memory', async () => {
  const denied = await handle(req(ETH_V2), { ...ENV, RATE_LIMIT: { limit: async () => ({ success: false }) } });
  assert.equal(denied.status, 429);
  assert.equal(denied.headers.get('x-nymra-relay'), 'rate');
  let keys: string[] = [];
  await handle(req(ETH_V2, { ip: '198.51.100.9' }), { ...ENV, RATE_LIMIT: { limit: async (o) => { keys.push(o.key); return { success: true }; } } });
  assert.deepEqual(keys, ['198.51.100.9']);
  keys = [];
  await handle(req(ETH_V2, { origin: null, auth: `Bearer ${BOT}` }), { ...ENV, RATE_LIMIT: { limit: async (o) => { keys.push(o.key); return { success: true }; } } });
  assert.deepEqual(keys, ['bot'], 'the bot is limited by its token, not by its server IP');
  let last = 0;
  for (let i = 0; i < 301; i++) last = (await handle(req(ETH_V2, { ip: '192.0.2.1' }), {})).status;
  assert.equal(last, 429, 'the 301st request in a minute');
  assert.equal((await handle(req(ETH_V2, { ip: '192.0.2.2' }), {})).status, 200, 'another caller is not affected');
});

test('a keyed chain without its key is refused with a clear reason, not sent keyless', async () => {
  const r = await handle(req('https://api.etherscan.io/v2/api?chainid=137&module=account&action=txlist'), {});
  assert.equal(r.status, 503);
  assert.equal(r.headers.get('x-nymra-relay'), 'nokey');
  assert.equal(seen.length, 0);
});

test('the relay itself never logs', async () => {
  const src = await (await import('node:fs/promises')).readFile(new URL('../proxy/proxy.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /console\.|\bdebugger\b/);
  const toml = await (await import('node:fs/promises')).readFile(new URL('../proxy/wrangler.toml', import.meta.url), 'utf8');
  assert.match(toml, /^workers_dev = false$/m);
  assert.match(toml, /^logpush = false$/m);
  assert.match(toml, /\[observability\]\nenabled = false/);
});

test('paths: on each host only what the scan reads, with the method it uses', async () => {
  assert.equal((await handle(req('https://eth.blockscout.com/api/v2/search?q=vitalik'), ENV)).status, 400, 'the handler applies it');
  assert.equal((await handle(req('https://ethereum-rpc.publicnode.com/'), ENV)).status, 405, 'a GET to an RPC');
  assert.equal(seen.length, 0);
  const ok = (m: string, u: string) => assert.equal(targetProblem(m, new URL(u)), null, `${m} ${u}`);
  const no = (m: string, u: string, why: string) => assert.equal(targetProblem(m, new URL(u)), why, `${m} ${u}`);
  const A = '0x1111111111111111111111111111111111111111';
  ok('GET', `https://eth.blockscout.com/api/v2/addresses/${A}`);
  for (const l of ['transactions', 'token-transfers', 'internal-transactions']) ok('GET', `https://base.blockscout.com/api/v2/addresses/${A}/${l}?filter=from`);
  no('GET', 'https://eth.blockscout.com/api/v2/search?q=vitalik', 'path not allowed');
  no('GET', `https://eth.blockscout.com/api/v2/tokens/${A}/holders`, 'path not allowed');
  no('GET', 'https://eth.blockscout.com/api?module=account&action=txlist', 'path not allowed');
  no('POST', `https://eth.blockscout.com/api/v2/addresses/${A}`, 'method not allowed');
  ok('GET', 'https://api.routescan.io/v2/network/mainnet/evm/43114/etherscan/api?module=account&action=tokentx&address=' + A);
  no('GET', 'https://api.routescan.io/v2/network/mainnet/evm/43114/etherscan/api?module=proxy&action=eth_sendRawTransaction', 'path not allowed');
  ok('GET', `https://api.etherscan.io/v2/api?chainid=137&module=account&action=txlist&address=${A}`);
  no('GET', 'https://api.etherscan.io/v2/api?chainid=1&module=contract&action=getsourcecode', 'path not allowed');
  ok('GET', `https://bens.services.blockscout.com/api/v1/1/addresses/${A}`);
  ok('GET', `https://bens.services.blockscout.com/api/v1/1/addresses:lookup?address=${A}`);
  ok('GET', 'https://bens.services.blockscout.com/api/v1/1/domains/vitalik.eth');
  no('GET', 'https://bens.services.blockscout.com/api/v1/1/domains:lookup?name=x', 'path not allowed');
  ok('POST', 'https://ethereum-rpc.publicnode.com/');
  ok('POST', 'https://bsc-mainnet.nodereal.io/v1/');
  no('GET', 'https://ethereum-rpc.publicnode.com/', 'method not allowed');
  no('GET', 'https://evil.example/', 'host not allowed');
});

test('every request a whole scan makes through the relay is one the relay accepts', async () => {
  const { scan } = await import('../src/index.ts');
  const ME = '0x2222222222222222222222222222222222222222';
  const refused: string[] = [];
  // Upstream: an active wallet on Ethereum (a funding, a payment, a deposit) and ENS records.
  reply = (url, init) => {
    const u = new URL(url);
    const j = (b: unknown) => new Response(JSON.stringify(b), { headers: { 'content-type': 'application/json' } });
    if (init.method === 'POST') return j(JSON.parse(String(init.body)).map((c: any) => ({ id: c.id, result: c.method === 'eth_getCode' ? '0x' : c.method === 'eth_call' ? '0x' : u.host.startsWith('ethereum') ? '0x2' : '0x0' })));
    if (u.pathname.endsWith('/transactions')) return j({ items: [], next_page_params: null });
    if (/addresses\/0x[0-9a-f]{40}$/.test(u.pathname) && u.host.includes('blockscout.com') && !u.host.startsWith('bens')) return j({ is_contract: false, ens_domain_name: 'someone.eth' });
    if (u.pathname.includes('/domains/')) return j({ id: '0x' + 'ab'.repeat(32), resolver_address: { hash: '0x' + 'cd'.repeat(20) } });
    return j({ items: [], next_page_params: null });
  };
  const through = (async (input: any, init: RequestInit = {}) => {
    const url = String(input);
    const headers = new Headers(init.headers);
    headers.set('origin', SITE);
    const res = await handle(new Request(url, { ...init, headers }), ENV);
    if (res.status === 400 || res.status === 405 || res.status === 403) refused.push(`${res.status} ${decodeURIComponent(url.split('?u=')[1] ?? url)}`);
    return res;
  }) as typeof fetch;
  const r = await scan(ME, { chainIds: [1, 8453, 43114, 56, 137], proxy: 'https://nymra.si/p', relay: 'https://nymra.si/p', fetch: through, cache: false });
  assert.deepEqual(refused, [], 'nothing the scan sends is refused');
  assert.ok(seen.length > 5, 'the scan went through the relay');
  assert.equal(r.identity.ens, 'someone.eth');
});

test('a POST without Content-Length (chunked) is cut off at MAX_BODY, never read whole into memory', async () => {
  let pulled = 0;
  const chunk = new TextEncoder().encode('a'.repeat(1024));
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      if (++pulled > 1024) return c.close(); // 1 MB in all
      c.enqueue(chunk);
    },
  });
  const r = new Request(`${SITE}/p?u=${enc('https://ethereum-rpc.publicnode.com/')}`, { method: 'POST', body, headers: { origin: SITE, 'cf-connecting-ip': '203.0.113.9' }, duplex: 'half' } as RequestInit);
  assert.equal(r.headers.get('content-length'), null);
  const res = await handle(r, ENV);
  assert.equal(res.status, 413);
  assert.ok(pulled < 16, `read ${pulled} KB of a 1 MB body`);
  assert.equal(seen.length, 0);
});
