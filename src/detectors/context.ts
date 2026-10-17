// What every detector gets, plus shared helpers (counterparties, lookups, finding builder).
import type { ChainDef } from '../chains.ts';
import { addressUrl, chainName, txUrl } from '../chains.ts';
import type { ChainHistory, Transfer } from '../history.ts';
import { normInternal, normToken, normTx } from '../history.ts';
import { cexLabel, serviceLabel, type CexLabel } from '../labels.ts';
import type { AccountAction, ListQuery } from '../sources/explorer.ts';
import { accountList } from '../sources/explorer.ts';
import { reasonOf, type Http } from '../sources/http.ts';
import type { ChainId, DetectorId, Evidence, Finding, Incomplete, ServiceIdentity } from '../types.ts';

export interface Profile {
  isContract: boolean;
  ens?: string;
  /** Text records of the primary ENS name: key -> value. */
  ensRecords: Record<string, string>;
  /** Other ENS names this address owns (not only names pointing at it). */
  ownedNames: string[];
  /** Public name tags on the address itself (the explorer's, from its address page and its own side of the rows). */
  tags: string[];
  /** Every explorer tag slug on the address itself (`exchange`, `deposit-address`, `warpcast-account` ...), and the entity they name. */
  slugs?: string[];
  entity?: string;
  contractName?: string;
  /** EIP-7702 delegation target name on Ethereum: reveals the wallet software. */
  delegate?: string;
}

export interface DetectorContext {
  me: string;
  histories: ChainHistory[];
  http: Http;
  profile: Profile;
  /** Cached explorer reads for other addresses, with a per-scan budget. Returns null when out of budget or on error. */
  lookup(chain: ChainDef, action: AccountAction, address: string, q: ListQuery): Promise<Transfer[] | null>;
  /**
   * Transactions sent by other addresses (RPC nonce), one batch per chain. An address that could not
   * be checked is missing from the map; offline (the streaming passes) the map is always empty.
   */
  nonces(items: { address: string; chainId: ChainId }[]): Promise<Map<string, number>>;
  /** Memo shared between detectors (e.g. funder or deposit analysis run once). */
  memo: Map<string, Promise<unknown>>;
  /** The address is a contract or a service, not a person's wallet: findings say "this address", never "you" (set by runDetectors). */
  thirdPerson?: boolean;
  /**
   * Replay of a finished scan from its lookup record (session.ts): lookups cost nothing, so every
   * candidate is considered and the record decides what is known. Never set in a live scan.
   */
  replay?: boolean;
}

export interface Detector {
  id: DetectorId;
  /** False: runs on local data only, so it can run after every chain for streaming. */
  network: boolean;
  run(ctx: DetectorContext): Promise<Finding[]>;
}

export function memo<T>(ctx: DetectorContext, key: string, fn: () => Promise<T>): Promise<T> {
  let p = ctx.memo.get(key) as Promise<T> | undefined;
  if (!p) { p = fn(); ctx.memo.set(key, p); }
  return p;
}

/**
 * Cached reads of other addresses with a fixed per-scan budget. A read that fails, or one skipped
 * because the budget is spent, is recorded in `gaps`, so the result says it is partial.
 */
export function makeLookup(http: Http, budget: number, gaps?: Incomplete[]): DetectorContext['lookup'] {
  const cache = new Map<string, Promise<Transfer[] | null>>();
  let used = 0;
  const note = (g: Incomplete) => { if (gaps && !gaps.some((x) => x.reason === g.reason)) gaps.push(g); };
  return (chain, action, address, q) => {
    const key = `${chain.id}|${action}|${address}|${JSON.stringify(q)}`;
    let p = cache.get(key);
    if (!p) {
      if (used >= budget) {
        note({ part: 'lookups', name: 'Funder and deposit checks', reason: 'Some funder and deposit checks were skipped: the lookup budget of this scan was spent' });
        return Promise.resolve(null);
      }
      used++;
      const a = address.toLowerCase();
      p = accountList(http, chain, action, a, { timeoutMs: 12000, retries: 2, ...q })
        .then((rows) => rows.map((r) => (action === 'txlist' ? normTx(r, chain, a) : action === 'tokentx' ? normToken(r, chain, a) : normInternal(r, chain, a))))
        .catch((e) => {
          note({ part: 'lookups', chainId: chain.id, name: 'Funder and deposit checks', reason: `${chain.name}: a funder or deposit check could not be read (${reasonOf(e)})` });
          return null;
        });
      cache.set(key, p);
    }
    return p;
  };
}

