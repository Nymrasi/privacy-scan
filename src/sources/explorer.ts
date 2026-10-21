// Address history from the explorers.
//   Blockscout: REST `/api/v2/addresses/<a>/...` (keyless 180 requests a minute per instance).
//     Its Etherscan-compatible `/api` allows only ~10 an hour per IP, so it is not used.
//   Routescan: Etherscan-compatible `/api`, keyless.
//   Etherscan V2: the same format with `chainid`; keyless at one request per 5 s, or with the relay's key.
//   NodeReal (BNB Smart Chain): JSON-RPC `nr_getTransactionByAddress`, through the relay.
//   Alchemy (Base and Polygon PoS on a server): JSON-RPC `alchemy_getAssetTransfers`, through the relay.
// All come back as Etherscan-shaped rows, so history.ts normalizes one format.
import { keyed, type ChainDef } from '../chains.ts';
import { HttpError, type Http } from './http.ts';

export type AccountAction = 'txlist' | 'txlistinternal' | 'tokentx';

export interface ListQuery {
  sort?: 'asc' | 'desc';
  /** Max rows wanted. */
  offset?: number;
  /** Desc only: rows at or above this block are skipped; stops once below startblock. */
  startblock?: number;
  endblock?: number;
  /** Blockscout only: only transactions sent by (`from`) or to (`to`) the address. */
  filter?: 'from' | 'to';
  /** Stop paging after this time (ms since epoch); rows read so far are kept and the list is marked `cut`. */
  deadline?: number;
  timeoutMs?: number;
  retries?: number;
  timeoutRetries?: number;
  /** Asked before each page after the first: true stops the list there (the address is no person, see history.ts `quick`). */
  stop?: () => boolean;
  /** Told the rows of each page as it comes in (Etherscan shape), so the scan can learn what the address is early. */
  onPage?: (rows: any[]) => void;
  /** Blockscout only: the list is no longer needed (see CallOptions.signal); it stops and gives its place on the host back. */
  signal?: AbortSignal;
}

/** A list cut short by its deadline carries `cut = true`. */
export type Rows = any[] & { cut?: boolean };

const V2_PAGE = 50;
/** Retries on a paced keyless source (Etherscan V2 without a key), whose refusals pass in a turn. */
export const KEYLESS_RETRIES = 6;

export function apiUrl(chain: ChainDef, action: AccountAction, address: string, q: ListQuery = {}): string {
  const p = new URLSearchParams({
    module: 'account', action, address,
    page: '1', offset: String(q.offset ?? 100), sort: q.sort ?? 'desc',
  });
  if (q.startblock !== undefined) p.set('startblock', String(q.startblock));
  if (q.endblock !== undefined) p.set('endblock', String(q.endblock));
  if (chain.source.kind === 'etherscan') p.set('chainid', String(chain.source.chainid));
  return `${chain.source.api.replace(/\/$/, '')}?${p}`;
}

const hexOrDec = (v: unknown): string => {
  if (typeof v === 'number') return String(v);
  const s = String(v ?? '0');
  return /^0x[0-9a-f]+$/i.test(s) ? BigInt(s).toString() : /^\d+$/.test(s) ? s : '0';
};
const unixOf = (v: unknown): string => {
  const s = String(v ?? '');
  if (/^0x[0-9a-f]+$/i.test(s) || /^\d+$/.test(s)) return hexOrDec(s);
  const t = Date.parse(s);
  return Number.isFinite(t) ? String(Math.floor(t / 1000)) : '0';
};

/**
 * NodeReal transfer -> Etherscan-shaped row. It carries no calldata: `_blind` tells history.ts. Its time is
 * `blockTimeStamp`, with a capital S (unix seconds, as NodeReal answers): read as `blockTimestamp`, every BNB Smart
 * Chain row had time 0, so its days were unknown and a wallet that sent nothing there was first seen at Infinity,
 * which the Terminal could not draw (Bybit Exploiter 1).
 */
export function noderealRow(action: AccountAction, x: any): any {
  const base = { blockNumber: hexOrDec(x.blockNum), timeStamp: unixOf(x.blockTimeStamp), hash: String(x.hash ?? ''), from: lc(x.from), to: lc(x.to), value: hexOrDec(x.value), _blind: true };
  if (action === 'tokentx') {
    return { ...base, tokenDecimal: x.decimal == null ? '' : hexOrDec(x.decimal), tokenSymbol: String(x.asset ?? ''), contractAddress: lc(x.contractAddress) };
  }
  return { ...base, gas: '', gasPrice: hexOrDec(x.gasPrice), isError: String(x.receiptsStatus) === '0' ? '1' : '0' };
}

