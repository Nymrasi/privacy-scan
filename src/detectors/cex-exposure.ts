// CEX exposure: transfers with exchange wallets, funding from an exchange, personal deposit addresses.
import type { Finding } from '../types.ts';
import { addrEv, cexOf, chainList, counterparties, finding, fmtAmount, plural, txEv, type Detector } from './context.ts';
import { findDeposits } from './deposits.ts';

export const cexExposure: Detector = {
  id: 'cex_exposure',
  network: true,
  async run(ctx) {
    const out: Finding[] = [];

    // Funded straight from an exchange.
    const cexFunded = ctx.histories
      .map((h) => h.firstFunding)
      .filter((t) => t && cexOf(t.from, t.cp)?.kind === 'hot');
    if (cexFunded.length) {
      const t = cexFunded[0]!;
      const ent = cexOf(t.from, t.cp)!.entity;
      out.push(finding({
        id: 'cex_exposure.funded_by_cex', detector: 'cex_exposure', severity: 'high', confidence: 1,
        title: 'Your wallet was funded straight from an exchange',
        explanation: `Your first transaction on ${chainList(cexFunded.map((x) => x!.chainId))} was paid with coins from ${ent}. The exchange can match this address to the account that withdrew, and anyone can see the money came from ${ent}.`,
        evidence: cexFunded.slice(0, 3).map((x) => ({ ...txEv(x!, `Paid for your first transaction: ${fmtAmount(x!.amount, x!.symbol)} from ${cexOf(x!.from, x!.cp)!.entity}`), address: x!.from, label: cexOf(x!.from, x!.cp)!.entity })),
        chains: [...new Set(cexFunded.map((x) => x!.chainId))],
      }));
    }

    // Direct transfers with exchange hot wallets.
    const byEnt = new Map<string, number>();
    const chains = new Set<number>();
    for (const c of counterparties(ctx).values()) {
      if (c.cex?.kind !== 'hot') continue;
      const n = c.nIn + c.nOut;
      if (!n) continue;
      byEnt.set(c.cex.entity, (byEnt.get(c.cex.entity) ?? 0) + n);
      for (const x of c.chains) chains.add(x);
    }
    const total = [...byEnt.values()].reduce((a, b) => a + b, 0);
    if (total > 0) {
      const ents = [...byEnt.entries()].sort((a, b) => b[1] - a[1]);
      out.push(finding({
        id: 'cex_exposure.direct', detector: 'cex_exposure', severity: total >= 3 ? 'medium' : 'low', confidence: 1,
        title: 'Transfers with exchange wallets',
        explanation: `${plural(total, 'transfer')} went to or came from known exchange wallets (${ents.slice(0, 3).map((e) => e[0]).join(', ')}). Exchanges know who their customers are, and their wallets are labelled publicly.`,
        evidence: ents.slice(0, 5).map(([e, n]) => ({ kind: 'label' as const, text: `${e}: ${plural(n, 'transfer')}`, label: e, value: n })),
        chains: [...chains],
      }));
    }

    // Personal deposit addresses.
    const deps = await findDeposits(ctx);
    if (deps.length) {
      const d = deps[0];
      const n = deps.reduce((a, x) => a + x.myDeposits.length, 0);
      const shared = d.senders > 6;
      out.push(finding({
        id: 'cex_exposure.deposit_address', detector: 'cex_exposure', severity: shared ? 'high' : 'critical',
        confidence: d.how === 'label' ? (shared ? 0.7 : 0.92) : (shared ? 0.6 : 0.8),
        title: 'You send to an exchange deposit address',
        explanation: `You sent funds ${plural(n, 'time')} to ${deps.length === 1 ? 'an address' : `${deps.length} addresses`} that ${d.how === 'label' ? `is listed as a ${d.entity} deposit address` : `forwards what it receives to ${d.entity}`}. Exchanges give each customer their own deposit address, so this is very likely tied to a verified exchange account.`,
        evidence: deps.slice(0, 3).flatMap((x) => {
          const ev = [addrEv(x.chainId, x.address, `${x.entity} deposit address, used ${plural(x.myDeposits.length, 'time')}`, `${x.entity} deposit`, x.myDeposits.length)];
          if (x.sweepTx) ev.push({ ...txEv(x.sweepTx, `It forwarded ${fmtAmount(x.sweepTx.amount, x.sweepTx.symbol)} to ${cexOf(x.sweepTx.to, x.sweepTx.cp)?.entity ?? 'the exchange'}`), address: x.sweepTx.to });
          return ev;
        }),
        chains: [...new Set(deps.map((x) => x.chainId))],
      }));
    }
    return out;
  },
};
