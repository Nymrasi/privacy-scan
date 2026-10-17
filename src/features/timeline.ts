// Privacy timeline (FEATURES D3): the score through time, and the transactions that cost the most.
// Zero requests: every detector runs again on the history the scan read, cut at each moment, and
// lookups come only from the scan's record (a question it never asked is skipped and counted, never
// asked now). Facts about other addresses (a deposit address, a funder's other wallets) are what the
// scan knows today; each drop is dated by this wallet's own transaction that made the link.
// Names and labels have no date: they count from today only, unless the read Ethereum history
// shows the transaction that set the primary name.
import type { Profile } from '../detectors/context.ts';
import type { ChainHistory, Transfer } from '../history.ts';
import { txUrl } from '../chains.ts';
import { bandFor } from '../score.ts';
import type { ChainId, Finding, ScanResult, ScoreBand } from '../types.ts';
import type { ScanSession } from '../session.ts';
import { replayLookup, rerun } from './replay.ts';

export interface TimelinePoint {
  /** Unix seconds. */
  t: number;
  score: number;
  band: ScoreBand;
  /** start = the first transfer read; month = the end of a month (or quarter); now = all history; today = with names and labels. */
  kind: 'start' | 'month' | 'now' | 'today';
}

export interface TimelineDrop {
  /** The transaction that cost the most in that period. */
  t: number;
  tx: { chainId: ChainId; hash: string; url?: string };
  /** Points lost at that transaction (negative). */
  delta: number;
  from: number;
  to: number;
  /** The finding that moved most at that step. */
  ruleId: string;
  title: string;
  change: 'new' | 'stronger';
  /** The month it falls in lost this many points in total (negative). */
  periodDelta: number;
}

export interface Timeline {
  /** Chronological. Never inside `gap`. */
  points: TimelinePoint[];
  /** Part of a long history the scan did not read: draw it grey, put no points in it. */
  gap?: { from: number; to: number };
  /** Up to 3, biggest first. */
  drops: TimelineDrop[];
  /** Rule ids counted from today only (no date on chain). */
  undated: string[];
  /** When the read history dates the primary name (the transaction that set it). */
  namedAt?: number;
  stats: { recomputations: number; skippedLookups: number; ms: number };
}

export interface TimelineOptions {
  /** Most moments on the line. Default 36: month ends, or quarter ends for a longer history. */
  maxPoints?: number;
  /** Most extra replays to find the transaction behind each big drop. Default 200. */
  maxSteps?: number;
  /** Called between replays so a browser can paint; resolve to continue. */
  yieldEvery?: () => Promise<void>;
  /** "Now" for the last point. Default: the latest transfer read, or the clock. */
  now?: number;
}

const UNDATED = ['public_identity.ens_reverse', 'public_identity.ens_records', 'public_identity.owned_names', 'public_identity.public_label', 'behavioral_fingerprint.wallet_software', 'public_identity.is_contract'];
/** ENS reverse registrars and the calls that set a primary name: setName(string), setNameForAddr(...). */
const REVERSE_REGISTRARS = new Set(['0x084b1c3c81545d370f3634392de611caabff8148', '0xa58e81fe9b61b5c3fe2afd33cf304c454abfc7cb']);
const SET_NAME = new Set(['0xc47f0027', '0x7a806d6b']);

function transfersOf(h: ChainHistory): Transfer[] {
  return [...h.txs, ...h.tokens, ...h.internal, ...(h.firstOwn ? [h.firstOwn] : []), ...(h.firstFunding ? [h.firstFunding] : [])].filter((t) => t.timestamp > 0);
}

/**
 * The history as it stood at time T, by the rules of history.ts: what the wallet had signed by then
 * (the chain's own count is today's, so it is left out), and its funding only once the first
 * transaction it paid for was signed.
 */
function cutAt(me: string, hs: ChainHistory[], T: number): ChainHistory[] {
  return hs.map(({ nonce: _today, ...h }) => {
    const keep = (t: Transfer) => t.timestamp <= T;
    const txs = h.txs.filter(keep), tokens = h.tokens.filter(keep), internal = h.internal.filter(keep);
    const firstOwn = h.firstOwn && h.firstOwn.timestamp <= T ? h.firstOwn : undefined;
    const own = new Set(txs.filter((t) => t.from === me).map((t) => t.hash));
    if (firstOwn) own.add(firstOwn.hash);
    return { ...h, txs, tokens, internal, ownCount: own.size, firstOwn, firstFunding: firstOwn ? h.firstFunding : undefined };
  });
}

