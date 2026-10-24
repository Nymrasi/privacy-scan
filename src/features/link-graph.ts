// Link Graph (roadmap Phase 2): what someone who reads the public chain can tie to one wallet, followed
// from wallet to wallet in one graph. Each wallet is read with the ordinary scan; a line between two
// wallets is a link Nymra's own rules found (the scan's linked wallets, and the Compare rules once both
// ends are read), with its likelihood and the transactions behind it. A wallet's place in the graph is
// the likelihood of its strongest path back to the first wallet: the links along it multiplied, so it
// can only fall with every hop.
//
// Nothing here says who owns a wallet, and nothing is ever certain: a link and a path both stay at or
// below MAX_CONFIDENCE. A service, an exchange address, a contract or a look-alike is never a link
// (RULES 1.2.0), so the graph never runs through one. An exchange deposit address is drawn as what it is: the
// point where an exchange that knows its customers can put a name to the wallets that pay in. It carries the
// exchange's name only when Nymra can show where that name comes from. The graph lives in memory only, for as long
// as the caller holds it, and is never written anywhere.
import { addressUrl, chainName, txUrl } from '../chains.ts';
import { cexOf, short } from '../detectors/context.ts';
import { analyzeRecipients, type DepositHit } from '../detectors/deposits.ts';
import { cexLabel } from '../labels.ts';
import type { Transfer } from '../history.ts';
import { linkLevel } from '../score.ts';
import { sessionOf, type ScanSession } from '../session.ts';
import type { ChainId, Evidence, Finding, LinkLevel, RelatedAddress, ScanResult, ScoreBand } from '../types.ts';
import { compareWallets, type Comparison } from './compare.ts';
import { replayContext, rerun } from './replay.ts';

/** Never certain: no link and no path above this. The same ceiling as merged links and Compare. */
export const MAX_CONFIDENCE = 0.95;

export interface GraphLimits {
  /** How many hops from the first wallet the graph reads by itself. A wallet further out can still be followed by hand. */
  depth: number;
  /** Links drawn from one wallet, strongest first. */
  perWallet: number;
  /** A wallet is read further only when the link that reaches it is at least this likely (Possible). */
  follow: number;
  /** ...and its path to the first wallet is at least this likely. */
  reach: number;
  /** Wallets the graph reads by itself, the first one included. */
  reads: number;
  /** Wallets read in all, by hand included: each read is a whole scan of the public explorers. */
  maxReads: number;
  /** Wallets in the graph at most; the least likely leave first. */
  nodes: number;
  /** Scans at the same time. */
  together: number;
}

export const GRAPH_LIMITS: GraphLimits = { depth: 2, perWallet: 6, follow: 0.45, reach: 0.3, reads: 7, maxReads: 16, nodes: 40, together: 2 };

/** One reason behind a link, in plain words, with the proof the scans read. */
export interface GraphReason {
  /** The rule (RULES.md), whose advice is the fix. */
  ruleId: string;
  title: string;
  /** One or two plain sentences. Never a claim about who owns a wallet. */
  text: string;
  confidence: number;
  level: LinkLevel;
  /** Transactions first (each with its explorer link), then the address both touched, when there is one. */
  evidence: Evidence[];
  /** A weak extra signal, capped low on purpose (Compare). */
  weak?: boolean;
}

export interface GraphLink {
  /** The wallet nearer the first one (the one that was read, when only one was). */
  a: string;
  b: string;
  /** All reasons together: 1 - (1 - c1)(1 - c2)..., at most MAX_CONFIDENCE. */
  confidence: number;
  level: LinkLevel;
  /** Strongest first. */
  reasons: GraphReason[];
  /**
   * 'both': both wallets were read and Compare weighed the pair with everything both scans saw. 'one': only `a`
   * was read so far, so this is what a's scan saw; reading b can change it.
   */
  read: 'both' | 'one';
  chainIds: ChainId[];
}

/** A wallet in the graph that pays into a deposit address, with the transfers that show it. */
export interface DepositUser {
  address: string;
  /** Payments into it the scans saw. */
  count: number;
  evidence: Evidence[];
}

/**
 * An exchange deposit address one or more wallets in the graph pay into. Not a wallet of the graph: it never carries
 * a path. Two wallets that pay into the same one get a link of their own (linked_wallets.shared_deposit).
 */
