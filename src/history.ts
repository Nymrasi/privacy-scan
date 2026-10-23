// One normalized history per chain. Detectors only ever see these shapes.
import { keyed, type ChainDef } from './chains.ts';
import type { ChainCoverage, ChainId } from './types.ts';
import type { Http } from './sources/http.ts';
import { accountList, type Rows } from './sources/explorer.ts';
import { HttpError, reasonOf, refused } from './sources/http.ts';

export type TransferKind = 'native' | 'internal' | 'token';

export interface Transfer {
  chainId: ChainId;
  hash: string;
  block: number;
  timestamp: number;
  from: string;
  to: string;
  kind: TransferKind;
  /** Amount in whole units (ETH, USDC ...). 0 for a plain contract call. */
  amount: number;
  symbol: string;
  token?: string;
  dir: 'in' | 'out' | 'self';
  failed: boolean;
  /** Top-level tx only. */
  gasPrice?: number;
  gasLimit?: number;
  methodId?: string;
  /** True when the top-level tx carried calldata (a contract call, not a plain send). */
  isCall?: boolean;
  /** Max priority fee in gwei (EIP-1559 txs, Blockscout only). */
  priorityFee?: number;
  /** What the explorer says about the other side of the transfer (Blockscout only). */
  cp?: { isContract?: boolean; tags?: string[]; slugs?: string[]; entity?: string; scam?: boolean };
  /** The source gave no calldata (NodeReal): whether this was a plain send or a contract call is unknown. */
  blind?: boolean;
  /** Token transfers on Blockscout: the token has a market price (a real, listed token). Undefined when the source does not say. */
  priced?: boolean;
  /** Token transfers on Blockscout: how many addresses hold the token. */
  holders?: number;
}

function cpOf(r: any, dir: 'in' | 'out' | 'self'): Transfer['cp'] | undefined {
  const x = dir === 'in' ? r._from : r._to;
  return x && Object.keys(x).length ? x : undefined;
}

export interface ChainHistory {
  chain: ChainDef;
  /** Top-level transactions sent or received, newest first. */
  txs: Transfer[];
  internal: Transfer[];
  tokens: Transfer[];
  /** Transactions this address sent on this chain, from the chain's own RPC. Undefined when not checked. */
  nonce?: number;
  /** The address holds code on this chain (a contract; an EIP-7702 delegation does not count). Undefined when not checked. */
  code?: boolean;
  /** Distinct transactions this address signed among those read (newest page plus oldest page). */
  ownCount: number;
  /** The oldest transaction this address signed that was read. */
  firstOwn?: Transfer;
  /** What paid for `firstOwn`: see `fundingOf`. Undefined when the address never signed here or it is not visible. */
  firstFunding?: Transfer;
  truncated: boolean;
  coverage: ChainCoverage;
  /** What the explorer says about this address itself, from its own side of the rows (Blockscout only). */
  self?: SelfTags;
  /** Cut to what the card of an address that is no person needs: see `quickShape`. */
  quick?: true;
  /** The explorer's index lacks part of what this address sent here: `listed` of the `sent` the chain's nonce counts. */
  indexGap?: { listed: number; sent: number };
}

/**
 * An address that is no person (a contract, a service, a bot) gets a card without a score: its name, its
 * labels and where it is active. That needs the newest page of its transactions on each chain it used, not
 * its whole history. Read in full, such an address took 20 to 60 s, nearly all of it paging lists its card
 * never shows (30 known wallets: USDC 55 s, Layerswap 63 s, WETH 52 s, exchange wallets 21 to
 * 29 s). This many rows per chain, one Blockscout page.
 */
export const QUICK_ROWS = 50;
/** The coverage line of a chain read as `QUICK_ROWS`. Says "history", so the generic long-history line is not added. */
export const QUICK_LIMIT = 'This address is not a personal wallet, so only the newest part of its history was read here, which is enough to name it.';

/**
 * The history of an address that is no person, as its card reads it: the newest `QUICK_ROWS` transactions,
 * its newest token transfers only on a chain where it has none, no internal transfers and nothing older. The
 * same shape whatever this run read before it knew what the address is, so two scans give one result.
 */
