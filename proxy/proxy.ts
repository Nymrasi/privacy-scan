// The scan's relay. One fetch handler for two hosts: a Cloudflare Pages Function (the website mounts
// it at /p) or a standalone Worker (proxy/worker.ts + proxy/wrangler.toml).
//
//   GET  /p?u=<encoded https URL>    an explorer read
//   POST /p?u=<encoded https URL>    a JSON-RPC call (nonce and balance, ENS text records, BNB history)
//
// The scan calls it only when the direct road refused (rate limit or bot check), for the chains that
// need a key (BNB Smart Chain), and on a server for Base and Polygon through Alchemy (`keyedAlts`).
// Rules, each one tested in test/proxy.test.ts and test/alchemy.test.ts:
// - Logs nothing: no URL, no address, no IP. Never add a console call: the address is in every URL.
// - No CORS: the site calls /p on its own origin, so no other website can read an answer. Callers:
//   a page of our own site calling its own /p (Origin equal to the relay's own origin, or no Origin
//   and Sec-Fetch-Site: same-origin), on our hosts only (nymra.si, www, the Pages previews of project
//   `nymra`); or a server that sends `Authorization: Bearer <BOT_TOKEN>` (the Telegram bot).
// - Targets: only the hosts of the chain register, BENS, the ENS RPC and the keyed APIs, and on each
//   host only what the scan reads: GET of an address and its three lists on an explorer, GET of an
//   account list on an Etherscan-style API, GET of an address or a name on BENS, POST on an RPC, and
//   POST of the transfer list (`alchemy_getAssetTransfers`, nothing else) on /v2/ of an Alchemy host.
// - Keys are secrets of the deployment: BLOCKSCOUT_PRO_KEY (sent as a Bearer header),
//   ETHERSCAN_API_KEY (query: Etherscan has no header form), NODEREAL_API_KEY and ALCHEMY_API_KEY
//   (path). Every key is cut out of every answer before it goes back, in case an upstream echoes its URL.
// - Daily quota: PRO answers carry `x-credits-remaining`; below MIN_CREDITS the relay stops spending
//   it and answers 503 with `x-nymra-relay: quota`, so the scan says so instead of hiding it.
// - JSON-RPC: only the read calls the scan sends (nonce, balance, code, an ENS text record, the BNB
//   history; on an Alchemy host only the transfer list), at most 16 calls per batch, at most 4 KB.
// - Per caller: the RATE_LIMIT binding when there is one, else a limiter in memory; plus the WAF rule
//   in proxy/README.md. Every upstream call has a 15 s timeout. A bot check upstream comes back as
//   JSON 503, never as its HTML page, and so does a redirect: the relay follows none.
import { CHAINS } from '../src/chains.ts';
import { ENS_RPC, XNS_REGISTRY } from '../src/sources/identity.ts';

export interface RateLimiter { limit(o: { key: string }): Promise<{ success: boolean }> }

export interface ProxyEnv {
  BLOCKSCOUT_PRO_KEY?: string;
  ETHERSCAN_API_KEY?: string;
  NODEREAL_API_KEY?: string;
  /** Alchemy (Base and Polygon PoS on a server): one app with those two networks on. */
  ALCHEMY_API_KEY?: string;
  /** Shared secret of server callers (the Telegram bot). */
  BOT_TOKEN?: string;
  /** Extra allowed origins, comma separated (e.g. a staging domain). */
  ALLOWED_ORIGINS?: string;
  /** "1": also allow http://localhost:<port> and http://127.0.0.1:<port> (local preview only). */
  ALLOW_LOCALHOST?: string;
  /** Workers rate limiting binding (proxy/wrangler.toml). */
  RATE_LIMIT?: RateLimiter;
}

/** Below this many PRO credits left today, the relay stops using the key (about 250 calls of headroom). */
export const MIN_CREDITS = 5000;
const UPSTREAM_TIMEOUT_MS = 15_000;
/** Largest JSON-RPC body: the biggest the scan sends is the ENS records batch, 3,931 bytes. */
export const MAX_BODY = 4096;
const MAX_BATCH = 16;
/** JSON-RPC methods the scan sends. Anything else is refused. */
export const RPC_METHODS = new Set(['eth_getTransactionCount', 'eth_getBalance', 'eth_getCode', 'eth_call', 'nr_getTransactionByAddress']);
/** The one call an Alchemy host gets, and no other host: the key pays for nothing else. */
export const ALCHEMY_METHOD = 'alchemy_getAssetTransfers';
/** The contract calls the scan makes: an ENS resolver's text(bytes32,string), and getName(address) on the XNS registry. */
const ENS_TEXT = '0x59d1d43c';
const XNS_NAME = '0x5fd4b08a';
/** Fallback limiter (when no binding): requests per minute per caller, per isolate. */
const MEM_LIMIT = 300;

