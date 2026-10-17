// Before you send (FEATURES D1): what a planned transfer would reveal, before it exists.
// Nothing is signed or sent. The scan's history gets one synthetic transfer, every detector runs
// again, and the result is compared with the same replay without it. The destination costs 1 to 3
// requests (one RPC batch, then at most its two lists), inside a small budget and the engine's own
// rate-limit pacing. A destination that could not be read is reported as unread, never as clean.
import type { ChainDef } from '../chains.ts';
import { CHAIN_BY_ID } from '../chains.ts';
import { isRound } from '../detectors/behavioral-fingerprint.ts';
import { counterparties, lookalike, makeLookup, SERVICE_NONCE } from '../detectors/context.ts';
import { fundingOf, type ChainHistory, type Transfer } from '../history.ts';
import { cexLabel, serviceIdentity, type CexLabel } from '../labels.ts';
import { linkLevel } from '../score.ts';
import type { Lookup, ScanSession } from '../session.ts';
import { createHttp, HttpError, type Http } from '../sources/http.ts';
import type { ChainCoverage, ChainId, Finding, RelatedAddress, ScanOptions, ScanResult, ServiceIdentity, Severity, LinkLevel } from '../types.ts';
import { replayContext, replayLookup, replayNonces, rerun } from './replay.ts';

/** The hash of the synthetic transfer in evidence: there is no transaction yet, so never link it. */
export const PLANNED_HASH = 'planned';

export interface PlannedTransfer {
  chainId: ChainId;
  /** Lowercase 0x address. Resolve a name first. */
  to: string;
  /** Whole units (0.5 = half an ETH). Without it the amount rules stay as they were. */
  amount?: number;
  /** 'native' (default) or a stablecoin symbol such as 'USDC'. */
  asset?: string;
}

/**
 * fresh = never sent a transaction and holds nothing; wallet = an address with a history and no code;
 * contract = code; service = an exchange or service wallet from the bundled lists, or a wallet that
 * sent 2,000 or more transactions here (RULES: a service or a bot, never a link).
 */
export type DestinationKind = 'fresh' | 'wallet' | 'contract' | 'service' | 'unknown';

export interface Destination {
  address: string;
  chainId: ChainId;
  kind: DestinationKind;
  /** Exchange label from the bundled list. */
  label?: CexLabel;
  /** What kind of service it is (bundled lists), or `busy` with its own count of sent transactions. */
  service?: ServiceIdentity | { kind: 'busy'; sent: number };
  /**
   * Address poisoning: the address this destination imitates (your own, or a wallet you used), in
   * full. The two share their first and last characters, so shortened they read the same.
   */
  imitates?: string;
  /** False when something the rules needed about the destination could not be read. */
  read: boolean;
  /** Why it could not be read, e.g. "rate limit reached". */
  unread?: string;
  /** Nymra already links it to the sender, before this transfer. */
  knownLink?: RelatedAddress;
}

export interface SendChange {
  kind: 'new' | 'stronger';
  ruleId: string;
  after: Finding;
  before?: Finding;
  /** Points this finding costs after the transfer minus before (negative = it costs more). */
  delta: number;
  /** Links to other wallets this finding gains, each with its confidence and word. */
  links: RelatedAddress[];
  /** The finding is about the destination itself: a link to it, its label, or its first funds. */
  aboutDestination: boolean;
}

export interface SendCheck {
  from: string;
  planned: PlannedTransfer;
  destination: Destination;
  /** The scan replayed without the transfer, and with it. */
  before: ScanResult;
  after: ScanResult;
  /** after.score - before.score. */
  delta: number;
  /** The scan's own score. Differs from before.score when checking the destination taught Nymra
   *  something about a transfer you already made (e.g. you paid this deposit address before). */
  scanScore: number;
  /** Costliest first. */
  changes: SendChange[];
  /** Points of the delta from small shifts in findings that are not listed, so the numbers add up. */
  rest: number;
  /** What the scan read on the chosen chain. */
  coverage?: ChainCoverage;
  /** True when no amount was given: the amount rules were left as they were. */
  noAmount: boolean;
  /**
   * A fresh destination only holds what you sent, so the tie is weak (rules 1.3.0). Its first own
   * transaction is paid with your coins: the link and the score at that moment, from the same replay
   * with that one transaction counted. Absent when that changes nothing.
   */
  whenItSends?: { confidence: number; level: LinkLevel; score: number };
  requests: number;
}

export interface SendOptions extends Pick<ScanOptions, 'fetch' | 'proxy' | 'fallbackProxy' | 'relay' | 'signal' | 'requestTimeoutMs'> {
  /** Most requests the check may make. Default 6: one RPC batch and two lists, with room for a retry. */
  budget?: number;
}