export interface GraphDeposit {
  address: string;
  chainId: ChainId;
  /**
   * The exchange, only where Nymra can show it: the open list of exchange deposit addresses it carries ('label'), or a
   * transfer that forwarded what came in to a labelled exchange wallet ('sweep', with that transfer as proof). Unset:
   * an exchange deposit address whose exchange Nymra cannot show.
   */
  entity?: string;
  how: 'label' | 'sweep';
  /** How likely it is one customer's deposit address at that exchange (cex_exposure.deposit_address), at most MAX_CONFIDENCE. */
  confidence: number;
  level: LinkLevel;
  /** Distinct wallets the scans saw pay into it. */
  senders: number;
  /** More than 6 senders: an address many pay into, so the link through it is weak. */
  shared: boolean;
  /** Wallets of the graph that pay into it, the most payments first. */
  users: DepositUser[];
  /** Where the exchange's name comes from: the listed address, or the transfer that forwarded to the exchange. */
  evidence: Evidence[];
}

export type GraphNodeState = 'start' | 'read' | 'reading' | 'unread' | 'failed';

export interface GraphNode {
  address: string;
  /** Links on its strongest path to the first wallet; 0 for the first wallet. */
  hop: number;
  /** How likely its strongest path to the first wallet is: the links along it multiplied. null for the first wallet. */
  reach: number | null;
  level: LinkLevel | null;
  /** The wallet before it on that path. */
  via?: string;
  state: GraphNodeState;
  /** A public label the explorer gives it, or its ENS name once read. */
  label?: string;
  /** Once read: its own privacy score. */
  score?: number;
  band?: ScoreBand;
  /** Once read: its scan could not read everything, so it may have more links. */
  partial?: boolean;
  /** Why the graph does not read it by itself: too many hops, a weak path, or the read limit. */
  stop?: 'depth' | 'weak' | 'limit';
}

export interface LinkGraph {
  start: string;
  /** The first wallet, then by hop, then most likely first. */
  nodes: GraphNode[];
  links: GraphLink[];
  /** Wallets read so far (scans), the first one included. */
  reads: number;
  /** Wallets that were read and turned out to be no person (a service, an exchange address, a contract): never a link. */
  notPersonal: { address: string; what: string }[];
  /** Exchange deposit addresses the wallets of the graph pay into, those with the most wallets of the graph first. */
  deposits: GraphDeposit[];
  limits: GraphLimits;
  /** True while a wallet is being read. */
  running: boolean;
}

const r2 = (x: number) => Math.round(x * 100) / 100;
const cap = (x: number) => Math.min(MAX_CONFIDENCE, r2(x));
const pairKey = (x: string, y: string) => (x < y ? `${x}|${y}` : `${y}|${x}`);
const combine = (cs: number[]) => cap(1 - cs.reduce((p, c) => p * (1 - c), 1));

function amount(t: Transfer): string {
  const v = t.amount >= 100 ? Math.round(t.amount).toString() : t.amount >= 1 ? (+t.amount.toFixed(2)).toString() : (+t.amount.toPrecision(3)).toString();
  return `${v} ${t.symbol}`;
}
function txProof(t: Transfer, text: string): Evidence {
  const url = txUrl(t.chainId, t.hash);
  return { kind: 'tx', text, chainId: t.chainId, txHash: t.hash, timestamp: t.timestamp, ...(url ? { url } : {}) };
}
function addrProof(chainId: ChainId, address: string, text: string, label?: string): Evidence {
  const url = addressUrl(chainId, address);
  return { kind: 'address', text, address, chainId, ...(url ? { url } : {}), ...(label ? { label } : {}) };
}

/** Every transfer a scan read, its own lists and the lookups it made about other addresses (funders, deposit addresses). */
async function readTransfers(s: ScanSession): Promise<{ own: Transfer[]; looked: { address: string; chainId: ChainId; rows: Transfer[] }[] }> {
  const own = s.histories.flatMap((h) => [...h.txs, ...h.internal, ...h.tokens]).filter((t) => !t.failed && t.amount > 0);
  const looked: { address: string; chainId: ChainId; rows: Transfer[] }[] = [];
  for (const c of s.lookups.values()) {
    const rows = await c.rows.catch(() => null);
    if (rows?.length) looked.push({ address: c.address, chainId: c.chainId, rows: rows.filter((t) => !t.failed && t.amount > 0) });
  }
  return { own, looked };
}

