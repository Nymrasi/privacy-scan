// Exchange and service labels, looked up locally from the bundled datasets (src/data/*.json).
import cex from './data/cex.json' with { type: 'json' };
import services from './data/services.json' with { type: 'json' };
import { addrKey } from './hash.ts';
import type { ServiceIdentity } from './types.ts';

export interface CexLabel {
  entity: string;
  /** 'hot' = exchange-operated wallet; 'deposit' = a customer deposit address. */
  kind: 'hot' | 'deposit';
}

type Packed = { keyChars: number; entities: string[]; hot: [number, string][]; deposit: [number, string][] };

let index: Map<string, CexLabel> | null = null;

function build(): Map<string, CexLabel> {
  const d = cex as unknown as Packed;
  const m = new Map<string, CexLabel>();
  const w = d.keyChars;
  for (const kind of ['hot', 'deposit'] as const) {
    for (const [i, s] of d[kind]) {
      for (let k = 0; k < s.length; k += w) m.set(s.slice(k, k + w), { entity: d.entities[i], kind });
    }
  }
  return m;
}

export function cexLabel(address: string): CexLabel | undefined {
  if (!index) index = build();
  return index.get(addrKey(address));
}

export function cexStats(): { entities: number; addresses: number; source: string } {
  if (!index) index = build();
  return { entities: (cex as unknown as Packed).entities.length, addresses: index.size, source: (cex as any).source };
}

/** A wallet run by a service (bot, bundler, relayer, deployer, market maker, payments, faucet, bridge). Never a person's other wallet. */
export interface ServiceLabel {
  kind: 'bridge' | 'bot' | 'infrastructure' | 'distributor' | 'payments' | 'market maker' | 'service';
  /** Who runs it; the list names bridges, market makers, payment and payout services, not bots or infrastructure. */
  entity?: string;
}

/** `services`: [kind index, keys] or [kind index, keys, entity index]. */
type PackedServices = { keyChars: number; kinds: ServiceLabel['kind'][]; entities: string[]; services: [number, string, number?][] };
let svc: Map<string, ServiceLabel> | null = null;

export function serviceLabel(address: string): ServiceLabel | undefined {
  if (!svc) {
    const d = services as unknown as PackedServices;
    svc = new Map();
    for (const [k, str, e] of d.services) {
      const label: ServiceLabel = e !== undefined ? { kind: d.kinds[k], entity: d.entities[e] } : { kind: d.kinds[k] };
      for (let i = 0; i < str.length; i += d.keyChars) svc.set(str.slice(i, i + d.keyChars), label);
    }
  }
  return svc.get(addrKey(address).slice(-(services as unknown as PackedServices).keyChars));
}

/**
 * The scanned address itself as a service, from the bundled lists: an exchange's own wallet or a
 * deposit address an exchange holds the key of (cex.json), or a wallet on the service list.
 */
export function serviceIdentity(address: string): ServiceIdentity | undefined {
  const c = cexLabel(address);
  if (c) return { kind: c.kind === 'hot' ? 'exchange' : 'deposit', entity: c.entity };
  const s = serviceLabel(address);
  if (!s) return undefined;
  return s.entity ? { kind: s.kind, entity: s.entity } : { kind: s.kind };
}
