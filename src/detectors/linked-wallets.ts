// Likely linked wallets: back and forth transfers, wallets you funded first, a shared exchange deposit address.
// (Wallets with the same funder are reported by funding_reuse and merged into linkedWallets.)
// Every link carries a confidence; nothing here says who owns a wallet.
import type { Finding, RelatedAddress } from '../types.ts';
import { addrEv, counterparties, finding, mainChainOf, personal, personsByNonce, plural, round2, short, txEv, type Detector } from './context.ts';
import { analyzeRecipients } from './deposits.ts';

export const linkedWallets: Detector = {
  id: 'linked_wallets',
  network: true,
  async run(ctx) {
    const out: Finding[] = [];

    // Back and forth with a person-held wallet (by its own transaction count: not a service, and it really sends).
    const candidates = [...counterparties(ctx).values()]
      .filter((c) => c.nIn >= 1 && c.nOut >= 1 && c.nIn + c.nOut >= 3 && personal(c) && (c.signedToMe || c.plainSendTo))
      .map((c) => ({ c, conf: round2(Math.min(0.85, 0.35 + 0.08 * Math.min(c.nIn, c.nOut) + 0.02 * (c.nIn + c.nOut))) }))
      .sort((a, b) => b.conf - a.conf || a.c.address.localeCompare(b.c.address))
      .slice(0, 16);
    const pairs = await personsByNonce(ctx, candidates, (p) => ({ address: p.c.address, chainId: mainChainOf(p.c) }), true);
    if (pairs.length) {
      const top = pairs[0];
      const related: RelatedAddress[] = pairs.slice(0, 10).map(({ c, conf }) => ({ address: c.address, confidence: conf, reasons: ['back and forth transfers'], chainIds: [...c.chains] }));
      out.push(finding({
        id: 'linked_wallets.back_and_forth', detector: 'linked_wallets', severity: top.conf >= 0.6 ? 'high' : 'medium', confidence: top.conf,
        title: pairs.length === 1 ? 'Funds go back and forth with one wallet' : `Funds go back and forth with ${pairs.length} wallets`,
        explanation: `You sent to and received from ${short(top.c.address)} ${plural(top.c.nIn + top.c.nOut, 'time')} (${top.c.nOut} out, ${top.c.nIn} in). Repeated two-way flows between personal wallets often mean they belong together. This is a likelihood, not proof of who owns them.`,
        evidence: pairs.slice(0, 3).flatMap(({ c }) => [
          addrEv([...c.chains][0], c.address, `${c.nOut} out, ${c.nIn} in`, undefined, c.nIn + c.nOut),
          txEv(c.first, `First transfer with ${short(c.address)}`),
        ]),
        chains: [...new Set(pairs.flatMap((p) => [...p.c.chains]))],
        related,
        deep: true,
      }));
    }

    const rec = await analyzeRecipients(ctx);

    // Wallets you set up: your transfer was their first funds.
    if (rec.funded.length) {
      // A wallet that never sent a transaction itself only received: a gift, a payment or a cold wallet. A weak link.
      const related: RelatedAddress[] = rec.funded.map((f) => ({ address: f.address, confidence: f.idle ? 0.3 : 0.6, reasons: ['you sent its first funds'], chainIds: [f.chainId] }));
      out.push(finding({
        id: 'linked_wallets.funded_by_you', detector: 'linked_wallets', severity: 'high', confidence: Math.max(...related.map((r) => r.confidence)),
        title: rec.funded.length === 1 ? 'You funded a fresh wallet' : `You funded ${rec.funded.length} fresh wallets`,
        explanation: `Your transfer was the very first money ${short(rec.funded[0].address)} ever received. A new wallet funded from an old one carries the old one's history with it. It may be a gift or a payment, so this is a likelihood, not proof of who owns it.`,
        evidence: rec.funded.slice(0, 3).map((f) => txEv(f.tx, `First funds of ${short(f.address)}`)),
        chains: [...new Set(rec.funded.map((f) => f.chainId))],
        related,
        deep: true,
      }));
    }

    // Other wallets paying into the same exchange deposit address.
    // Each deposit address has its own confidence: one with more than 6 senders is shared (omnibus).
    const confOf = (x: { how: 'label' | 'sweep'; senders: number }) => (x.how === 'label' ? (x.senders > 6 ? 0.35 : 0.8) : (x.senders > 6 ? 0.3 : 0.7));
    const deps = rec.deposits.filter((d) => d.otherSenders.length > 0).sort((a, b) => confOf(b) - confOf(a));
    if (deps.length) {
      const d = deps[0];
      const omnibus = d.senders > 6;
      const conf = confOf(d);
      const related: RelatedAddress[] = deps.flatMap((x) => x.otherSenders.slice(0, 8).map((s) => ({
        address: s.address, confidence: round2(confOf(x) * (s.count >= 2 ? 1 : 0.9)), reasons: ['same CEX deposit address'], chainIds: [x.chainId],
      })));
      out.push(finding({
        id: 'linked_wallets.shared_deposit', detector: 'linked_wallets', severity: omnibus ? 'medium' : 'high', confidence: conf,
        title: d.otherSenders.length === 1 ? 'Another wallet uses your exchange deposit address' : `${d.otherSenders.length} other wallets use your exchange deposit address`,
        explanation: `${short(d.otherSenders[0].address)} also sends to the ${d.entity} deposit address you use. A deposit address belongs to one exchange account, so wallets that pay into it are often run by the same person${omnibus ? '; this one has many senders, so the link is weak' : ''}. This is a likelihood, not proof of who owns them.`,
        evidence: [addrEv(d.chainId, d.address, `Shared ${d.entity} deposit address`, `${d.entity} deposit`), ...d.otherSenders.slice(0, 3).map((s) => addrEv(d.chainId, s.address, `Also paid in ${plural(s.count, 'time')}`, undefined, s.count))],
        chains: [...new Set(deps.map((x) => x.chainId))],
        related,
        deep: true,
      }));
    }
    return out;
  },
};
