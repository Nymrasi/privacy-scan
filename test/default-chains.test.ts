// The chains a scan reads by default, and the hosts it asks for them (2026-10-21). The register is the one source of
// every chain list and count (site, docs, bot), so these two lists change only with a line in src/chains.ts.
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { CHAINS, defaultChainIds } from '../src/chains.ts';
import { scan } from '../src/index.ts';
import { clearSessionCache, resetHostState } from '../src/sources/http.ts';

beforeEach(() => { clearSessionCache(); resetHostState(); });

const ME = '0x5555555555555555555555555555555555555555';

/** Every request, answered as a wallet that sent `nonce` transactions on every chain and whose lists are empty. */
function wallet(log: string[], nonce: string) {
  return (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    log.push(`${init?.method ?? 'GET'} ${url}`);
    const json = (b: unknown) => new Response(JSON.stringify(b), { headers: { 'content-type': 'application/json' } });
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      return json((Array.isArray(body) ? body : [body]).map((c: any) => ({ jsonrpc: '2.0', id: c.id, result: c.method === 'eth_call' ? '0x' : c.method === 'eth_getTransactionCount' ? nonce : '0x0' })));
    }
    if (url.includes('addresses:lookup')) return json({ items: [] });
    if (url.includes('/etherscan/api') || url.includes('api.etherscan.io')) return json({ status: '0', message: 'No transactions found', result: [] });
    return json({ items: [], next_page_params: null, is_contract: false, public_tags: [], metadata: null });
  }) as typeof fetch;
}

const hosts = (log: string[]) => [...new Set(log.map((l) => { const [m, u] = l.split(' '); return `${m} ${new URL(u).host}`; }))].sort();

test('the chains on by default are these fifteen, in the order of the register', () => {
  assert.deepEqual(defaultChainIds(), [1, 8453, 42161, 10, 137, 4663, 43114, 324, 534352, 130, 100, 57073, 1868, 56, 42220]);
  assert.deepEqual(defaultChainIds(), CHAINS.filter((c) => c.defaultOn && !c.retired).map((c) => c.id));
});

test('a default scan of an empty wallet asks the RPC of each default chain, the ENS services and nothing else', async () => {
  const log: string[] = [];
  const r = await scan(ME, { fetch: wallet(log, '0x0'), cache: false });
  assert.deepEqual(hosts(log), [
    'GET bens.services.blockscout.com', 'GET eth.blockscout.com',
    'POST arbitrum-one-rpc.publicnode.com', 'POST avalanche-c-chain-rpc.publicnode.com', 'POST base-rpc.publicnode.com',
    'POST bsc-rpc.publicnode.com', 'POST celo-rpc.publicnode.com', 'POST ethereum-rpc.publicnode.com', 'POST gnosis-rpc.publicnode.com',
    'POST mainnet.era.zksync.io', 'POST optimism-rpc.publicnode.com', 'POST polygon-bor-rpc.publicnode.com', 'POST rpc-gel.inkonchain.com',
    'POST rpc.mainnet.chain.robinhood.com', 'POST scroll-rpc.publicnode.com', 'POST soneium-rpc.publicnode.com', 'POST unichain-rpc.publicnode.com',
  ]);
  assert.deepEqual(r.coverage.map((c) => c.chainId).sort((a, b) => a - b), [...defaultChainIds()].sort((a, b) => a - b));
});

test('a default scan in the browser, of a wallet active on every chain, never asks Etherscan V2 straight from the page', async () => {
  const log: string[] = [];
  await scan(ME, { fetch: wallet(log, '0x1'), cache: false });
  assert.ok(log.length > 30, `${log.length} requests`);
  assert.deepEqual(log.filter((l) => new URL(l.split(' ')[1]).host === 'api.etherscan.io'), [], 'no keyless Etherscan read');
});
