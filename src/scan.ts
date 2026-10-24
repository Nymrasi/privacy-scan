// The scan: read every chain in parallel, stream a partial result after each one,
// then run the detectors that need extra lookups and return the final result.
import { CHAIN_BY_ID, chainForRoad, defaultChainIds, UNSUPPORTED } from './chains.ts';
import { lookalike, makeLookup, makeNonces, plural, serviceByTags, type Detector, type DetectorContext, type Profile } from './detectors/context.ts';
import { analyzeRecipients } from './detectors/deposits.ts';
import { DETECTOR_LIST } from './detectors/index.ts';
import { poisoningWarning } from './detectors/poisoning.ts';
import { fetchChainWhole, quickShape, selfTags, SIDE_SHARE, type ChainHistory, type FetchLimits } from './history.ts';
import { serviceIdentity } from './labels.ts';
import { linkLevel, RULES_VERSION, scoreFindings } from './score.ts';
import { createHttp } from './sources/http.ts';
export { clearSessionCache } from './sources/http.ts';
import { fetchProfile, type ProfileGap } from './sources/identity.ts';
import { keepSession, recordLookups } from './session.ts';
import type { ChainCoverage, ChainId, Finding, Incomplete, RelatedAddress, ScanOptions, ScanResult, ServiceIdentity, Warning } from './types.ts';

export const ENGINE_VERSION = '0.1.0';
const LOOKUP_BUDGET = 14;

export function isAddress(a: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(a.trim());
}

function mergeRelated(findings: Finding[], me: string): RelatedAddress[] {
  const m = new Map<string, RelatedAddress>();
  for (const f of findings) for (const r of f.related ?? []) {
    // Never the wallet itself, and never an imitation of it (address poisoning): see `warnings`.
    if (r.address === me || lookalike(r.address, me)) continue;
    const x = m.get(r.address);
    if (!x) { m.set(r.address, { ...r, reasons: [...r.reasons], chainIds: [...r.chainIds] }); continue; }
    // Two independent reasons make a link more likely: 1 - (1-a)(1-b), capped below certainty.
    const fresh = r.reasons.some((s) => !x.reasons.includes(s));
    x.confidence = fresh ? Math.min(0.95, Math.round((1 - (1 - x.confidence) * (1 - r.confidence)) * 100) / 100) : Math.max(x.confidence, r.confidence);
    for (const s of r.reasons) if (!x.reasons.includes(s)) x.reasons.push(s);
    for (const c of r.chainIds) if (!x.chainIds.includes(c)) x.chainIds.push(c);
  }
  return [...m.values()]
    .map((r) => ({ ...r, level: linkLevel(r.confidence) }))
    .sort((a, b) => b.confidence - a.confidence || a.address.localeCompare(b.address));
}

function lock(f: Finding): Finding {
  return { ...f, title: 'Deep finding', explanation: 'Hold the required amount of $NYMRA to see this finding.', evidence: [], related: undefined };
}

export function assemble(
  me: string, findings: Finding[], coverage: ChainCoverage[], profile: Profile | null,
  t0: number, startedAt: string, status: ScanResult['status'], opts: ScanOptions, incomplete: Incomplete[] = [], warnings: Warning[] = [],
): ScanResult {
  const s = scoreFindings(findings);
  const gated = opts.gate && opts.gate.threshold > 0 && opts.gate.holderBalance < opts.gate.threshold;
  const shown = gated ? s.findings.map((f) => (f.deep ? lock(f) : f)) : s.findings;
  const service = selfService(me, profile, coverage);
  // Never used: no transaction sent and nothing held on any chain read, and nothing names it.
  const unused = !shown.length && coverage.length > 0 && coverage.every((c) => c.status === 'no_activity' || (c.status === 'skipped' && !c.precheck?.sent && !c.precheck?.holds));
  return {
    schemaVersion: 1, address: me, scannedAt: startedAt, durationMs: Date.now() - t0, status,
    addressType: profile ? (profile.isContract ? 'contract' : 'eoa') : 'unknown',
    score: s.score, band: s.band, breakdown: s.breakdown, findings: shown,
    linkedWallets: mergeRelated(shown, me),
    warnings,
    identity: {
      ...(profile?.ens ? { ens: profile.ens } : {}), ...(profile?.xns ? { xns: profile.xns } : {}), labels: profile?.tags ?? [],
      ...(profile?.tagChains ? { labelChains: profile.tagChains } : {}), ...(service ? { service } : {}),
      ...(profile?.isContract ? { contract: contractOf(profile) } : {}),
    },
    ...(unused ? { unused: true as const } : {}),
    coverage: [...coverage].sort((a, b) => order(a) - order(b) || a.chainId - b.chainId),
    incomplete,
    engine: { name: 'nymra-privacy-scan', version: ENGINE_VERSION, rulesVersion: RULES_VERSION },
  };
}