const VIA_RULES = new Set(['funding_reuse.shared_funder', 'linked_wallets.shared_deposit']);
const PROOF_MAX = 6;

/** The transactions behind one link as the scan of `me` read them, oldest first, without doubles. */
function proofFor(me: string, other: string, ruleId: string, f: Finding, read: Awaited<ReturnType<typeof readTransfers>>, hits: DepositHit[]): Evidence[] {
  const seen = new Set<string>();
  const out: Evidence[] = [];
  const add = (e: Evidence) => {
    const k = e.txHash ? `${e.chainId}:${e.txHash}` : `${e.chainId}:${e.address}`;
    if (seen.has(k) || out.length >= PROOF_MAX) return;
    seen.add(k);
    out.push(e);
  };
  const by = (list: Transfer[]) => [...list].sort((x, y) => x.timestamp - y.timestamp);
  if (VIA_RULES.has(ruleId)) {
    // The address both touched (the funder, the deposit address), as the finding names it, and the transfers
    // that tie each of the two to it.
    for (const l of read.looked) {
      const theirs = by(l.rows.filter((t) => t.from === other || t.to === other));
      if (!theirs.length || l.address === me || l.address === other) continue;
      const mine = by(read.own.filter((t) => t.chainId === l.chainId && (t.from === l.address || t.to === l.address)));
      if (!mine.length) continue;
      const label = f.evidence.find((e) => e.address === l.address)?.label;
      const ent = ruleId === 'linked_wallets.shared_deposit' ? named(hits.find((h) => h.address === l.address)?.entity) : undefined;
      const role = ruleId === 'funding_reuse.shared_funder' ? 'The funder of both' : `The ${ent ? `${ent} ` : 'exchange '}deposit address both paid into`;
      for (const t of mine.slice(0, 2)) add(txProof(t, `${short(t.from)} sent ${amount(t)} to ${short(t.to)}`));
      for (const t of theirs.slice(0, 2)) add(txProof(t, `${short(t.from)} sent ${amount(t)} to ${short(t.to)}`));
      add(addrProof(l.chainId, l.address, role, label));
    }
  } else {
    const direct = by(read.own.filter((t) => (t.from === me && t.to === other) || (t.from === other && t.to === me)));
    // The first and the latest transfers say most; the ones in between fill up to PROOF_MAX.
    const pick = direct.length <= PROOF_MAX ? direct : [...direct.slice(0, PROOF_MAX - 1), direct[direct.length - 1]];
    for (const t of pick) add(txProof(t, `${short(t.from)} sent ${amount(t)} to ${short(t.to)}`));
  }
  // What the finding itself names about this wallet, when the lists above had nothing (a fixture, a cut history).
  if (!out.length) for (const e of f.evidence) if (e.address === other || (e.kind === 'tx' && e.text.includes(short(other)))) add(e);
  return out;
}

/** The words for one reason a scan gave, seen from the wallet that was read. */
function words(ruleId: string, me: string, other: string, f: Finding, rel: RelatedAddress, read: Awaited<ReturnType<typeof readTransfers>>, hits: DepositHit[]): { title: string; text: string } {
  const a = short(me), b = short(other);
  const chains = rel.chainIds.map(chainName).join(', ');
  switch (ruleId) {
    case 'linked_wallets.back_and_forth': {
      const outN = read.own.filter((t) => t.from === me && t.to === other).length, inN = read.own.filter((t) => t.from === other && t.to === me).length;
      return {
        title: 'Funds went back and forth',
        text: `${a} sent to ${b} ${outN} ${outN === 1 ? 'time' : 'times'} and received from it ${inN} ${inN === 1 ? 'time' : 'times'}${chains ? `, on ${chains}` : ''}. Repeated two-way flows between personal wallets often mean they belong together.`,
      };
    }
    case 'linked_wallets.funded_by_you':
      return { title: 'Its first funds came from here', text: `The first money ${b} ever received came from ${a}. A new wallet funded from an old one carries the old one's history, though it can also be a gift or a payment.` };
    case 'linked_wallets.shared_deposit': {
      const d = hits.find((h) => h.otherSenders.some((s) => s.address === other));
      const ent = named(d?.entity);
      const where = d ? `${ent ? `the ${ent}` : 'one exchange'} deposit address ${short(d.address)}` : 'one exchange deposit address';
      return {
        title: ent ? `The same ${ent} deposit address` : 'The same exchange deposit address',
        text: `${a} and ${b} both paid into ${where}. A deposit address belongs to one exchange account, so the wallets that use it are often run by the same person${d && d.senders > 6 ? '; many wallets pay into this one, so the link is weak' : ''}. An exchange that verified that account can put a name to both.`,
      };
    }
    case 'funding_reuse.shared_funder':
      return { title: 'The same funder', text: `The wallet that paid for the first transaction of ${a} also sent coins to ${b} within 3 days. Wallets funded together from one source are easy to group.` };
    default:
      return { title: f.title, text: f.explanation };
  }
}