async function noderealList(http: Http, chain: ChainDef, action: AccountAction, address: string, q: ListQuery): Promise<Rows> {
  // This source has no internal transfers (the chain's coverage says so) and no wide block windows.
  if (action === 'txlistinternal') return [];
  const want = q.offset ?? 100;
  const out: Rows = [];
  let pageKey: string | undefined;
  do {
    const params: Record<string, unknown> = {
      category: [action === 'tokentx' ? '20' : 'external'], address, order: q.sort === 'asc' ? 'asc' : 'desc',
      maxCount: '0x' + Math.min(1000, want - out.length).toString(16), excludeZeroValue: false,
      ...(q.filter ? { addressType: q.filter } : {}), ...(pageKey ? { pageKey } : {}),
    };
    const j = await http.getJson(chain.source.api, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'nr_getTransactionByAddress', params: [params] }) }, { timeoutMs: q.timeoutMs, retries: q.retries, via: 'relay' });
    if (j?.error) throw new Error(`${chain.name}: ${String(j.error.message ?? 'source error').slice(0, 120)}`);
    const rows: any[] = Array.isArray(j?.result?.transfers) ? j.result.transfers : [];
    const from = out.length;
    for (const x of rows) { out.push(noderealRow(action, x)); if (out.length >= want) break; }
    if (out.length > from) q.onPage?.(out.slice(from));
    pageKey = rows.length && j?.result?.pageKey ? String(j.result.pageKey) : undefined;
  } while (pageKey && out.length < want && !q.stop?.());
  return out;
}

/** Alchemy transfer -> Etherscan-shaped row. Like NodeReal it carries no calldata: `_blind` tells history.ts. */
export function alchemyRow(action: AccountAction, x: any): any {
  const raw = x.rawContract ?? {};
  const base = { blockNumber: hexOrDec(x.blockNum), timeStamp: unixOf(x.metadata?.blockTimestamp), hash: String(x.hash ?? ''), from: lc(x.from), to: lc(x.to), value: hexOrDec(raw.value), _blind: true };
  if (action === 'tokentx') {
    return { ...base, tokenDecimal: raw.decimal == null ? '' : hexOrDec(raw.decimal), tokenSymbol: String(x.asset ?? ''), contractAddress: lc(raw.address) };
  }
  if (action === 'txlistinternal') return { ...base, transactionHash: base.hash, isError: '0' };
  return { ...base, gas: '', gasPrice: '', isError: '0' };
}

const hexOf = (n: number) => '0x' + Math.max(0, Math.floor(n)).toString(16);

async function alchemyList(http: Http, chain: ChainDef, action: AccountAction, address: string, q: ListQuery): Promise<Rows> {
  const want = q.offset ?? 100;
  const order = q.sort === 'asc' ? 'asc' : 'desc';
  const category = [action === 'tokentx' ? 'erc20' : action === 'txlistinternal' ? 'internal' : 'external'];
  // One call filters on the sender or on the receiver: both together mean "from A to B". So a list is two
  // calls, one per side, unless the caller wants one side only (a funder's sends).
  const sides = q.filter === 'from' ? ['fromAddress'] : q.filter === 'to' ? ['toAddress'] : ['fromAddress', 'toAddress'];
  const lists = await Promise.all(sides.map(async (side) => {
    const out: Rows = [];
    let pageKey: string | undefined;
    do {
      if (q.deadline !== undefined && out.length > 0 && Date.now() > q.deadline) { out.cut = true; break; }
      const params = {
        fromBlock: hexOf(q.startblock ?? 0), toBlock: q.endblock !== undefined ? hexOf(q.endblock) : 'latest', [side]: address, category, order,
        // Alchemy leaves out every transfer of value 0 unless asked: a contract call without value is a transaction too.
        withMetadata: true, excludeZeroValue: false, maxCount: hexOf(Math.min(1000, want - out.length)), ...(pageKey ? { pageKey } : {}),
      };
      const j = await http.getJson(chain.source.api, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'alchemy_getAssetTransfers', params: [params] }) }, { timeoutMs: q.timeoutMs, retries: q.retries, timeoutRetries: q.timeoutRetries, via: 'relay' });
      if (j?.error) throw new Error(`${chain.name}: ${String(j.error.message ?? 'Alchemy error').slice(0, 120)}`);
      const rows: any[] = Array.isArray(j?.result?.transfers) ? j.result.transfers : [];
      for (const x of rows) { out.push(x); if (out.length >= want) break; }
      pageKey = rows.length && j?.result?.pageKey ? String(j.result.pageKey) : undefined;
    } while (pageKey && out.length < want);
    return out;
  }));
  // A transfer to itself is on both sides. Each side holds its own newest (or oldest) `want`, so the first
  // `want` of the two merged are the list's own; a stable sort keeps the same rows in the same order.
  const seen = new Set<string>();
  const all: any[] = [];
  for (const x of lists.flat()) {
    const id = String(x.uniqueId ?? `${x.hash}:${x.category}:${x.from}:${x.to}`);
    if (!seen.has(id)) { seen.add(id); all.push(x); }
  }
  const block = (x: any) => Number(hexOrDec(x.blockNum));
  all.sort((a, b) => (order === 'asc' ? block(a) - block(b) : block(b) - block(a)));
  const out: Rows = all.slice(0, want).map((x) => alchemyRow(action, x));
  if (lists.some((l) => l.cut)) out.cut = true;
  return out;
}

