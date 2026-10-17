// The HTTP layer on its own: pacing, retries, the bot wall, the budget, the session cache. No network,
// no real waiting: sleeps are recorded, jitter is fixed.
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { clearSessionCache, createHttp, HttpError, resetHostState, waitFromHeaders, type HttpOptions } from '../src/sources/http.ts';

beforeEach(() => { clearSessionCache(); resetHostState(); });

type Reply = { status?: number; body?: string; headers?: Record<string, string> };
const ok = (body: unknown, headers: Record<string, string> = {}): Reply => ({ body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } });

/** A fetch that answers from a script, one reply per call (the last one repeats). */
function scripted(replies: Reply[], log: string[] = []) {
  let i = 0;
  return (async (input: string | URL) => {
    log.push(String(input));
    const r = replies[Math.min(i++, replies.length - 1)];
    return new Response(r.body ?? '', { status: r.status ?? 200, headers: r.headers ?? {} });
  }) as typeof fetch;
}

function rig(o: Partial<HttpOptions> & { replies: Reply[] }) {
  const log: string[] = [];
  const slept: number[] = [];
  const http = createHttp({
    cache: null, random: () => 0.5, sleep: async (ms) => { slept.push(ms); },
    ...o, fetch: o.fetch ?? scripted(o.replies, log),
  });
  return { http, log, slept };
}

test('a 429 waits for x-ratelimit-reset (ms) and then succeeds', async () => {
  const { http, log, slept } = rig({ replies: [{ status: 429, headers: { 'x-ratelimit-reset': '30000', 'x-ratelimit-remaining': '0' } }, ok({ a: 1 })] });
  assert.deepEqual(await http.getJson('https://eth.blockscout.com/api/v2/x'), { a: 1 });
  assert.equal(log.length, 2);
  assert.equal(slept[0], 30000 + 250, 'the reset plus half of the 500 ms jitter');
  assert.equal(http.waitedMs, 30250);
});

test('Retry-After in seconds wins over x-ratelimit-reset', () => {
  assert.equal(waitFromHeaders(new Headers({ 'retry-after': '7', 'x-ratelimit-reset': '30000' })), 7000);
  assert.equal(waitFromHeaders(new Headers({ 'x-ratelimit-reset': '1200' })), 1200);
  const at = Date.now() + 5000;
  const w = waitFromHeaders(new Headers({ 'retry-after': new Date(at).toUTCString() }), at - 5000)!;
  assert.ok(w > 3000 && w <= 5000, `HTTP date form gives ${w}`);
  assert.equal(waitFromHeaders(new Headers({})), undefined);
});

test('a window longer than the longest wait is not waited out: rate_limit at once', async () => {
  const { http, log, slept } = rig({ maxWaitMs: 65000, replies: [{ status: 429, headers: { 'x-ratelimit-reset': '3000000' } }] });
  await assert.rejects(http.getJson('https://eth.blockscout.com/a'), (e: any) => e instanceof HttpError && e.kind === 'rate_limit');
  assert.equal(log.length, 1);
  assert.equal(slept.length, 0);
});

test('pacing: with the quota nearly spent, the next request waits for the window instead of hitting 429', async () => {
  const { http, log, slept } = rig({ replies: [ok({ n: 1 }, { 'x-ratelimit-remaining': '2', 'x-ratelimit-reset': '20000' }), ok({ n: 2 }, { 'x-ratelimit-remaining': '179', 'x-ratelimit-reset': '60000' })] });
  await http.getJson('https://eth.blockscout.com/a');
  await http.getJson('https://eth.blockscout.com/b');
  assert.equal(log.length, 2);
  assert.equal(slept.length, 1);
  assert.ok(slept[0] > 19000 && slept[0] <= 20200, `waited ${slept[0]} ms`);
  assert.equal(http.remaining, 2, 'lowest headroom seen');
});

test('a quota on one host does not slow another host', async () => {
  const { http, slept } = rig({ replies: [ok({}, { 'x-ratelimit-remaining': '1', 'x-ratelimit-reset': '20000' }), ok({})] });
  await http.getJson('https://eth.blockscout.com/a');
  await http.getJson('https://base.blockscout.com/a');
  assert.equal(slept.length, 0);
});

