// The scan's HTTP layer. Logs nothing: every URL carries the scanned address.
//
// - Per host: at most `perHost` requests at once, and pacing from the explorer's own headers.
//   Blockscout sends `x-ratelimit-remaining` and `x-ratelimit-reset` (ms) and exposes both to the
//   browser; when a host is nearly out, new requests wait for its window instead of running into 429.
// - Retries: 429, 5xx, timeouts and network errors are retried with exponential backoff and full
//   jitter. A 429 waits for `Retry-After` or `x-ratelimit-reset` when the host sends one.
// - A bot wall (403 with an HTML "Just a moment..." page, or HTML instead of JSON) is `blocked`:
//   it is not retried on the same road; the caller switches source or goes through the fallback proxy.
// - A relay that refuses this page as a caller (it answers on its own domain only, or there is no relay at
//   this address) is no road: a keyed source is skipped as if the relay had no key, and a refused direct
//   read waits out its window after all instead of failing on the relay (2026-10-17: on nymra.pages.dev
//   every scan of a wallet active on BNB Smart Chain or Linea came back without a score).
// - A source with a fixed rate (Etherscan V2 without a key: one request per 5 s) gets its turns spaced.
// - Every scan has a request budget. Answers are cached in memory for the session (10 minutes), so
//   scanning the same wallet again in the same page costs no requests and reads the same data.
// Host state (remaining quota, reset time) is shared by all scans in the page: the quota is per IP.

export interface CallOptions {
  timeoutMs?: number;
  retries?: number;
  /** `relay`: this source needs the relay's API key, so it only goes through `HttpOptions.relay`. */
  via?: 'relay';
  /** Retries after a timeout (default 1): a slow query usually stays slow. */
  timeoutRetries?: number;
  /** At least this long between two requests to this host (a source that allows one request per N s). */
  minGapMs?: number;
}

export type HttpErrorKind = 'rate_limit' | 'blocked' | 'not_found' | 'http' | 'timeout' | 'network' | 'bad_json' | 'budget' | 'aborted'
  /** The relay spent its free daily quota. */
  | 'quota'
  /** The source needs an API key the relay does not have (or there is no relay). */
  | 'needs_key';

export class HttpError extends Error {
  status: number;
  kind: HttpErrorKind;
  constructor(status: number, message: string, kind: HttpErrorKind = 'http') {
    super(message);
    this.status = status;
    this.kind = kind;
  }
}

/** Plain reason for a failed read, for coverage and `incomplete`. Never carries a URL or the address. */
export function reasonOf(e: unknown): string {
  if (!(e instanceof HttpError)) return 'explorer error';
  switch (e.kind) {
    case 'rate_limit': return 'rate limit reached';
    case 'blocked': return 'the explorer asked for a bot check';
    case 'timeout': return 'timed out';
    case 'budget': return 'request budget reached';
    case 'aborted': return 'scan stopped';
    case 'network': return 'explorer unreachable';
    case 'not_found': return 'not found';
    case 'quota': return "the relay's daily quota is spent";
    case 'needs_key': return 'needs an API key in the Nymra relay';
    default: return 'explorer error';
  }
}

/** The direct road refused: the fallback proxy (or a second source) may still answer. */
export const refused = (e: unknown) => e instanceof HttpError && (e.kind === 'rate_limit' || e.kind === 'blocked');

export interface Http {
  getJson(url: string, init?: RequestInit, call?: CallOptions): Promise<any>;
  /** Network requests this scan made (cache hits not counted). */
  count: number;
  /** Answers served from the session cache. */
  cached: number;
  /** Time spent waiting for rate-limit windows, ms. */
  waitedMs: number;
  /** Lowest `x-ratelimit-remaining` an explorer reported during this scan. */
  remaining?: number;
  /** Requests left in this scan's budget. */
  budgetLeft(): number;
  /** Network requests per kind of endpoint (for the relay's credit math in SCHEMA.md). */
  byKind: Record<string, number>;
}