export function quickShape(h: ChainHistory): ChainHistory {
  const st = h.coverage.status;
  if (h.quick || st === 'no_activity' || st === 'skipped' || st === 'error') return h;
  const txs = h.txs.slice(0, QUICK_ROWS);
  const tokens = txs.length ? [] : h.tokens.slice(0, QUICK_ROWS);
  const ts = [...txs, ...tokens].map((t) => t.timestamp).filter((x) => x > 0);
  const coverage: ChainCoverage = {
    ...h.coverage, status: 'scanned', txCount: txs.length, tokenTransferCount: tokens.length,
    internalTransfers: h.chain.traces === false ? 'none' : 'not_fetched',
    truncated: h.truncated || h.txs.length >= QUICK_ROWS || h.tokens.length > tokens.length,
    limitations: [...(h.chain.limits ?? []), QUICK_LIMIT], missing: [], firstSeen: undefined,
    lastSeen: ts.length ? Math.max(...ts) : undefined,
  };
  return {
    ...h, txs, tokens, internal: [], ownCount: txs.filter((t) => t.dir !== 'in').length, firstOwn: undefined,
    firstFunding: undefined, truncated: coverage.truncated, coverage, quick: true,
  };
}

/** Explorer tags on the scanned address: name tags ("Binance 14", "Vitalik Buterin"), all tag slugs, the entity they name. */
export interface SelfTags { names: string[]; slugs: string[]; entity?: string }

/**
 * The address's own side of every row it is on. Blockscout's address page carries no tags (measured
 * 2026-10-16: `metadata: null` and no public tags even on Binance 14), but every row tags both sides.
 */
export function selfTags(rows: any[], me: string): SelfTags | undefined {
  const names: string[] = [], slugs: string[] = [];
  let entity: string | undefined;
  for (const r of rows) {
    const s = r.from === me ? r._from : r.to === me ? r._to : undefined;
    if (!s) continue;
    for (const n of s.tags ?? []) if (!names.includes(n)) names.push(n);
    for (const x of s.slugs ?? []) if (!slugs.includes(x)) slugs.push(x);
    entity ??= s.entity;
  }
  if (!names.length && !slugs.length) return undefined;
  return entity ? { names, slugs, entity } : { names, slugs };
}

/**
 * One try at the internal transfers of a chain. Base answers vitalik.eth's in 43 s on its own and took
 * 59 s inside a full scan (measured in Chrome, 2026-10-16); at 30 s every scan of a long history came back
 * partial.
 */
export const INTERNAL_TIMEOUT_MS = 90_000;

/**
 * Share of the scan's time limit by which the side lists (internal transfers) give up. The funder and
 * deposit checks run after every chain is read and need the rest: on the bot's 65 s limit inside a 75 s
 * hard stop, a 90 s internal list was cut off from outside, and the scan lost its funder checks with it
 * (2026-10-17: orbiter1 and nick.eth in 5 of 28 bot scans). In the browser (150 s) the cap is 112 s, so
 * the 90 s above stands.
 */
export const SIDE_SHARE = 0.75;

/**
 * Ethereum's internal list on Blockscout can stall past a minute for a heavy wallet (orbiter1 and
 * nick.eth: over 90 s, the tail of every scan of them, measured 2026-10-17), while its second keyless
 * source (Routescan) gives the same newest page in 1 to 1.6 s. A chain with such a second source asks
 * it too once the first has not answered in this long, or has failed; the first answer counts. A first
 * answer in time never asks the second.
 *
 * 3 s, not 12: a light wallet waited the whole 12 s too. On jesse.base.eth Blockscout's
 * internal list never answered while Routescan gave it in 0.13 s once asked, so Ethereum took 12.2 s for
 * four reads of under 0.4 s each. Blockscout answers a normal wallet's internal list well within a second,
 * so 3 s asks the second source only when the first stalls.
 */
export const ALT_INTERNAL_AFTER_MS = 3_000;