/** Rules about when you transact: Nymra cannot know when you will send, so they stay as they were. */
const TIMING_RULES = ['behavioral_fingerprint.timezone', 'behavioral_fingerprint.fixed_timing'];
const ROUND_RULE = 'behavioral_fingerprint.round_amounts';
const SEV_RANK: Record<Severity, number> = { info: 0, low: 1, medium: 2, high: 3, critical: 4 };

interface Facts { nonce?: number; balance?: bigint; code?: 'none' | 'delegated' | 'contract'; latest?: number; error?: string }

/** A plain reason for a failed read. Never carries a URL or an address. */
function why(e: unknown): string {
  const m = e instanceof Error ? e.message : '';
  if (/budget/i.test(m)) return 'request budget reached';
  if (/429|rate limit/i.test(m)) return 'rate limit reached';
  if (/timed out|timeout/i.test(m)) return 'timed out';
  return 'the explorer did not answer';
}

/**
 * The check's own network road: the engine's http (pacing, retries, backoff, fallback proxy) over a
 * fetch that counts and stops at the budget, so a check can never make more requests than it says.
 */
function checkHttp(o: SendOptions, budget: number): Http {
  const f = o.fetch ?? globalThis.fetch.bind(globalThis);
  let n = 0;
  const counted = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (n >= budget) return Promise.reject(new HttpError(0, 'request budget of this check reached'));
    n++;
    return f(input, init);
  }) as typeof fetch;
  return createHttp({ fetch: counted, proxy: o.proxy, fallbackProxy: o.fallbackProxy, relay: o.relay, signal: o.signal, timeoutMs: o.requestTimeoutMs, budget });
}

function codeKind(code: unknown): Facts['code'] | undefined {
  if (typeof code !== 'string') return undefined;
  const c = code.toLowerCase();
  if (/^0x0*$/.test(c)) return 'none';
  // EIP-7702: 0xef0100 + a 20-byte target is a wallet that delegates, not a contract.
  if (c.startsWith('0xef0100') && c.length === 48) return 'delegated';
  return 'contract';
}

