// Behavioral fingerprint: time zone from the hours you are active, round amounts,
// a fixed gas setting, transactions on a fixed schedule.
import type { Transfer } from '../history.ts';
import type { Finding } from '../types.ts';
import { cleanTokens, finding, pct, signedTxs, STABLES, type Detector } from './context.ts';

const MIN_QUIET = 5;

/** Transactions per UTC hour. */
export function hourHistogram(ts: number[]): number[] {
  const h = new Array(24).fill(0);
  for (const t of ts) h[new Date(t * 1000).getUTCHours()]++;
  return h;
}

/**
 * The longest circular run of near-silent hours (at most 2% of activity each).
 * Returns its start hour, length and the share of activity inside it.
 */
export function quietestWindow(h: number[]): { start: number; len: number; share: number } {
  const total = h.reduce((a, b) => a + b, 0) || 1;
  const low = h.map((n) => n / total <= 0.02);
  if (low.every(Boolean)) return { start: 0, len: 24, share: 0 };
  let best = { start: 0, len: 0, share: 1 };
  for (let s = 0; s < 24; s++) {
    if (!low[s] || low[(s + 23) % 24]) continue; // start of a run
    let len = 0, n = 0;
    while (len < 24 && low[(s + len) % 24]) { n += h[(s + len) % 24]; len++; }
    if (len > best.len) best = { start: s, len, share: n / total };
  }
  return best;
}

/** Assumes the quiet run is local night, centred on 03:00. Returns the likely UTC offset in hours. */
export function utcOffsetFromQuiet(start: number, len: number): number {
  const centre = (start + len / 2) % 24;
  let off = Math.round(3 - centre);
  while (off > 12) off -= 24;
  while (off < -11) off += 24;
  return off;
}

const fmtOff = (o: number) => `UTC${o >= 0 ? '+' : '-'}${Math.abs(o)}`;
const hh = (h: number) => `${String(((h % 24) + 24) % 24).padStart(2, '0')}:00`;

export function isRound(t: Transfer): boolean {
  const x = t.amount;
  if (x <= 0) return false;
  if (t.kind === 'token' && STABLES.has(t.symbol.toUpperCase())) return x >= 10 && Number.isInteger(x / 10);
  if (t.kind === 'token') return false;
  // native: at most two significant digits, e.g. 0.05, 0.25, 1.5, 20
  const mag = Math.pow(10, Math.floor(Math.log10(x)) - 1);
  const r = Math.round(x / mag) * mag;
  return Math.abs(r - x) / x < 1e-9 && x >= 0.001;
}