/**
 * The profile plus what the explorer says about the address on its own side of the rows, chains in
 * register order. The address page carries no tags (`metadata: null`, measured 2026-10-16), the rows do.
 */
export function withSelf(p: Profile, hs: ChainHistory[]): Profile {
  const tags = [...p.tags], slugs = [...(p.slugs ?? [])];
  // Where each tag was seen: the address page is Ethereum's, a row tag is its row's chain.
  const tagChains: Record<string, ChainId[]> = Object.fromEntries(Object.entries(p.tagChains ?? {}).map(([t, c]) => [t, [...c]]));
  let entity = p.entity;
  for (const h of hs) {
    if (!h.self) continue;
    for (const n of h.self.names) {
      if (!tags.includes(n)) tags.push(n);
      const on = (tagChains[n] ??= []);
      if (!on.includes(h.chain.id)) on.push(h.chain.id);
    }
    for (const x of h.self.slugs) if (!slugs.includes(x)) slugs.push(x);
    entity ??= h.self.entity;
  }
  // Code on ANY chain this scan read makes the address a contract. The identity read asks Blockscout for
  // chain 1 only (sources/identity.ts), so a contract that lives on Base or on Robinhood Chain and not on
  // Ethereum came through as a wallet and was given a Privacy Score: measured 2026-10-18 on WETH (Robinhood
  // Chain) and Uniswap V4's Pool Manager (Base). The per-chain quick check already reads the code
  // (history.ts `presence`), and it leaves out an EIP-7702 delegation, which is a wallet with code.
  const codeChains = [...(p.codeChains ?? [])];
  for (const h of hs) if (h.code === true && !codeChains.includes(h.chain.id)) codeChains.push(h.chain.id);
  const isContract = p.isContract || codeChains.length > 0;
  const kept = tags.slice(0, 6);
  return {
    ...p, isContract, tags: kept, tagChains: Object.fromEntries(kept.map((t) => [t, tagChains[t] ?? []])),
    ...(codeChains.length ? { codeChains } : {}), slugs, ...(entity ? { entity } : {}),
  };
}

/**
 * A contract's chains and its name there. The name is a tag seen on a chain that holds the code, else the
 * explorer's contract name when that code is on Ethereum (the identity read's chain). A tag that only
 * another chain gives this address is never its name: on Robinhood Chain 0x0bd7...ad73 is WETH, on
 * Ethereum the same address is a wallet flagged as phishing, and the card called WETH a phishing address.
 *
 */
export function contractOf(p: Profile): { chains: ChainId[]; name?: string } {
  const chains = p.codeChains?.length ? p.codeChains : [1];
  const name = p.tags.find((t) => (p.tagChains?.[t] ?? []).some((c) => chains.includes(c)))
    ?? (chains.includes(1) && p.contractName ? p.contractName : undefined);
  return { chains, ...(name ? { name } : {}) };
}