/** Blockscout PRO API chains (github.com/blockscout/backend-configs, pro-api/prod/chains-config.json, 2026-10-16). */
const PRO_CHAINS = new Set([1, 8453, 42161, 10, 137, 4663, 324, 534352, 130, 100, 57073, 1868, 42220, 480, 34443, 42170, 4326, 1135, 360, 13371, 30, 2020, 592, 747, 314]);
export const ETHERSCAN_HOST = 'api.etherscan.io';
export const NODEREAL_HOST = 'bsc-mainnet.nodereal.io';

/** What kind of road each allowed host is, and so which requests it may get. */
type Road = 'explorer' | 'account-api' | 'bens' | 'rpc' | 'alchemy';
const BLOCKSCOUT = new Map<string, number>();
const ROADS = new Map<string, Road>([['bens.services.blockscout.com', 'bens'], [new URL(ENS_RPC).host, 'rpc'], [ETHERSCAN_HOST, 'account-api'], [NODEREAL_HOST, 'rpc']]);
for (const c of CHAINS) {
  // A retired chain is read on no road: its hosts are not targets (a host it shares, Routescan's, stays for the others).
  if (c.retired) continue;
  for (const src of [c.source, ...(c.alt ? [c.alt] : []), ...(c.keyedAlt ? [c.keyedAlt] : [])]) {
    const h = new URL(src.api).host;
    if (src.kind === 'blockscout') { ROADS.set(h, 'explorer'); BLOCKSCOUT.set(h, c.id); }
    else if (src.kind === 'nodereal') ROADS.set(h, 'rpc');
    else if (src.kind === 'alchemy') ROADS.set(h, 'alchemy');
    else ROADS.set(h, 'account-api');
  }
  if (c.rpc) ROADS.set(new URL(c.rpc).host, 'rpc');
}
const ALLOWED = new Set(ROADS.keys());

const ADDR = '0x[0-9a-fA-F]{40}';
const EXPLORER_PATH = new RegExp(`^/api/v2/addresses/${ADDR}(/(transactions|token-transfers|internal-transactions))?$`);
const BENS_PATH = new RegExp(`^/api/v1/1/(addresses/${ADDR}|addresses:lookup|domains/[^/]{1,300})$`);
const ACCOUNT_ACTIONS = new Set(['txlist', 'txlistinternal', 'tokentx']);

/** Whether this request is one the scan makes to this host. Returns an error text or null. */
export function targetProblem(method: string, target: URL): string | null {
  const road = ROADS.get(target.host);
  if (!road) return 'host not allowed';
  if (road === 'rpc') return method === 'POST' ? null : 'method not allowed';
  if (road === 'alchemy') return method !== 'POST' ? 'method not allowed' : target.pathname === '/v2/' && !target.search ? null : 'path not allowed';
  if (method !== 'GET') return 'method not allowed';
  if (road === 'explorer') return EXPLORER_PATH.test(target.pathname) ? null : 'path not allowed';
  if (road === 'bens') return BENS_PATH.test(target.pathname) ? null : 'path not allowed';
  const q = target.searchParams;
  return q.get('module') === 'account' && ACCOUNT_ACTIONS.has(q.get('action') ?? '') ? null : 'path not allowed';
}

const ORIGINS = ['https://nymra.si', 'https://www.nymra.si'];
const PREVIEW = /^https:\/\/[a-z0-9-]+\.nymra\.pages\.dev$/;
const LOCAL = /^http:\/\/(localhost|127\.0\.0\.1):\d{2,5}$/;

export function originAllowed(origin: string | null, env: ProxyEnv): boolean {
  if (!origin) return false;
  if (ORIGINS.includes(origin) || origin === 'https://nymra.pages.dev' || PREVIEW.test(origin)) return true;
  if ((env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean).includes(origin)) return true;
  return env.ALLOW_LOCALHOST === '1' && LOCAL.test(origin);
}