const NONCE_BATCH = 16;

/**
 * RPC nonces of other addresses: one JSON-RPC batch per chain (at most 16 calls each), cached for the
 * scan. A failed batch is recorded in `gaps`, so the result says it is partial. `cache` holds every
 * answer by `chainId:address` (null = asked, not answered); a replay passes the scan's own.
 */
export function makeNonces(http: Http, rpcOf: (chainId: ChainId) => string | undefined, gaps?: Incomplete[], cache = new Map<string, Promise<number | null>>()): DetectorContext['nonces'] {
  const note = (g: Incomplete) => { if (gaps && !gaps.some((x) => x.reason === g.reason)) gaps.push(g); };
  return async (items) => {
    const todo = new Map<ChainId, string[]>();
    for (const { address, chainId } of items) {
      const k = `${chainId}:${address}`;
      if (cache.has(k) || !rpcOf(chainId)) continue;
      todo.set(chainId, [...(todo.get(chainId) ?? []), address]);
    }
    for (const [chainId, addrs] of todo) {
      const uniq = [...new Set(addrs)];
      for (let i = 0; i < uniq.length; i += NONCE_BATCH) {
        const part = uniq.slice(i, i + NONCE_BATCH);
        const body = JSON.stringify(part.map((a, j) => ({ jsonrpc: '2.0', id: j, method: 'eth_getTransactionCount', params: [a, 'latest'] })));
        const p = http.getJson(rpcOf(chainId)!, { method: 'POST', headers: { 'content-type': 'application/json' }, body }, { timeoutMs: 10000, retries: 2 })
          .then((r) => new Map<string, number>((Array.isArray(r) ? r : []).filter((x: any) => typeof x?.result === 'string' && part[x.id]).map((x: any) => [part[x.id], parseInt(x.result, 16)])))
          .catch((e) => {
            note({ part: 'lookups', chainId, name: 'Funder and deposit checks', reason: `${chainName(chainId)}: a check of linked wallets could not be read (${reasonOf(e)})` });
            return new Map<string, number>();
          });
        part.forEach((a) => cache.set(`${chainId}:${a}`, p.then((m) => m.get(a) ?? null)));
      }
    }
    const out = new Map<string, number>();
    await Promise.all(items.map(async ({ address, chainId }) => {
      const n = await (cache.get(`${chainId}:${address}`) ?? Promise.resolve(null));
      if (n !== null && Number.isFinite(n) && (!out.has(address) || n > out.get(address)!)) out.set(address, n);
    }));
    return out;
  };
}

/** A wallet that sent this many transactions on a chain is a service or a bot (a bridge maker, a solver, an exchange), never a person's other wallet. */
export const SERVICE_NONCE = 2000;

/**
 * Drops the addresses that cannot be a person's other wallet by their own RPC nonce: a service or bot
 * (SERVICE_NONCE or more), and, when `mustHaveSent`, an address that never signed a transaction there
 * (a sender with nonce 0 can only appear through a forged token event). Unknown nonces are kept.
 */
export async function personsByNonce<T>(ctx: DetectorContext, xs: T[], key: (x: T) => { address: string; chainId: ChainId }, mustHaveSent = false): Promise<T[]> {
  if (!xs.length) return xs;
  const n = await ctx.nonces(xs.map(key));
  return xs.filter((x) => {
    const v = n.get(key(x).address);
    if (v === undefined) return true;
    return v < SERVICE_NONCE && (!mustHaveSent || v > 0);
  });
}

/** A finding without impacts; score.ts fills them in. `key` defaults to the rule id. */
export function finding(p: Omit<Finding, 'scoreImpact' | 'rawImpact' | 'key'> & { key?: string }): Finding {
  return { ...p, key: p.key ?? p.id, confidence: round2(p.confidence), scoreImpact: 0, rawImpact: 0 };
}

