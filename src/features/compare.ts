// Compare (FEATURES D2): can these two wallets be linked? Built from what both scans read, with
// the engine's own rules and confidences; two weak extras (shared counterparties, a similar
// fingerprint) are capped low and say so. A link is a likelihood with its reasons and proof, never a
// claim about who owns a wallet. No request: both sessions are replayed from their records.
import { cexOf, counterparties, lookalike, personal, serviceOf, SERVICE_NONCE, type Counterparty } from '../detectors/context.ts';
import { analyzeRecipients } from '../detectors/deposits.ts';
import { bridgeMatches } from '../detectors/cross-chain.ts';
import { hourHistogram, isRound, quietestWindow } from '../detectors/behavioral-fingerprint.ts';
import { signedHere, type Transfer } from '../history.ts';
import { serviceIdentity } from '../labels.ts';
import { linkLevel } from '../score.ts';
import type { ScanSession } from '../session.ts';
import { addressUrl, chainName, txUrl } from '../chains.ts';
import type { ChainCoverage, ChainId, Evidence, Incomplete, LinkLevel, ScanResult } from '../types.ts';
import { replayContext, rerun } from './replay.ts';

export type CompareReasonKind = 'direct' | 'funded' | 'shared_funder' | 'shared_deposit' | 'bridge' | 'counterparties' | 'fingerprint';

export interface CompareReason {
  kind: CompareReasonKind;
  confidence: number;
  level: LinkLevel;
  /** Short, English. */
  title: string;
  /** One or two plain sentences. */
  text: string;
  evidence: Evidence[];
  /** The rule whose advice is the fix (fix-plan advice.json). */
  ruleId: string;
  /** A weak extra signal, capped low on purpose. */
  weak?: boolean;
  /** The shape of the trail, for a picture of it: who sent to whom, or the address both touched. */
  trail: CompareTrail;
}

/**
 * flow: transfers between the two (counts per direction; paying the other's first transaction counts as one from the payer).
 * via: an address both touched: the funder of both, the deposit address both paid into.
 * bridge: out of one wallet on one chain, into the other on another. shared: personal wallets both deal with.
 * habits: no address in between, only similar habits.
 */
export type CompareTrail =
  | { kind: 'flow'; aToB: number; bToA: number; chains: ChainId[] }
  | { kind: 'via'; role: 'funder' | 'deposit'; address: string; chainId: ChainId; label?: string }
  | { kind: 'bridge'; from: 'a' | 'b'; chains: [ChainId, ChainId] }
  | { kind: 'shared'; count: number }
  | { kind: 'habits' };

export interface Comparison {
  a: string;
  b: string;
  /** Combined: 1 - (1 - c1)(1 - c2)..., capped at 0.95. 0 when no reason was found. */
  confidence: number;
  /** null = no link found by Nymra's rules (never "not linked"). */
  level: LinkLevel | null;
  /** Strongest first. */
  reasons: CompareReason[];
  /** Chains read per wallet, and chains where at least one of the two could not be read. */
  coverage: { a: ChainCoverage[]; b: ChainCoverage[]; read: { a: number; b: number }; unchecked: ChainId[] };
  /** A wallet that is a contract, an exchange address or a listed service: Compare is about personal wallets. */
  notPersonal: { a?: string; b?: string };
  /**
   * Chains where one of the two sent 2,000 or more transactions (its own count): RULES treats a wallet
   * that busy as a service or a bot, so nothing on that chain links them.
   */
  busy: { wallet: 'a' | 'b'; chainId: ChainId; sent: number }[];
  /** The two addresses look alike (address poisoning): one may imitate the other. Never a link. */
  lookalike: boolean;
  /** What each scan could not read (its `incomplete`). Not empty: "no link found" covers only what was read. */
  gaps: { a: Incomplete[]; b: Incomplete[] };
}

const short = (a: string) => `${a.slice(0, 6)}...${a.slice(-4)}`;
const r2 = (x: number) => Math.round(x * 100) / 100;
const DAY = 86400;

function txEv(t: Transfer, text: string): Evidence {
  return { kind: 'tx', text, chainId: t.chainId, txHash: t.hash, timestamp: t.timestamp, ...(txUrl(t.chainId, t.hash) ? { url: txUrl(t.chainId, t.hash) } : {}) };
}
function addrEv(chainId: ChainId, address: string, text: string, label?: string): Evidence {
  return { kind: 'address', text, address, chainId, ...(addressUrl(chainId, address) ? { url: addressUrl(chainId, address) } : {}), ...(label ? { label } : {}) };
}

