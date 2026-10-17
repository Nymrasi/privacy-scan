// Public identity of an address: ENS primary name and records, owned names, explorer tags.
// Keyless: Blockscout v2 + Blockscout BENS + a public Ethereum RPC for ENS text records.
import { CHAIN_BY_ID } from '../chains.ts';
import type { Profile } from '../detectors/context.ts';
import { blockscoutAddress } from './explorer.ts';
import { reasonOf, type Http } from './http.ts';

export const ENS_RPC = 'https://ethereum-rpc.publicnode.com';
const BENS = 'https://bens.services.blockscout.com/api/v1/1';
/** ENS text records that tie a name to a person or an account elsewhere. */
export const IDENTITY_KEYS = ['com.twitter', 'com.github', 'url', 'email', 'com.discord', 'org.telegram', 'com.linkedin', 'xyz.farcaster', 'name', 'location'];

function enc32(hex: string) { return hex.replace(/^0x/, '').padStart(64, '0'); }
function encString(s: string) {
  const bytes = new TextEncoder().encode(s);
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return bytes.length.toString(16).padStart(64, '0') + hex.padEnd(Math.ceil(hex.length / 64) * 64 || 64, '0');
}
export function encodeText(node: string, key: string): string {
  // text(bytes32,string) = 0x59d1d43c
  return '0x59d1d43c' + enc32(node) + (64).toString(16).padStart(64, '0') + encString(key);
}
export function decodeString(ret: string): string {
  const h = ret.replace(/^0x/, '');
  if (h.length < 128) return '';
  const off = parseInt(h.slice(0, 64), 16) * 2;
  const len = parseInt(h.slice(off, off + 64), 16);
  if (!len || len > 2000) return '';
  const data = h.slice(off + 64, off + 64 + len * 2);
  const bytes = new Uint8Array(data.match(/../g)!.map((b) => parseInt(b, 16)));
  return new TextDecoder().decode(bytes).trim();
}

async function ensRecords(http: Http, name: string): Promise<Record<string, string>> {
  const d = await http.getJson(`${BENS}/domains/${encodeURIComponent(name)}`);
  const node: string | undefined = d?.id;
  const resolver: string | undefined = d?.resolver_address?.hash;
  if (!node || !resolver) return {};
  const batch = IDENTITY_KEYS.map((k, i) => ({ jsonrpc: '2.0', id: i, method: 'eth_call', params: [{ to: resolver, data: encodeText(node, k) }, 'latest'] }));
  const res = await http.getJson(ENS_RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(batch) });
  const out: Record<string, string> = {};
  for (const r of Array.isArray(res) ? res : []) {
    if (typeof r?.result !== 'string') continue;
    const v = decodeString(r.result);
    if (v) out[IDENTITY_KEYS[r.id]] = v.slice(0, 200);
  }
  return out;
}

/**
 * One identity read that failed. `identity`: the name, the labels or the contract check, which set the
 * named-wallet ceiling and the contract state. `names`: the other names and the records of the name,
 * side lists that never set the ceiling.
 */
export interface ProfileGap { part: 'identity' | 'names'; name: string; reason: string }

export async function fetchProfile(http: Http, me: string): Promise<{ profile: Profile; errors: ProfileGap[] }> {
  const profile: Profile = { isContract: false, ensRecords: {}, ownedNames: [], tags: [] };
  const errors: ProfileGap[] = [];
  const eth = CHAIN_BY_ID.get(1)!;
  // The primary name comes from Blockscout's address page, and also from BENS (another host with its own
  // limit): when the explorer refuses, the name, its -22 and the named-wallet ceiling still apply.
  const [addr, owned, rev] = await Promise.allSettled([
    blockscoutAddress(http, eth, me),
    http.getJson(`${BENS}/addresses:lookup?address=${me}&resolved_to=false&owned_by=true&only_active=true&page_size=50`),
    http.getJson(`${BENS}/addresses/${me}`),
  ]);
  if (addr.status === 'fulfilled' && addr.value) {
    const a = addr.value;
    // An EIP-7702 account is a normal wallet that delegates to code; it is not a contract.
    profile.isContract = !!a.is_contract && a.proxy_type !== 'eip7702';
    if (a.proxy_type === 'eip7702') profile.delegate = String(a.implementations?.[0]?.name ?? a.implementations?.[0]?.address_hash ?? 'a smart account');
    if (a.ens_domain_name) profile.ens = String(a.ens_domain_name);
    if (a.is_contract && a.name) profile.contractName = String(a.name);
    const tags = [...(a.public_tags ?? []), ...(a.metadata?.tags ?? [])]
      .filter((t: any) => t && (t.tagType === 'name' || t.display_name || t.label))
      .map((t: any) => String(t.name ?? t.display_name ?? t.label));
    profile.tags = [...new Set(tags)].slice(0, 6);
  }
  if (!profile.ens && rev.status === 'fulfilled') {
    // Only a name that resolves back to this address is its primary name.
    const d = rev.value?.domain;
    if (d?.name && String(d.resolved_address?.hash ?? '').toLowerCase() === me) profile.ens = String(d.name);
  }
  if (addr.status === 'rejected') {
    errors.push({ part: 'identity', name: 'ENS and labels', reason: rev.status === 'fulfilled'
      ? `Public labels and the contract check could not be read (${reasonOf(addr.reason)})`
      : `ENS name and public labels could not be read (${reasonOf(addr.reason)})` });
  }
  if (owned.status === 'fulfilled') {
    profile.ownedNames = (owned.value?.items ?? []).map((d: any) => String(d.name)).filter((n: string) => n && n !== profile.ens).slice(0, 20);
  } else {
    errors.push({ part: 'names', name: 'Other ENS names', reason: `Other ENS names of this address could not be read (${reasonOf(owned.reason)})` });
  }
  if (profile.ens) {
    try { profile.ensRecords = await ensRecords(http, profile.ens); } catch (e) { errors.push({ part: 'names', name: 'ENS records', reason: `ENS records could not be read (${reasonOf(e)})` }); }
  }
  return { profile, errors };
}