/** Nonce, balance, code and the latest block of the destination, in one RPC batch. */
async function inspect(http: Http, chain: ChainDef, to: string): Promise<Facts> {
  if (!chain.rpc) return { error: 'no public RPC for this chain' };
  const body = JSON.stringify([
    { jsonrpc: '2.0', id: 1, method: 'eth_getTransactionCount', params: [to, 'latest'] },
    { jsonrpc: '2.0', id: 2, method: 'eth_getBalance', params: [to, 'latest'] },
    { jsonrpc: '2.0', id: 3, method: 'eth_getCode', params: [to, 'latest'] },
    { jsonrpc: '2.0', id: 4, method: 'eth_blockNumber', params: [] },
  ]);
  try {
    const r = await http.getJson(chain.rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    const get = (id: number) => (Array.isArray(r) ? r.find((x: any) => x?.id === id)?.result : undefined);
    const n = get(1), b = get(2), latest = get(4);
    const code = codeKind(get(3));
    if (typeof n !== 'string' || typeof b !== 'string' || !code) return { error: 'the chain node gave no clear answer' };
    return { nonce: parseInt(n, 16), balance: BigInt(b), code, ...(typeof latest === 'string' ? { latest: parseInt(latest, 16) } : {}) };
  } catch (e) {
    return { error: why(e) };
  }
}

/**
 * The histories with the planned transfer in them. It is a transaction you sign, so on a chain where
 * you never sent one it becomes your first, and what pays for it becomes your funding (history.ts).
 */
function withPlanned(hs: ChainHistory[], chain: ChainDef, t: Transfer): ChainHistory[] {
  const signed: Transfer = t.kind === 'native' ? t : { ...t, to: t.token ?? t.to, kind: 'native', amount: 0, symbol: chain.native, isCall: true };
  let found = false;
  const out = hs.map((h) => {
    if (h.chain.id !== chain.id) return h;
    found = true;
    const firstOwn = h.firstOwn ?? signed;
    return {
      ...h, txs: t.kind === 'native' ? [t, ...h.txs] : h.txs, tokens: t.kind === 'token' ? [t, ...h.tokens] : h.tokens,
      ownCount: h.ownCount + 1, ...(h.nonce !== undefined ? { nonce: h.nonce + 1 } : {}),
      firstOwn, firstFunding: h.firstOwn ? h.firstFunding : fundingOf(signed, [...h.txs, ...h.internal]),
    };
  });
  if (!found) {
    const coverage = {
      chainId: chain.id, name: chain.name, status: 'no_activity', source: chain.source.kind, txCount: 0, tokenTransferCount: 0,
      internalTransfers: 'not_fetched', truncated: false, limitations: [], missing: [], durationMs: 0,
    } as ChainCoverage;
    out.push({ chain, txs: t.kind === 'native' ? [t] : [], internal: [], tokens: t.kind === 'token' ? [t] : [], ownCount: 1, firstOwn: signed, truncated: false, coverage });
  }
  return out;
}

/**
 * The address a destination imitates (address poisoning, RULES: 3 + 4 or 4 + 3 equal hex
 * characters): your own address, or a wallet in your history. Of several, the one you sent the most to.
 */
function imitated(s: ScanSession, to: string): string | undefined {
  if (lookalike(to, s.me)) return s.me;
  return [...counterparties(replayContext(s)).values()]
    .filter((c) => c.address !== to && !c.poison && lookalike(to, c.address))
    .sort((a, b) => b.nOut - a.nOut || a.first.timestamp - b.first.timestamp)[0]?.address;
}

export async function beforeYouSend(s: ScanSession, plan: PlannedTransfer, o: SendOptions = {}): Promise<SendCheck> {
  const to = plan.to.trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(to)) throw new Error('Not an EVM address: expected 0x followed by 40 hex characters.');
  const h = s.histories.find((x) => x.chain.id === plan.chainId);
  const chain = h?.chain ?? CHAIN_BY_ID.get(plan.chainId);
  if (!chain) throw new Error(`Chain ${plan.chainId} is not in the register.`);

  // The scan as it was (replayed); it is also what the timing rules are kept from.
  const scan = await rerun(s);
  const label = cexLabel(to);
  const imitates = imitated(s, to);
  const given = typeof plan.amount === 'number' && Number.isFinite(plan.amount) && plan.amount > 0;
  const base = { from: s.me, planned: { ...plan, to }, scanScore: scan.score, ...(h ? { coverage: h.coverage } : {}), noAmount: !given };
  if (to === s.me) {
    return { ...base, destination: { address: to, chainId: chain.id, kind: 'wallet', read: true }, before: scan, after: scan, delta: 0, changes: [], rest: 0, requests: 0 };
  }

  const budget = o.budget ?? 6;
  const http = checkHttp(o, budget);
  const facts = await inspect(http, chain, to);
  const service: Destination['service'] = serviceIdentity(to)
    ?? (facts.nonce !== undefined && facts.nonce >= SERVICE_NONCE ? { kind: 'busy', sent: facts.nonce } : undefined);
  const kind: DestinationKind = facts.code === 'contract' ? 'contract'
    : service ? 'service'
    : facts.error ? 'unknown'
    : facts.nonce === 0 && facts.balance === 0n && facts.code === 'none' ? 'fresh'
    : 'wallet';
  // The destination's own count joins the scan's record, so the rules see a service or a bot as one.
  const nonces = replayNonces(s, facts.nonce !== undefined ? [[`${chain.id}:${to}`, facts.nonce]] : []);

  const native = !plan.asset || /^native$/i.test(plan.asset) || plan.asset.toUpperCase() === chain.native.toUpperCase();
  const symbol = native ? chain.native : plan.asset!.toUpperCase();
  // Without an amount the transfer still moves value (links need that), at a stand-in that is not round.
  const amount = given ? plan.amount! : native ? 0.0137 : 13.7;
  const token = native ? undefined : h?.tokens.find((t) => t.symbol.toUpperCase() === symbol)?.token;
  const maxBlock = Math.max(0, ...(h ? [...h.txs, ...h.tokens, ...h.internal].map((t) => t.block) : []));
  const planned: Transfer = {
    chainId: chain.id, hash: PLANNED_HASH, block: Math.max(facts.latest ?? 0, maxBlock) + 1, timestamp: Math.floor(Date.now() / 1000),
    from: s.me, to, kind: native ? 'native' : 'token', amount, symbol, ...(token ? { token } : {}), dir: 'out', failed: false,
    isCall: kind === 'contract', ...(kind === 'contract' ? { cp: { isContract: true } } : {}),
  };
  const histories = withPlanned(s.histories, chain, planned);
  const wasActive = !!h && h.txs.length + h.tokens.length + h.internal.length > 0;

  // Only one new question may go to the network: the destination's own lists (is it a deposit
  // address, a wallet you funded first). Every other question, also a funder check on the
  // destination, is answered from the scan's record or not at all, the same way in both replays,
  // so the only difference between before and after is the planned transfer.
  let unread = facts.error;
  const net = makeLookup(http, 2);
  const isListCheck = (c: ChainDef, action: string, address: string, q: { filter?: string; startblock?: number; endblock?: number }) =>
    c.id === chain.id && address.toLowerCase() === to && (action === 'txlist' || action === 'tokentx') && !q.filter && q.startblock === undefined && q.endblock === undefined;
  const fresh: Lookup = (c, action, address, q) => {
    if (!isListCheck(c, action, address, q)) return Promise.resolve(null);
    if (kind === 'fresh') return Promise.resolve([]);
    return net(c, action, address, q);
  };
  const shared = replayLookup(s, fresh).lookup;
  const theirs: Transfer = { ...planned, dir: 'in' }; // the same transfer, seen from the destination
  const watch = (inject: boolean): Lookup => async (c, action, address, q) => {
    const rows = await shared(c, action, address, q);
    if (!isListCheck(c, action, address, q)) return rows;
    if (rows === null) {
      unread ??= http.count >= budget ? 'request budget reached' : 'its history could not be read';
      return null; // unknown stays unknown: never pretend it is empty
    }
    return inject && action === (native ? 'txlist' : 'tokentx') ? [theirs, ...rows] : rows;
  };

  const roundPlanned = given && isRound(planned);
  const keep = new Set([...TIMING_RULES, ...(roundPlanned ? [] : [ROUND_RULE])]);
  const after = await rerun(s, {
    histories, lookup: watch(true), nonces,
    adjust: (fs) => [...fs.filter((f) => !keep.has(f.id)), ...scan.findings.filter((f) => keep.has(f.id))],
  });
  // Before, with the same answers: when you paid this address before and the scan had not checked
  // it, its facts count in both (and before.score can differ from the scan's score).
  const before = await rerun(s, { lookup: watch(false), nonces });
  const knownLink = before.linkedWallets.find((w) => w.address === to);
  let whenItSends: SendCheck['whenItSends'];
  if (kind === 'fresh') {
    const used = await rerun(s, {
      histories, lookup: watch(true), nonces: replayNonces(s, [[`${chain.id}:${to}`, 1]]),
      adjust: (fs) => [...fs.filter((f) => !keep.has(f.id)), ...scan.findings.filter((f) => keep.has(f.id))],
    });
    const now = after.linkedWallets.find((w) => w.address === to)?.confidence ?? 0;
    const then = used.linkedWallets.find((w) => w.address === to);
    if (then && then.confidence > now) whenItSends = { confidence: then.confidence, level: linkLevel(then.confidence), score: used.score };
  }
  // The planned transfer has no hash yet: its evidence says so and carries no link.
  for (const f of after.findings) for (const e of f.evidence) if (e.txHash === PLANNED_HASH) { delete e.url; e.text = `${e.text} (this transfer)`; }

  const prev = new Map(before.findings.map((f) => [f.key, f]));
  const changes: SendChange[] = [];
  let explained = 0;
  for (const f of after.findings) {
    if (f.severity === 'info') continue;
    const b = prev.get(f.key);
    const links = (f.related ?? []).filter((r) => !(b?.related ?? []).some((x) => x.address === r.address)).map((r) => ({ ...r, level: linkLevel(r.confidence) }));
    const delta = f.scoreImpact - (b?.scoreImpact ?? 0);
    const about = (f.related ?? []).some((r) => r.address === to) || f.evidence.some((e) => e.address === to || e.txHash === PLANNED_HASH);
    const relevant = about
      || (f.id === 'cross_chain.multichain_presence' && !wasActive)
      || (f.id === 'cex_exposure.direct' && label?.kind === 'hot')
      || (f.id === ROUND_RULE && roundPlanned);
    const kindOf = !b ? 'new' : SEV_RANK[f.severity] > SEV_RANK[b.severity] || links.length || (delta < 0 && relevant) ? 'stronger' : null;
    if (!kindOf) continue;
    changes.push({ kind: kindOf, ruleId: f.id, after: f, ...(b ? { before: b } : {}), delta, links, aboutDestination: about });
    explained += delta;
  }
  changes.sort((a, b) => a.delta - b.delta || (a.kind === 'new' ? -1 : 1) - (b.kind === 'new' ? -1 : 1));
  const delta = after.score - before.score;
  return {
    ...base,
    destination: {
      address: to, chainId: chain.id, kind, ...(label ? { label } : {}), ...(service ? { service } : {}), ...(imitates ? { imitates } : {}),
      read: !unread, ...(unread ? { unread } : {}), ...(knownLink ? { knownLink } : {}),
    },
    before, after, delta, changes, rest: delta - explained, requests: http.count, ...(whenItSends ? { whenItSends } : {}),
  };
}