/** Everything a scan could not read, from the chain coverage, the profile and the lookups. */
export function collectIncomplete(coverage: ChainCoverage[], identityErrors: ProfileGap[] | null, lookupGaps: Incomplete[], aborted: boolean): Incomplete[] {
  const out: Incomplete[] = [];
  for (const c of coverage) {
    if (c.status === 'error') out.push({ part: 'chain', chainId: c.chainId, name: c.name, reason: `${c.name}: ${c.error ?? 'explorer error'}` });
    // A chain this scan cannot read yet (its key is not in the relay) is a gap only where the quick check saw the wallet use it.
    const pre = c.status === 'skipped' ? c.precheck : undefined;
    if (pre && (pre.sent > 0 || pre.holds)) {
      const what = pre.sent > 0 ? `sent ${plural(pre.sent, 'transaction')}` : `holds ${CHAIN_BY_ID.get(c.chainId)?.native ?? 'coins'}`;
      const why = c.skipReason === 'quota' ? "the Nymra relay's daily quota is spent; it comes back at 00:00 UTC" : 'the Nymra relay has no key for this chain';
      out.push({ part: 'skipped', chainId: c.chainId, name: c.name, reason: `${c.name}: not read, although this wallet ${what} here (${why})` });
    }
    for (const m of c.missing ?? []) {
      // `transactions (...)`: the explorer's index lacks this address's own transactions, so the chain is unread.
      const part: Incomplete['part'] = /^transactions\b/.test(m) ? 'chain' : /token/.test(m) ? 'tokens' : /internal/.test(m) ? 'internal' : 'oldest';
      out.push({ part, chainId: c.chainId, name: c.name, reason: `${c.name}: ${m.replace(/ \(([^)]*)\)$/, ' could not be read ($1)')}` });
    }
  }
  if (identityErrors === null) out.push({ part: 'identity', chainId: 1, name: 'ENS and labels', reason: 'ENS names and public labels could not be read' });
  else for (const e of identityErrors) out.push({ part: e.part, chainId: 1, name: e.name, reason: e.reason });
  out.push(...lookupGaps);
  if (aborted) out.push({ part: 'aborted', name: 'Scan', reason: 'The scan was stopped before it finished' });
  return out;
}

function order(c: ChainCoverage) {
  const rank = { scanned: 0, partial: 1, no_activity: 2, error: 3, skipped: 4 }[c.status];
  return rank * 1e6 + (c.txCount ? -c.txCount : 0);
}

/** No person signs this many transactions on one chain: an address that did is a bot or a service. */
export const BOT_COUNT = 50_000;

/**
 * The scanned address itself as a service: the bundled label lists, the explorer's own service tags,
 * or its own transaction count (BOT_COUNT or more on one chain, from the chain's RPC).
 */
export function selfService(me: string, profile: Profile | null, coverage: ChainCoverage[]): ServiceIdentity | undefined {
  const sent = Math.max(0, ...coverage.map((c) => c.precheck?.sent ?? 0));
  return serviceIdentity(me) ?? serviceByTags(profile?.slugs, profile?.entity) ?? (sent >= BOT_COUNT ? { kind: 'bot' } : undefined);
}

/** A contract's or a service's traffic is not a person's habits: only identity and cross-chain apply. */
const CONTRACT_DETECTORS = new Set(['public_identity', 'cross_chain']);

export async function runDetectors(detectors: Detector[], ctx: DetectorContext, coverage: ChainCoverage[]): Promise<Finding[]> {
  const notPerson = ctx.profile.isContract || !!selfService(ctx.me, ctx.profile, coverage);
  // Not a person: every finding, and the poisoning warning after this, speaks of "this address".
  ctx.thirdPerson = notPerson;
  const use = notPerson ? detectors.filter((d) => CONTRACT_DETECTORS.has(d.id)) : detectors;
  const res = await Promise.all(use.map((d) => d.run(ctx).catch(() => [] as Finding[])));
  return res.flat();
}