/** The kind of a request, as Blockscout's PRO API prices it. */
export function kindOfUrl(url: string, method = 'GET'): string {
  if (method === 'POST') return 'rpc';
  const p = new URL(url).pathname;
  if (/\/internal-transactions$/.test(p)) return 'internal-transactions';
  if (/\/token-transfers$/.test(p)) return 'token-transfers';
  if (/\/transactions$/.test(p)) return 'transactions';
  if (/\/api\/v2\/addresses\/0x[0-9a-f]{40}$/i.test(p)) return 'address';
  if (p.includes('/bens') || url.includes('bens.services')) return 'ens';
  if (/etherscan\/api$|\/v2\/api$/.test(p)) return 'etherscan';
  return 'other';
}

export interface HttpCache {
  get(key: string): string | undefined;
  set(key: string, text: string): void;
}

export interface HttpOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Every request goes through `${proxy}?u=<url>`. */
  proxy?: string;
  /** Used only when the direct road refuses (rate limit or bot wall): `${fallbackProxy}?u=<url>`. */
  fallbackProxy?: string;
  /** The relay for keyed sources (`via: 'relay'`). Default: fallbackProxy. */
  relay?: string;
  perHost?: number;
  retries?: number;
  /** Most network requests one scan may make. Default 600. */
  budget?: number;
  /** Longest single wait for a rate-limit window, ms. Default 65000. */
  maxWaitMs?: number;
  /** No wait may end after this time (ms since epoch). */
  deadline?: number;
  /** Answer cache. Default: the shared in-memory session cache. `null`: no cache. */
  cache?: HttpCache | null;
  /** Randomness for jitter (tests). Default Math.random. */
  random?: () => number;
  /** Sleep (tests). Default setTimeout. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const sleepReal = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason ?? new Error('aborted')); return; }
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason ?? new Error('aborted')); }, { once: true });
  });

// ---------- session cache: in memory only, never persisted ----------
const CACHE_TTL_MS = 10 * 60_000;
const CACHE_MAX_CHARS = 40_000_000;

class SessionCache implements HttpCache {
  private m = new Map<string, { text: string; at: number }>();
  private chars = 0;
  get(key: string) {
    const e = this.m.get(key);
    if (!e) return undefined;
    if (Date.now() - e.at > CACHE_TTL_MS) { this.drop(key); return undefined; }
    return e.text;
  }
  set(key: string, text: string) {
    this.drop(key);
    this.m.set(key, { text, at: Date.now() });
    this.chars += text.length;
    for (const k of this.m.keys()) {
      if (this.chars <= CACHE_MAX_CHARS) break;
      this.drop(k);
    }
  }
  clear() { this.m.clear(); this.chars = 0; }
  private drop(key: string) {
    const e = this.m.get(key);
    if (e) { this.chars -= e.text.length; this.m.delete(key); }
  }
}

export const sessionCache = new SessionCache();
/** Forget every cached answer (e.g. a "scan again" button that must re-read). */
export function clearSessionCache() { sessionCache.clear(); }

// ---------- host state, shared by every scan in the page ----------
interface HostState { remaining?: number; resetAt?: number; blockedUntil?: number; nextAt?: number }
const HOSTS = new Map<string, HostState>();
/** Below this many requests left, new requests wait for the host's window. */
const RESERVE = 4;
/** Relays that refused this page as a caller, by host, until when (ms since epoch). */
const RELAY_DOWN = new Map<string, number>();
const RELAY_DOWN_MS = 10 * 60_000;
export function resetHostState() { HOSTS.clear(); RELAY_DOWN.clear(); }
const relayDown = (relay: string) => (RELAY_DOWN.get(new URL(relay).host) ?? 0) > Date.now();