test('5xx, timeouts and network errors are retried with exponential backoff and jitter', async () => {
  const { http, log, slept } = rig({ replies: [{ status: 502 }, { status: 503, body: '{}' }, ok({ fine: true })] });
  assert.deepEqual(await http.getJson('https://x.example/a'), { fine: true });
  assert.equal(log.length, 3);
  assert.deepEqual(slept, [200, 400], 'random 0.5 x 400 x 2^attempt');
  let calls = 0;
  const flaky = createHttp({ cache: null, random: () => 0.5, sleep: async () => {}, fetch: (async () => { if (++calls < 3) throw new TypeError('fetch failed'); return new Response('{"ok":1}'); }) as any });
  assert.deepEqual(await flaky.getJson('https://x.example/b'), { ok: 1 });
  assert.equal(calls, 3);
});

test('404 and other 4xx are final: no retry', async () => {
  const { http, log } = rig({ replies: [{ status: 404, body: '{}' }] });
  await assert.rejects(http.getJson('https://x.example/a'), (e: any) => e.kind === 'not_found');
  assert.equal(log.length, 1);
  const b = rig({ replies: [{ status: 400, body: '{}' }] });
  await assert.rejects(b.http.getJson('https://x.example/a'), (e: any) => e.kind === 'http' && e.status === 400);
  assert.equal(b.log.length, 1);
});

test('a bot wall (403 with "Just a moment...", or HTML instead of JSON) is `blocked`, not retried', async () => {
  const wall = { status: 403, body: '<!DOCTYPE html><html><head><title>Just a moment...</title></head></html>', headers: { 'content-type': 'text/html' } };
  const a = rig({ replies: [wall] });
  await assert.rejects(a.http.getJson('https://base.blockscout.com/api/v2/x'), (e: any) => e.kind === 'blocked');
  assert.equal(a.log.length, 1);
  const b = rig({ replies: [{ status: 200, body: '<html><body>Attention Required</body></html>', headers: { 'content-type': 'text/html' } }] });
  await assert.rejects(b.http.getJson('https://base.blockscout.com/api/v2/x'), (e: any) => e.kind === 'blocked');
  const c = rig({ replies: [{ status: 403, body: '{"message":"forbidden"}', headers: { 'content-type': 'application/json' } }] });
  await assert.rejects(c.http.getJson('https://x.example/a'), (e: any) => e.kind === 'http' && e.status === 403, 'a JSON 403 is an API answer, not a wall');
});

test('fallback proxy: taken after a bot wall, and after a 429 whose window is longer than 10 s', async () => {
  const wall = { status: 403, body: '<html>Just a moment...</html>', headers: { 'content-type': 'text/html' } };
  const log: string[] = [];
  const f = (async (input: string | URL) => {
    const u = String(input);
    log.push(u);
    if (u.startsWith('https://proxy.test/')) return new Response('{"via":"proxy"}');
    if (u.includes('/wall')) return new Response(wall.body, { status: 403, headers: wall.headers });
    return new Response('{}', { status: 429, headers: { 'x-ratelimit-reset': '40000' } });
  }) as typeof fetch;
  const slept: number[] = [];
  const http = createHttp({ cache: null, fetch: f, fallbackProxy: 'https://proxy.test/p', random: () => 0.5, sleep: async (ms) => { slept.push(ms); } });
  assert.deepEqual(await http.getJson('https://base.blockscout.com/wall'), { via: 'proxy' });
  assert.deepEqual(await http.getJson('https://eth.blockscout.com/limited'), { via: 'proxy' });
  assert.equal(slept.length, 0, 'a 40 s window is not waited out when a proxy can answer now');
  assert.equal(log.filter((u) => u.startsWith('https://proxy.test/p?u=')).length, 2);
  assert.ok(log.some((u) => u === 'https://proxy.test/p?u=' + encodeURIComponent('https://base.blockscout.com/wall')));
});

test('an Etherscan-style "Max rate limit reached" body is a rate limit and is retried', async () => {
  const { http, log } = rig({ replies: [ok({ status: '0', message: 'NOTOK', result: 'Max rate limit reached' }), ok({ status: '1', message: 'OK', result: [] })] });
  assert.deepEqual((await http.getJson('https://api.routescan.io/x')).result, []);
  assert.equal(log.length, 2);
});

