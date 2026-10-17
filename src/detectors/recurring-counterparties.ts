// Recurring counterparties: a few personal wallets that make up most of the transfers.
// Contracts (routers, tokens), exchanges and known services are left out: everyone uses those.
import { addrEv, counterparties, finding, mainChainOf, pct, personal, personsByNonce, plural, type Detector } from './context.ts';

export const recurringCounterparties: Detector = {
  id: 'recurring_counterparties',
  network: false,
  async run(ctx) {
    const all = [...counterparties(ctx).values()]
      .filter((c) => personal(c) && c.nIn + c.nOut > 0)
      .sort((a, b) => b.nIn + b.nOut - (a.nIn + a.nOut) || a.address.localeCompare(b.address));
    // The busiest ones are checked by their own transaction count: a service or bot is not a person.
    const checked = await personsByNonce(ctx, all.slice(0, 16), (c) => ({ address: c.address, chainId: mainChainOf(c) }));
    const people = [...checked, ...all.slice(16)];
    const total = people.reduce((a, c) => a + c.nIn + c.nOut, 0);
    if (total < 10) return [];
    const top = people.slice(0, 3);
    const topN = top.reduce((a, c) => a + c.nIn + c.nOut, 0);
    const share = topN / total;
    if (share < 0.4 || top[0].nIn + top[0].nOut < 4) return [];
    return [finding({
      id: 'recurring_counterparties.top', detector: 'recurring_counterparties', severity: share >= 0.6 ? 'medium' : 'low',
      confidence: Math.min(0.9, 0.5 + total / 100),
      title: 'You deal with the same few wallets',
      explanation: `${plural(top.length, 'wallet')} account for ${pct(share)} of your transfers with personal wallets. Repeat counterparties draw a small, recognisable circle around you.`,
      evidence: top.map((c) => addrEv([...c.chains][0], c.address, plural(c.nIn + c.nOut, 'transfer'), undefined, c.nIn + c.nOut)),
      chains: [...new Set(top.flatMap((c) => [...c.chains]))],
    })];
  },
};