/** `first`, and after `afterMs` without an answer (or at once when it fails) also `second()`: the first answer wins. */
function raceAfter<T>(first: Promise<T>, second: () => Promise<T>, afterMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false, firstFailed: { e: unknown } | null = null, secondState: 'idle' | 'running' | 'failed' = 'idle';
    const finish = (f: () => void) => { if (!settled) { settled = true; clearTimeout(timer); f(); } };
    const go = () => {
      if (settled || secondState !== 'idle') return;
      secondState = 'running';
      second().then((v) => finish(() => resolve(v)), () => { secondState = 'failed'; if (firstFailed) finish(() => reject(firstFailed!.e)); });
    };
    const timer = setTimeout(go, afterMs);
    first.then((v) => finish(() => resolve(v)), (e) => { firstFailed = { e }; if (secondState === 'failed') finish(() => reject(e)); else go(); });
  });
}

/** A transfer below this share of all the coin that came in before the first transaction is dust or a sprinkle, never what paid for it. */
export const FUNDING_SHARE = 0.1;

/** Arbitrum and the OP Stack show an L1 sender on L2 as its address plus this offset (address aliasing). */
const L1_ALIAS = 0x1111000000000000000000000000000000001111n;
export function l1Alias(a: string): string {
  return '0x' + ((BigInt(a) + L1_ALIAS) % (1n << 160n)).toString(16).padStart(40, '0');
}

/**
 * What paid for the first transaction this address signed on a chain. Nothing leaves a wallet without
 * its signature, so all the native coin that came in before that transaction (plain transfers and
 * contract payouts) was still there when it was signed. Of those transfers, the earliest one that on
 * its own covers what the network required the wallet to hold to send it (value plus gas limit times
 * gas price), counting only transfers of at least 10% of that total: dust and sprinkles are smaller,
 * and on a cheap chain dust covers the gas (0.0000029 ETH from a sprinkler, three months
 * after the 0.016 ETH that really paid). Undefined when no single transfer qualifies (several small
 * deposits), and when it came from the address itself through an L1 deposit (it funded itself).
 */
export function fundingOf(firstOwn: Transfer | undefined, incoming: Transfer[]): Transfer | undefined {
  if (!firstOwn) return undefined;
  const gas = (firstOwn.gasPrice ?? 0) * (firstOwn.gasLimit && Number.isFinite(firstOwn.gasLimit) ? firstOwn.gasLimit : 21000) / 1e9;
  const need = (firstOwn.amount + (Number.isFinite(gas) ? gas : 0)) * 0.99;
  const seen = new Set<string>();
  const before = incoming
    .filter((t) => t.dir === 'in' && !t.failed && t.kind !== 'token' && t.hash !== firstOwn.hash && t.amount > 0
      && (t.block < firstOwn.block || (t.block === firstOwn.block && t.timestamp <= firstOwn.timestamp)))
    // The newest and the oldest page can overlap: count each transfer once.
    .filter((t) => { const k = `${t.kind}:${t.hash}:${t.from}:${t.amount}`; return !seen.has(k) && !!seen.add(k); })
    .sort((a, b) => a.block - b.block || a.timestamp - b.timestamp || a.hash.localeCompare(b.hash));
  const total = before.reduce((s, t) => s + t.amount, 0);
  const paid = before.find((t) => t.amount >= need && t.amount >= total * FUNDING_SHARE);
  return paid && paid.from !== l1Alias(firstOwn.from) ? paid : undefined;
}

/**
 * A read failed this time on a chain the address may have used (the chain itself, or the oldest page
 * of a long history), so its first funding is unknown in this run only. Funding findings that pick one
 * chain out of all of them wait for it, so a failed run never shows another chain in its place.
 * A gap in the explorer's index is the same every run: it does not hold them back.
 */
export function fundingUnread(h: ChainHistory): boolean {
  const c = h.coverage;
  if (c.status === 'error') return (c.precheck?.sent ?? 1) > 0;
  return c.missing.some((m) => /^oldest transactions\b/.test(m));
}

/** The address signed at least one transaction on this chain. */
export const signedHere = (h: ChainHistory) => (h.nonce ?? 0) > 0 || h.ownCount > 0;

const lc = (s: unknown) => String(s ?? '').toLowerCase();

function units(raw: unknown, decimals: number): number {
  const s = String(raw ?? '0');
  if (!/^\d+$/.test(s)) return 0;
  if (decimals === 0) return Number(s);
  const pad = s.padStart(decimals + 1, '0');
  return Number(pad.slice(0, -decimals) + '.' + pad.slice(-decimals));
}