test('request budget: the scan stops asking once it is spent', async () => {
  const { http, log } = rig({ budget: 2, replies: [ok({})] });
  await http.getJson('https://x.example/1');
  await http.getJson('https://x.example/2');
  await assert.rejects(http.getJson('https://x.example/3'), (e: any) => e.kind === 'budget');
  assert.equal(log.length, 2);
  assert.equal(http.budgetLeft(), 0);
});

test('session cache: the same request in the same page is answered from memory, and errors are not cached', async () => {
  const log: string[] = [];
  const f = scripted([ok({ n: 1 }), { status: 500 }, ok({ n: 2 })], log);
  const a = createHttp({ fetch: f, sleep: async () => {}, random: () => 0 });
  const b = createHttp({ fetch: f, sleep: async () => {}, random: () => 0 });
  assert.deepEqual(await a.getJson('https://x.example/same'), { n: 1 });
  assert.deepEqual(await b.getJson('https://x.example/same'), { n: 1 }, 'a second scan reads the same answer');
  assert.equal(log.length, 1);
  assert.equal(b.cached, 1);
  assert.equal(b.count, 0);
  const one = await a.getJson('https://x.example/other');
  assert.deepEqual(one, { n: 2 }, 'the 500 was retried, not cached');
  const rpc = createHttp({ fetch: scripted([ok([{ id: 1, error: { code: -32005, message: 'limit' } }]), ok([{ id: 1, result: '0x1' }])], log), sleep: async () => {} });
  const init = { method: 'POST', body: '[{"id":1}]' };
  await rpc.getJson('https://rpc.example/', init);
  assert.deepEqual(await rpc.getJson('https://rpc.example/', init), [{ id: 1, result: '0x1' }], 'a JSON-RPC error answer is not cached');
});

test('identical requests in flight at the same time share one fetch', async () => {
  let calls = 0;
  const f = (async () => { calls++; await new Promise((r) => setTimeout(r, 5)); return new Response('{"x":1}'); }) as any;
  const http = createHttp({ fetch: f, cache: null });
  const [a, b] = await Promise.all([http.getJson('https://x.example/s'), http.getJson('https://x.example/s')]);
  assert.deepEqual(a, b);
  assert.equal(calls, 1);
});

test('at most perHost requests run at once on one host', async () => {
  let now = 0, peak = 0;
  const f = (async () => { now++; peak = Math.max(peak, now); await new Promise((r) => setTimeout(r, 5)); now--; return new Response('{}'); }) as any;
  const http = createHttp({ fetch: f, cache: null, perHost: 2 });
  await Promise.all(Array.from({ length: 8 }, (_, i) => http.getJson(`https://eth.blockscout.com/${i}`)));
  assert.equal(peak, 2);
});

test('an aborted scan stops at once', async () => {
  const ac = new AbortController();
  ac.abort();
  const http = createHttp({ fetch: scripted([ok({})]), cache: null, signal: ac.signal });
  await assert.rejects(http.getJson('https://x.example/a'), (e: any) => e.kind === 'aborted');
});

// ---------- a relay that cannot serve this page, and a source paced by the second ----------

/** The site's relay on a host it does not serve (nymra.pages.dev: the site's function answers 403). */
const REFUSES = (u: string) => u.startsWith('https://site.test/p') ? new Response('{"error":"the relay answers on nymra.si only"}', { status: 403, headers: { 'content-type': 'application/json' } }) : null;