/** Where a cut history starts to be complete: the latest start among its lists. */
function completeFrom(h: ChainHistory): number | null {
  if (!h.truncated && !h.coverage.truncated) return null;
  const starts = [h.txs, h.tokens, h.internal].filter((l) => l.length).map((l) => Math.min(...l.map((t) => t.timestamp).filter((x) => x > 0)));
  return starts.length ? Math.max(...starts) : null;
}

function endOfMonth(t: number, step: number): number {
  const d = new Date(t * 1000);
  const m = d.getUTCMonth();
  const next = Date.UTC(d.getUTCFullYear(), m - (m % step) + step, 1) / 1000;
  return next - 1;
}

/** Month ends (or quarter or year ends when there would be more than `max`) after `from`, before `to`. */
function moments(from: number, to: number, max: number): number[] {
  for (const step of [1, 3, 6, 12]) {
    const out: number[] = [];
    for (let t = endOfMonth(from, step); t < to; t = endOfMonth(t + 1, step)) out.push(t);
    if (out.length <= max) return out;
  }
  return [];
}

export async function privacyTimeline(s: ScanSession, scan: Pick<ScanResult, 'score' | 'findings'>, o: TimelineOptions = {}): Promise<Timeline> {
  const t0 = Date.now();
  const all = s.histories.flatMap(transfersOf);
  const rec = replayLookup(s);
  let recomputations = 0;
  const yieldNow = o.yieldEvery ?? (() => Promise.resolve());

  // The primary name, dated by its setName transaction when the read history has it.
  const setName = s.profile.ens
    ? s.histories.filter((h) => h.chain.id === 1).flatMap((h) => h.txs)
        .filter((t) => t.from === s.me && !t.failed && REVERSE_REGISTRARS.has(t.to) && SET_NAME.has(t.methodId ?? ''))
        .sort((a, b) => b.timestamp - a.timestamp)[0]
    : undefined;
  const bare: Profile = { isContract: s.profile.isContract, ensRecords: {}, ownedNames: [], tags: [] };
  const profileAt = (T: number): Profile => (setName && T >= setName.timestamp ? { ...bare, ens: s.profile.ens } : bare);

  const at = async (T: number) => {
    recomputations++;
    if (recomputations % 8 === 0) await yieldNow();
    return rerun(s, { histories: cutAt(s.me, s.histories, T), profile: profileAt(T), lookup: rec.lookup });
  };

  const undated = [...new Set(scan.findings.map((f) => f.id).filter((id) => UNDATED.includes(id)))].filter((id) => !(setName && id === 'public_identity.ens_reverse'));
  if (!all.length) {
    return { points: [], drops: [], undated, stats: { recomputations: 0, skippedLookups: 0, ms: Date.now() - t0 } };
  }

  const first = Math.min(...all.map((t) => t.timestamp));
  const last = Math.max(...all.map((t) => t.timestamp));
  const now = Math.max(o.now ?? last, last);
  const cut = Math.max(0, ...s.histories.map(completeFrom).filter((x): x is number => x !== null));
  const gap = cut > first ? { from: first, to: cut } : undefined;

  const points: TimelinePoint[] = [];
  const results = new Map<number, ScanResult>();
  const push = async (t: number, kind: TimelinePoint['kind']) => {
    const r = await at(t);
    results.set(t, r);
    points.push({ t, score: r.score, band: r.band, kind });
  };
  await push(first, 'start');
  const readFrom = gap ? gap.to : first;
  if (gap) await push(gap.to, 'month'); // the first moment the whole history is read again
  for (const t of moments(readFrom, now, o.maxPoints ?? 36)) if (t > readFrom) await push(t, 'month');
  if (points[points.length - 1].t < now) await push(now, 'now');
  else points[points.length - 1].kind = 'now';
  const lastPoint = points[points.length - 1];
  if (scan.score !== lastPoint.score) points.push({ t: now, score: scan.score, band: bandFor(scan.score), kind: 'today' });

  // The biggest drops between two points, then the one transaction inside that cost the most.
  const periods = points.slice(1)
    .map((p, i) => ({ a: points[i], b: p, delta: p.score - points[i].score }))
    .filter((x) => x.b.kind !== 'today' && x.delta < 0 && !(gap && x.a.t < gap.to && x.b.t > gap.from && x.a.kind === 'start'))
    .sort((x, y) => x.delta - y.delta)
    .slice(0, 3);
  const maxSteps = o.maxSteps ?? 200;
  const budget = Math.floor(maxSteps / Math.max(1, periods.length));
  const stepsFrom = recomputations;
  const stepsLeft = () => maxSteps - (recomputations - stepsFrom);
  const drops: TimelineDrop[] = [];
  for (const p of periods) {
    const inside = [...new Set(all.filter((t) => t.timestamp > p.a.t && t.timestamp <= p.b.t).map((t) => t.timestamp))].sort((x, y) => x - y);
    if (!inside.length) continue;
    // One replay per moment with a transfer. A busy period is narrowed first: replay the end of each
    // of 16 slices, keep the slice that lost the most, and repeat until it is small enough.
    let candidates = inside;
    let prevScore = p.a.score;
    let prevResult = results.get(p.a.t)!;
    const SLICES = 16;
    while (candidates.length > Math.min(SLICES, budget) && stepsLeft() > SLICES * 2) {
      const size = Math.ceil(candidates.length / SLICES);
      let worst = { from: 0, delta: 0, before: prevResult, beforeScore: prevScore };
      let pr = prevResult, ps = prevScore;
      for (let i = 0; i < candidates.length; i += size) {
        const r = await at(candidates[Math.min(i + size, candidates.length) - 1]);
        if (r.score - ps < worst.delta) worst = { from: i, delta: r.score - ps, before: pr, beforeScore: ps };
        pr = r;
        ps = r.score;
      }
      if (worst.delta >= 0) break;
      candidates = candidates.slice(worst.from, worst.from + size);
      prevResult = worst.before;
      prevScore = worst.beforeScore;
    }
    let best: { t: number; delta: number; before: ScanResult; after: ScanResult } | null = null;
    for (const t of candidates) {
      if (stepsLeft() <= 0) break;
      const r = await at(t);
      const delta = r.score - prevScore;
      if (!best || delta < best.delta) best = { t, delta, before: prevResult, after: r };
      prevResult = r;
      prevScore = r.score;
    }
    if (!best || best.delta >= 0) continue;
    const moved = topMove(best.before.findings, best.after.findings);
    const tx = all.filter((x) => x.timestamp === best!.t).sort((x, y) => Number(y.from === s.me) - Number(x.from === s.me))[0];
    drops.push({
      t: best.t, tx: { chainId: tx.chainId, hash: tx.hash, ...(txUrl(tx.chainId, tx.hash) ? { url: txUrl(tx.chainId, tx.hash) } : {}) },
      delta: best.delta, from: best.before.score, to: best.after.score,
      ruleId: moved?.f.id ?? '', title: moved?.f.title ?? 'Several findings moved', change: moved?.isNew ? 'new' : 'stronger', periodDelta: p.delta,
    });
  }
  return {
    points, ...(gap ? { gap } : {}), drops: rankDrops(drops), undated, ...(setName ? { namedAt: setName.timestamp } : {}),
    stats: { recomputations, skippedLookups: rec.missed.size, ms: Date.now() - t0 },
  };
}

/** Biggest drop first (a month can lose much in small steps; the list is about single transactions). */
export function rankDrops(drops: TimelineDrop[]): TimelineDrop[] {
  return [...drops].sort((a, b) => a.delta - b.delta || a.t - b.t);
}

/** The finding that took the most points between two replays. */
export function topMove(before: Finding[], after: Finding[]): { f: Finding; isNew: boolean } | null {
  const prev = new Map(before.map((f) => [f.key, f]));
  let best: { f: Finding; isNew: boolean; d: number } | null = null;
  for (const f of after) {
    const b = prev.get(f.key);
    const d = f.scoreImpact - (b?.scoreImpact ?? 0);
    if (d < 0 && (!best || d < best.d)) best = { f, isNew: !b, d };
  }
  return best ? { f: best.f, isNew: best.isNew } : null;
}