/** Transfers between the two, seen from A, merged with what B's history shows (either may be cut). */
function between(ca: Counterparty | undefined, cb: Counterparty | undefined): { out: Transfer[]; in: Transfer[] } {
  const out = new Map<string, Transfer>(), inn = new Map<string, Transfer>();
  for (const t of ca?.outTransfers ?? []) out.set(`${t.chainId}:${t.hash}`, t);
  for (const t of ca?.inTransfers ?? []) inn.set(`${t.chainId}:${t.hash}`, t);
  // B's side: what B received from A is A's out; what B sent to A is A's in.
  for (const t of cb?.inTransfers ?? []) if (!out.has(`${t.chainId}:${t.hash}`)) out.set(`${t.chainId}:${t.hash}`, t);
  for (const t of cb?.outTransfers ?? []) if (!inn.has(`${t.chainId}:${t.hash}`)) inn.set(`${t.chainId}:${t.hash}`, t);
  return { out: [...out.values()], in: [...inn.values()] };
}

/** "3 transfers from A to B and 2 back", "4 transfers from A to B, none back", "2 transfers from B to A". */
function flowText(nOut: number, nIn: number, a: string, b: string): string {
  const n = (k: number) => `${k} ${k === 1 ? 'transfer' : 'transfers'}`;
  if (nOut && nIn) return `${n(nOut)} from ${a} to ${b} and ${nIn} back`;
  return nOut ? `${n(nOut)} from ${a} to ${b}, none back` : `${n(nIn)} from ${b} to ${a}, none back`;
}

/** Sibling-link confidence of RULES.md shared_funder: the finding's confidence for k siblings, times 0.75. */
function sharedFunderLink(k: number): number {
  const conf = k <= 1 ? 0.55 : k <= 5 ? 0.75 : k <= 15 ? 0.55 : k <= 40 ? 0.35 : 0.2;
  return r2(conf * 0.75);
}

/** Personal counterparties by the engine's own test (no contract, exchange, service or look-alike), minus busy ones. */
function personalCps(cps: Map<string, Counterparty>, skip: string[], busy: (address: string, chains: Iterable<ChainId>) => boolean): Set<string> {
  return new Set([...cps.values()].filter((c) => personal(c) && c.nIn + c.nOut > 0 && !skip.includes(c.address) && !busy(c.address, c.chains)).map((c) => c.address));
}

/**
 * Did this wallet ever sign a transaction on the chain, by its own scan? Unknown when the scan did not
 * read the chain, or read only part of a long history without the chain's own count.
 */
function signedOn(s: ScanSession, chainId: ChainId): boolean | undefined {
  const h = s.histories.find((x) => x.chain.id === chainId);
  if (!h) return undefined;
  if (signedHere(h)) return true;
  return h.nonce === 0 || (!h.truncated && h.coverage.status !== 'error' && h.coverage.status !== 'partial') ? false : undefined;
}

/** The nonces both scans read (`chainId:address`), answered: what RULES uses to tell a service or a bot. */
async function knownNonces(...ss: ScanSession[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const s of ss) for (const [k, p] of s.nonces) {
    const n = await p;
    if (n !== null && Number.isFinite(n)) out.set(k, Math.max(n, out.get(k) ?? 0));
  }
  return out;
}

function signedHours(s: ScanSession): number[] | null {
  const ts: number[] = [];
  for (const h of s.histories) for (const t of h.txs) if (t.from === s.me && t.timestamp > 0) ts.push(t.timestamp);
  return ts.length >= 25 ? hourHistogram(ts) : null;
}

function quietSet(hist: number[]): Set<number> {
  const q = quietestWindow(hist);
  const out = new Set<number>();
  if (q.len < 5 || q.len > 12) return out;
  for (let i = 0; i < q.len; i++) out.add((q.start + i) % 24);
  return out;
}