/** The links one scan found, per linked wallet, with every reason and its proof. */
export async function scanLinks(result: ScanResult, session: ScanSession | undefined = sessionOf(result)): Promise<Map<string, GraphLink>> {
  const me = result.address;
  const read = session ? await readTransfers(session) : { own: [], looked: [] };
  const hits = session ? await depositHits(session) : [];
  const out = new Map<string, GraphLink>();
  for (const w of result.linkedWallets) {
    const reasons: GraphReason[] = [];
    for (const f of result.findings) for (const rel of f.related ?? []) {
      if (rel.address !== w.address || reasons.some((r) => r.ruleId === f.id)) continue;
      const c = cap(rel.confidence);
      reasons.push({ ruleId: f.id, ...words(f.id, me, w.address, f, rel, read, hits), confidence: c, level: linkLevel(c), evidence: proofFor(me, w.address, f.id, f, read, hits) });
    }
    if (!reasons.length) continue;
    reasons.sort((x, y) => y.confidence - x.confidence || x.ruleId.localeCompare(y.ruleId));
    const c = cap(w.confidence);
    out.set(w.address, { a: me, b: w.address, confidence: c, level: linkLevel(c), reasons, read: 'one', chainIds: [...w.chainIds] });
  }
  return out;
}

/** The deposit analysis of one scan again, from its record: no request (replay.ts). */
const depositHits = async (s: ScanSession): Promise<DepositHit[]> => (await analyzeRecipients(replayContext(s))).deposits;

const DEPOSIT_PROOF = 3;
const DEPOSITS_MAX = 12;
/** An exchange's name, or undefined where the label names none (an explorer tag without one reads 'an exchange', context.ts). */
const named = (entity: string | undefined) => (entity && entity !== 'an exchange' ? entity : undefined);
/** How likely an address is one customer's deposit address: the scan's own weights (cex_exposure.deposit_address). */
export const depositConfidence = (how: GraphDeposit['how'], senders: number) => cap(how === 'label' ? (senders > 6 ? 0.7 : 0.92) : senders > 6 ? 0.6 : 0.8);

/** Where a deposit address's exchange name comes from, as proof anyone can check. */
function depositProof(d: Pick<DepositHit, 'address' | 'chainId' | 'how' | 'sweepTx'> & { entity?: string }): Evidence[] {
  if (d.how === 'label') {
    const where = cexLabel(d.address) ? 'in the open exchange labels Nymra carries' : 'by the public explorer';
    return [addrProof(d.chainId, d.address, `${cexLabel(d.address) ? 'Listed' : 'Tagged'} as ${d.entity ? `a ${d.entity}` : 'an exchange'} deposit address ${where}`, d.entity ? `${d.entity} deposit` : undefined)];
  }
  const t = d.sweepTx;
  if (!t) return [addrProof(d.chainId, d.address, 'The deposit address')];
  const to = named(cexOf(t.to, t.cp)?.entity) ?? d.entity;
  return [
    txProof(t, `It forwarded ${amount(t)} to ${to ? `a labelled ${to} wallet` : 'a labelled exchange wallet'}`),
    addrProof(t.chainId, t.to, to ? `The ${to} wallet it forwarded to` : 'The exchange wallet it forwarded to', to),
  ];
}

/**
 * The exchange deposit addresses one scan found (deposits.ts, replayed from its record), each with the wallets the
 * scan saw pay into it: the scanned wallet itself, and the other senders it kept (persons by their own count).
 */