export async function scan(address: string, opts: ScanOptions = {}): Promise<ScanResult> {
  if (!isAddress(address)) throw new Error('Not an EVM address: expected 0x followed by 40 hex characters.');
  const me = address.trim().toLowerCase();
  const t0 = Date.now();
  const startedAt = new Date().toISOString();
  const emit = opts.onProgress ?? (() => {});
  const timeLimit = opts.timeLimitMs ?? 150_000;
  const http = createHttp({
    fetch: opts.fetch, timeoutMs: opts.requestTimeoutMs, signal: opts.signal, proxy: opts.proxy, fallbackProxy: opts.fallbackProxy, relay: opts.relay,
    budget: opts.requestBudget, deadline: t0 + timeLimit, cache: opts.cache === false ? null : undefined,
  });
  const maxTx = opts.maxTxPerChain ?? 500;
  // No person (a contract, a service, a bot): its card needs only the newest page of each chain (history.ts
  // QUICK_ROWS). Known at once from the bundled label lists, else as soon as a chain's quick check shows code or
  // a bot's count of transactions, the identity read says contract, or a page of rows carries the explorer's
  // service tags. Every one of these also decides the card at the end (selfService, isContract), never more.
  let quickOn = false;
  let quickGo: () => void = () => {};
  const quickNow = new Promise<void>((r) => { quickGo = r; });
  const notPersonNow = () => {
    if (quickOn || opts.readAll) return;
    quickOn = true;
    quickGo();
  };
  if (serviceIdentity(me)) notPersonNow();
  const saw: FetchLimits['saw'] = (x) => {
    if (x.pre && (x.pre.code === true || x.pre.nonce >= BOT_COUNT)) notPersonNow();
    if (x.rows) {
      const s = selfTags(x.rows, me);
      if (s && serviceByTags(s.slugs, s.entity)) notPersonNow();
    }
  };
  // Internal transfers: one page. Deeper pages stall for 40 s and more on big addresses (measured on Ethereum, 2026-10-16).
  const lim: FetchLimits = {
    maxTx, maxToken: Math.min(250, maxTx), maxInternal: Math.min(50, maxTx), noPrecheck: opts.noPrecheck, sideBy: t0 + Math.round(timeLimit * SIDE_SHARE),
    quick: () => quickOn, quickNow, saw,
  };

  const wanted = opts.chainIds ?? [...defaultChainIds(), ...UNSUPPORTED.map((u) => u.id)];
  // A retired chain is never read, also when asked for: it comes back skipped, with its reason.
  const defs = wanted.map((id) => CHAIN_BY_ID.get(id)).filter((c) => c !== undefined).filter((c) => !c.retired).map((c) => chainForRoad(c, opts.keyedAlts));
  const skipped: ChainCoverage[] = wanted.filter((id) => !CHAIN_BY_ID.has(id) || CHAIN_BY_ID.get(id)!.retired).map((id) => {
    const c = CHAIN_BY_ID.get(id), u = UNSUPPORTED.find((x) => x.id === id);
    return {
      chainId: id, name: c?.name ?? u?.name ?? `Chain ${id}`, status: 'skipped', source: 'rpc', txCount: 0, tokenTransferCount: 0,
      internalTransfers: 'not_fetched', truncated: false, limitations: [c?.retired ?? u?.reason ?? 'This chain is not in the register.'], missing: [], durationMs: 0,
    };
  });
  emit({ type: 'start', address: me, chainIds: wanted });
  for (const c of skipped) emit({ type: 'chain', coverage: c });

  // Chains finish in any order; detectors always see them in register order, so the same data gives the same result.
  const rank = new Map(wanted.map((id, i) => [id, i]));
  const histories: ChainHistory[] = [];
  const ordered = () => [...histories].sort((a, b) => (rank.get(a.chain.id) ?? 0) - (rank.get(b.chain.id) ?? 0));
  let profile: Profile | null = null;
  const seen = new Set<string>();
  const offline: DetectorContext['lookup'] = async () => null;
  const noNonces: DetectorContext['nonces'] = async () => new Map();
  const coverage = () => [...histories.map((h) => h.coverage), ...skipped];
  const noProfile: Profile = { isContract: false, ensRecords: {}, ownedNames: [], tags: [] };

  // A chain read in full before the scan knew the address is no person gets the same shape as the others.
  const shapeAll = () => { if (quickOn) for (let i = 0; i < histories.length; i++) histories[i] = quickShape(histories[i]); };
  const partial = async () => {
    shapeAll();
    const hs = ordered();
    const ctx: DetectorContext = { me, histories: hs, http, profile: withSelf(profile ?? noProfile, hs), lookup: offline, nonces: noNonces, memo: new Map() };
    const findings = await runDetectors(DETECTOR_LIST, ctx, coverage());
    const w = poisoningWarning(ctx);
    const r = assemble(me, findings, coverage(), profile && ctx.profile, t0, startedAt, 'running', opts, [], w ? [w] : []);
    for (const f of r.findings) if (!seen.has(f.key)) { seen.add(f.key); emit({ type: 'finding', finding: f }); }
    emit({ type: 'partial', result: r });
  };
  let queue = Promise.resolve();
  const schedule = () => { queue = queue.then(partial).catch(() => {}); };

  const profileP = fetchProfile(http, me).then((p) => { profile = p.profile; if (p.profile.isContract) notPersonNow(); schedule(); return p; }).catch(() => null);
  await Promise.all(defs.map((c) => fetchChainWhole(http, c, me, lim).then((h) => {
    const hh = quickOn ? quickShape(h) : h;
    histories.push(hh);
    emit({ type: 'chain', coverage: hh.coverage });
    schedule();
  })));
  const prof = await profileP;
  await queue;

  // The card decides with what was read: a contract or a service that showed itself only at the very end
  // (its last chain's rows) still reads as one.
  const end = withSelf(profile ?? noProfile, ordered());
  if (!opts.readAll && (end.isContract || selfService(me, end, coverage()))) notPersonNow();
  shapeAll();
  const gaps: Incomplete[] = [];
  const hs = ordered();
  // Every lookup and nonce check and its answer is kept with the result, so features can replay it offline (session.ts).
  const recorded = recordLookups(makeLookup(http, LOOKUP_BUDGET, gaps));
  const nonceAnswers = new Map<string, Promise<number | null>>();
  const ctx: DetectorContext = {
    me, histories: hs, http, profile: withSelf(profile ?? noProfile, hs), lookup: recorded.lookup,
    nonces: makeNonces(http, (id) => CHAIN_BY_ID.get(id)?.rpc, gaps, nonceAnswers), memo: new Map(),
  };
  const findings = await runDetectors(DETECTOR_LIST, ctx, coverage());
  const rec = ctx.profile.isContract || selfService(me, ctx.profile, coverage()) ? null : await analyzeRecipients(ctx).catch(() => null);
  const warning = poisoningWarning(ctx, rec);
  const inRegisterOrder = coverage().sort((a, b) => (rank.get(a.chainId) ?? 0) - (rank.get(b.chainId) ?? 0));
  const incomplete = collectIncomplete(inRegisterOrder, prof ? prof.errors : null, gaps, !!opts.signal?.aborted);
  const result = assemble(me, findings, coverage(), profile && ctx.profile, t0, startedAt, incomplete.length ? 'partial' : 'complete', opts, incomplete, warning ? [warning] : []);
  result.stats = { requests: http.count, cached: http.cached, waitedMs: http.waitedMs, byKind: { ...http.byKind }, ...(http.remaining !== undefined ? { rateLimitRemaining: http.remaining } : {}) };
  keepSession(result, { me, histories: ctx.histories, profile: ctx.profile, lookups: recorded.calls, nonces: nonceAnswers, incomplete, skipped });
  for (const f of result.findings) if (!seen.has(f.key)) { seen.add(f.key); emit({ type: 'finding', finding: f }); }
  emit({ type: 'done', result });
  return result;
}