const lc = (s: unknown) => (typeof s === 'string' ? s.toLowerCase() : '');
const unix = (iso: unknown) => (typeof iso === 'string' ? Math.floor(Date.parse(iso) / 1000) : 0);

/** Public tags Blockscout attaches to an address object: names and generic slugs. */
export function v2Tags(a: any): { names: string[]; slugs: string[]; entity?: string } {
  const tags: any[] = [...(a?.metadata?.tags ?? []), ...(a?.public_tags ?? [])];
  const names = tags.filter((t) => t?.tagType === 'name' && t.name).map((t) => String(t.name));
  const slugs = tags.map((t) => String(t?.slug ?? '')).filter(Boolean);
  const entity = tags.map((t) => t?.meta?.main_entity).find(Boolean);
  return { names, slugs, ...(entity ? { entity: String(entity) } : {}) };
}

function side(a: any) {
  if (!a) return {};
  const t = v2Tags(a);
  return { isContract: !!a.is_contract && a.proxy_type !== 'eip7702', tags: t.names, slugs: t.slugs, entity: t.entity, scam: !!a.is_scam };
}

function v2Row(action: AccountAction, x: any): any {
  if (action === 'txlist') {
    const input = String(x.raw_input ?? '0x');
    return {
      blockNumber: String(x.block_number), timeStamp: String(unix(x.timestamp)), hash: x.hash,
      from: lc(x.from?.hash), to: lc(x.to?.hash ?? x.created_contract?.hash), value: String(x.value ?? '0'),
      gas: String(x.gas_limit ?? ''), gasPrice: String(x.gas_price ?? ''), maxPriorityFeePerGas: x.max_priority_fee_per_gas ?? undefined,
      input, methodId: input.slice(0, 10), isError: x.status === 'error' ? '1' : '0',
      _from: side(x.from), _to: side(x.to ?? x.created_contract),
    };
  }
  if (action === 'tokentx') {
    return {
      blockNumber: String(x.block_number), timeStamp: String(unix(x.timestamp)), hash: x.transaction_hash,
      from: lc(x.from?.hash), to: lc(x.to?.hash), value: String(x.total?.value ?? '0'),
      tokenDecimal: String(x.total?.decimals ?? x.token?.decimals ?? ''), tokenSymbol: String(x.token?.symbol ?? ''),
      contractAddress: lc(x.token?.address_hash ?? x.token?.address), _from: side(x.from), _to: side(x.to),
      // A token with a market price is a real, listed token. Address-poisoning fakes ("USDT" clones,
      // look-alike symbols) have none, and 0 holders (measured on a Revolut deposit address, 2026-10-16).
      _priced: x.token ? x.token.exchange_rate != null && x.token.exchange_rate !== '' : undefined,
      _holders: x.token ? Number(x.token.holders_count ?? x.token.holders) : undefined,
    };
  }
  return {
    blockNumber: String(x.block_number), timeStamp: String(unix(x.timestamp)), transactionHash: x.transaction_hash,
    from: lc(x.from?.hash), to: lc(x.to?.hash ?? x.created_contract?.hash), value: String(x.value ?? '0'),
    isError: x.success === false ? '1' : '0', type: x.type, _from: side(x.from), _to: side(x.to ?? x.created_contract),
  };
}