export async function scanDeposits(result: ScanResult, session: ScanSession | undefined = sessionOf(result)): Promise<GraphDeposit[]> {
  if (!session) return [];
  const [hits, read] = await Promise.all([depositHits(session), readTransfers(session)]);
  const me = result.address;
  const sent = (from: string, to: string, rows: Transfer[]) => rows.filter((t) => t.from === from && t.to === to).sort((x, y) => x.timestamp - y.timestamp);
  const proofs = (list: Transfer[]) => {
    const pick = list.length <= DEPOSIT_PROOF ? list : [...list.slice(0, DEPOSIT_PROOF - 1), list[list.length - 1]];
    return pick.map((t) => txProof(t, `${short(t.from)} paid ${amount(t)} into it`));
  };
  return hits.map((h) => {
    const into = read.looked.filter((l) => l.address === h.address && l.chainId === h.chainId).flatMap((l) => l.rows);
    const mine = h.myDeposits.length ? [...h.myDeposits].sort((x, y) => x.timestamp - y.timestamp) : sent(me, h.address, read.own);
    const users: DepositUser[] = [
      { address: me, count: Math.max(1, mine.length), evidence: proofs(mine) },
      ...h.otherSenders.map((o) => ({ address: o.address, count: o.count, evidence: proofs(sent(o.address, h.address, into)) })),
    ];
    const g: GraphDeposit = {
      address: h.address, chainId: h.chainId, how: h.how, confidence: depositConfidence(h.how, h.senders), level: linkLevel(depositConfidence(h.how, h.senders)),
      senders: h.senders, shared: h.senders > 6, users, evidence: depositProof({ ...h, entity: named(h.entity) }),
    };
    const ent = named(h.entity);
    if (ent) g.entity = ent;
    return g;
  });
}

/** One deposit address as all read wallets saw it: every user once, the strongest naming, the most senders seen. */
export function mergeDeposits(list: GraphDeposit[]): GraphDeposit[] {
  const by = new Map<string, GraphDeposit>();
  for (const d of list) {
    const had = by.get(d.address);
    if (!had) {
      by.set(d.address, { ...d, users: d.users.map((u) => ({ ...u, evidence: [...u.evidence] })), evidence: [...d.evidence] });
      continue;
    }
    for (const u of d.users) {
      const x = had.users.find((y) => y.address === u.address);
      if (!x) had.users.push({ ...u, evidence: [...u.evidence] });
      else {
        x.count = Math.max(x.count, u.count);
        for (const e of u.evidence) if (!x.evidence.some((y) => y.txHash === e.txHash)) x.evidence.push(e);
      }
    }
    // A listed address is named by the list; a forward only says where its money went.
    if (d.how === 'label' && had.how !== 'label') Object.assign(had, { how: 'label', evidence: [...d.evidence], ...(d.entity ? { entity: d.entity } : {}) });
    if (!had.entity && d.entity) had.entity = d.entity;
    had.senders = Math.max(had.senders, d.senders);
  }
  for (const d of by.values()) {
    d.shared = d.senders > 6;
    d.confidence = depositConfidence(d.how, d.senders);
    d.level = linkLevel(d.confidence);
    d.users.sort((x, y) => y.count - x.count || x.address.localeCompare(y.address));
    for (const u of d.users) u.evidence.sort((x, y) => (x.timestamp ?? 0) - (y.timestamp ?? 0));
  }
  return [...by.values()];
}

/** Compare's words, with a shared deposit address named after its exchange where Nymra can show it, and what that means. */
function depositWords(r: Comparison['reasons'][number]): { title: string; text: string } {
  if (r.ruleId !== 'linked_wallets.shared_deposit' || r.trail?.kind !== 'via') return { title: r.title, text: r.text };
  const ent = named(r.trail.label?.replace(/ deposit$/, ''));
  return {
    title: ent ? `Both pay into the same ${ent} deposit address` : r.title,
    text: `${r.text.replace(/\ba an exchange\b/g, 'an exchange')} An exchange that verified that account can put a name to both.`,
  };
}

