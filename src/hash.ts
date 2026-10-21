// cyrb53: a fast 53-bit string hash (public domain, bryc). Used to key the bundled label set,
// so a lookup hashes the WHOLE address and vanity prefixes cannot collide.
export function cyrb53(str: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/**
 * Fixed-width key of an address: 11 base-36 chars (53 bits). Remembered per address: the result page asks the
 * label lists about the same counterparties again for every moment of the privacy timeline, and hashing them
 * each time was half of the drawing (phone at 4x CPU: 1.91 s of long tasks after a scan of nick.eth,
 * 1.17 s with this). The key is the same either way; KEYS only stops it being worked out twice.
 */
export const KEYS = new Map<string, string>();
/** KEYS starts over past this many addresses, so a long session cannot grow it without end. */
export const KEYS_MAX = 50_000;
export function addrKey(address: string): string {
  let k = KEYS.get(address);
  if (k === undefined) {
    if (KEYS.size >= KEYS_MAX) KEYS.clear();
    k = cyrb53(address.toLowerCase()).toString(36).padStart(11, '0');
    KEYS.set(address, k);
  }
  return k;
}