/** With a fallback proxy, a direct road waits at most this long for a rate-limit window. */
const FALLBACK_AFTER_MS = 10_000;
const BACKOFF_BASE_MS = 400;
const BACKOFF_CAP_MS = 8000;
/**
 * A limit that every Nymra user shares (a key of the relay, a node's capacity) is waited out for up to
 * this long per request, without spending its own retries: at a launch's peak the calls of every visitor
 * queue for one key, and three retries made BNB Smart Chain a failed chain for whoever came a few seconds
 * too late. 24 scans at once need about 48 BNB calls, 40 s at NodeReal's free 1.2 a second (a peak
 * test). BUSY_TRIES only bounds the calls.
 */
const BUSY_MS = 60_000;
const BUSY_TRIES = 24;
/** A busy turn: half a second plus a random part that widens fast, so the waiting pages spread out. */
const busyWait = (busy: number, random: () => number) => 500 + Math.round(random() * Math.min(BACKOFF_CAP_MS, 1500 * 2 ** busy));

/**
 * A JSON-RPC node that says it is too busy inside its answer, with HTTP 200: NodeReal's MegaNode answers
 * -32005 "Your account has exceeded its Compute Units Per Second capacity" (free plan: 300 a second for
 * every user of the relay's one key together, and one BNB history call costs 250), also inside a batch.
 * Only -32005 with the words of a rate: a node also says -32005 for a query that is too large, which no
 * wait fixes.
 */
export function rpcBusy(text: string): boolean {
  return text.length < 2000 && /"code"\s*:\s*-32005\b/.test(text) && /rate|capacity|per second|too many/i.test(text);
}

/** `Retry-After` in seconds or as an HTTP date, else Blockscout's `x-ratelimit-reset` in ms. */
export function waitFromHeaders(h: Headers, now = Date.now()): number | undefined {
  const ra = h.get('retry-after');
  if (ra) {
    const s = Number(ra);
    if (Number.isFinite(s)) return Math.max(0, s * 1000);
    const d = Date.parse(ra);
    if (Number.isFinite(d)) return Math.max(0, d - now);
  }
  const reset = Number(h.get('x-ratelimit-reset'));
  if (h.get('x-ratelimit-reset') !== null && Number.isFinite(reset)) return Math.max(0, reset);
  return undefined;
}

const looksHtml = (text: string, type: string | null) => /text\/html/i.test(type ?? '') || /^\s*</.test(text);
const challenge = (text: string) => /just a moment|cf-chl|cloudflare|attention required|captcha/i.test(text);
/**
 * The relay itself refused this page, not an answer it passed on: its origin or host check (proxy.ts,
 * or the site's own function), or no relay at all at this address (the site's own 404 page).
 */
function relayRefused(res: Response, text: string): boolean {
  if (res.headers.get('x-nymra-relay') === 'refused') return true;
  if (res.status === 403 && /"error"\s*:\s*"(origin not allowed|the relay answers on [^"]* only)"/.test(text)) return true;
  return res.status === 404 && looksHtml(text, res.headers.get('content-type'));
}