/** A pair both scans read, weighed by Compare. null: Compare found no link (or one of the two is no person, or they look alike). */
export function pairLink(c: Comparison): GraphLink | null {
  if (!c.level || !c.reasons.length) return null;
  const chainIds = [...new Set(c.reasons.flatMap((r) => r.evidence.map((e) => e.chainId).filter((x): x is ChainId => x !== undefined)))];
  return {
    a: c.a, b: c.b, confidence: cap(c.confidence), level: linkLevel(cap(c.confidence)), read: 'both', chainIds,
    reasons: c.reasons.map((r) => ({ ruleId: r.ruleId, ...depositWords(r), confidence: cap(r.confidence), level: linkLevel(cap(r.confidence)), evidence: r.evidence, ...(r.weak ? { weak: true } : {}) })),
  };
}

/** What a read wallet is when it is no person: a service, an exchange address, a contract. Never a link (RULES 1.2.0). */
export function notPersonal(r: ScanResult): string | undefined {
  const svc = r.identity.service;
  if (svc) {
    const who = svc.entity ? ` (${svc.entity})` : '';
    return svc.kind === 'exchange' ? `an exchange wallet${who}` : svc.kind === 'deposit' ? `an exchange deposit address${who}` : `a ${svc.kind} wallet${who}`;
  }
  if (r.addressType === 'contract' || r.identity.contract) return r.identity.contract?.name ? `a contract (${r.identity.contract.name})` : 'a contract';
  return undefined;
}

/**
 * The graph from what was read: every link (a pair both read through Compare, else the scan that saw it), every
 * wallet's strongest path to the first one, and why a wallet is not read further. No request.
 */
