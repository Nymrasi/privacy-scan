// Run the detectors again on what a finished scan read (its session), with or without a change.
// A replay asks the network nothing: a lookup or a nonce check comes from the scan's record, or from
// the `fresh` lookup a feature passes in for the one new address it is about.
// Everything else is skipped and noted, never guessed.
import { makeNonces, type DetectorContext, type Profile } from '../detectors/context.ts';
import { analyzeRecipients } from '../detectors/deposits.ts';
import { DETECTOR_LIST } from '../detectors/index.ts';
import { poisoningWarning } from '../detectors/poisoning.ts';
import type { ChainHistory } from '../history.ts';
import { assemble, runDetectors, selfService } from '../scan.ts';
import { lookupKey, type Lookup, type LookupCall, type ScanSession } from '../session.ts';
import { createHttp, HttpError } from '../sources/http.ts';
import type { AccountAction, ListQuery } from '../sources/explorer.ts';
import type { ChainId, Finding, ScanResult } from '../types.ts';

/** The question without its block window: a funder lookup is the same question when the window moved a little. */
function looseKey(chainId: ChainId, action: AccountAction, address: string, q: ListQuery): string {
  return `${chainId}|${action}|${address.toLowerCase()}|${q.sort ?? ''}|${q.filter ?? ''}|${q.offset ?? ''}`;
}

export interface ReplayLookup {
  lookup: Lookup;
  /** Questions the record could not answer (and nothing else answered): `chainId|action|address`. */
  missed: Set<string>;
}

/** Answers from the session's record; a new question goes to `fresh` when given, else it is skipped and noted. */
export function replayLookup(s: ScanSession, fresh?: Lookup): ReplayLookup {
  const loose = new Map<string, LookupCall>();
  for (const c of s.lookups.values()) {
    const k = looseKey(c.chainId, c.action, c.address, c.q);
    if (!loose.has(k)) loose.set(k, c);
  }
  const missed = new Set<string>();
  const lookup: Lookup = (chain, action, address, q) => {
    const c = s.lookups.get(lookupKey(chain.id, action, address, q)) ?? loose.get(looseKey(chain.id, action, address, q));
    if (c) return c.rows;
    if (fresh) return fresh(chain, action, address, q);
    missed.add(`${chain.id}|${action}|${address.toLowerCase()}`);
    return Promise.resolve(null);
  };
  return { lookup, missed };
}

/** Detectors never use ctx.http directly (lookups go through ctx.lookup); this one refuses every call anyway. */
const OFFLINE = createHttp({ fetch: (() => Promise.reject(new HttpError(0, 'a replay makes no requests'))) as unknown as typeof fetch, retries: 0 });

/**
 * Nonce checks answered from the scan's record, plus `known` answers a feature read itself
 * (`chainId:address` to the nonce). An address the scan never checked stays unknown: like a failed
 * check in a live scan, it is kept as a possible person. Never a request.
 */
export function replayNonces(s: ScanSession, known: Iterable<[string, number]> = []): DetectorContext['nonces'] {
  const cache = new Map(s.nonces);
  for (const [k, n] of known) cache.set(k, Promise.resolve(n));
  return makeNonces(OFFLINE, () => undefined, undefined, cache);
}

export interface ReplayInputs {
  histories?: ChainHistory[];
  profile?: Profile;
  lookup?: Lookup;
  nonces?: DetectorContext['nonces'];
}

/** A detector context over a session, for features that call the shared analyses directly. */
export function replayContext(s: ScanSession, o: ReplayInputs = {}): DetectorContext {
  return {
    me: s.me, histories: o.histories ?? s.histories, http: OFFLINE, profile: o.profile ?? s.profile,
    lookup: o.lookup ?? replayLookup(s).lookup, nonces: o.nonces ?? replayNonces(s), memo: new Map(), replay: true,
  };
}

export interface RerunOptions extends ReplayInputs {
  /** Change the raw findings before they are scored (e.g. keep a rule as it was). */
  adjust?: (findings: Finding[]) => Finding[];
  scannedAt?: string;
}

/**
 * Every detector again, on the session's data or a changed copy of it, assembled the way the scan
 * assembles its final result: the same score formula, the address-poisoning warning, and the scan's
 * own gaps (`incomplete`), so a replay of a partial scan is just as partial.
 */
export async function rerun(s: ScanSession, o: RerunOptions = {}): Promise<ScanResult> {
  const ctx = replayContext(s, o);
  // The scan's own coverage (rules 1.3.0, A7/A12): a service, an exchange or a bot replays as one, never as a person.
  const coverage = [...ctx.histories.map((h) => h.coverage), ...s.skipped];
  let findings = await runDetectors(DETECTOR_LIST, ctx, coverage);
  if (o.adjust) findings = o.adjust(findings);
  const rec = ctx.profile.isContract || selfService(s.me, ctx.profile, coverage) ? null : await analyzeRecipients(ctx).catch(() => null);
  const warning = poisoningWarning(ctx, rec);
  return assemble(
    s.me, findings, coverage, ctx.profile, Date.now(), o.scannedAt ?? new Date().toISOString(),
    s.incomplete.length ? 'partial' : 'complete', {}, s.incomplete, warning ? [warning] : [],
  );
}
