// Address poisoning: addresses made to look like the scanned wallet, or like a wallet it really uses,
// so that a shortened address in a history reads the same. Never a link; shown as a warning instead.
import type { Warning } from '../types.ts';
import { addrEv, counterparties, type DetectorContext } from './context.ts';
import type { RecipientAnalysis } from './deposits.ts';

/** The look-alikes in this history, as one warning, or null. `rec` adds those seen on deposit addresses. */
export function poisoningWarning(ctx: DetectorContext, rec?: RecipientAnalysis | null): Warning | null {
  const found = new Map<string, { address: string; imitates: string; chainId: number }>();
  for (const c of counterparties(ctx).values()) {
    if (c.poison && c.imitates) found.set(c.address, { address: c.address, imitates: c.imitates, chainId: [...c.chains][0] });
  }
  for (const d of rec?.deposits ?? []) for (const a of d.lookalikes) if (!found.has(a)) found.set(a, { address: a, imitates: ctx.me, chainId: d.chainId });
  if (!found.size) return null;
  const list = [...found.values()].sort((a, b) => a.address.localeCompare(b.address));
  const ofYou = list.filter((x) => x.imitates === ctx.me).length;
  const one = list.length === 1;
  // A contract or a service is not a person: its warning speaks of "this address", never "you".
  const it = !!ctx.thirdPerson;
  const own = it ? 'this address' : 'your own address', used = it ? 'a wallet it deals with' : 'a wallet you use';
  return {
    id: 'address_poisoning',
    title: `${one ? 'A look-alike address is' : `${list.length} look-alike addresses are`} in ${it ? "this address's" : 'your'} history`,
    explanation: `${one ? 'This address copies' : 'These addresses copy'} the first and last characters of ${ofYou === list.length ? own : ofYou ? `${own} or of ${used}` : used}, so shortened ${one ? 'it reads' : 'they read'} the same. This is address poisoning: `
      + (it
        ? `someone hopes a sender copies one from this history and sends money to it. Always check the full address, and never copy one from a transaction history. Nymra never counts ${one ? 'it' : 'them'} as a linked wallet.`
        : `someone hopes you copy one from your history and send money to it. Always check the full address, and never copy one from your transaction history. Nymra never counts ${one ? 'it' : 'them'} as your wallet${one ? '' : 's'}.`),
    lookalikes: list,
    evidence: list.slice(0, 10).map((x) => addrEv(x.chainId, x.address, `${x.address} imitates ${x.imitates === ctx.me ? (it ? 'this address' : 'your address') : used}, ${x.imitates}`)),
    chains: [...new Set(list.map((x) => x.chainId))],
  };
}