function dirOf(me: string, from: string, to: string): 'in' | 'out' | 'self' {
  if (from === me && to === me) return 'self';
  return from === me ? 'out' : 'in';
}

export function normTx(r: any, chain: ChainDef, me: string): Transfer {
  const from = lc(r.from), to = lc(r.to || r.contractAddress);
  const input = String(r.input ?? '0x');
  return {
    chainId: chain.id, hash: lc(r.hash), block: Number(r.blockNumber), timestamp: Number(r.timeStamp),
    from, to, kind: 'native', amount: units(r.value, 18), symbol: chain.native,
    dir: dirOf(me, from, to), failed: r.isError === '1' || r.txreceipt_status === '0',
    gasPrice: Number(r.gasPrice) / 1e9, gasLimit: Number(r.gas),
    methodId: input.length >= 10 ? input.slice(0, 10) : (r.methodId && r.methodId !== '0x' ? r.methodId : undefined),
    ...(r._blind ? { blind: true } : { isCall: input !== '0x' && input !== '' }),
    ...(r.maxPriorityFeePerGas != null ? { priorityFee: Number(r.maxPriorityFeePerGas) / 1e9 } : {}),
    ...withCp(r, dirOf(me, from, to)),
  };
}

function withCp(r: any, dir: 'in' | 'out' | 'self') {
  const cp = cpOf(r, dir);
  return cp ? { cp } : {};
}

export function normInternal(r: any, chain: ChainDef, me: string): Transfer {
  const from = lc(r.from), to = lc(r.to || r.contractAddress);
  return {
    chainId: chain.id, hash: lc(r.transactionHash || r.hash), block: Number(r.blockNumber), timestamp: Number(r.timeStamp),
    from, to, kind: 'internal', amount: units(r.value, 18), symbol: chain.native,
    dir: dirOf(me, from, to), failed: r.isError === '1', ...withCp(r, dirOf(me, from, to)),
  };
}

export function normToken(r: any, chain: ChainDef, me: string): Transfer {
  const from = lc(r.from), to = lc(r.to);
  const dec = Number(r.tokenDecimal);
  return {
    chainId: chain.id, hash: lc(r.hash), block: Number(r.blockNumber), timestamp: Number(r.timeStamp),
    from, to, kind: 'token', amount: Number.isFinite(dec) && r.tokenDecimal !== '' ? units(r.value, dec) : 0,
    symbol: String(r.tokenSymbol ?? '').slice(0, 24), token: lc(r.contractAddress),
    dir: dirOf(me, from, to), failed: false, ...withCp(r, dirOf(me, from, to)), ...(r._blind ? { blind: true } : {}),
    ...(r._priced !== undefined ? { priced: !!r._priced } : {}),
    ...(Number.isFinite(r._holders) ? { holders: r._holders } : {}),
  };
}

export interface FetchLimits {
  maxTx: number;
  maxToken: number;
  maxInternal: number;
  /** Skip the nonce + balance check and always ask the explorer. */
  noPrecheck?: boolean;
  /** Side lists (internal transfers) give up by this time (ms since epoch); see SIDE_SHARE. */
  sideBy?: number;
  /** When a slow internal list also asks the chain's second keyless source (tests); see ALT_INTERNAL_AFTER_MS. */
  altInternalAfterMs?: number;
  /**
   * True once the scan knows the address is no person (see QUICK_ROWS). Asked at the start of each list and
   * before each next page, since the scan can learn it while this chain reads.
   */
  quick?: () => boolean;
  /** Resolves when `quick()` turns true: a side list still in flight is then not waited for. */
  quickNow?: Promise<void>;
  /** Told what this chain saw first: its quick check, then each page of its two main lists. */
  saw?: (x: { chainId: ChainId; pre?: { nonce: number; code?: boolean }; rows?: any[] }) => void;
  /**
   * Optional time budget per chain for paging, ms. Off by default: a list cut by time depends on how
   * fast the explorer was, so two scans of one wallet would read different data. When set and hit,
   * the chain is marked `partial`.
   */
  chainBudgetMs?: number;
}

