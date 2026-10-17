// Blast (81457) is retired: its team ended the
// chain (announced 2 October 2026; withdrawals through the normal interface close on 26 October 2026, then it
// goes offline). Its line stays in the register with a note, so nobody puts it back by mistake, and no road
// reads it: not by default, not when asked for, not through the relay. Counts come from the register.
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { CHAIN_BY_ID, CHAINS, defaultChainIds } from '../src/chains.ts';
import { scan } from '../src/index.ts';
import { clearSessionCache, resetHostState } from '../src/sources/http.ts';
import { resetRelayState, targetProblem } from '../proxy/proxy.ts';

beforeEach(() => { clearSessionCache(); resetHostState(); resetRelayState(); });

const ME = '0x5555555555555555555555555555555555555555';
const BLAST = 81457;

/** Every request, answered as an empty wallet would be (no activity anywhere). */
function emptyFetch(log: string[]) {
  return (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    log.push(url);
    const json = (b: unknown) => new Response(JSON.stringify(b), { headers: { 'content-type': 'application/json' } });
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      return json((Array.isArray(body) ? body : [body]).map((c: any) => ({ jsonrpc: '2.0', id: c.id, result: c.method === 'eth_call' ? '0x' : '0x0' })));
    }
    if (url.includes('addresses:lookup')) return json({ items: [] });
    return json({ items: [], next_page_params: null, is_contract: false, public_tags: [], metadata: null });
  }) as typeof fetch;
}

test('register: Blast keeps its line, marked retired with the reason, and is not on by default', () => {
  const b = CHAIN_BY_ID.get(BLAST)!;
  assert.ok(b, 'the id stays in the register');
  assert.equal(b.defaultOn, false);
  assert.match(b.retired ?? '', /^Blast is retired\b/);
  assert.ok(!defaultChainIds().includes(BLAST));
  // The count of chains on by default is the register's, never a fixed number.
  assert.deepEqual(defaultChainIds(), CHAINS.filter((c) => c.defaultOn && !c.retired).map((c) => c.id));
  assert.ok(CHAINS.filter((c) => c.retired).every((c) => !c.defaultOn), 'a retired chain is never on by default');
});

test('a default scan never asks anything about Blast', async () => {
  const log: string[] = [];
  const r = await scan(ME, { fetch: emptyFetch(log), cache: false });
  assert.ok(!r.coverage.some((c) => c.chainId === BLAST));
  assert.ok(!log.some((u) => /blast|81457/i.test(decodeURIComponent(u))), 'no request to its RPC or its Routescan API');
  assert.equal(r.coverage.length, defaultChainIds().length);
});

test('Blast asked for by id is not read either: skipped with the reason, and not one request', async () => {
  const log: string[] = [];
  const r = await scan(ME, { chainIds: [BLAST], fetch: emptyFetch(log), cache: false });
  const c = r.coverage.find((x) => x.chainId === BLAST)!;
  assert.equal(c.status, 'skipped');
  assert.deepEqual(c.limitations, [CHAIN_BY_ID.get(BLAST)!.retired]);
  assert.ok(!log.some((u) => /blast|81457/i.test(decodeURIComponent(u))), 'not one request about Blast');
  assert.ok(!r.incomplete.some((g) => g.chainId === BLAST), 'a retired chain is no gap in the score');
});

test('the relay no longer lets Blast\'s RPC through', () => {
  assert.equal(targetProblem('POST', new URL('https://blast-rpc.publicnode.com')), 'host not allowed');
  // The shared Routescan host stays for Avalanche.
  assert.equal(targetProblem('GET', new URL('https://api.routescan.io/v2/network/mainnet/evm/43114/etherscan/api?module=account&action=txlist&address=0x5555555555555555555555555555555555555555')), null);
});