export function assembleGraph(p: {
  start: string;
  results: Map<string, ScanResult>;
  links: Map<string, Map<string, GraphLink>>;
  pairs: Map<string, GraphLink | null>;
  reading: Set<string>;
  failed: Set<string>;
  limits: GraphLimits;
  /** Per read wallet, the deposit addresses its scan found (scanDeposits). */
  deposits?: Map<string, GraphDeposit[]>;
}): LinkGraph {
  const { start, results, limits } = p;
  const away = new Map<string, string>();
  for (const [a, r] of results) {
    const np = notPersonal(r);
    if (np && a !== start) away.set(a, np);
  }
  // Every link once per pair: Compare's when both were read (also a link neither scan listed), else the strongest
  // scan's. Never to or through a wallet that turned out to be no person.
  const all = new Map<string, GraphLink>();
  for (const [k, l] of p.pairs) if (l) all.set(k, l);
  for (const [a, m] of p.links) {
    if (away.has(a)) continue;
    const strongest = [...m.values()].sort((x, y) => y.confidence - x.confidence || x.b.localeCompare(y.b)).slice(0, limits.perWallet);
    for (const l of strongest) {
      const k = pairKey(l.a, l.b);
      if (p.pairs.has(k) && results.has(l.a) && results.has(l.b)) continue; // both read: Compare's word stands, also "no link"
      const had = all.get(k);
      if (!had || had.confidence < l.confidence) all.set(k, l);
    }
  }
  // An address a read wallet's scan found to be an exchange deposit address is that, never a wallet of the graph,
  // even when another scan took it for one (a funder of both, measured on the 'deposit' fixture 2026-10-22).
  const personDeps = [...(p.deposits ?? new Map<string, GraphDeposit[]>())].filter(([a]) => !away.has(a)).flatMap(([, l]) => l);
  const isDeposit = new Set(personDeps.map((d) => d.address));
  for (const [k, l] of all) if (away.has(l.a) || away.has(l.b) || l.a === l.b || (l.a !== start && isDeposit.has(l.a)) || (l.b !== start && isDeposit.has(l.b))) all.delete(k);

  // Strongest path to the first wallet: the product of the links along it (a widest-path search; every factor <= 0.95).
  const adj = new Map<string, GraphLink[]>();
  for (const l of all.values()) for (const x of [l.a, l.b]) adj.set(x, [...(adj.get(x) ?? []), l]);
  const reach = new Map<string, { p: number; hop: number; via?: string }>([[start, { p: 1, hop: 0 }]]);
  const done = new Set<string>();
  for (;;) {
    let best: string | undefined;
    for (const [x, v] of reach) if (!done.has(x) && (!best || v.p > reach.get(best)!.p || (v.p === reach.get(best)!.p && x < best))) best = x;
    if (!best) break;
    done.add(best);
    const from = reach.get(best)!;
    for (const l of adj.get(best) ?? []) {
      const y = l.a === best ? l.b : l.a;
      const q = from.p * l.confidence;
      const had = reach.get(y);
      if (!done.has(y) && (!had || q > had.p)) reach.set(y, { p: q, hop: from.hop + 1, via: best });
    }
  }

  let nodes: GraphNode[] = [...reach.entries()].map(([address, v]) => {
    const r = results.get(address);
    const label = r?.identity.ens ?? r?.identity.labels[0] ?? [...results.values()].map((x) => x.linkedWallets.find((w) => w.address === address)?.label).find(Boolean);
    const state: GraphNodeState = address === start ? 'start' : p.reading.has(address) ? 'reading' : r ? 'read' : p.failed.has(address) ? 'failed' : 'unread';
    const n: GraphNode = { address, hop: v.hop, reach: address === start ? null : cap(v.p), level: address === start ? null : linkLevel(cap(v.p)), state };
    if (v.via) n.via = v.via;
    if (label) n.label = label;
    if (r) {
      n.score = r.score;
      n.band = r.band;
      if (r.status === 'partial') n.partial = true;
    }
    return n;
  });
  nodes.sort((x, y) => x.hop - y.hop || (y.reach ?? 1) - (x.reach ?? 1) || x.address.localeCompare(y.address));
  // A graph too big to read: the least likely leave first (never the first wallet, never a read one).
  if (nodes.length > limits.nodes) {
    const keep = new Set([start, ...nodes.filter((n) => n.state !== 'unread' && n.state !== 'failed').map((n) => n.address)]);
    for (const n of [...nodes].sort((x, y) => (y.reach ?? 1) - (x.reach ?? 1))) if (keep.size < limits.nodes) keep.add(n.address);
    nodes = nodes.filter((n) => keep.has(n.address));
  }
  const inGraph = new Set(nodes.map((n) => n.address));
  // A wallet whose path leans on a wallet that left is drawn with its own path only when that path is still in the graph.
  const links = [...all.values()].filter((l) => inGraph.has(l.a) && inGraph.has(l.b));
  // Orient each link from the wallet nearer the first one.
  const hopOf = new Map(nodes.map((n) => [n.address, n.hop]));
  for (const l of links) if ((hopOf.get(l.b) ?? 0) < (hopOf.get(l.a) ?? 0)) [l.a, l.b] = [l.b, l.a];
  links.sort((x, y) => (hopOf.get(x.a)! - hopOf.get(y.a)!) || y.confidence - x.confidence || pairKey(x.a, x.b).localeCompare(pairKey(y.a, y.b)));

  // Deposit addresses: once each, with the wallets of the graph that pay into it. Never one that is itself a wallet of
  // the graph, never from a wallet that turned out to be no person.
  const deposits = mergeDeposits(personDeps)
    .map((d) => ({ ...d, users: d.users.filter((u) => inGraph.has(u.address)) }))
    .filter((d) => d.users.length && !inGraph.has(d.address) && !away.has(d.address))
    .sort((x, y) => y.users.length - x.users.length || y.confidence - x.confidence || x.address.localeCompare(y.address))
    .slice(0, DEPOSITS_MAX);

  const reads = results.size;
  for (const n of nodes) {
    if (n.state !== 'unread') continue;
    const last = links.find((l) => (l.a === n.via && l.b === n.address) || (l.b === n.via && l.a === n.address));
    n.stop = n.hop > limits.depth - 1 ? 'depth' : (last?.confidence ?? 0) < limits.follow || (n.reach ?? 0) < limits.reach ? 'weak' : reads + p.reading.size >= limits.reads ? 'limit' : undefined;
    if (!n.stop) delete n.stop;
  }
  return {
    start, nodes, links, reads, limits,
    notPersonal: [...away].map(([address, what]) => ({ address, what })),
    deposits,
    running: p.reading.size > 0,
  };
}

export interface LinkGraphOptions {
  /** Reads one wallet: a whole scan, whose final result carries its session (sessionOf). */
  read: (address: string, signal: AbortSignal) => Promise<ScanResult>;
  /** Stops every read. What was read stays in the graph. */
  signal?: AbortSignal;
  /** After every change: a wallet starts or ends its read. */
  onChange?: (g: LinkGraph) => void;
  limits?: Partial<GraphLimits>;
}