/** The name to show for an address: its public tag or exchange name when known, else the short address. */
export function nameOf(address: string, cp?: Transfer['cp']): string {
  const cex = cexOf(address, cp);
  if (cex) return cex.entity;
  const tag = cp?.tags?.find(Boolean);
  return tag ? tag.slice(0, 40) : short(address);
}

export const round2 = (x: number) => Math.round(Math.max(0, Math.min(1, x)) * 100) / 100;
export const short = (a: string) => `${a.slice(0, 6)}...${a.slice(-4)}`;
export const pct = (x: number) => `${Math.round(x * 100)}%`;
export const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;

export function txEv(t: Transfer, text: string): Evidence {
  return { kind: 'tx', text, chainId: t.chainId, txHash: t.hash, timestamp: t.timestamp, url: txUrl(t.chainId, t.hash) };
}
export function addrEv(chainId: ChainId | undefined, address: string, text: string, label?: string, value?: number | string): Evidence {
  const e: Evidence = { kind: 'address', text, address };
  if (chainId !== undefined) { e.chainId = chainId; e.url = addressUrl(chainId, address); }
  if (label) e.label = label;
  if (value !== undefined) e.value = value;
  return e;
}

export function chainList(ids: Iterable<ChainId>): string {
  const names = [...new Set(ids)].map(chainName);
  if (names.length <= 1) return names.join('');
  return names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
}

export function fmtAmount(x: number, symbol: string): string {
  const v = x >= 100 ? Math.round(x).toString() : x >= 1 ? (+x.toFixed(2)).toString() : (+x.toPrecision(3)).toString();
  return `${v} ${symbol}`;
}

// ---------- which token transfers are real ----------
export const STABLES = new Set(['USDC', 'USDT', 'DAI', 'USDC.E', 'USDBC', 'USDT0', 'USDE', 'PYUSD', 'FDUSD', 'EURC', 'GHO', 'FRAX', 'LUSD', 'XDAI', 'WXDAI']);

/**
 * Major tokens by contract address, for the sources that give no market price (Routescan, Etherscan
 * V2, NodeReal). A symbol proves nothing: anyone can deploy a token called "USDT". Each address was
 * checked with symbol() on the chain's own RPC, 2026-10-16.
 */
const MAJOR_TOKENS: Record<number, string[]> = {
  1: ['0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', '0xdac17f958d2ee523a2206206994597c13d831ec7', '0x6b175474e89094c44da98b954eedeac495271d0f', '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599', '0xae7ab96520de3a18e5e111b5eaab095312d7fe84', '0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0', '0x514910771af9ca656af840dff83e8264ecf986ca', '0x1f9840a85d5af5bf1d1762f925bdaddc4201f984', '0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9', '0x6c3ea9036406852006290770bedfcaba0e23a0e8', '0x4c9edd5852cd905f086c759e8383e09bff1e68b3', '0x1abaea1f7c830bd89acc67ec4af516284b1bc33c', '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf', '0xc5f0f7b66764f6ec8c8dff7ba683102295e16409', '0xae78736cd615f374d3085123a210448e74fc6393', '0x40d16fc0246ad3160ccc09b8d0d3a2cd28ae6c2f', '0x5f98805a4e8be255a32880fdec7f6728c6568ba0', '0x853d955acef822db058eb8505911ed77f175b99e', '0x455e53cbb86018ac2b8092fdcd39d8444affc3f6', '0x7d1afa7b718fb893db30a3abc0cfc608aacfebb0', '0xbe9895146f7af43049ca1c1ae358b0541ea49704'],
  43114: ['0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e', '0x9702230a8ea53601f5cd2dc00fdbc13d4df4a8c7', '0xa7d7079b0fead91f3e65f86e8915cb59c1a4c664', '0xc7198437980c041c805a1edcba50c1ce5db95118', '0xb31f66aa3c1e785363f0875a1b74e27b85fd66c7', '0x49d5c2bdffac6ce2bfdb6640f4f80f226bc10bab', '0xd586e7f844cea2f87f50152665bcbc2c279d8d70', '0x50b7545627a5162f82a992c33b87adc75187b218', '0x152b9d0fdc40c096757f570a51e494bd4b943e50'],
  81457: ['0x4300000000000000000000000000000000000003', '0x4300000000000000000000000000000000000004'],
  59144: ['0x176211869ca2b568f2a7d4ee941e073a821ee1ff', '0xa219439258ca9da29e9cc4ce5596924745e12b93', '0xe5d7c2a44ffddf6b295a15c148167daaaf5cf34f', '0x4af15ec2a0bd43db75dd04e62faa3b8ef36b00d5', '0x3aab2285ddcddad8edf438c1bab47e1a9d05a9b4'],
  56: ['0x55d398326f99059ff775485246999027b3197955', '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', '0xe9e7cea3dedca5984780bafc599bd69add087d56', '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c', '0x2170ed0880ac9a755fd29b2688956bd959f933f8', '0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c', '0x1af3f329e8be154074d8769d1ffa4ee058b1dbc3', '0xc5f0f7b66764f6ec8c8dff7ba683102295e16409'],
};
const MAJOR = new Set(Object.entries(MAJOR_TOKENS).flatMap(([id, xs]) => xs.map((a) => `${id}:${a}`)));
/** More holders than an address-poisoning fake gets: those are made per victim (measured 0 to 661 holders, 2026-10-16). */
const MANY_HOLDERS = 10_000;

