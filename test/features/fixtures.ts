// Sessions for the feature tests, built the way scan.ts and history.ts build them. No network.
import { CHAIN_BY_ID } from '../../src/chains.ts';
import { fundingOf, type ChainHistory, type Transfer } from '../../src/history.ts';
import { lookupKey, type LookupCall, type ScanSession } from '../../src/session.ts';
import type { Incomplete } from '../../src/types.ts';

/** One chain's history as seen by `me`: its own transactions, and what paid for the first (history.ts). */
export function chainHist(me: string, chainId: number, rows: Transfer[], extra: Partial<ChainHistory> = {}): ChainHistory {
  const chain = CHAIN_BY_ID.get(chainId)!;
  const txs = rows.filter((r) => r.kind === 'native'), tokens = rows.filter((r) => r.kind === 'token'), internal = rows.filter((r) => r.kind === 'internal');
  const own = txs.filter((t) => t.from === me).sort((a, b) => a.block - b.block || a.timestamp - b.timestamp);
  return {
    chain, txs, tokens, internal, ownCount: own.length, firstOwn: own[0], firstFunding: fundingOf(own[0], rows), truncated: false,
    coverage: {
      chainId, name: chain.name, status: rows.length ? 'scanned' : 'no_activity', source: 'blockscout', txCount: txs.length, tokenTransferCount: tokens.length,
      internalTransfers: 'full', truncated: false, limitations: [], missing: [], durationMs: 1,
    },
    ...extra,
  };
}

export interface SessionParts {
  lookups?: LookupCall[];
  profile?: Partial<ScanSession['profile']>;
  /** `chainId:address` to the nonce the scan read (null = asked, not answered). */
  nonces?: Record<string, number | null>;
  incomplete?: Incomplete[];
}

export function mkSession(me: string, histories: ChainHistory[], o: SessionParts = {}): ScanSession {
  return {
    me, histories, profile: { isContract: false, ensRecords: {}, ownedNames: [], tags: [], ...o.profile },
    lookups: new Map((o.lookups ?? []).map((c) => [lookupKey(c.chainId, c.action, c.address, c.q), c])),
    nonces: new Map(Object.entries(o.nonces ?? {}).map(([k, v]) => [k, Promise.resolve(v)])),
    incomplete: o.incomplete ?? [], skipped: [],
  };
}

/** A session from rows on any chains: one history per chain, in the order the chains first appear. */
export function sessionFrom(me: string, rows: Transfer[], o: SessionParts = {}): ScanSession {
  const by = new Map<number, Transfer[]>();
  for (const r of rows) by.set(r.chainId, [...(by.get(r.chainId) ?? []), r]);
  return mkSession(me, [...by.entries()].map(([id, rs]) => chainHist(me, id, rs)), o);
}