/** Nonce, native balance and code from the chain's public RPC, in one batch. */
export async function presence(http: Http, rpc: string, me: string): Promise<{ nonce: number; balance: bigint; code?: boolean }> {
  const body = JSON.stringify([
    { jsonrpc: '2.0', id: 1, method: 'eth_getTransactionCount', params: [me, 'latest'] },
    { jsonrpc: '2.0', id: 2, method: 'eth_getBalance', params: [me, 'latest'] },
    { jsonrpc: '2.0', id: 3, method: 'eth_getCode', params: [me, 'latest'] },
  ]);
  const r = await http.getJson(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  const get = (id: number) => (Array.isArray(r) ? r.find((x: any) => x?.id === id)?.result : undefined);
  const n = get(1), b = get(2), c = get(3);
  if (typeof n !== 'string' || typeof b !== 'string') throw new Error('bad rpc answer');
  // An EIP-7702 delegation (0xef0100 + address) is a wallet, not a contract.
  const code = typeof c === 'string' ? c !== '0x' && c !== '0x0' && !/^0xef0100/i.test(c) : undefined;
  return { nonce: parseInt(n, 16), balance: BigInt(b), ...(code !== undefined ? { code } : {}) };
}

/** Read one chain. Never throws: errors land in coverage. */
export async function fetchChain(http: Http, primary: ChainDef, me: string, lim: FetchLimits): Promise<ChainHistory> {
  const t0 = Date.now();
  let chain = primary;
  const traces = chain.traces !== false;
  const coverage: ChainCoverage = {
    chainId: chain.id, name: chain.name, status: 'scanned', source: chain.source.kind,
    txCount: 0, tokenTransferCount: 0, internalTransfers: traces ? 'full' : 'none',
    truncated: false, limitations: [...(chain.limits ?? [])], missing: [], durationMs: 0,
  };
  let pre: { nonce: number; balance: bigint; code?: boolean } | null = null;
  const empty = (): ChainHistory => ({ chain, txs: [], internal: [], tokens: [], ownCount: 0, truncated: false, coverage, ...(pre ? { nonce: pre.nonce, code: pre.code } : {}) });
  // An address that is no person reads only what its card needs (QUICK_ROWS), from the moment the scan knows it.
  const quick = () => lim.quick?.() === true;
  try {
    if (chain.rpc && !lim.noPrecheck) {
      const p = pre = await presence(http, chain.rpc, me).catch(() => null);
      if (p) {
        coverage.precheck = { sent: p.code ? 0 : p.nonce, holds: p.balance > 0n };
        lim.saw?.({ chainId: chain.id, pre: p });
      }
      if (p && p.nonce === 0 && p.balance === 0n) {
        coverage.status = 'no_activity';
        coverage.limitations.push(`Quick check only: no transaction sent and no ${chain.native} held. Tokens that were only received are not listed.`);
        coverage.durationMs = Date.now() - t0;
        return empty();
      }
    }
    // Fixed page caps, so the same wallet always reads the same rows. Retries with backoff live in http.ts.
    const deadline = lim.chainBudgetMs !== undefined ? Date.now() + lim.chainBudgetMs : undefined;
    const main = { sort: 'desc' as const, deadline, timeoutMs: 15000, stop: quick, onPage: (rows: any[]) => lim.saw?.({ chainId: chain.id, rows }) };
    // Internal transfers are slow on big addresses: page 1 takes 12 to 14 s on OP for a wallet like vitalik.eth (2026-10-16).
    const sideMs = lim.sideBy !== undefined ? Math.max(2000, Math.min(INTERNAL_TIMEOUT_MS, lim.sideBy - Date.now())) : INTERNAL_TIMEOUT_MS;
    const side = { sort: 'desc' as const, deadline, timeoutMs: sideMs, retries: 1, timeoutRetries: 0 };
    const list = (c: ChainDef) => accountList(http, c, 'txlist', me, { ...main, offset: quick() ? QUICK_ROWS : lim.maxTx });
    // The internal list, raced against the chain's second keyless source when it is slow (Ethereum).
    const internalOf = (c: ChainDef): Promise<Rows> => {
      if (!c.alt || keyed(c.alt) || c.source.kind !== 'blockscout') return accountList(http, c, 'txlistinternal', me, { ...side, offset: lim.maxInternal });
      // Once the race is decided the slow list is not waited for, so it gives its place on the host back: Blockscout
      // took 36 to 57 s for Ethereum's internal list on 2026-10-21 while Routescan answered in 2 to 5 s, and the request
      // it no longer needed held one of the host's four places all that time (the funder checks queued behind it).
      const done = new AbortController();
      const first = accountList(http, c, 'txlistinternal', me, { ...side, offset: lim.maxInternal, signal: done.signal });
      const alt: ChainDef = { ...c, source: c.alt };
      const won = raceAfter(first, () => accountList(http, alt, 'txlistinternal', me, { sort: 'desc', deadline, timeoutMs: 15000, retries: 1, timeoutRetries: 0, offset: lim.maxInternal }), lim.altInternalAfterMs ?? ALT_INTERNAL_AFTER_MS);
      won.then(() => done.abort(), () => {});
      return won;
    };
    // Start all three together; on a refusal of the main list, switch source and restart.
    // A chain whose explorer is slow on this one list waits longer for a page, once (ChainDef.tokenPageMs).
    const tokens$ = () => accountList(http, chain, 'tokentx', me, { ...main, ...(chain.tokenPageMs ? { timeoutMs: chain.tokenPageMs, timeoutRetries: 0 } : {}), offset: quick() ? QUICK_ROWS : lim.maxToken });
    const internal$ = () => (traces && !quick() ? internalOf(chain) : Promise.resolve([] as Rows));
    // A source that gives one call per turn (Etherscan without a key): for an address that is no person its
    // token list waits until the transactions turn out empty, the only case its card reads it, so it never takes a
    // turn from them (USDC took 5 turns, 21 s, for one list of 50 on such a source).
    const paced = chain.source.kind === 'etherscan' && !!chain.source.minGapMs;
    const later = quick() && paced;
    let tokP = later ? Promise.resolve([] as Rows) : tokens$();
    let intP = internal$();
    // Handled here, read below: a refused main list must not leave these two as unhandled rejections.
    tokP.catch(() => {}); intP.catch(() => {});
    let first: Rows;
    try {
      first = await list(chain);
    } catch (e) {
      const alt = chain.alt;
      if (!(alt && refused(e))) throw e;
      chain = { ...chain, source: alt };
      coverage.source = alt.kind;
      first = await list(chain);
      tokP = tokens$();
      intP = internal$();
      tokP.catch(() => {}); intP.catch(() => {});
    }
    if (later && first.length === 0) { tokP = tokens$(); tokP.catch(() => {}); }
    // The oldest page of a long history starts as soon as the main list says it is long: it does not wait for the slow internal list.
    const oldTxP = !quick() && (first.length >= lim.maxTx || first.cut) ? accountList(http, chain, 'txlist', me, { sort: 'asc', offset: 50, timeoutMs: 15000 }) : Promise.resolve([] as Rows);
    oldTxP.catch(() => {});
    // Once the scan knows the address is no person, a list its card does not need is not waited for (quickShape
    // drops it either way): the internal list, the oldest page, and the token transfers where it has transactions.
    const orQuick = (p: Promise<Rows>): Promise<Rows> => (lim.quickNow ? Promise.race([p, lim.quickNow.then(() => [] as Rows)]) : p);
    const [txR, tokR, intR] = await Promise.allSettled([Promise.resolve(first), first.length ? orQuick(tokP) : tokP, orQuick(intP)]);
    if (txR.status === 'rejected') throw txR.reason;
    const txs = txR.value.map((r) => normTx(r, chain, me));
    const tokens = tokR.status === 'fulfilled' ? tokR.value.map((r) => normToken(r, chain, me)) : [];
    const internal = intR.status === 'fulfilled' ? intR.value.map((r) => normInternal(r, chain, me)) : [];
    if (tokR.status === 'rejected') {
      coverage.limitations.push('Token transfers could not be read on this chain.');
      coverage.missing.push(`token transfers (${reasonOf(tokR.reason)})`);
    }
    if (intR.status === 'rejected') {
      coverage.internalTransfers = 'not_fetched';
      coverage.missing.push(`internal transfers (${reasonOf(intR.reason)})`);
    }

    // A list cut short (its deadline, or a later page that failed) keeps what it read. A cut token list says so on its own
    // line, so it counts as a gap in the tokens (a partial score), never as unread transactions.
    const tokCut = tokR.status === 'fulfilled' && !!tokR.value.cut;
    const txCut = !!(first.cut || (intR.status === 'fulfilled' && intR.value.cut));
    const cut = txCut || tokCut;
    const truncTx = txs.length >= lim.maxTx || !!first.cut;
    const truncInt = internal.length >= lim.maxInternal || (intR.status === 'fulfilled' && !!intR.value.cut);
    const truncated = truncTx || tokens.length >= lim.maxToken || truncInt || cut;
    // The oldest page, so funding is visible even for a long history.
    let oldTx: Transfer[] = [], oldInt: Transfer[] = [], oldFailed = false;
    // Blockscout's internal-transactions list cannot be sorted oldest first (422 "Unexpected field: order").
    const oldIntPossible = chain.source.kind !== 'blockscout';
    if (truncInt && !oldIntPossible) coverage.limitations.push('Only the newest internal transfers can be read here: funding paid out by a contract long ago may not show.');
    if (truncTx || (truncInt && oldIntPossible)) {
      const [a, b] = await Promise.allSettled([
        truncTx ? orQuick(oldTxP) : Promise.resolve([]),
        truncInt && oldIntPossible && !quick() ? accountList(http, chain, 'txlistinternal', me, { sort: 'asc', offset: 50, timeoutMs: 15000, retries: 2 }) : Promise.resolve([]),
      ]);
      if (a.status === 'fulfilled') oldTx = a.value.map((r) => normTx(r, chain, me));
      if (b.status === 'fulfilled') oldInt = b.value.map((r) => normInternal(r, chain, me));
      const old = a.status === 'rejected' ? a.reason : b.status === 'rejected' ? b.reason : null;
      if (old) { oldFailed = true; coverage.missing.push(`oldest transactions, so the first funding is unknown (${reasonOf(old)})`); }
    }
    // What the wallet itself signed, and what paid for the first of those (see fundingOf).
    const own = new Map<string, Transfer>();
    for (const t of [...txs, ...oldTx]) if (t.from === me && !own.has(t.hash)) own.set(t.hash, t);
    const firstOwn = [...own.values()].sort((a, b) => a.block - b.block || a.timestamp - b.timestamp)[0];
    // In a long history the first transaction must be on the oldest page; else it lies in the part between the pages.
    const firstKnown = !truncTx || oldTx.some((t) => t.from === me);
    if (truncTx && !oldFailed && !firstKnown) coverage.limitations.push('Long history: the first transaction this address signed here is older than what was read, so what paid for it is unknown.');
    const firstFunding = firstKnown && !oldFailed ? fundingOf(firstOwn, [...txs, ...oldTx, ...internal, ...oldInt]) : undefined;

    const all = [...txs, ...tokens, ...internal];
    coverage.txCount = txs.length;
    coverage.tokenTransferCount = tokens.length;
    coverage.truncated = truncated;
    if (truncTx || truncInt || txCut || tokens.length >= lim.maxToken) coverage.limitations.push(txCut
      ? `Long history on a slow explorer: the newest ${txs.length} transactions were read in the time limit, plus the oldest ones for funding.`
      : `Long history: the newest ${lim.maxTx} transactions were read, plus the oldest ones for funding.`);
    // A gap in the explorer's index: the chain says this address sent transactions, the full list
    // read here shows none of them (or far fewer). Never "no activity": the history is unread.
    // (A contract's nonce counts the contracts it created, so the check is for wallets only.)
    const sent = pre && !pre.code ? pre.nonce : 0;
    const gap = sent > 0 && !truncTx && (own.size === 0 || (sent - own.size >= 3 && own.size < sent * 0.9));
    if (gap) coverage.missing.push(`transactions (the explorer lists ${own.size === 0 ? 'none' : own.size} of the ${sent} this address sent here)`);
    if (all.length === 0 && !gap) coverage.status = 'no_activity';
    else if (all.length) {
      // Real times only: rows without one leave the chain's days unknown, never Infinity (the min of nothing), which
      // no date can show (BNB Smart Chain, read before NodeReal's time field was right).
      const ts = all.map((t) => t.timestamp).filter((x) => x > 0);
      const firsts = [...ts, ...(firstOwn ? [firstOwn.timestamp] : []), ...(firstFunding ? [firstFunding.timestamp] : [])].filter((x) => x > 0);
      coverage.firstSeen = firsts.length ? Math.min(...firsts) : undefined;
      coverage.lastSeen = ts.length ? Math.max(...ts) : undefined;
    }
    if (tokCut) coverage.limitations.push(`Many token transfers on a slow explorer: the newest ${tokens.length} were read in the time limit.`);
    if (txCut) coverage.missing.push('older transactions (time limit)');
    if (tokCut) coverage.missing.push('older token transfers (time limit)');
    if (coverage.missing.length && (coverage.status === 'scanned' || coverage.status === 'no_activity')) coverage.status = 'partial';
    coverage.durationMs = Date.now() - t0;
    const self = selfTags([...txR.value, ...(tokR.status === 'fulfilled' ? tokR.value : []), ...(intR.status === 'fulfilled' ? intR.value : [])], me);
    const h: ChainHistory = {
      ...(self ? { self } : {}),
      chain, txs, internal, tokens, ownCount: own.size, firstOwn, firstFunding, truncated, coverage,
      ...(gap ? { indexGap: { listed: own.size, sent } } : {}),
      ...(pre ? { nonce: pre.nonce, ...(pre.code !== undefined ? { code: pre.code } : {}) } : {}),
    };
    return quick() ? quickShape(h) : h;
  } catch (e) {
    // Not a failure of this scan: a chain that only the relay can read, and the relay cannot serve it
    // today (no key set up, or its free daily quota spent until 00:00 UTC). A retry would not help, so
    // it is skipped with the reason, never "not read". A keyless chain that only fell
    // back to the relay stays a failed read: its own explorer answers again after its window.
    if (e instanceof HttpError && (e.kind === 'needs_key' || (e.kind === 'quota' && keyed(chain.source)))) {
      coverage.status = 'skipped';
      coverage.skipReason = e.kind === 'quota' ? 'quota' : 'no_key';
      coverage.limitations.push(e.kind === 'quota'
        ? `Not scanned: ${chain.name} is read through the Nymra relay, whose daily quota is spent. It comes back at 00:00 UTC.`
        : `Not scanned: ${chain.name} is read through the Nymra relay, which has no key for it.`);
      coverage.durationMs = Date.now() - t0;
      return empty();
    }
    coverage.status = 'error';
    coverage.error = reasonOf(e);
    coverage.durationMs = Date.now() - t0;
    return empty();
  }
}

/** Chains where the address signed at least one transaction: what it did itself. */
/**
 * A chain read whole where its explorer's index has a gap. Polygon's Blockscout had 98% of its blocks on 2026-10-19 and
 * listed none of the 130 transactions nick.eth sent there, so the scan held back its score. When the first read
 * finds such a gap and the chain has a gap source (`gapAlt`: Etherscan V2 through the relay, where the key lives),
 * the chain is read once more from there. Only a second read that closes the gap takes the place of the first;
 * a relay without that key (the chain comes back skipped), a failure or a second gap keeps the first read and its
 * gap as they were, so the result never claims more than was read.
 */
export async function fetchChainWhole(http: Http, chain: ChainDef, me: string, lim: FetchLimits): Promise<ChainHistory> {
  const first = await fetchChain(http, chain, me, lim);
  if (!first.indexGap || !chain.gapAlt) return first;
  const second = await fetchChain(http, { ...chain, source: chain.gapAlt, alt: undefined }, me, lim).catch(() => null);
  if (!second || second.indexGap || second.coverage.status === 'skipped' || second.coverage.status === 'error') return first;
  const { listed, sent } = first.indexGap;
  second.coverage.limitations.push(`${chain.name}'s own explorer lists ${listed === 0 ? 'none' : listed} of the ${sent} transactions this address sent here, so this chain was read from Etherscan.`);
  return second;
}

export function active(h: ChainHistory[]): ChainHistory[] {
  return h.filter(signedHere);
}

/** Chains where others sent to the address but it never signed anything: not a trail it left. */
export function receivedOnly(h: ChainHistory[]): ChainHistory[] {
  return h.filter((x) => !signedHere(x) && x.txs.length + x.tokens.length + x.internal.length > 0);
}