/** A real, listed token: priced on the explorer, held by many addresses, or a major token by contract address. */
export const realToken = (t: Transfer) => t.priced === true || (t.holders ?? 0) >= MANY_HOLDERS || (!!t.token && MAJOR.has(`${t.chainId}:${t.token}`));

/**
 * Token transfers that really happened, minus spam and address poisoning. A fake token can write
 * "you sent 500 USDT to X" into any history (it emits the event itself), so:
 * - an outgoing transfer counts when the wallet signed that transaction, or the token is a real one;
 * - an incoming transfer counts when the token is a real one, or the wallet itself sent that token.
 */
export function cleanTokens(h: ChainHistory): Transfer[] {
  const signed = new Set(h.txs.filter((t) => t.dir === 'out').map((t) => t.hash));
  const sent = new Set(h.tokens.filter((t) => t.dir === 'out' && (signed.has(t.hash) || realToken(t))).map((t) => t.token));
  return h.tokens.filter((t) => {
    if (t.amount <= 0) return false;
    if (t.dir === 'out') return signed.has(t.hash) || realToken(t);
    if (t.cp?.scam) return false;
    return realToken(t) || sent.has(t.token);
  });
}

const common = (a: string, b: string, n: number) => { let i = 0; while (i < n && a[i] === b[i]) i++; return i; };
/**
 * Address poisoning: a different address that starts and ends like the real one, so it reads the
 * same when shortened. At least 3 + 4 or 4 + 3 equal hex characters (seen 2026-10-16: 0x983193ae...4689
 * imitating 0x983f20a7...4689). Two random addresses match like that about once in 130 million pairs.
 * Precompiles and system contracts (30 or more leading zero hex characters, such as 0x...01 and
 * ZKsync's 0x...8001) are never one: they all start alike by design.
 */
const system = (a: string) => /^0x0{30}/.test(a);
export function lookalike(a: string, b: string): boolean {
  if (a === b || a.length !== 42 || b.length !== 42 || system(a) || system(b)) return false;
  const head = common(a.slice(2), b.slice(2), 6);
  const tail = common([...a].reverse().join(''), [...b].reverse().join(''), 6);
  return (head >= 3 && tail >= 4) || (head >= 4 && tail >= 3);
}

const EXCHANGE_SLUGS = new Set(['exchange', 'cex', 'hot-wallet', 'centralized-exchange']);

/** Exchange label: the bundled list first, then the explorer's own public tags. */
export function cexOf(address: string, cp?: Transfer['cp']): CexLabel | undefined {
  const l = cexLabel(address);
  if (l || !cp?.slugs?.some((s) => EXCHANGE_SLUGS.has(s))) return l;
  const entity = cp.entity ?? cp.tags?.[0]?.split(':')[0]?.trim() ?? 'an exchange';
  return { entity, kind: cp.slugs.some((s) => s.includes('deposit')) ? 'deposit' : 'hot' };
}

/**
 * The address itself as a service by the explorer's own tags, for an address the bundled lists do not
 * name. Only tags that say so outright: an exchange's wallet, a deposit address, an MEV bot. A Farcaster
 * account, a DAO voter or a contract deployer is still a person.
 */
