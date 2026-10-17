// Cross-chain traceability: one address on many chains, and bridge transfers that match on both sides.
import { active, receivedOnly, type ChainHistory, type Transfer } from '../history.ts';
import type { Finding } from '../types.ts';
import { chainList, cleanTokens, finding, fmtAmount, plural, STABLES, txEv, type Detector } from './context.ts';

const MAX_LAG_S = 45 * 60;

function isEthLike(t: Transfer) {
  return t.kind !== 'token' && (t.symbol === 'ETH' || t.symbol === 'XDAI');
}

/** Same address: an outgoing amount on chain A, a slightly smaller incoming amount on chain B soon after. */
export function bridgeMatches(outs: Transfer[], ins: Transfer[]): [Transfer, Transfer][] {
  const pairs: [Transfer, Transfer][] = [];
  const used = new Set<Transfer>();
  for (const o of outs) {
    let best: Transfer | undefined, bestGap = Infinity;
    for (const i of ins) {
      if (used.has(i) || i.chainId === o.chainId) continue;
      const lag = i.timestamp - o.timestamp;
      if (lag < 0 || lag > MAX_LAG_S) continue;
      const kindOk = (isEthLike(o) && isEthLike(i)) || (STABLES.has(o.symbol.toUpperCase()) && o.symbol.toUpperCase() === i.symbol.toUpperCase());
      if (!kindOk) continue;
      const loss = (o.amount - i.amount) / o.amount;
      if (loss < -0.0001 || loss > 0.03) continue;
      if (loss < bestGap) { bestGap = loss; best = i; }
    }
    if (best) { used.add(best); pairs.push([o, best]); }
  }
  return pairs;
}

/** What the address sent on a chain: the chain's own count when known, else what was read ("500+" when cut). */
function sentText(h: ChainHistory): { text: string; value: number } {
  if (h.nonce !== undefined && h.nonce > 0) return { text: `${h.chain.name}: ${plural(h.nonce, 'transaction')} sent`, value: h.nonce };
  const more = h.truncated ? '+' : '';
  return { text: `${h.chain.name}: ${h.ownCount}${more} ${h.ownCount === 1 && !more ? 'transaction' : 'transactions'} sent`, value: h.ownCount };
}

export const crossChain: Detector = {
  id: 'cross_chain',
  network: false,
  async run(ctx) {
    const out: Finding[] = [];
    // Active = the address signed a transaction there. Coins and tokens others sent to it are not its trail.
    const act = active(ctx.histories);
    if (act.length >= 2) {
      out.push(finding({
        id: 'cross_chain.multichain_presence', detector: 'cross_chain', severity: act.length >= 4 ? 'medium' : 'low', confidence: 1,
        title: `Active on ${act.length} chains with one address`,
        explanation: `This address sent transactions on ${chainList(act.map((h) => h.chain.id))}. One address everywhere means one public history everywhere: anyone who finds ${ctx.thirdPerson ? 'it' : 'you'} on one chain finds ${ctx.thirdPerson ? 'it' : 'you'} on all of them.`,
        evidence: act.map((h) => ({ kind: 'stat' as const, chainId: h.chain.id, ...sentText(h) })),
        chains: act.map((h) => h.chain.id),
      }));
    }
    const got = receivedOnly(ctx.histories);
    if (got.length) {
      const n = (h: ChainHistory) => h.txs.length + h.internal.length + cleanTokens(h).length;
      out.push(finding({
        id: 'cross_chain.received_only', detector: 'cross_chain', severity: 'info', confidence: 1,
        title: `Received on ${plural(got.length, 'chain')} ${ctx.thirdPerson ? 'it' : 'you'} never used`,
        explanation: `Others sent coins or tokens to this address on ${chainList(got.map((h) => h.chain.id))}, but it never sent a transaction there. Anyone can send to any address, so this is not a trail ${ctx.thirdPerson ? 'it' : 'you'} left and it costs no points.`,
        evidence: got.map((h) => ({ kind: 'stat' as const, text: `${h.chain.name}: ${plural(n(h), 'incoming transfer')}${h.truncated ? ' or more' : ''}, none sent`, chainId: h.chain.id, value: n(h) })),
        chains: got.map((h) => h.chain.id),
      }));
    }
    // A bridge: out on a chain where the address signs, in on any chain (arriving needs no signature).
    if (act.length >= 1 && act.length + got.length >= 2) {
      const outs: Transfer[] = [], ins: Transfer[] = [];
      for (const h of [...act, ...got]) {
        for (const t of [...h.txs, ...h.internal, ...cleanTokens(h)]) {
          if (t.failed || t.amount <= 0) continue;
          if (t.dir === 'out' && t.amount >= 0.001) outs.push(t);
          if (t.dir === 'in') ins.push(t);
        }
      }
      const m = bridgeMatches(outs, ins);
      if (m.length) {
        out.push(finding({
          id: 'cross_chain.bridge_match', detector: 'cross_chain', severity: 'medium', confidence: Math.min(0.85, 0.55 + 0.1 * (m.length - 1)),
          title: m.length === 1 ? 'A bridge transfer matches on both sides' : `${m.length} bridge transfers match on both sides`,
          explanation: `An amount left one chain and almost the same amount arrived at this address on another chain minutes later. A bridge does not hide ${ctx.thirdPerson ? 'anyone who receives' : 'you when you receive'} on the same address.`,
          evidence: m.slice(0, 3).flatMap(([o, i]) => [txEv(o, `Out on ${chainList([o.chainId])}, ${fmtAmount(o.amount, o.symbol)}`), txEv(i, `In on ${chainList([i.chainId])}, ${fmtAmount(i.amount, i.symbol)}, ${Math.round((i.timestamp - o.timestamp) / 60)} min later`)]),
          chains: [...new Set(m.flatMap(([o, i]) => [o.chainId, i.chainId]))],
        }));
      }
    }
    return out;
  },
};