export function createHttp(o: HttpOptions = {}): Http {
  const f = o.fetch ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = o.timeoutMs ?? 12000;
  const perHost = o.perHost ?? 4;
  const retries = o.retries ?? 3;
  const budget = o.budget ?? 600;
  const maxWaitMs = o.maxWaitMs ?? 65000;
  const cache = o.cache === undefined ? sessionCache : o.cache;
  const random = o.random ?? Math.random;
  const sleep = o.sleep ?? sleepReal;
  const active = new Map<string, number>();
  const waiters = new Map<string, (() => void)[]>();
  const inflight = new Map<string, Promise<string>>();

  async function acquire(host: string) {
    while ((active.get(host) ?? 0) >= perHost) {
      await new Promise<void>((r) => { const q = waiters.get(host) ?? []; q.push(r); waiters.set(host, q); });
    }
    active.set(host, (active.get(host) ?? 0) + 1);
  }
  function release(host: string) {
    active.set(host, Math.max(0, (active.get(host) ?? 1) - 1));
    waiters.get(host)?.shift()?.();
  }

  /** Waits `ms` unless that crosses the limits; returns false when the wait is not allowed. */
  async function waitFor(ms: number, most = maxWaitMs): Promise<boolean> {
    if (ms <= 0) return true;
    if (ms > most) return false;
    if (o.deadline !== undefined && Date.now() + ms > o.deadline) return false;
    await sleep(ms, o.signal);
    http.waitedMs += ms;
    return true;
  }

  const backoff = (attempt: number) => Math.round(random() * Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt));

  /**
   * One road (direct or through a proxy) with pacing and retries. Resolves to the response text. `shared`: a keyed
   * source through the relay (BNB Smart Chain's NodeReal), whose one key every visitor shares; only its limit is
   * waited out for long (BUSY_MS). A relay that is itself limited on a fallback read keeps the normal retries, so
   * a scan never sits a minute on a chain that will not open (features-e2e 'half': 16 s, not 88).
   */
  async function road(url: string, init: RequestInit | undefined, proxy: string | undefined, tries: number, tmo: number, most = maxWaitMs, timeoutTries = 1, gapMs = 0, shared = false): Promise<string> {
    const host = proxy ? new URL(proxy).host : new URL(url).host;
    const target = proxy ? `${proxy}?u=${encodeURIComponent(url)}` : url;
    const st = HOSTS.get(host) ?? {};
    HOSTS.set(host, st);
    let last: HttpError | undefined;
    let justWaited = false;
    // Waits for a limit every user shares (BUSY_MS); they give the attempt back, so they never spend a retry.
    let busy = 0;
    let busyMs = 0;
    const busyTurn = async (w: number) => {
      if (busy >= BUSY_TRIES || busyMs + w > BUSY_MS || !(await waitFor(w, most))) return false;
      busy++;
      busyMs += w;
      return true;
    };
    for (let attempt = 0; attempt <= tries; attempt++) {
      if (o.signal?.aborted) throw new HttpError(0, 'scan aborted', 'aborted');
      if (o.deadline !== undefined && Date.now() >= o.deadline) throw new HttpError(0, 'scan time limit reached', 'timeout');
      // Pacing: a known refusal window, or a nearly empty quota, waits for the reset.
      const now = Date.now();
      // A request that just waited out its window goes now: it never waits twice for the same window.
      const until = justWaited ? 0 : Math.max(st.blockedUntil ?? 0, st.remaining !== undefined && st.remaining <= RESERVE ? st.resetAt ?? 0 : 0);
      justWaited = false;
      if (until > now) {
        if (!(await waitFor(until - now + Math.round(random() * 400), most))) throw new HttpError(429, `${host} rate limit reached`, 'rate_limit');
      }
      // A source with a fixed rate: each request takes the next free turn on its host.
      if (gapMs > 0) {
        const at = Math.max(Date.now(), st.nextAt ?? 0);
        st.nextAt = at + gapMs;
        if (!(await waitFor(at - Date.now(), maxWaitMs))) throw new HttpError(429, `${host} rate limit reached`, 'rate_limit');
      }
      if (http.count >= budget) throw new HttpError(0, 'request budget of this scan reached', 'budget');
      await acquire(host);
      let res: Response;
      try {
        http.count++;
        const k = kindOfUrl(url, init?.method);
        http.byKind[k] = (http.byKind[k] ?? 0) + 1;
        if (st.remaining !== undefined) st.remaining--;
        const signals = [AbortSignal.timeout(tmo)];
        if (o.signal) signals.push(o.signal);
        res = await f(target, { ...init, signal: AbortSignal.any(signals), headers: { accept: 'application/json', ...(init?.headers ?? {}) } });
      } catch (e) {
        release(host);
        if (o.signal?.aborted) throw new HttpError(0, 'scan aborted', 'aborted');
        const msg = e instanceof Error ? `${e.name} ${e.message}` : String(e);
        last = /timeout|abort/i.test(msg) ? new HttpError(0, `${host} timed out`, 'timeout') : new HttpError(0, `${host} unreachable`, 'network');
        // A query that timed out is usually slow, not unlucky: one more try, not three.
        const cap = last.kind === 'timeout' ? Math.min(tries, timeoutTries) : tries;
        if (attempt < cap && (await waitFor(backoff(attempt)))) continue;
        throw last;
      }
      let text = '';
      try {
        text = await res.text();
      } catch {
        text = '';
      } finally {
        release(host);
      }
      const left = res.headers.get('x-ratelimit-remaining');
      if (left !== null && Number.isFinite(Number(left))) {
        st.remaining = Number(left);
        const w = waitFromHeaders(res.headers);
        if (w !== undefined) st.resetAt = Date.now() + w;
        if (!proxy) http.remaining = Math.min(http.remaining ?? Infinity, st.remaining);
      }
      // A relay that does not serve this page (nymra.pages.dev, or no relay here) is no road for ten minutes.
      if (proxy && relayRefused(res, text)) {
        RELAY_DOWN.set(host, Date.now() + RELAY_DOWN_MS);
        throw new HttpError(res.status, `${host}: no relay for this page`, 'needs_key');
      }
      // The relay names its own refusals (proxy/proxy.ts).
      const relaySays = proxy ? res.headers.get('x-nymra-relay') ?? (/"error"\s*:\s*"(quota|not configured)"/.exec(text)?.[1] ?? null) : null;
      if (relaySays === 'quota') throw new HttpError(503, `${host}: relay quota spent`, 'quota');
      if (relaySays === 'nokey' || relaySays === 'not configured') throw new HttpError(503, `${host}: relay has no key for this source`, 'needs_key');
      if (res.status === 429) {
        const w = waitFromHeaders(res.headers) ?? backoff(attempt + 2);
        st.blockedUntil = Date.now() + w;
        last = new HttpError(429, `${host} rate limit reached`, 'rate_limit');
        // On a keyed source a 429 through the relay is the key's limit, which every visitor shares: waited out.
        if (shared && (await busyTurn(Math.max(w, busyWait(busy, random))))) { attempt--; justWaited = true; continue; }
        if (attempt < tries && (await waitFor(w + Math.round(random() * 500), most))) { justWaited = true; continue; }
        throw last;
      }
      if (res.status === 403 || ((res.ok || res.status === 503) && looksHtml(text, res.headers.get('content-type')))) {
        if (res.status === 403 && !looksHtml(text, res.headers.get('content-type')) && !challenge(text)) throw new HttpError(403, `HTTP 403 from ${host}`, 'http');
        throw new HttpError(res.status, `${host} answered a bot check instead of data`, 'blocked');
      }
      if (res.status === 404) throw new HttpError(404, `HTTP 404 from ${host}`, 'not_found');
      if (res.status >= 500 || res.status === 408) {
        last = new HttpError(res.status, `HTTP ${res.status} from ${host}`, 'http');
        const w = waitFromHeaders(res.headers) ?? backoff(attempt);
        if (attempt < tries && (await waitFor(Math.min(w, BACKOFF_CAP_MS)))) continue;
        throw last;
      }
      if (!res.ok) throw new HttpError(res.status, `HTTP ${res.status} from ${host}`, 'http');
      // Etherscan-style APIs (Routescan) answer a rate limit with 200 and an error body. Etherscan without
      // a key also refuses part of its calls with "Missing/Invalid API Key" (Linea, measured 2026-10-17: about
      // half, at 6 s and at 11 s apart alike), so on a paced keyless source that is a refusal of the
      // moment: the next turn usually reads.
      const keylessNo = gapMs > 0 && text.length < 300 && /"status"\s*:\s*"0"/.test(text) && /Missing\/Invalid API Key/i.test(text);
      if (text.length < 600 && /"status"\s*:\s*"0"/.test(text) && (/rate limit/i.test(text) || keylessNo)) {
        last = new HttpError(429, `${host} rate limit reached`, 'rate_limit');
        const w = Math.max(gapMs, backoff(attempt + 2) + 1000);
        st.blockedUntil = Date.now() + w;
        if (attempt < tries && (await waitFor(w, most))) { justWaited = true; continue; }
        throw last;
      }
      // A node that is too busy for this second: NodeReal at its capacity is waited out (shared), a public node's
      // own limit on this visitor is retried like a 429.
      if (rpcBusy(text)) {
        last = new HttpError(429, `${host} rate limit reached`, 'rate_limit');
        const w = busyWait(busy, random);
        st.blockedUntil = Date.now() + w;
        if (shared && (await busyTurn(w))) { attempt--; justWaited = true; continue; }
        if (!shared && attempt < tries && (await waitFor(w, most))) { justWaited = true; continue; }
        throw last;
      }
      return text;
    }
    throw last ?? new HttpError(0, `${host} failed`, 'network');
  }

  async function fetchText(url: string, init: RequestInit | undefined, call: CallOptions): Promise<string> {
    const tries = call.retries ?? retries, tmo = call.timeoutMs ?? timeoutMs;
    const tt = call.timeoutRetries ?? 1, gap = call.minGapMs ?? 0;
    if (call.via === 'relay') {
      const relay = o.relay ?? o.fallbackProxy ?? o.proxy;
      if (!relay) throw new HttpError(0, 'no relay configured for a keyed source', 'needs_key');
      if (relayDown(relay)) throw new HttpError(0, 'no relay for this page', 'needs_key');
      return road(url, init, relay, tries, tmo, maxWaitMs, tt, 0, true);
    }
    // A paced keyless source (Etherscan without a key, one call per 5 s: Linea) stays with each visitor. It never goes
    // through the relay, not first and not when it is refused, so a launch's crowd never shares the relay's one
    // Etherscan key (5 calls a second for all of them): that key reads only a gap in Polygon's index (`via: 'relay'`).
    if (o.proxy || !o.fallbackProxy || gap > 0) return road(url, init, o.proxy, tries, tmo, maxWaitMs, tt, gap);
    // The direct road on its own, waiting out a window up to the longest wait: no relay can help.
    const direct = () => road(url, init, undefined, tries, tmo, maxWaitMs, tt, gap);
    if (relayDown(o.fallbackProxy)) return direct();
    // With a fallback, a long rate-limit window is not waited out on the direct road.
    try {
      return await road(url, init, undefined, tries, tmo, Math.min(maxWaitMs, FALLBACK_AFTER_MS), tt, gap);
    } catch (e) {
      if (!refused(e)) throw e;
      try {
        return await road(url, init, o.fallbackProxy, tries, tmo, maxWaitMs, tt);
      } catch (r) {
        // The relay cannot serve this read (it refuses this page, or holds no key for this source).
        if (r instanceof HttpError && r.kind === 'needs_key') {
          // A bot wall in a browser can lift in a moment; a window is waited out by the road itself.
          if (e instanceof HttpError && e.kind === 'blocked') await waitFor(1500);
          return direct();
        }
        throw r;
      }
    }
  }

  const http: Http = {
    count: 0,
    cached: 0,
    waitedMs: 0,
    byKind: {},
    budgetLeft: () => Math.max(0, budget - http.count),
    async getJson(url: string, init?: RequestInit, call: CallOptions = {}) {
      const key = `${init?.method ?? 'GET'} ${url} ${typeof init?.body === 'string' ? init.body : ''}`;
      let text = cache?.get(key);
      if (text !== undefined) {
        http.cached++;
      } else {
        let p = inflight.get(key);
        if (!p) {
          p = fetchText(url, init, call).finally(() => inflight.delete(key));
          inflight.set(key, p);
        }
        text = await p;
      }
      let json: any;
      try {
        json = JSON.parse(text);
      } catch {
        throw new HttpError(502, `${new URL(url).host} did not return JSON`, 'bad_json');
      }
      if (cache && !rpcError(json)) cache.set(key, text);
      return json;
    },
  };
  return http;
}

/** A JSON-RPC answer that carries an error (also inside a batch) is not worth caching. */
function rpcError(j: any): boolean {
  if (Array.isArray(j)) return j.some((x) => x && x.error);
  return !!(j && typeof j === 'object' && j.jsonrpc && j.error);
}
