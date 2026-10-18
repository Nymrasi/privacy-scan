// GIWA Sepolia (91342) is read when asked for by id. GIWA's mainnet (9134) is not live (docs.giwa.io "in development",
// read October 2026), so the testnet is how
// the engine proves it reads GIWA Chain. A testnet sits in TESTNETS, never in CHAINS: every count, chain list and menu
// on the site, the docs and the bot is built from CHAINS (docs/src/l2.ts counts every line that is not retired), so
// none of them may change. Measured live in October 2026 on ten GIWA Sepolia wallets with `node scripts/scan.ts <addr> 91342`.
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { CHAIN_BY_ID, CHAINS, TESTNETS, chainName, defaultChainIds, txUrl } from '../src/chains.ts';
import { scan } from '../src/index.ts';
import { clearSessionCache, resetHostState } from '../src/sources/http.ts';
import { resetRelayState, targetProblem } from '../proxy/proxy.ts';

beforeEach(() => { clearSessionCache(); resetHostState(); resetRelayState(); });

const ME = '0x5555555555555555555555555555555555555555';
const GIWA_SEPOLIA = 91342;
const GIWA_MAINNET = 9134;
const GIWA = /giwa/i;

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

test('register: GIWA Sepolia is a testnet, known to the lookup, outside CHAINS and off by default', () => {
  const g = CHAIN_BY_ID.get(GIWA_SEPOLIA)!;
  assert.ok(g, 'the scan knows the id');
  assert.ok(TESTNETS.includes(g));
  assert.equal(g.name, 'GIWA Sepolia');
  assert.equal(g.native, 'ETH');
  assert.deepEqual(g.source, { kind: 'blockscout', api: 'https://sepolia-explorer.giwa.io', cf: false });
  assert.equal(g.rpc, 'https://sepolia-rpc.giwa.io');
  assert.equal(g.defaultOn, false);
  assert.ok(!g.retired);
  assert.match(g.limits?.[0] ?? '', /^GIWA Sepolia is the testnet of GIWA Chain: its coins have no value\. GIWA mainnet is not live yet\.$/);
  assert.equal(chainName(GIWA_SEPOLIA), 'GIWA Sepolia');
  assert.equal(txUrl(GIWA_SEPOLIA, '0xab'), 'https://sepolia-explorer.giwa.io/tx/0xab');
});

test('no count, list or menu built from the register sees a testnet', () => {
  for (const t of TESTNETS) {
    assert.ok(!CHAINS.some((c) => c.id === t.id), `${t.name} is not in CHAINS`);
    assert.ok(!defaultChainIds().includes(t.id), `${t.name} is not on by default`);
    assert.equal(t.defaultOn, false);
  }
  assert.ok(!CHAINS.some((c) => GIWA.test(c.name) || GIWA.test(c.source.api) || GIWA.test(c.rpc ?? '')), 'no GIWA line in CHAINS');
  // The register's own counts: the lookup holds CHAINS plus the testnets, nothing else.
  assert.equal(CHAIN_BY_ID.size, CHAINS.length + TESTNETS.length);
});

test('GIWA mainnet (9134) is not in the register: it is not live, so nothing may pretend to read it', () => {
  assert.ok(!CHAIN_BY_ID.has(GIWA_MAINNET));
});

test('a default scan never asks anything about GIWA', async () => {
  const log: string[] = [];
  const r = await scan(ME, { fetch: emptyFetch(log), cache: false });
  assert.ok(!r.coverage.some((c) => c.chainId === GIWA_SEPOLIA));
  assert.ok(!log.some((u) => GIWA.test(u)), 'no request to a GIWA host');
  assert.equal(r.coverage.length, defaultChainIds().length);
});

test('GIWA Sepolia asked for by id is read on its own Blockscout and RPC, straight (no relay), with the testnet line', async () => {
  const log: string[] = [];
  const r = await scan(ME, { chainIds: [GIWA_SEPOLIA], fetch: emptyFetch(log), cache: false });
  const c = r.coverage.find((x) => x.chainId === GIWA_SEPOLIA)!;
  assert.ok(c, 'a coverage line for GIWA Sepolia');
  assert.equal(c.name, 'GIWA Sepolia');
  assert.notEqual(c.status, 'skipped');
  assert.ok(c.limitations.includes(CHAIN_BY_ID.get(GIWA_SEPOLIA)!.limits![0]));
  const hosts = new Set(log.map((u) => new URL(u).host));
  assert.ok(hosts.has('sepolia-rpc.giwa.io') || hosts.has('sepolia-explorer.giwa.io'), `asked GIWA's own hosts: ${[...hosts].join(', ')}`);
  assert.ok([...hosts].filter((h) => GIWA.test(h)).every((h) => h === 'sepolia-rpc.giwa.io' || h === 'sepolia-explorer.giwa.io'));
  assert.ok(!r.coverage.some((x) => x.chainId !== GIWA_SEPOLIA && x.chainId !== 1 && x.status !== 'skipped'), 'only GIWA Sepolia is read (Ethereum only for the ENS name)');
});

test('the relay does not change: no GIWA host is a target (the browser reads GIWA straight, CORS *)', () => {
  assert.equal(targetProblem('GET', new URL(`https://sepolia-explorer.giwa.io/api/v2/addresses/${ME}/transactions`)), 'host not allowed');
  assert.equal(targetProblem('POST', new URL('https://sepolia-rpc.giwa.io')), 'host not allowed');
});
