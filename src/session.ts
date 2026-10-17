// What a finished scan read, kept in memory so a feature can replay it without asking the network
// again: the histories, the profile, every funder or deposit lookup and every nonce check with its answer.
// Held per result in a WeakMap: it lives exactly as long as the result object, never leaves the
// page, and is never written anywhere. Partial results carry no session; only the final one does.
import type { DetectorContext, Profile } from './detectors/context.ts';
import type { ChainHistory, Transfer } from './history.ts';
import type { AccountAction, ListQuery } from './sources/explorer.ts';
import type { ChainCoverage, ChainId, Incomplete, ScanResult } from './types.ts';

export type Lookup = DetectorContext['lookup'];

/** One lookup the scan made: the question as the detector asked it, and its answer (null = failed or skipped). */
export interface LookupCall {
  chainId: ChainId;
  action: AccountAction;
  address: string;
  q: ListQuery;
  rows: Promise<Transfer[] | null>;
}

export interface ScanSession {
  me: string;
  /** In register order, exactly as the detectors saw them. */
  histories: ChainHistory[];
  profile: Profile;
  /** Every lookup of the final detector pass, keyed by `lookupKey`. */
  lookups: Map<string, LookupCall>;
  /** Every RPC nonce check of the final pass by `chainId:address` (makeNonces' cache): null = asked, not answered. */
  nonces: Map<string, Promise<number | null>>;
  /** What the scan could not read (the result's `incomplete`): a replay is exactly as partial. */
  incomplete: Incomplete[];
  /** Coverage of the chains the scan did not read at all (not in the register). */
  skipped: ChainCoverage[];
}

export function lookupKey(chainId: ChainId, action: AccountAction, address: string, q: ListQuery): string {
  return `${chainId}|${action}|${address.toLowerCase()}|${JSON.stringify(q)}`;
}

/** Wraps a lookup so every question and its answer is recorded. Answers are not changed. */
export function recordLookups(inner: Lookup): { lookup: Lookup; calls: Map<string, LookupCall> } {
  const calls = new Map<string, LookupCall>();
  const lookup: Lookup = (chain, action, address, q) => {
    const rows = inner(chain, action, address, q);
    const key = lookupKey(chain.id, action, address, q);
    if (!calls.has(key)) calls.set(key, { chainId: chain.id, action, address: address.toLowerCase(), q, rows });
    return rows;
  };
  return { lookup, calls };
}

const SESSIONS = new WeakMap<ScanResult, ScanSession>();

export function keepSession(result: ScanResult, session: ScanSession): void {
  SESSIONS.set(result, session);
}

/** The session behind a final scan result, or undefined (a partial result, a fixture, a copy). */
export function sessionOf(result: ScanResult): ScanSession | undefined {
  return SESSIONS.get(result);
}
