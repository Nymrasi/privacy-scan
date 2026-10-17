// Funding source reuse: whose coins paid for the first transaction on each chain, and did that wallet fund other wallets too.
import { blind } from '../chains.ts';
import { fundingUnread, type Transfer } from '../history.ts';
import type { ChainId, Finding, RelatedAddress } from '../types.ts';
import { addrEv, cexOf, chainList, counterparties, finding, fmtAmount, memo, personsByNonce, plural, round2, secondsPerBlock, serviceOf, SERVICE_NONCE, txEv, type Detector, type DetectorContext } from './context.ts';

export interface FunderInfo {
  chainId: ChainId;
  funding: Transfer;
  funder: string;
  kind: 'cex' | 'service' | 'contract' | 'eoa';
  /** Other addresses the funder sent plain value to within +-3 days. null = not looked up. */
  siblings: { address: string; amount: number; timestamp: number }[] | null;
  /** The funder pays out to many wallets (a service, faucet or bot): its window was full, it funded more than 40 others, or it sent 2,000+ transactions. */
  busy: boolean;
}

const WINDOW_S = 3 * 86400;
const MAX_LOOKUPS = 4;
/** A funder that sent this many transactions in the window is a service or a bot. */
const BUSY = 200;
/** A funder that paid this many other wallets around the same time is a distributor, not a person's wallet. */
const MANY_SIBLINGS = 40;

export function analyzeFunders(ctx: DetectorContext): Promise<FunderInfo[]> {
  return memo(ctx, 'funders', async () => {
    const cps = counterparties(ctx);
    const hs = ctx.histories
      .filter((h) => h.firstFunding)
      .sort((a, b) => b.txs.length + b.tokens.length - (a.txs.length + a.tokens.length));
    const infos = hs.map((h): FunderInfo => {
      const f = h.firstFunding!;
      const funder = f.from;
      const kind: FunderInfo['kind'] = cexOf(funder, f.cp)?.kind === 'hot' ? 'cex'
        : f.kind === 'internal' || f.cp?.isContract || cps.get(funder)?.contractLike ? 'contract'
        : serviceOf(funder, f.cp) ? 'service' : 'eoa';
      return { chainId: h.chain.id, funding: f, funder, kind, siblings: null, busy: false };
    });
    // A funder that sent 2,000 or more transactions is a service or a bot: no window lookup needed.
    const nonces = await ctx.nonces(infos.filter((i) => i.kind === 'eoa').map((i) => ({ address: i.funder, chainId: i.chainId })));
    for (const i of infos) if (i.kind === 'eoa' && (nonces.get(i.funder) ?? 0) >= SERVICE_NONCE) i.busy = true;
    let looked = 0;
    return Promise.all(infos.map(async (info): Promise<FunderInfo> => {
      const h = hs.find((x) => x.chain.id === info.chainId)!;
      const f = info.funding, funder = info.funder;
      // A source without calldata (BNB through NodeReal, Base and Polygon through Alchemy on a server) cannot
      // tell a funder's sends from its paid contract calls, so a router would pass for a sibling; NodeReal
      // cannot list a window around a date at all. The chain's coverage says so.
      if (info.kind !== 'eoa' || info.busy || (!ctx.replay && looked >= MAX_LOOKUPS) || blind(h.chain.source)) return info;
      looked++;
      const w = Math.ceil(WINDOW_S / secondsPerBlock(h));
      const rows = await ctx.lookup(h.chain, 'txlist', funder, { sort: 'desc', offset: BUSY, filter: 'from', startblock: Math.max(0, f.block - w), endblock: f.block + w });
      if (!rows) return info;
      info.busy = rows.length >= BUSY;
      const sib = new Map<string, { address: string; amount: number; timestamp: number }>();
      for (const t of rows) {
        if (t.dir !== 'out' || t.isCall || t.amount <= 0 || t.failed) continue;
        if (t.to === ctx.me || cexOf(t.to, t.cp) || t.cp?.isContract || serviceOf(t.to, t.cp)) continue;
        if (!sib.has(t.to)) sib.set(t.to, { address: t.to, amount: t.amount, timestamp: t.timestamp });
      }
      info.siblings = [...sib.values()];
      if (info.siblings.length > MANY_SIBLINGS) info.busy = true;
      return info;
    }));
  });
}