async function blockscoutList(http: Http, chain: ChainDef, action: AccountAction, address: string, q: ListQuery): Promise<Rows> {
  const path = action === 'txlist' ? 'transactions' : action === 'tokentx' ? 'token-transfers' : 'internal-transactions';
  const base = `${chain.source.api.replace(/\/$/, '')}/api/v2/addresses/${address}/${path}`;
  const want = q.offset ?? V2_PAGE;
  const fixed = new URLSearchParams();
  if (action === 'tokentx') fixed.set('type', 'ERC-20');
  if (q.filter && action === 'txlist') fixed.set('filter', q.filter);
  // The internal-transactions list takes no `sort` or `order` (422 "Unexpected field: order", measured
  // 2026-10-15): it is newest first only. history.ts never asks it for the oldest page; this keeps it so.
  if (q.sort === 'asc') {
    if (action === 'txlistinternal') throw new HttpError(400, 'Blockscout cannot list internal transfers oldest first', 'http');
    fixed.set('sort', 'block_number'); fixed.set('order', 'asc');
  }
  // No `items_count` in a request: Blockscout v11 reads it as a cursor offset (`items_count=100` on a
  // first page returns nothing), v12 (rolling out since 7 October 2026) as the page size and rejects 0.
  let next: Record<string, unknown> | null = q.endblock !== undefined && q.sort !== 'asc'
    ? { block_number: q.endblock + 1, index: 0 } : {};
  const out: Rows = [];
  while (next && out.length < want) {
    if (q.deadline !== undefined && out.length > 0 && Date.now() > q.deadline) { out.cut = true; break; }
    if (out.length > 0 && q.stop?.()) break;
    const p = new URLSearchParams(fixed);
    for (const [k, v] of Object.entries(next)) if (v !== null && v !== undefined) p.set(k, String(v));
    const qs = p.toString();
    let j: any;
    try {
      j = await http.getJson(qs ? `${base}?${qs}` : base, undefined, { timeoutMs: q.timeoutMs, retries: q.retries, timeoutRetries: q.timeoutRetries, ...(q.signal ? { signal: q.signal } : {}) });
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) return out; // address never seen
      throw e;
    }
    const items: any[] = Array.isArray(j?.items) ? j.items : [];
    let done = false;
    const from = out.length;
    for (const x of items) {
      if (q.startblock !== undefined && q.sort !== 'asc' && Number(x.block_number) < q.startblock) { done = true; break; }
      out.push(v2Row(action, x));
      if (out.length >= want) break;
    }
    if (out.length > from) q.onPage?.(out.slice(from));
    next = done ? null : j?.next_page_params ?? null;
  }
  return out;
}

/** Raw rows (Etherscan shape), or [] when the explorer says there are none. Throws on a real error. */
export async function accountList(http: Http, chain: ChainDef, action: AccountAction, address: string, q: ListQuery = {}): Promise<Rows> {
  if (chain.source.kind === 'blockscout') return blockscoutList(http, chain, action, address, q);
  if (chain.source.kind === 'nodereal') return noderealList(http, chain, action, address, q);
  if (chain.source.kind === 'alchemy') return alchemyList(http, chain, action, address, q);
  const gap = chain.source.kind === 'etherscan' ? chain.source.minGapMs : undefined;
  // A keyless source that refuses about half of its calls for a moment gets more tries (7: 1 in 128 left).
  const tries = gap ? Math.max(q.retries ?? 0, KEYLESS_RETRIES) : q.retries;
  const j = await http.getJson(apiUrl(chain, action, address, q), undefined, { timeoutMs: q.timeoutMs, retries: tries, ...(keyed(chain.source) ? { via: 'relay' as const } : {}), ...(gap ? { minGapMs: gap } : {}) });
  if (Array.isArray(j?.result)) {
    if (j.result.length) q.onPage?.(j.result);
    return j.result;
  }
  const msg = String(j?.message ?? '') + ' ' + String(j?.result ?? '');
  if (/no (transactions|records|token transfers|internal transactions)|not found/i.test(msg)) return [];
  throw new Error(`${chain.name}: ${msg.trim().slice(0, 120) || 'unexpected answer'}`);
}

/** Blockscout `/api/v2/addresses/<a>`: ENS primary name, public tags, contract flag. */
export async function blockscoutAddress(http: Http, chain: ChainDef, address: string): Promise<any | null> {
  if (chain.source.kind !== 'blockscout') return null;
  return http.getJson(`${chain.source.api.replace(/\/$/, '')}/api/v2/addresses/${address}`);
}
