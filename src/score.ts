// The score formula. RULES.md explains it in words; keep both in step.
import type { DetectorId, Finding, LinkLevel, ScoreBand, ScoreBreakdown, Severity } from './types.ts';

export const RULES_VERSION = '1.4.0';

/** Points a finding costs at confidence 1.0. */
export const SEVERITY_POINTS: Record<Severity, number> = {
  info: 0,
  low: 4,
  medium: 8,
  high: 14,
  critical: 22,
};

/** Most points one detector can take off, whatever it finds. */
export const DETECTOR_CAPS: Record<DetectorId, number> = {
  public_identity: 30,
  linked_wallets: 25,
  funding_reuse: 20,
  cex_exposure: 20,
  cross_chain: 12,
  behavioral_fingerprint: 12,
  recurring_counterparties: 10,
};

export const DETECTORS: DetectorId[] = [
  'public_identity',
  'linked_wallets',
  'funding_reuse',
  'cex_exposure',
  'cross_chain',
  'behavioral_fingerprint',
  'recurring_counterparties',
];

/** A wallet with a public label is identified: its score never reads better than this. */
export const NAMED_CEILING = 34;
/**
 * Findings that mean "anyone can see who this is" (at confidence 0.9 or more): a public label (an exchange,
 * a service, a known entity). Not an ENS name since 1.4.0: anyone can make one up, so it does not say who it is.
 */
export const NAMING_RULES = ['public_identity.public_label'];

/**
 * The word for how likely a link between wallets is: `likely` at 0.70 and up, `possible` at 0.45 and
 * up, else `weak`. The single source for these edges: the docs, the site and the motion read them here.
 */
export const LINK_LEVELS = { likely: 0.7, possible: 0.45 } as const;

export function linkLevel(confidence: number): LinkLevel {
  if (confidence >= LINK_LEVELS.likely) return 'likely';
  if (confidence >= LINK_LEVELS.possible) return 'possible';
  return 'weak';
}

export function bandFor(score: number): ScoreBand {
  if (score >= 80) return 'private';
  if (score >= 60) return 'moderate';
  if (score >= 35) return 'traceable';
  return 'exposed';
}

/** Raw cost of one finding: severity points times confidence, rounded, as a negative number. */
export function rawImpact(severity: Severity, confidence: number): number {
  const c = Math.min(1, Math.max(0, confidence));
  const p = Math.round(SEVERITY_POINTS[severity] * c);
  return p === 0 ? 0 : -p;
}

/**
 * Fill in rawImpact and scoreImpact on every finding and compute the score.
 * Within a detector the costliest finding counts first; once the cap is reached the
 * rest cost 0. The sum of scoreImpact over all findings is exactly score - 100.
 */
export function scoreFindings(findings: Finding[]): {
  score: number;
  band: ScoreBand;
  breakdown: ScoreBreakdown;
  findings: Finding[];
} {
  const scored = findings.map((f) => ({ ...f, rawImpact: rawImpact(f.severity, f.confidence) }));
  const byDetector = Object.fromEntries(DETECTORS.map((d) => [d, 0])) as Record<DetectorId, number>;
  const capped: DetectorId[] = [];

  for (const d of DETECTORS) {
    let left = DETECTOR_CAPS[d];
    const group = scored
      .filter((f) => f.detector === d)
      .sort((a, b) => a.rawImpact - b.rawImpact || a.id.localeCompare(b.id));
    for (const f of group) {
      const cost = Math.min(left, -f.rawImpact);
      if (cost < -f.rawImpact && !capped.includes(d)) capped.push(d);
      f.scoreImpact = cost === 0 ? 0 : -cost;
      left -= cost;
      byDetector[d] -= cost;
    }
  }

  // Caps add up to more than 100: the score floors at 0. Trim the cheapest findings first
  // so the sum still equals score - 100.
  let total = Object.values(byDetector).reduce((a, b) => a + b, 0);
  if (total < -100) {
    let excess = -100 - total;
    const order = [...scored].sort((a, b) => b.scoreImpact - a.scoreImpact);
    for (const f of order) {
      if (excess === 0) break;
      const take = Math.min(excess, -f.scoreImpact);
      if (take === 0) continue;
      f.scoreImpact += take;
      byDetector[f.detector] += take;
      excess -= take;
    }
    total = -100;
  }

  let score = 100 + total;

  // Named-wallet ceiling: the naming finding itself absorbs the extra points, so the sum still adds up.
  let ceiling: number | undefined;
  const naming = scored
    .filter((f) => NAMING_RULES.includes(f.id) && f.confidence >= 0.9)
    .sort((a, b) => a.scoreImpact - b.scoreImpact)[0];
  if (naming && score > NAMED_CEILING) {
    const extra = score - NAMED_CEILING;
    naming.scoreImpact -= extra;
    byDetector[naming.detector] -= extra;
    score = NAMED_CEILING;
    ceiling = NAMED_CEILING;
  }

  scored.sort((a, b) => a.scoreImpact - b.scoreImpact || b.confidence - a.confidence);
  return { score, band: bandFor(score), breakdown: { base: 100, byDetector, capped, ...(ceiling !== undefined ? { ceiling } : {}) }, findings: scored };
}