export const fundingReuse: Detector = {
  id: 'funding_reuse',
  network: true,
  async run(ctx) {
    const out: Finding[] = [];
    const funders = await analyzeFunders(ctx);

    // Same funder on several chains: only a person-held funder ties chains together. An exchange,
    // a bridge contract, a known service or a funder that pays out to many wallets funds everyone.
    // One finding for the rule, every such funder in its evidence. No address or name in the title:
    // a title travels to the share card.
    const byFunder = new Map<string, FunderInfo[]>();
    for (const f of funders) if (f.kind === 'eoa') byFunder.set(f.funder, [...(byFunder.get(f.funder) ?? []), f]);
    for (const [addr, fs] of byFunder) if (fs.some((f) => f.busy) || fs.length < 2) byFunder.delete(addr);
    if (byFunder.size) {
      const groups = [...byFunder.values()].sort((a, b) => b.length - a.length || a[0].funder.localeCompare(b[0].funder));
      const chains = groups.flatMap((fs) => fs.map((f) => f.chainId));
      out.push(finding({
        id: 'funding_reuse.same_funder_multichain', detector: 'funding_reuse', severity: 'medium', confidence: 0.85,
        title: groups.length === 1 ? `Same funder on ${chains.length} chains` : `${groups.length} funders each funded you on several chains`,
        explanation: groups.length === 1
          ? `On ${chainList(chains)}, your first transaction was paid with coins from the same wallet. That ties your activity on those chains together.`
          : `On ${chainList(chains)}, your first transactions were paid with coins from ${groups.length} wallets, each of them on more than one chain. That ties your activity on those chains together.`,
        evidence: groups.flatMap((fs) => [
          addrEv(fs[0].chainId, fs[0].funder, `Funder on ${chainList(fs.map((f) => f.chainId))}`, undefined, fs.length),
          ...fs.map((f) => txEv(f.funding, `Paid for your first transaction on ${chainList([f.chainId])}, ${fmtAmount(f.funding.amount, f.funding.symbol)}`)),
        ]),
        chains,
      }));
    }

    // The next three pick one chain's funder out of all chains. When the funding on a chain the wallet
    // used could not be read, another chain would take its place unannounced (vitalik.eth
    // scored 31 instead of 23 when Robinhood Chain failed). They wait for a full read instead; the
    // result already lists that chain as not read.
    if (ctx.histories.some(fundingUnread)) return out;

    // The funder funded other wallets too. A sibling that is itself a service (2,000+ transactions) is
    // a payment the funder made, not a wallet funded alongside you; one that never sent a transaction
    // there only received (a gift, a tutorial address), so it is no sibling either.
    for (const f of funders) if (f.siblings?.length && !f.busy) f.siblings = await personsByNonce(ctx, f.siblings.slice(0, MANY_SIBLINGS), (s) => ({ address: s.address, chainId: f.chainId }), true);
    const shared = funders.filter((f) => f.siblings && f.siblings.length > 0 && !f.busy);
    if (shared.length) {
      const best = shared.sort((a, b) => a.siblings!.length - b.siblings!.length || a.funder.localeCompare(b.funder))[0];
      const k = best.siblings!.length;
      const conf = k === 1 ? 0.55 : k <= 5 ? 0.75 : k <= 15 ? 0.55 : k <= 40 ? 0.35 : 0.2;
      const sibConf = round2(conf * 0.75);
      const related: RelatedAddress[] = best.siblings!
        .sort((a, b) => Math.abs(a.timestamp - best.funding.timestamp) - Math.abs(b.timestamp - best.funding.timestamp))
        .slice(0, 10)
        .map((s) => ({ address: s.address, confidence: sibConf, reasons: ['shared funder'], chainIds: [best.chainId] }));
      out.push(finding({
        id: 'funding_reuse.shared_funder', detector: 'funding_reuse', severity: k >= 2 && k <= 15 ? 'high' : 'medium', confidence: conf,
        title: 'Your funder also funded other wallets',
        explanation: `The wallet whose coins paid for your first transaction on ${chainList([best.chainId])} also sent coins to ${plural(k, 'other wallet')} within 3 days of funding you. Wallets funded together from one source are easy to group${k > 10 ? ', although a funder this busy may also be a service' : ''}.`,
        evidence: [txEv(best.funding, `Paid for your first transaction, ${fmtAmount(best.funding.amount, best.funding.symbol)}`), addrEv(best.chainId, best.funder, 'Funder')],
        chains: [best.chainId],
        related,
        deep: true,
      }));
    }

    // Reassurance when we looked and found nothing.
    const clean = funders.filter((f) => f.kind === 'eoa' && f.siblings && f.siblings.length === 0);
    if (!shared.length && clean.length) {
      out.push(finding({
        id: 'funding_reuse.unique_funder', detector: 'funding_reuse', severity: 'info', confidence: 0.8,
        title: 'Funding source looks unique',
        explanation: `The wallet that paid for your first transaction on ${chainList(clean.map((f) => f.chainId))} did not fund other wallets around the same time, as far as we can see.`,
        evidence: clean.slice(0, 2).map((f) => addrEv(f.chainId, f.funder, 'Funder')),
        chains: clean.map((f) => f.chainId),
      }));
    }
    const busy = funders.filter((f) => f.kind === 'eoa' && f.busy);
    if (busy.length && !shared.length) {
      out.push(finding({
        id: 'funding_reuse.busy_funder', detector: 'funding_reuse', severity: 'low', confidence: 0.5,
        title: 'Funded by a very busy wallet',
        explanation: `Your first transaction on ${chainList(busy.map((f) => f.chainId))} was paid with coins from a wallet that pays out to many addresses, like a service, a bridge or a bot. It hides you in a crowd, but whoever runs it can still see you.`,
        evidence: busy.slice(0, 2).map((f) => addrEv(f.chainId, f.funder, 'Funder')),
        chains: busy.map((f) => f.chainId),
      }));
    }
    return out;
  },
};
