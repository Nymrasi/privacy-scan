// Synthetic histories for detector tests. No network.
import { CHAIN_BY_ID } from '../src/chains.ts';
import type { DetectorContext, Profile } from '../src/detectors/context.ts';
import { fundingOf, type ChainHistory, type Transfer } from '../src/history.ts';
import { createHttp } from '../src/sources/http.ts';

export const ME = '0x1111111111111111111111111111111111111111';
export const A = (n: number) => '0x' + n.toString(16).padStart(40, '0');
let seq = 0;
export const T0 = 1_750_000_000;

export function tx(p: Partial<Transfer> & { chainId?: number }): Transfer {
  const from = p.from ?? ME, to = p.to ?? A(99);
  return {
    chainId: p.chainId ?? 1, hash: '0x' + (++seq).toString(16).padStart(64, '0'), block: p.block ?? 1000 + seq,
    timestamp: p.timestamp ?? T0 + seq * 3600, from, to, kind: p.kind ?? 'native', amount: p.amount ?? 0.1,
    symbol: p.symbol ?? 'ETH', dir: p.dir ?? (from === ME ? (to === ME ? 'self' : 'out') : 'in'), failed: false,
    gasPrice: p.gasPrice ?? 1.234, gasLimit: p.gasLimit ?? 21000, methodId: p.methodId, isCall: p.isCall ?? false,
    ...(p.token ? { token: p.token } : {}),
  };
}

/** A chain history built the way history.ts builds one: own transactions, and what paid for the first. */
export function hist(chainId: number, rows: Transfer[], extra: Partial<ChainHistory> = {}): ChainHistory {
  const chain = CHAIN_BY_ID.get(chainId)!;
  const txs = rows.filter((r) => r.kind === 'native'), tokens = rows.filter((r) => r.kind === 'token'), internal = rows.filter((r) => r.kind === 'internal');
  const own = txs.filter((t) => t.from === ME).sort((a, b) => a.block - b.block);
  const firstOwn = own[0];
  return {
    chain, txs, tokens, internal, ownCount: own.length, firstOwn, firstFunding: fundingOf(firstOwn, rows), truncated: false,
    coverage: { chainId, name: chain.name, status: rows.length ? 'scanned' : 'no_activity', source: 'blockscout', txCount: txs.length, tokenTransferCount: tokens.length, internalTransfers: 'full', truncated: false, limitations: [], missing: [], durationMs: 1 },
    ...extra,
  };
}

export function ctx(histories: ChainHistory[], o: { profile?: Partial<Profile>; lookup?: DetectorContext['lookup']; nonces?: Record<string, number> } = {}): DetectorContext {
  return {
    me: ME, histories, http: createHttp({ fetch: (() => { throw new Error('no network in tests'); }) as any }),
    profile: { isContract: false, ensRecords: {}, ownedNames: [], tags: [], ...o.profile },
    lookup: o.lookup ?? (async () => null),
    nonces: async (items) => new Map(items.filter((i) => o.nonces?.[i.address] !== undefined).map((i) => [i.address, o.nonces![i.address]])),
    memo: new Map(),
  };
}