export function serviceByTags(slugs: string[] = [], entity?: string): ServiceIdentity | undefined {
  const kind = slugs.includes('deposit-address') ? 'deposit' : slugs.some((s) => EXCHANGE_SLUGS.has(s)) ? 'exchange' : slugs.includes('mev-bot') ? 'bot' : undefined;
  if (!kind) return undefined;
  return entity ? { kind, entity } : { kind };
}

/** Generic explorer tags that still describe a person, not a service. */
const PERSON_SLUGS = new Set(['ens', 'ens-name', 'whale', 'smart-money', 'funded-by', 'airdrop-hunter']);

/**
 * A service: never a person's other wallet, so it never makes a link (shared funder, back and forth,
 * deposit sender, recurring counterparty). From the bundled service list, or the explorer's own
 * public tags on the address (a protocol, bridge, router, bot or fund). Exchanges are `cexOf`.
 */
export function serviceOf(address: string, cp?: Transfer['cp']): string | undefined {
  const s = serviceLabel(address);
  if (s) return s.kind === 'market maker' ? 'a market maker' : s.kind === 'bot' ? 'a bot' : s.kind === 'payments' ? 'a payment service' : s.kind === 'distributor' ? 'a payout or airdrop wallet' : s.kind === 'bridge' ? 'a bridge wallet' : 'a service wallet';
  const tag = cp?.tags?.find(Boolean);
  if (tag) return tag.slice(0, 40);
  if (cp?.slugs?.some((x) => !PERSON_SLUGS.has(x) && !EXCHANGE_SLUGS.has(x))) return cp.entity ?? 'a labelled service';
  return undefined;
}

/** All value-moving transfers of the wallet on all chains, spam removed. */
export function allTransfers(ctx: DetectorContext): Transfer[] {
  const out: Transfer[] = [];
  for (const h of ctx.histories) {
    out.push(...h.txs, ...h.internal, ...cleanTokens(h));
  }
  return out;
}

export interface Counterparty {
  address: string;
  nIn: number;
  nOut: number;
  chains: Set<ChainId>;
  /** Signed a top-level tx to us: a person-held wallet (EOA), not a contract. */
  signedToMe: boolean;
  /** We sent it plain value with no calldata. */
  plainSendTo: boolean;
  /** Looks like a contract: we called it with calldata, it paid us internally, or it is a token. */
  contractLike: boolean;
  cex?: CexLabel;
  /** The explorer flagged this address as a contract. */
  explorerContract?: boolean;
  /** A known service (see serviceOf): it never counts as a person's wallet. */
  service?: string;
  /** Looks like the scanned wallet or another counterparty (address poisoning): never a link. */
  poison?: boolean;
  /** For a poisoner: the address it imitates (the scanned wallet, or the counterparty it copies). */
  imitates?: string;
  first: Transfer;
  last: Transfer;
  outTransfers: Transfer[];
  inTransfers: Transfer[];
}

const ZERO = '0x0000000000000000000000000000000000000000';