/** The gas limit a wallet uses on most of its contract calls across different functions, if any. */
function fixedGas(s: ScanSession): number | null {
  const calls = s.histories.flatMap((h) => h.txs).filter((t) => t.from === s.me && t.isCall && t.gasLimit);
  if (calls.length < 10) return null;
  const n = new Map<number, Transfer[]>();
  for (const t of calls) n.set(t.gasLimit!, [...(n.get(t.gasLimit!) ?? []), t]);
  const [limit, same] = [...n.entries()].sort((a, b) => b[1].length - a[1].length)[0];
  return same.length / calls.length >= 0.5 && new Set(same.map((t) => t.methodId)).size >= 2 ? limit : null;
}

export async function compareWallets(sa: ScanSession, sb: ScanSession): Promise<Comparison> {
  const a = sa.me, b = sb.me;
  if (a === b) throw new Error('These are the same address.');
  const readOf = (c: ChainCoverage[]) => c.filter((x) => x.status === 'scanned' || x.status === 'partial').length;
  const covA = sa.histories.map((h) => h.coverage), covB = sb.histories.map((h) => h.coverage);
  const failed = new Set([...covA, ...covB].filter((c) => c.status === 'error').map((c) => c.chainId));
  const kindOf = (s: ScanSession, addr: string) => {
    if (s.profile.isContract) return 'a contract';
    const svc = serviceIdentity(addr);
    if (!svc) return undefined;
    const who = svc.entity ? ` (${svc.entity})` : '';
    return svc.kind === 'exchange' ? `an exchange wallet${who}` : svc.kind === 'deposit' ? `an exchange deposit address${who}` : `a ${svc.kind} wallet${who}`;
  };
  const ca = replayContext(sa), cb = replayContext(sb);
  const cpsA = counterparties(ca), cpsB = counterparties(cb);
  // As the other's counterparty, a wallet with a public service tag is a service too (serviceOf).
  const tagged = (c?: Counterparty) => (c?.service ? `a tagged service (${c.service})` : undefined);
  const na = kindOf(sa, a) ?? tagged(cpsB.get(a)), nb = kindOf(sb, b) ?? tagged(cpsA.get(b));
  const busy: Comparison['busy'] = [];
  for (const [w, s] of [['a', sa], ['b', sb]] as const) for (const h of s.histories) if ((h.nonce ?? 0) >= SERVICE_NONCE) busy.push({ wallet: w, chainId: h.chain.id, sent: h.nonce! });
  const busyChain = new Set(busy.map((x) => x.chainId));
  const look = lookalike(a, b);
  const shell: Omit<Comparison, 'confidence' | 'level' | 'reasons'> = {
    a, b, coverage: { a: covA, b: covB, read: { a: readOf(covA), b: readOf(covB) }, unchecked: [...failed] },
    notPersonal: { ...(na ? { a: na } : {}), ...(nb ? { b: nb } : {}) }, busy, lookalike: look,
    gaps: { a: [...sa.incomplete], b: [...sb.incomplete] },
  };
  // A service is never a link, and neither is a look-alike (RULES 1.2.0): nothing to weigh.
  if (look || na || nb) return { ...shell, confidence: 0, level: null, reasons: [] };

  const [ra, rb, nonces] = await Promise.all([rerun(sa), rerun(sb), knownNonces(sa, sb)]);
  const busyOther = (address: string, chains: Iterable<ChainId>) => [...chains].some((c) => (nonces.get(`${c}:${address}`) ?? 0) >= SERVICE_NONCE);
  const reasons: CompareReason[] = [];

  // What each scan already linked (its own findings): the confidence the engine gave that link.
  const fromScan = (r: ScanResult, other: string) => {
    const m = new Map<string, number>();
    for (const f of r.findings) for (const x of f.related ?? []) if (x.address === other) m.set(f.id, Math.max(m.get(f.id) ?? 0, x.confidence));
    return m;
  };
  const linkA = fromScan(ra, b), linkB = fromScan(rb, a);
  const scanConf = (...ids: string[]) => Math.max(0, ...ids.flatMap((id) => [linkA.get(id) ?? 0, linkB.get(id) ?? 0]));

  // 1. Direct transfers, and coins that paid for the other's first transaction.
  const d = between(cpsA.get(b), cpsB.get(a));
  const fundedB = sb.histories.map((h) => h.firstFunding).find((t) => t && t.from === a && !busyChain.has(t.chainId));
  const fundedA = sa.histories.map((h) => h.firstFunding).find((t) => t && t.from === b && !busyChain.has(t.chainId));
  if (fundedB || fundedA) {
    const t = (fundedB ?? fundedA)!;
    const [payer, payee] = fundedB ? [a, b] : [b, a];
    reasons.push({
      kind: 'funded', confidence: Math.max(0.6, scanConf('linked_wallets.funded_by_you')), level: 'possible', ruleId: 'linked_wallets.funded_by_you',
      title: "One paid for the other's first transaction",
      text: `What paid for the first transaction ${short(payee)} signed on ${chainName(t.chainId)} came from ${short(payer)}. A new wallet funded from an old one carries its history. It can also be a gift or a payment.`,
      evidence: [txEv(t, `Paid for the first transaction of ${short(payee)}`)],
      trail: { kind: 'flow', aToB: fundedB ? 1 : 0, bToA: fundedB ? 0 : 1, chains: [t.chainId] },
    });
  }
  // The first-funds transfer is that reason's proof: it does not count a second time as a direct transfer.
  const funding = new Set([fundedA, fundedB].filter(Boolean).map((t) => `${t!.chainId}:${t!.hash}`));
  // RULES 1.2.0: a token event from a wallet that never signed a transaction on that chain can only be
  // forged. A plain transaction is its sender's own signature, so it always counts. Each wallet's own
  // scan says whether it signed there; unknown is kept.
  const senderSigned = (t: Transfer) => t.kind !== 'token' || signedOn(t.from === a ? sa : sb, t.chainId) !== false;
  d.out = d.out.filter((t) => !funding.has(`${t.chainId}:${t.hash}`) && !busyChain.has(t.chainId) && senderSigned(t));
  d.in = d.in.filter((t) => !funding.has(`${t.chainId}:${t.hash}`) && !busyChain.has(t.chainId) && senderSigned(t));
  const nOut2 = d.out.length, nIn2 = d.in.length;
  if (nOut2 + nIn2 > 0) {
    const [nOut, nIn] = [nOut2, nIn2];
    const both = nOut > 0 && nIn > 0 && nOut + nIn >= 3;
    const conf = both ? r2(Math.min(0.85, 0.35 + 0.08 * Math.min(nIn, nOut) + 0.02 * (nIn + nOut))) : 0.3;
    const first = [...d.out, ...d.in].sort((x, y) => x.timestamp - y.timestamp)[0];
    const last = [...d.out, ...d.in].sort((x, y) => y.timestamp - x.timestamp)[0];
    const chains = [...new Set([...d.out, ...d.in].map((t) => t.chainId))];
    reasons.push({
      kind: 'direct', confidence: Math.max(conf, scanConf('linked_wallets.back_and_forth')), level: 'weak', ruleId: 'linked_wallets.back_and_forth',
      title: both ? 'Funds go back and forth between them' : nOut && nIn ? 'One transfer each way between them' : nIn === 0 ? `${short(a)} sent to ${short(b)}` : `${short(b)} sent to ${short(a)}`,
      text: `${flowText(nOut, nIn, short(a), short(b))}, on ${chains.map(chainName).join(', ')}. ${
        both ? 'Repeated two-way flows between personal wallets often mean they belong together.'
          : nOut + nIn === 1 ? 'A direct transfer is a visible trail, though one payment alone says little.'
          : 'Payments in one direction draw a clear trail, but they are also what you send a friend or a shop, so they say little about who owns the two.'
      }`,
      evidence: [txEv(first, 'First transfer between them'), ...(last !== first ? [txEv(last, 'Latest transfer between them')] : [])],
      trail: { kind: 'flow', aToB: nOut, bToA: nIn, chains },
    });
  }

  // 2. The same first funder.
  for (const ha of sa.histories) {
    const fa = ha.firstFunding;
    if (!fa || fa.from === b || fa.kind === 'internal' || busyChain.has(ha.chain.id)) continue;
    const hb = sb.histories.find((h) => h.chain.id === ha.chain.id);
    const fb = hb?.firstFunding;
    if (!fb || fb.from !== fa.from || fb.kind === 'internal' || cexOf(fa.from, fa.cp) || cexOf(fb.from, fb.cp) || fa.cp?.isContract || fb.cp?.isContract) continue;
    // A service or a bot funds crowds (RULES 1.2.0): a listed or tagged service, or one that sent 2,000+ transactions there.
    if (serviceOf(fa.from, fa.cp) || serviceOf(fb.from, fb.cp) || busyOther(fa.from, [ha.chain.id])) continue;
    const gap = Math.abs(fa.timestamp - fb.timestamp);
    // How many wallets that funder paid around A's funding, from A's own funder check when it was made.
    const rec = [...sa.lookups.values(), ...sb.lookups.values()].find((c) => c.chainId === ha.chain.id && c.action === 'txlist' && c.address === fa.from && c.q.filter === 'from');
    const rows = rec ? await rec.rows : null;
    if (rows && rows.length >= 200) continue; // a service or a bot: a crowd, not a link
    const funded = rows ? rows.filter((t) => t.dir === 'out' && !t.isCall && !t.failed && t.amount > 0 && !cexOf(t.to, t.cp) && !t.cp?.isContract && !serviceOf(t.to, t.cp)).map((t) => t.to) : [];
    // Other wallets it funded besides one of the two (the engine's k), never fewer than the other one.
    const k = rows ? Math.max(1, new Set(funded.filter((x) => x !== a)).size) : 1;
    if (k > 40) continue; // a distributor: more than 40 wallets funded in the window
    const conf = gap <= 3 * DAY ? Math.max(sharedFunderLink(k), scanConf('funding_reuse.shared_funder')) : 0.3;
    reasons.push({
      kind: 'shared_funder', confidence: conf, level: 'weak', ruleId: 'funding_reuse.shared_funder', weak: gap > 3 * DAY,
      title: 'The same wallet paid for the first transaction of both',
      text: `On ${chainName(ha.chain.id)}, the first transaction of each was paid with coins from ${short(fa.from)}, sent ${gap <= 3 * DAY ? `${Math.max(1, Math.round(gap / 3600))} hours apart` : `${Math.round(gap / DAY)} days apart, which makes it weaker`}. Wallets funded from one source are easy to group.`,
      evidence: [txEv(fa, `Paid for the first transaction of ${short(a)}`), txEv(fb, `Paid for the first transaction of ${short(b)}`), addrEv(ha.chain.id, fa.from, 'The funder')],
      trail: { kind: 'via', role: 'funder', address: fa.from, chainId: ha.chain.id },
    });
    break;
  }

  // 3. A shared exchange deposit address.
  const [depA, depB] = await Promise.all([analyzeRecipients(ca), analyzeRecipients(cb)]);
  const hits = [
    ...depA.deposits.filter((x) => (cpsB.get(x.address)?.nOut ?? 0) > 0),
    ...depB.deposits.filter((x) => (cpsA.get(x.address)?.nOut ?? 0) > 0 && !depA.deposits.some((y) => y.address === x.address)),
  ].filter((x) => !busyChain.has(x.chainId));
  if (hits.length) {
    const x = hits[0];
    const omnibus = x.senders > 6;
    const conf = x.how === 'label' ? (omnibus ? 0.35 : 0.8) : omnibus ? 0.3 : 0.7;
    reasons.push({
      kind: 'shared_deposit', confidence: Math.max(conf, scanConf('linked_wallets.shared_deposit')), level: 'weak', ruleId: 'linked_wallets.shared_deposit',
      title: 'Both pay into the same exchange deposit address',
      text: `Both sent funds to ${short(x.address)}, ${x.how === 'label' ? `listed as a ${x.entity} deposit address` : `which forwards to ${x.entity}`}. One deposit address belongs to one exchange account${omnibus ? '; this one has many senders, so the link is weak' : ''}.`,
      evidence: [addrEv(x.chainId, x.address, `${x.entity} deposit address`, `${x.entity} deposit`)],
      trail: { kind: 'via', role: 'deposit', address: x.address, chainId: x.chainId, label: `${x.entity} deposit` },
    });
  }

  // 4. A bridge from one to the other: out on one chain, almost the same amount in on another, minutes later.
  const flows = (s: ScanSession) => {
    const outs: Transfer[] = [], ins: Transfer[] = [];
    for (const h of s.histories) for (const t of [...h.txs, ...h.internal, ...h.tokens]) {
      if (t.failed || t.amount <= 0) continue;
      if (t.dir === 'out' && t.amount >= 0.001) outs.push(t);
      if (t.dir === 'in') ins.push(t);
    }
    return { outs, ins };
  };
  const fa = flows(sa), fb = flows(sb);
  const pairs = [...bridgeMatches(fa.outs, fb.ins), ...bridgeMatches(fb.outs, fa.ins)].filter(([o, i]) => !busyChain.has(o.chainId) && !busyChain.has(i.chainId));
  if (pairs.length) {
    const exact = pairs.filter(([o]) => !isRound(o));
    const conf = exact.length ? Math.min(0.85, 0.55 + 0.1 * (exact.length - 1)) : 0.25;
    const [o, i] = exact[0] ?? pairs[0];
    reasons.push({
      kind: 'bridge', confidence: r2(conf), level: 'weak', ruleId: 'cross_chain.bridge_match', weak: !exact.length,
      title: exact.length ? 'A bridge transfer from one to the other' : 'Round amounts that match across chains',
      text: `${o.amount} ${o.symbol} left ${o.from === a ? short(a) : short(b)} on ${chainName(o.chainId)} and ${i.amount} ${i.symbol} reached ${i.to === a ? short(a) : short(b)} on ${chainName(i.chainId)} ${Math.max(1, Math.round((i.timestamp - o.timestamp) / 60))} minutes later.${exact.length ? '' : ' The amounts are round, so this may be chance.'}`,
      evidence: [txEv(o, `Out on ${chainName(o.chainId)}`), txEv(i, `In on ${chainName(i.chainId)}`)],
      trail: { kind: 'bridge', from: o.from === a ? 'a' : 'b', chains: [o.chainId, i.chainId] },
    });
  }

  // 5. Weak: many of the same personal counterparties.
  const pa = personalCps(cpsA, [a, b], busyOther), pb = personalCps(cpsB, [a, b], busyOther);
  const shared = [...pa].filter((x) => pb.has(x));
  const union = new Set([...pa, ...pb]).size;
  const jac = union ? shared.length / union : 0;
  if (shared.length >= 3 && jac >= 0.3) {
    reasons.push({
      kind: 'counterparties', confidence: r2(Math.min(0.4, 0.15 + 0.5 * (jac - 0.3) + 0.02 * (shared.length - 3))), level: 'weak', ruleId: 'recurring_counterparties.top', weak: true,
      title: 'They deal with many of the same wallets',
      text: `${shared.length} personal wallets trade with both (${Math.round(jac * 100)}% overlap). Friends and coworkers share counterparties too, so on its own this counts for little.`,
      evidence: shared.slice(0, 3).map((x) => addrEv([...(cpsA.get(x)?.chains ?? [1])][0], x, 'Deals with both')),
      trail: { kind: 'shared', count: shared.length },
    });
  }

  // 6. Weakest: a similar fingerprint (quiet hours, plus the same fixed gas limit or wallet app).
  const ha = signedHours(sa), hb = signedHours(sb);
  if (ha && hb) {
    const qa = quietSet(ha), qb = quietSet(hb);
    const overlap = qa.size && qb.size ? [...qa].filter((x) => qb.has(x)).length / Math.min(qa.size, qb.size) : 0;
    const gasA = fixedGas(sa), gasB = fixedGas(sb);
    const sameGas = gasA !== null && gasA === gasB;
    const sameApp = !!sa.profile.delegate && sa.profile.delegate === sb.profile.delegate;
    if (overlap >= 0.8 && (sameGas || sameApp)) {
      reasons.push({
        kind: 'fingerprint', confidence: sameGas && sameApp ? 0.25 : 0.2, level: 'weak', ruleId: sameGas ? 'behavioral_fingerprint.fixed_gas' : 'behavioral_fingerprint.wallet_software', weak: true,
        title: 'Similar habits',
        text: `The same quiet hours${sameGas ? `, the same fixed gas limit (${gasA})` : ''}${sameApp ? `, the same wallet app (${sa.profile.delegate})` : ''}. Many people share habits. This barely counts.`,
        evidence: [{ kind: 'pattern', text: `Quiet hours overlap ${Math.round(overlap * 100)}%` }],
        trail: { kind: 'habits' },
      });
    }
  }

  for (const x of reasons) x.level = linkLevel(x.confidence);
  reasons.sort((x, y) => y.confidence - x.confidence);
  const combined = reasons.length ? Math.min(0.95, r2(1 - reasons.reduce((p, x) => p * (1 - x.confidence), 1))) : 0;
  return { ...shell, confidence: combined, level: reasons.length ? linkLevel(combined) : null, reasons };
}
