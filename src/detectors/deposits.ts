// Shared analysis: which counterparties are exchange deposit addresses, and who else pays into them.
// Used by cex_exposure (the deposit itself) and linked_wallets (other wallets on the same deposit).
import { CHAIN_BY_ID } from '../chains.ts';
import type { Transfer } from '../history.ts';
import type { ChainId } from '../types.ts';
import { cexOf, counterparties, lookalike, memo, personal, personsByNonce, realToken, serviceOf, type Counterparty, type DetectorContext } from './context.ts';

export interface DepositHit {
  address: string;
  chainId: ChainId;
  entity: string;
  /** 'label' = listed as a deposit address; 'sweep' = we saw it forward funds to an exchange. */
  how: 'label' | 'sweep';
  myDeposits: Transfer[];
  /** Other wallets that also paid into this deposit address. */
  otherSenders: { address: string; count: number }[];
  /** Total distinct senders seen (incl. me); a high number means a shared or omnibus address. */
  senders: number;
  sweepTx?: Transfer;
  /** Look-alikes of the scanned wallet that "paid in" here (address poisoning). Never a link. */
  lookalikes: string[];
}

export interface FundedHit {
  address: string;
  chainId: ChainId;
  /** Your transfer that was this wallet's first incoming funds. */
  tx: Transfer;
  /** It never sent a transaction there (its own count is 0): a gift, a payment or a cold wallet. */
  idle?: boolean;
}

export interface RecipientAnalysis {
  deposits: DepositHit[];
  /** Wallets whose whole (short) history we read and whose first funds came from you. */
  funded: FundedHit[];
}

const MAX_CANDIDATES = 5;
const PAGE = 50;

function mainChain(c: Counterparty): ChainId {
  const n = new Map<ChainId, number>();
  for (const t of c.outTransfers) n.set(t.chainId, (n.get(t.chainId) ?? 0) + 1);
  return [...n.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? [...c.chains][0];
}

export async function findDeposits(ctx: DetectorContext): Promise<DepositHit[]> {
  return (await analyzeRecipients(ctx)).deposits;
}

/** One pass over the top recipients: is it an exchange deposit address, or a wallet you funded? */
export function analyzeRecipients(ctx: DetectorContext): Promise<RecipientAnalysis> {
  return memo(ctx, 'recipients', async () => {
    const cps = [...counterparties(ctx).values()];
    const tokens = new Set<string>();
    for (const h of ctx.histories) for (const t of h.tokens) if (t.token) tokens.add(t.token);
    const labelled = cps.filter((c) => c.cex?.kind === 'deposit' && c.nOut > 0);
    const unknown = cps
      .filter((c) => personal(c) && c.nOut > 0 && c.nIn === 0)
      .sort((a, b) => b.nOut - a.nOut)
      .slice(0, ctx.replay ? undefined : Math.max(0, MAX_CANDIDATES - labelled.length));
    const hits: DepositHit[] = [];
    const funded: FundedHit[] = [];
    await Promise.all([...labelled, ...unknown].map(async (c) => {
      // The history's chain carries the source that actually answered (it may be the alternative).
      const id = mainChain(c);
      const chain = ctx.histories.find((h) => h.chain.id === id)?.chain ?? CHAIN_BY_ID.get(id);
      if (!chain) return;
      const [txs, toks] = await Promise.all([
        ctx.lookup(chain, 'txlist', c.address, { sort: 'desc', offset: PAGE }),
        ctx.lookup(chain, 'tokentx', c.address, { sort: 'desc', offset: PAGE }),
      ]);
      // A short history is complete: if its first incoming value came from you, you set it up.
      if (txs && txs.length < PAGE && !c.cex) {
        const first = txs.filter((t) => t.dir === 'in' && t.amount > 0 && !t.failed).sort((a, b) => a.block - b.block)[0];
        if (first && first.from === ctx.me) funded.push({ address: c.address, chainId: chain.id, tx: first });
      }
      const rows = [...(txs ?? []), ...(toks ?? [])];
      const outs = rows.filter((t) => t.dir === 'out' && t.amount > 0 && !t.failed);
      const toCex = outs.filter((t) => cexOf(t.to, t.cp)?.kind === 'hot');
      const isLabel = c.cex?.kind === 'deposit';
      const swept = outs.length > 0 && toCex.length / outs.length >= 0.6;
      if (!isLabel && !swept) return;
      const entity = c.cex?.entity ?? cexOf(toCex[0].to, toCex[0].cp)!.entity;
      // Only real deposits make a co-sender: native coin, a real token, or a token you deposited here
      // too. Poisoners mirror each of your deposits with a fake token from a look-alike of your address.
      const mine = new Set(c.outTransfers.filter((t) => t.kind === 'token').map((t) => t.token));
      const senders = new Map<string, number>();
      const poisoners = new Set<string>();
      for (const t of rows) {
        if (t.dir !== 'in' || t.amount <= 0 || t.failed) continue;
        if (lookalike(t.from, ctx.me)) { poisoners.add(t.from); continue; }
        if (cexOf(t.from, t.cp)) continue; // gas top-ups come from the exchange itself
        if (t.cp?.isContract || serviceOf(t.from, t.cp)) continue; // a bridge or payout service paying in is not a person
        if (t.from === t.token || tokens.has(t.from)) continue; // a token contract minting or moving its own supply
        if (t.kind === 'token' && !realToken(t) && !mine.has(t.token)) continue;
        senders.set(t.from, (senders.get(t.from) ?? 0) + 1);
      }
      senders.delete(ctx.me);
      // Two senders that imitate each other: at least one is a poisoner, and we cannot tell which.
      for (const a of [...senders.keys()]) for (const b of senders.keys()) if (lookalike(a, b)) { senders.delete(a); senders.delete(b); }
      hits.push({
        address: c.address, chainId: chain.id, entity, how: isLabel ? 'label' : 'sweep',
        myDeposits: c.outTransfers, otherSenders: [...senders.entries()].map(([address, count]) => ({ address, count })).sort((a, b) => b.count - a.count),
        senders: senders.size + 1, sweepTx: toCex[0], lookalikes: [...poisoners],
      });
    }));
    // A co-sender must be a wallet that really sends (nonce above 0: a forged token event needs none)
    // and not a service by its own transaction count. The same check for wallets you funded.
    for (const h of hits) h.otherSenders = await personsByNonce(ctx, h.otherSenders, (s) => ({ address: s.address, chainId: h.chainId }), true);
    const depSet = new Set(hits.map((h) => h.address));
    const at = (f: FundedHit) => ({ address: f.address, chainId: f.chainId });
    const fresh = (await personsByNonce(ctx, funded.filter((f) => !depSet.has(f.address)), at))
      .sort((a, b) => a.tx.block - b.tx.block || a.address.localeCompare(b.address));
    // The same counts again (cached, no new request): one that never sent anything is only a weak link.
    const sent = await ctx.nonces(fresh.map(at));
    for (const f of fresh) if (sent.get(f.address) === 0) f.idle = true;
    return {
      deposits: hits.sort((a, b) => b.myDeposits.length - a.myDeposits.length || a.address.localeCompare(b.address)),
      funded: fresh,
    };
  });
}
