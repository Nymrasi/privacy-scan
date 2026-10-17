// The fix plan after a scan: what can be undone today, what to do differently from now on, and what
// is already on chain for good, with who can see each leak. The advice per rule id is in
// advice.json (one entry for every rule in RULES.md). Every number comes from scoreFindings, so the
// caps and the named-wallet ceiling apply exactly as in the score: points are never added by hand.
import ADVICE from './advice.json' with { type: 'json' };
import { scoreFindings } from '../score.ts';
import type { DetectorId, Finding, ScanResult, Severity } from '../types.ts';

/** now = state you can undo today; habit = change from now on; permanent = the past stays; info = nothing to do. */
export type FixKind = 'now' | 'habit' | 'permanent' | 'info';
/** Who can see a leak: anyone with a block explorer, the exchange behind the account, chain analysis firms. */
export type Viewer = 'anyone' | 'exchange' | 'analysts';

export interface Advice {
  kind: FixKind;
  who: Viewer[];
  action: string;
  steps: string[];
  /** Where the steps come from (a wallet's or ENS's own help page). */
  source?: string;
}

export interface FixItem extends Advice {
  /** Rule id, e.g. "public_identity.ens_reverse". One item per rule, also when the rule fired more than once. */
  id: string;
  detector: DetectorId;
  /** The docs section "How to reduce it" for this rule's detector. */
  learnMore: string;
  /** Keys of the findings this item answers. */
  findings: string[];
  /** Points these findings take off the score now (0 or less). */
  points: number;
  /** `now` items: points won back by doing only this (0 or more). */
  gain?: number;
  /** `now` items with no gain although the finding costs points: what holds the score down. */
  heldBy?: 'ceiling' | 'cap';
}

export interface FixPlan {
  score: number;
  /** Points won back today when every `now` item is done (0 or more). */
  winBack: number;
  /** The score after every `now` item is done. */
  scoreAfter: number;
  /** `now` (most points won first), then `habit` (most points first), then `permanent`. Info rules are left out. */
  items: FixItem[];
  /** The one thing to do first. */
  top?: FixItem;
  counts: { now: number; habit: number; permanent: number };
}

const RULES = ADVICE.rules as Record<string, Advice>;
const LEARN = ADVICE.learnMore as Record<DetectorId, string>;

/** Texts around the plan: title, lead, the win-back line ({points}), and the honest line. */
export const FIX_TEXT = ADVICE.intro;
/** "Who can see this": the words for each viewer. */
export const VIEWER_TEXT = ADVICE.who as Record<Viewer, string>;
/** The fresh wallet checklist (FEATURES D4). */
export const FRESH_WALLET = ADVICE.freshWallet;

export function adviceFor(ruleId: string): Advice | undefined {
  return RULES[ruleId];
}

export function learnMoreFor(detector: DetectorId): string {
  return LEARN[detector];
}

const ENS_REVERSE = 'public_identity.ens_reverse';
const ENS_RECORDS = 'public_identity.ens_records';
const OWNED_NAMES = 'public_identity.owned_names';

/**
 * The score if the findings of these rules were gone. Clearing the primary name also clears its
 * records (they are read from the primary name), and an owned name costs more without a primary
 * name (RULES.md: low, medium without a primary name). The named-wallet ceiling stays while any
 * other naming finding remains (a public label cannot be removed).
 */
export function whatIf(findings: Finding[], undo: Iterable<string>): number {
  const gone = new Set(undo);
  const clearsName = gone.has(ENS_REVERSE) && findings.some((f) => f.id === ENS_REVERSE);
  if (clearsName) gone.add(ENS_RECORDS);
  const rest = findings
    .filter((f) => !gone.has(f.id))
    .map((f) => (clearsName && f.id === OWNED_NAMES && f.severity === 'low' ? { ...f, severity: 'medium' as Severity } : f));
  return scoreFindings(rest).score;
}

/** Rules whose finding describes state that can be undone today. */
export const NOW_RULES = Object.entries(RULES).filter(([, a]) => a.kind === 'now').map(([id]) => id);

/** Points won back today if every finding that can be undone is undone (0 or more). */
export function winBack(result: Pick<ScanResult, 'findings' | 'score'>): number {
  return Math.max(0, whatIf(result.findings, NOW_RULES) - result.score);
}

const SEV_RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

export function fixPlan(result: Pick<ScanResult, 'findings' | 'score' | 'breakdown'>): FixPlan {
  const groups = new Map<string, Finding[]>();
  for (const f of result.findings) groups.set(f.id, [...(groups.get(f.id) ?? []), f]);

  const items: FixItem[] = [];
  for (const [id, fs] of groups) {
    const a = RULES[id];
    if (!a || a.kind === 'info') continue;
    const points = fs.reduce((s, f) => s + f.scoreImpact, 0);
    const item: FixItem = { ...a, who: [...a.who], steps: [...a.steps], id, detector: fs[0].detector, learnMore: LEARN[fs[0].detector], findings: fs.map((f) => f.key), points };
    if (a.kind === 'now') {
      item.gain = Math.max(0, whatIf(result.findings, [id]) - result.score);
      if (!item.gain && fs.some((f) => f.rawImpact < 0)) item.heldBy = result.breakdown.ceiling !== undefined ? 'ceiling' : 'cap';
    }
    items.push(item);
  }

  const rank = { now: 0, habit: 1, permanent: 2, info: 3 };
  const raw = (i: FixItem) => groups.get(i.id)!.reduce((s, f) => s + f.rawImpact, 0);
  const sev = (i: FixItem) => Math.min(...groups.get(i.id)!.map((f) => SEV_RANK[f.severity]));
  items.sort((a, b) =>
    rank[a.kind] - rank[b.kind]
    || (b.gain ?? 0) - (a.gain ?? 0)
    || a.points - b.points
    || raw(a) - raw(b)
    || sev(a) - sev(b)
    || a.id.localeCompare(b.id));

  const win = winBack(result);
  // Something to undo today comes first; else the costliest habit (habits sort before what is on chain).
  const top = items.find((i) => i.kind === 'now' && (i.gain ?? 0) > 0) ?? items.find((i) => i.kind !== 'now') ?? items[0];
  return {
    score: result.score,
    winBack: win,
    scoreAfter: result.score + win,
    items,
    ...(top ? { top } : {}),
    counts: {
      now: items.filter((i) => i.kind === 'now').length,
      habit: items.filter((i) => i.kind === 'habit').length,
      permanent: items.filter((i) => i.kind === 'permanent').length,
    },
  };
}