export interface LinkGraphRun {
  /** The graph as it stands. */
  graph(): LinkGraph;
  /** Reads outward by itself (limits.depth hops, limits.reads wallets), then resolves with the graph. */
  grow(): Promise<LinkGraph>;
  /** Reads one more wallet in the graph by hand, also past the depth, up to limits.maxReads. */
  follow(address: string): Promise<LinkGraph>;
}

/**
 * From one finished scan (with its session), the Link Graph: it reads the wallets that scan links to, then theirs,
 * as far as the limits allow, the most likely first. Every read is an ordinary scan through `read`; every pair of
 * read wallets is weighed by Compare, so a link two wallets further out share also shows.
 */
export function linkGraph(start: ScanResult, o: LinkGraphOptions): LinkGraphRun {
  const limits: GraphLimits = { ...GRAPH_LIMITS, ...o.limits };
  const results = new Map<string, ScanResult>();
  const links = new Map<string, Map<string, GraphLink>>();
  const pairs = new Map<string, GraphLink | null>();
  const deposits = new Map<string, GraphDeposit[]>();
  const reading = new Set<string>(), failed = new Set<string>();
  const replays = new Map<string, Promise<ScanResult>>();
  const again = (s: ScanSession) => {
    let r = replays.get(s.me);
    if (!r) replays.set(s.me, (r = rerun(s)));
    return r;
  };
  const ac = new AbortController();
  o.signal?.addEventListener('abort', () => ac.abort(), { once: true });
  const snapshot = () => assembleGraph({ start: start.address, results, links, pairs, reading, failed, limits, deposits });
  const changed = () => o.onChange?.(snapshot());

  /** Takes a read wallet in: its own links, then Compare against every wallet read before it. */
  async function admit(r: ScanResult) {
    results.set(r.address, r);
    const s = sessionOf(r);
    const person = !notPersonal(r) || r.address === start.address;
    links.set(r.address, person ? await scanLinks(r, s) : new Map());
    deposits.set(r.address, person ? await scanDeposits(r, s) : []);
    if (!s) return;
    for (const [x, other] of results) {
      if (x === r.address) continue;
      const so = sessionOf(other);
      if (!so) continue;
      const k = pairKey(x, r.address);
      if (pairs.has(k)) continue;
      try {
        const c = await compareWallets(so, s, { rerun: again });
        // Compare takes any public tag the other side's rows give a wallet for a service ("a tagged service
        // (Ronin Bridge Exploiter)", measured 2026-10-22). When that wallet's own scan reads it as a person, Compare did
        // not weigh the pair at all, so the scans' own links stand. A look-alike or a wallet that is a service by its
        // own scan is never a link either way.
        const tagOnly = !c.lookalike && !c.reasons.length && [c.a, c.b].some((w, i) => (i ? c.notPersonal.b : c.notPersonal.a) && !notPersonal(results.get(w)!));
        if (!tagOnly) pairs.set(k, pairLink(c));
      } catch {
        pairs.set(k, null);
      }
    }
  }

  async function readOne(address: string): Promise<void> {
    if (results.has(address) || reading.has(address) || ac.signal.aborted) return;
    reading.add(address);
    failed.delete(address);
    changed();
    try {
      const r = await o.read(address, ac.signal);
      if (!ac.signal.aborted) await admit(r);
    } catch {
      if (!ac.signal.aborted) failed.add(address);
    } finally {
      reading.delete(address);
      changed();
    }
  }

  /** The next wallets the graph reads by itself: unread, no stop, the most likely first. */
  const next = () => snapshot().nodes.filter((n) => n.state === 'unread' && !n.stop).map((n) => n.address);

  const ready = admit(start);
  return {
    graph: snapshot,
    async grow() {
      await ready;
      changed();
      for (;;) {
        if (ac.signal.aborted) break;
        const room = Math.min(limits.together, limits.reads - results.size - reading.size);
        const want = next().slice(0, Math.max(0, room));
        if (!want.length) break;
        await Promise.all(want.map(readOne));
      }
      return snapshot();
    },
    async follow(address: string) {
      await ready;
      const a = address.toLowerCase();
      if (!snapshot().nodes.some((n) => n.address === a)) throw new Error('This wallet is not in the graph.');
      if (results.size + reading.size >= limits.maxReads) throw new Error(`The graph has read ${limits.maxReads} wallets, its limit.`);
      await readOne(a);
      return snapshot();
    },
  };
}