/** Constant-time comparison, so the bot token cannot be guessed byte by byte from timing. */
function same(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/** A target request: the URL to fetch and the headers that carry a key. */
export interface Upstream { url: URL; headers: Record<string, string>; keyed: 'pro' | 'etherscan' | 'nodereal' | 'alchemy' | null }

/** Where a request really goes. Keys go in a header where the API allows it. */
export function rewrite(target: URL, env: ProxyEnv): Upstream {
  const id = BLOCKSCOUT.get(target.host);
  if (env.BLOCKSCOUT_PRO_KEY && id !== undefined && PRO_CHAINS.has(id) && target.pathname.startsWith('/api/v2/')) {
    return { url: new URL(`https://api.blockscout.com/${id}${target.pathname}${target.search}`), headers: { authorization: `Bearer ${env.BLOCKSCOUT_PRO_KEY}` }, keyed: 'pro' };
  }
  if (target.host === ETHERSCAN_HOST && env.ETHERSCAN_API_KEY) {
    const u = new URL(target.href);
    u.searchParams.set('apikey', env.ETHERSCAN_API_KEY);
    return { url: u, headers: {}, keyed: 'etherscan' };
  }
  if (target.host === NODEREAL_HOST && env.NODEREAL_API_KEY) {
    return { url: new URL(`https://${NODEREAL_HOST}/v1/${encodeURIComponent(env.NODEREAL_API_KEY)}`), headers: {}, keyed: 'nodereal' };
  }
  if (ROADS.get(target.host) === 'alchemy' && env.ALCHEMY_API_KEY) {
    return { url: new URL(`https://${target.host}/v2/${encodeURIComponent(env.ALCHEMY_API_KEY)}`), headers: {}, keyed: 'alchemy' };
  }
  return { url: target, headers: {}, keyed: null };
}

/** Removes every key, also URL-encoded, from a text that goes back to the caller. */
export function scrub(text: string, env: ProxyEnv): string {
  let out = text;
  for (const k of [env.BLOCKSCOUT_PRO_KEY, env.ETHERSCAN_API_KEY, env.NODEREAL_API_KEY, env.ALCHEMY_API_KEY, env.BOT_TOKEN]) {
    if (!k || k.length < 4) continue;
    for (const form of new Set([k, encodeURIComponent(k)])) out = out.split(form).join('[redacted]');
  }
  return out;
}

/** JSON-RPC body check: allowed methods only (`alchemy`: the transfer list only), a bounded batch. Returns an error text or null. */
export function rpcProblem(body: string, alchemy = false): string | null {
  if (new TextEncoder().encode(body).length > MAX_BODY) return 'body too large';
  let j: unknown;
  try { j = JSON.parse(body); } catch { return 'not JSON'; }
  const calls = Array.isArray(j) ? j : [j];
  if (calls.length === 0 || calls.length > MAX_BATCH) return 'batch size';
  for (const c of calls) {
    const m = (c as any)?.method;
    if (alchemy !== (m === ALCHEMY_METHOD)) return 'method not allowed';
    if (alchemy) continue;
    if (typeof m !== 'string' || !RPC_METHODS.has(m)) return 'method not allowed';
    const data = (c as any)?.params?.[0]?.data;
    const to = String((c as any)?.params?.[0]?.to ?? '').toLowerCase();
    const xns = to === XNS_REGISTRY && typeof data === 'string' && data.length === 74 && data.toLowerCase().startsWith(XNS_NAME);
    if (m === 'eth_call' && !xns && (typeof data !== 'string' || !data.toLowerCase().startsWith(ENS_TEXT))) return 'call not allowed';
  }
  return null;
}

// Quota state, per isolate: the lowest `x-credits-remaining` seen and when it was read.
let credits: { left: number; at: number } | null = null;
const creditsLow = () => credits !== null && credits.left < MIN_CREDITS && Date.now() - credits.at < 3_600_000;
/** Test hook. */
export function resetRelayState() { credits = null; memHits.clear(); }

const memHits = new Map<string, { n: number; since: number }>();
function memLimit(key: string): boolean {
  const now = Date.now();
  const e = memHits.get(key);
  if (!e || now - e.since > 60_000) { memHits.set(key, { n: 1, since: now }); return true; }
  e.n++;
  if (memHits.size > 5000) memHits.clear();
  return e.n <= MEM_LIMIT;
}

function json(status: number, body: unknown, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...headers, 'content-type': 'application/json', 'cache-control': 'no-store' } });
}

/**
 * The body as text, or null once it passes `max` bytes. A chunked POST carries no Content-Length, and
 * req.text() would read all of it into the isolate's memory before the size check.
 */
async function textUpTo(req: Request, max: number): Promise<string | null> {
  if (!req.body) return '';
  const reader = req.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    parts.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const p of parts) { all.set(p, at); at += p.byteLength; }
  return new TextDecoder().decode(all);
}