export const behavioralFingerprint: Detector = {
  id: 'behavioral_fingerprint',
  network: false,
  async run(ctx) {
    const out: Finding[] = [];
    const signed = signedTxs(ctx).filter((t) => t.timestamp > 0);
    const chains = [...new Set(signed.map((t) => t.chainId))];

    // Time zone.
    if (signed.length >= 25) {
      const hist = hourHistogram(signed.map((t) => t.timestamp));
      const q = quietestWindow(hist);
      if (q.len >= MIN_QUIET && q.len <= 12) {
        const off = utcOffsetFromQuiet(q.start, q.len);
        const conf = Math.min(0.9, 0.3 + 0.05 * (q.len - MIN_QUIET) + 0.4 * Math.min(1, signed.length / 100));
        out.push(finding({
          id: 'behavioral_fingerprint.timezone', detector: 'behavioral_fingerprint', severity: conf >= 0.6 ? 'medium' : 'low', confidence: conf,
          title: 'Your activity points to a time zone',
          explanation: `You almost never transact between ${hh(q.start)} and ${hh(q.start + q.len)} UTC (${pct(q.share)} of your transactions). If that is when you sleep, you live somewhere between ${fmtOff(off - 1)} and ${fmtOff(off + 1)}. It narrows down where you are.`,
          evidence: [{ kind: 'pattern', text: `Transactions per UTC hour, ${signed.length} transactions`, value: hist.join(',') }],
          chains,
        }));
      }
    }

    // Round amounts.
    const sends: Transfer[] = [];
    for (const h of ctx.histories) {
      for (const t of h.txs) if (t.dir === 'out' && t.amount > 0 && !t.failed) sends.push(t);
      // Only transfers the wallet really made: a fake token can write an outgoing transfer into any history.
      for (const t of cleanTokens(h)) if (t.dir === 'out' && STABLES.has(t.symbol.toUpperCase())) sends.push(t);
    }
    if (sends.length >= 8) {
      const round = sends.filter(isRound).length;
      const share = round / sends.length;
      if (share >= 0.4) {
        out.push(finding({
          id: 'behavioral_fingerprint.round_amounts', detector: 'behavioral_fingerprint', severity: share >= 0.6 ? 'medium' : 'low',
          confidence: Math.min(0.9, 0.4 + sends.length / 60),
          title: 'You often send round amounts',
          explanation: `${pct(share)} of your outgoing transfers are round numbers like 0.5 ETH or 100 USDC. Round amounts make it easier to match a payment out here with a payment in somewhere else.`,
          evidence: [{ kind: 'stat', text: `${round} of ${sends.length} outgoing transfers are round`, value: Math.round(share * 100) / 100 }],
          chains: [...new Set(sends.map((t) => t.chainId))],
        }));
      }
    }

    // Fixed gas setting: the same gas limit on calls to different functions (a tool, not a wallet estimate),
    // or on Ethereum the exact same gas price while the base fee moves.
    const calls = signed.filter((t) => t.isCall && t.gasLimit);
    if (calls.length >= 10) {
      const n = new Map<number, Transfer[]>();
      for (const t of calls) n.set(t.gasLimit!, [...(n.get(t.gasLimit!) ?? []), t]);
      const [limit, same] = [...n.entries()].sort((a, b) => b[1].length - a[1].length)[0];
      const methods = new Set(same.map((t) => t.methodId)).size;
      const share = same.length / calls.length;
      if (share >= 0.5 && methods >= 2) {
        out.push(finding({
          id: 'behavioral_fingerprint.fixed_gas', detector: 'behavioral_fingerprint', severity: 'low', confidence: Math.min(0.85, 0.4 + share / 2),
          title: 'You use the same gas setting every time',
          explanation: `${pct(share)} of your contract calls use a gas limit of exactly ${limit}, across different kinds of calls. Normal wallets estimate gas per call, so a fixed value is a fingerprint of the software or bot you use.`,
          evidence: [{ kind: 'stat', text: `Gas limit ${limit} on ${same.length} of ${calls.length} calls`, value: limit }],
          chains: [...new Set(same.map((t) => t.chainId))],
        }));
      }
    }
    const eth = signed.filter((t) => t.chainId === 1 && t.gasPrice);
    if (eth.length >= 10 && !out.some((f) => f.id === 'behavioral_fingerprint.fixed_gas')) {
      const n = new Map<number, number>();
      for (const t of eth) n.set(t.gasPrice!, (n.get(t.gasPrice!) ?? 0) + 1);
      const [price, cnt] = [...n.entries()].sort((a, b) => b[1] - a[1])[0];
      if (cnt / eth.length >= 0.5) {
        out.push(finding({
          id: 'behavioral_fingerprint.fixed_gas', detector: 'behavioral_fingerprint', severity: 'low', confidence: 0.7,
          title: 'You pay the same gas price every time',
          explanation: `${pct(cnt / eth.length)} of your Ethereum transactions paid exactly ${+price.toFixed(4)} gwei while the network price kept moving. A fixed setting is a fingerprint of your wallet software.`,
          evidence: [{ kind: 'stat', text: `${cnt} of ${eth.length} transactions at ${+price.toFixed(4)} gwei`, value: price }],
          chains: [1],
        }));
      }
    }

    // Fixed timing: transactions on a schedule.
    if (signed.length >= 10) {
      const ts = [...new Set(signed.map((t) => t.timestamp))].sort((a, b) => a - b);
      const gaps = ts.slice(1).map((t, i) => t - ts[i]).filter((g) => g > 0);
      if (gaps.length >= 9) {
        const med = [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)];
        const near = gaps.filter((g) => Math.abs(g - med) <= Math.max(60, med * 0.03)).length / gaps.length;
        if (med >= 300 && near >= 0.6) {
          const every = med >= 86400 * 0.9 ? `${Math.round(med / 3600)} hours` : med >= 3600 ? `${Math.round(med / 3600)} hours` : `${Math.round(med / 60)} minutes`;
          out.push(finding({
            id: 'behavioral_fingerprint.fixed_timing', detector: 'behavioral_fingerprint', severity: 'low', confidence: Math.min(0.85, near),
            title: 'Your transactions run on a schedule',
            explanation: `${pct(near)} of the gaps between your transactions are about ${every}. A fixed rhythm is easy to recognise across wallets and chains.`,
            evidence: [{ kind: 'stat', text: `Typical gap ${every}`, value: med }],
            chains,
          }));
        }
      }
    }
    // Smart-account delegation names the wallet app.
    if (ctx.profile.delegate) {
      out.push(finding({
        id: 'behavioral_fingerprint.wallet_software', detector: 'behavioral_fingerprint', severity: 'low', confidence: 0.9,
        title: 'Your wallet app is visible',
        explanation: `This address delegates to ${ctx.profile.delegate} (EIP-7702). Anyone can see which wallet software you use, which helps tell your wallets apart from others.`,
        evidence: [{ kind: 'label', text: `Delegates to ${ctx.profile.delegate}`, label: ctx.profile.delegate, chainId: 1 }],
        chains: [1],
      }));
    }
    return out;
  },
};