test('a relay that refuses this page is no fallback: the direct road waits out its 30 s window after all, and the relay is not asked again', async () => {
  const log: string[] = [];
  let direct = 0;
  const f = (async (input: string | URL) => {
    const u = String(input);
    log.push(u);
    const r = REFUSES(u);
    if (r) return r;
    return ++direct % 2 === 1
      ? new Response('{}', { status: 429, headers: { 'x-ratelimit-reset': '30000', 'x-ratelimit-remaining': '0' } })
      : new Response('{"items":[]}', { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const slept: number[] = [];
  const http = createHttp({ cache: null, fetch: f, fallbackProxy: 'https://site.test/p', random: () => 0.5, sleep: async (ms) => { slept.push(ms); } });
  assert.deepEqual(await http.getJson('https://base.blockscout.com/api/v2/a'), { items: [] }, 'a 429 on the first try is read in the end, never a failed chain');
  assert.ok(slept.some((ms) => ms >= 30000), 'the window was waited out on the direct road');
  assert.deepEqual(await http.getJson('https://polygon.blockscout.com/api/v2/b'), { items: [] });
  assert.equal(log.filter((u) => u.startsWith('https://site.test/p')).length, 1, 'the refusing relay was asked once');
});

test('a keyed source with a relay that refuses this page: needs_key (skipped, like a relay without the key), and the relay is asked once', async () => {
  const log: string[] = [];
  const f = (async (input: string | URL) => { const u = String(input); log.push(u); return REFUSES(u) ?? new Response('{}'); }) as typeof fetch;
  const http = createHttp({ cache: null, fetch: f, relay: 'https://site.test/p', sleep: async () => {} });
  const keyed = () => http.getJson('https://bsc-mainnet.nodereal.io/v1/', { method: 'POST', body: '{"id":1}' }, { via: 'relay' });
  await assert.rejects(keyed(), (e: any) => e instanceof HttpError && e.kind === 'needs_key');
  await assert.rejects(keyed(), (e: any) => e instanceof HttpError && e.kind === 'needs_key');
  assert.equal(log.length, 1);
});

test('a site without a relay (its own 404 page at /p) is no relay, never an empty answer', async () => {
  let direct = 0;
  const f = (async (input: string | URL) => {
    const u = String(input);
    if (u.startsWith('https://site.test/p')) return new Response('<!doctype html><title>Not found</title>', { status: 404, headers: { 'content-type': 'text/html' } });
    return ++direct === 1 ? new Response('{}', { status: 429, headers: { 'x-ratelimit-reset': '20000' } }) : new Response('{"items":[1]}', { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const http = createHttp({ cache: null, fetch: f, fallbackProxy: 'https://site.test/p', random: () => 0.5, sleep: async () => {} });
  assert.deepEqual(await http.getJson('https://base.blockscout.com/api/v2/c'), { items: [1] });
});

test('a source paced at one request per 5 s (Etherscan V2 without a key) waits its turn instead of running into its limit', async () => {
  const { http, log, slept } = rig({ replies: [ok({ status: '1', message: 'OK', result: [] })] });
  await Promise.all([1, 2, 3].map((i) => http.getJson(`https://api.etherscan.io/v2/api?i=${i}`, undefined, { minGapMs: 5000 })));
  assert.equal(log.length, 3);
  const waits = [...slept].sort((a, b) => a - b);
  assert.equal(waits.length, 2, `two requests waited: ${JSON.stringify(slept)}`);
  assert.ok(Math.abs(waits[0] - 5000) < 200 && Math.abs(waits[1] - 10000) < 200, `turns at 5 s and 10 s: ${JSON.stringify(waits)}`);
});

test("Etherscan's keyless rate-limit answer waits a whole turn of the source, not a short backoff", async () => {
  const { http, log, slept } = rig({ replies: [ok({ status: '0', message: 'NOTOK', result: 'Max calls per sec rate limit reached (1/5sec)' }), ok({ status: '1', message: 'OK', result: [] })] });
  assert.deepEqual((await http.getJson('https://api.etherscan.io/v2/api?x=1', undefined, { minGapMs: 5000 })).result, []);
  assert.equal(log.length, 2);
  assert.ok(Math.max(...slept) >= 5000, `waited ${JSON.stringify(slept)}`);
});

test("Etherscan without a key refuses part of its calls with 'Missing/Invalid API Key' (Linea, measured 2026-10-17: about half): on a paced keyless source that is a refusal of the moment, tried again a turn later", async () => {
  const no = ok({ status: '0', message: 'NOTOK', result: 'Missing/Invalid API Key' });
  const yes = ok({ status: '1', message: 'OK-Missing/Invalid API Key, rate limit of 1/5sec applied', result: [{ hash: '0x1' }] });
  const { http, log, slept } = rig({ replies: [no, no, no, yes] });
  assert.equal((await http.getJson('https://api.etherscan.io/v2/api?q=1', undefined, { minGapMs: 5000, retries: 6 })).result.length, 1);
  assert.equal(log.length, 4);
  assert.ok(slept.filter((ms) => ms >= 5000).length >= 3, `each new try waits a turn: ${JSON.stringify(slept)}`);
  // Without pacing (a keyed source through the relay), the same answer is final: a key really is missing.
  const keyed = rig({ replies: [no, yes] });
  assert.equal((await keyed.http.getJson('https://api.etherscan.io/v2/api?q=2')).status, '0');
  assert.equal(keyed.log.length, 1);
});