export async function handle(req: Request, env: ProxyEnv = {}): Promise<Response> {
  const origin = req.headers.get('origin');
  const auth = req.headers.get('authorization') ?? '';
  const isBot = !!env.BOT_TOKEN && auth.startsWith('Bearer ') && same(auth.slice(7), env.BOT_TOKEN);
  // Our own page calling its own /p. A same-origin GET carries no Origin header (Fetch standard): the
  // browser marks it with Sec-Fetch-Site instead, which a page cannot forge. A POST carries Origin.
  const own = new URL(req.url).origin;
  const browserOk = originAllowed(own, env) && (origin === own || (!origin && req.headers.get('sec-fetch-site') === 'same-origin'));
  // No CORS headers, ever: a preflight means another website is asking, and it gets nothing.

  if (req.method === 'OPTIONS') return new Response(null, { status: 405, headers: { allow: 'GET, POST' } });
  if (!browserOk && !isBot) return json(403, { error: 'origin not allowed' }, {});
  if (req.method !== 'GET' && req.method !== 'POST') return json(405, { error: 'method not allowed' }, {});

  // Per caller: the bot by its token, a browser by its IP.
  const who = isBot ? 'bot' : (req.headers.get('cf-connecting-ip') ?? 'unknown');
  const allowed = env.RATE_LIMIT ? (await env.RATE_LIMIT.limit({ key: who })).success : memLimit(who);
  if (!allowed) return json(429, { error: 'too many requests' }, { 'retry-after': '10', 'x-nymra-relay': 'rate' });

  let target: URL;
  try { target = new URL(new URL(req.url).searchParams.get('u') ?? ''); } catch { return json(400, { error: 'bad url' }, {}); }
  if (target.protocol !== 'https:' || !ALLOWED.has(target.host) || target.username || target.password) return json(400, { error: 'host not allowed' }, {});
  const bad = targetProblem(req.method, target);
  if (bad) return json(bad === 'method not allowed' ? 405 : 400, { error: bad }, {});

  let body: string | undefined;
  if (req.method === 'POST') {
    const len = Number(req.headers.get('content-length') ?? '0');
    if (len > MAX_BODY) return json(413, { error: 'body too large' }, {});
    const text = await textUpTo(req, MAX_BODY);
    if (text === null) return json(413, { error: 'body too large' }, {});
    body = text;
    const problem = rpcProblem(body, ROADS.get(target.host) === 'alchemy');
    if (problem) return json(400, { error: problem }, {});
  }

  const up = rewrite(target, env);
  if (up.keyed === 'pro' && creditsLow()) {
    return json(503, { error: 'quota', message: 'The relay has spent its daily quota. It resets at 00:00 UTC.' }, { 'x-nymra-relay': 'quota' });
  }
  if ((target.host === ETHERSCAN_HOST || target.host === NODEREAL_HOST || ROADS.get(target.host) === 'alchemy') && !up.keyed) {
    return json(503, { error: 'not configured', message: 'This chain needs an API key that the relay does not have.' }, { 'x-nymra-relay': 'nokey' });
  }

  let res: Response;
  try {
    res = await fetch(up.url, {
      method: req.method,
      headers: { accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...up.headers },
      body,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      // Cloudflare's runtime throws on redirect 'error' (Node takes it, so a Node test cannot see that).
      // 'manual' hands the redirect back, and the relay refuses it below: a target never sends a read
      // on to another host.
      redirect: 'manual',
    });
  } catch {
    // The relay's own failures answer 503, never 502 or 504: on a custom domain Cloudflare puts its own
    // error page over those, and the scan would never see the reason.
    return json(503, { error: 'upstream unreachable' }, { 'x-nymra-relay': 'unreachable' });
  }
  if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
    await res.body?.cancel().catch(() => {});
    return json(503, { error: 'upstream redirect' }, { 'x-nymra-relay': 'redirect' });
  }
  if (up.keyed === 'pro') {
    const c = Number(res.headers.get('x-credits-remaining'));
    if (res.headers.get('x-credits-remaining') !== null && Number.isFinite(c)) credits = { left: c, at: Date.now() };
  }
  const text = await res.text().catch(() => '');
  const type = res.headers.get('content-type') ?? '';
  if (/text\/html/i.test(type) || /^\s*</.test(text)) return json(503, { error: 'upstream bot check' }, { 'x-nymra-relay': 'blocked' });
  const pass: Record<string, string> = { 'content-type': 'application/json', 'cache-control': 'no-store' };
  // Only a 429 passes its wait on. The quota counters of one upstream explorer would mislead the scan's
  // pacing of the relay, which fronts many explorers (and the PRO counters describe our key, not the caller).
  if (res.status === 429) {
    const ra = res.headers.get('retry-after');
    const reset = Number(res.headers.get('x-ratelimit-reset'));
    pass['retry-after'] = ra ?? String(Number.isFinite(reset) && reset > 0 ? Math.ceil(reset / 1000) : 5);
  }
  return new Response(scrub(text, env), { status: res.status, headers: pass });
}

export default { fetch: (req: Request, env: ProxyEnv) => handle(req, env) };