export function counterparties(ctx: DetectorContext): Map<string, Counterparty> {
  const m = new Map<string, Counterparty>();
  const tokenContracts = new Set<string>();
  for (const h of ctx.histories) for (const t of h.tokens) if (t.token) tokenContracts.add(t.token);
  const get = (a: string, t: Transfer) => {
    let c = m.get(a);
    if (!c) {
      c = { address: a, nIn: 0, nOut: 0, chains: new Set(), signedToMe: false, plainSendTo: false, contractLike: tokenContracts.has(a), cex: cexOf(a, t.cp), service: serviceOf(a, t.cp), first: t, last: t, outTransfers: [], inTransfers: [] };
      m.set(a, c);
    }
    if (!c.cex && t.cp) c.cex = cexOf(a, t.cp);
    if (!c.service && t.cp) c.service = serviceOf(a, t.cp);
    if (t.cp?.isContract) c.explorerContract = true;
    if (t.timestamp < c.first.timestamp) c.first = t;
    if (t.timestamp > c.last.timestamp) c.last = t;
    c.chains.add(t.chainId);
    return c;
  };
  const sighted = new Set<string>();
  for (const t of allTransfers(ctx)) {
    if (t.failed || t.dir === 'self') continue;
    const other = t.dir === 'out' ? t.to : t.from;
    if (!other || other === ZERO || other === ctx.me) continue;
    const c = get(other, t);
    if (!t.blind) sighted.add(other);
    if (t.kind === 'native' && t.dir === 'in') c.signedToMe = true;
    if (t.kind === 'native' && t.dir === 'out' && !t.blind) {
      if (t.isCall) c.contractLike = true;
      else if (t.amount > 0) c.plainSendTo = true;
    }
    if (t.kind === 'internal' && t.dir === 'in') c.contractLike = true;
    const moves = t.amount > 0;
    if (!moves) continue;
    if (t.dir === 'out') { c.nOut++; c.outTransfers.push(t); } else { c.nIn++; c.inTransfers.push(t); }
  }
  for (const c of m.values()) {
    if (c.signedToMe) c.contractLike = false;
    if (c.explorerContract) c.contractLike = true; // the explorer saw code: trust it (an EIP-7702 wallet is not flagged)
    // Seen only through a source without calldata (BNB via NodeReal) and it never sent us a
    // transaction: it may be a router or a pool. Unknown counts as not a person.
    else if (!c.signedToMe && !sighted.has(c.address)) c.contractLike = true;
  }
  // Address poisoning: an imitation of the wallet itself, or of another counterparty. Of two that look
  // alike, the original is the one you sent more to; on a tie, the one seen first (a poisoner reacts to
  // a real transfer, so it always comes after it). Same first transfer too: neither can be trusted.
  const buckets = new Map<string, Counterparty[]>();
  for (const c of m.values()) {
    if (lookalike(c.address, ctx.me)) { c.poison = true; c.imitates = ctx.me; continue; }
    const k = c.address.slice(-3);
    buckets.set(k, [...(buckets.get(k) ?? []), c]);
  }
  const rank = (c: Counterparty) => [c.nOut, c.nIn, -c.first.timestamp];
  const better = (a: Counterparty, b: Counterparty) => { const x = rank(a), y = rank(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]; return false; };
  for (const bucket of buckets.values()) {
    if (bucket.length < 2) continue;
    for (const a of bucket) {
      const twins = bucket.filter((b) => b !== a && lookalike(a.address, b.address));
      if (!twins.length) continue;
      const best = twins.reduce((x, y) => (better(y, x) ? y : x));
      // `a` is an imitation when a look-alike of it is the better candidate for the original (or neither is).
      if (better(best, a) || !better(a, best)) { a.poison = true; a.imitates = best.address; }
    }
  }
  return m;
}

/** The chain with the most transfers with this counterparty: where its own transaction count is checked. */
export function mainChainOf(c: Counterparty): ChainId {
  const n = new Map<ChainId, number>();
  for (const t of [...c.outTransfers, ...c.inTransfers]) n.set(t.chainId, (n.get(t.chainId) ?? 0) + 1);
  return [...n.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] ?? [...c.chains][0];
}

/** A person-held wallet as far as we can tell: not a contract, not an exchange, not a known service. */
export const personal = (c: Counterparty) => !c.contractLike && !c.cex && !c.service && !c.poison;

/** Signed outgoing top-level transactions on every chain (what the wallet itself did). */
export function signedTxs(ctx: DetectorContext): Transfer[] {
  const out: Transfer[] = [];
  for (const h of ctx.histories) for (const t of h.txs) if (t.from === ctx.me) out.push(t);
  return out;
}

/** Seconds per block on a chain, estimated from the wallet's own history, or a default. */
export function secondsPerBlock(h: ChainHistory): number {
  const xs = [...h.txs, ...h.tokens, ...h.internal].filter((t) => t.block > 0 && t.timestamp > 0).sort((a, b) => a.block - b.block);
  if (xs.length >= 2) {
    const a = xs[0], b = xs[xs.length - 1];
    if (b.block > a.block && b.timestamp > a.timestamp) return (b.timestamp - a.timestamp) / (b.block - a.block);
  }
  const d: Record<number, number> = { 1: 12, 42161: 0.25, 4663: 0.1, 137: 2, 43114: 2, 100: 5, 324: 1 };
  return d[h.chain.id] ?? 2;
}
