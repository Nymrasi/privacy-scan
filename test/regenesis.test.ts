// OP Mainnet went through a regenesis on 11 November 2021, and no explorer lists what an
// address sent before it. sassal.eth sent 41 transactions there; the explorer lists nonces 9 to 40, its oldest on
// 2021-11-12 (block 2,910). The gap check read that as a hole in the index, so the scan gave no score at all.
// On a chain with ChainDef.regenesis, missing nonces that are exactly the lowest ones are no gap: the chain is read and
// scored, with no line about it (his word on 2026-10-23: no notice about the Optimism history, but such wallets are read),
// and its first funding counts as unknown. Any other hole stays a gap.
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { scan } from '../src/index.ts';
import { fetchChain } from '../src/history.ts';
import { clearSessionCache, createHttp, resetHostState } from '../src/sources/http.ts';
import { CHAINS, CHAIN_BY_ID, type ChainDef } from '../src/chains.ts';

beforeEach(() => { clearSessionCache(); resetHostState(); });

const ME = '0x2222222222222222222222222222222222222222';
const OTHER = '0x3333333333333333333333333333333333333333';
const FUNDER = '0x4444444444444444444444444444444444444444';
const chainOf = (id: number, extra: Partial<ChainDef> = {}): ChainDef =>
  ({ id, name: `Test chain ${id}`, native: 'ETH', source: { kind: 'blockscout', api: `https://rg${id}.test` }, rpc: `https://rg${id}-rpc.test/`, explorer: `https://rg${id}.test`, defaultOn: false, ...extra });
const REGEN = chainOf(990201, { regenesis: '11 November 2021' });
const PLAIN = chainOf(990202);
for (const c of [REGEN, PLAIN]) CHAIN_BY_ID.set(c.id, c);

interface World {
  /** The chain's RPC nonce of the address. */
  sent: number;
  /** Nonces the explorer lists for the address's own transactions. */
  listed: number[];
  /** Rows carry no nonce (an explorer that does not give it). */
  noNonce?: boolean;
  /** These listed sends carry no nonce. */
  bare?: number[];
}

function world(w: World) {
  return (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      const ours = /rg\d+-rpc\.test/.test(url);
      return json((Array.isArray(body) ? body : [body]).map((c: any) => ({
        id: c.id, jsonrpc: '2.0',
        result: c.method === 'eth_getCode' ? '0x' : !ours ? '0x0' : c.method === 'eth_getTransactionCount' ? '0x' + w.sent.toString(16) : '0xde0b6b3a7640000',
      })));
    }
    if (/\/api\/v2\/addresses\/0x[0-9a-f]{40}$/.test(url)) return json({ is_contract: false, public_tags: [], metadata: null });
    if (url.includes('bens.services.blockscout.com')) return json(url.includes('addresses:lookup') ? { items: [] } : {});
    const m = url.match(/^https:\/\/rg(\d+)\.test\/api\/v2\/addresses\/(0x[0-9a-f]{40})\/([a-z-]+)/);
    if (!m || m[2] !== ME || m[3] !== 'transactions') return json({ items: [], next_page_params: null });
    const id = Number(m[1]);
    const side = (a: string) => ({ hash: a, is_contract: false });
    // Newest first: the address's own sends by nonce, then one payment in from FUNDER before the oldest of them.
    const own = [...w.listed].sort((a, b) => b - a).map((n, i) => ({
      block_number: 10_000 - i, timestamp: new Date((1_700_000_000 - i * 3600) * 1000).toISOString(),
      hash: '0x' + (id * 1000 + n).toString(16).padStart(64, '0'), from: side(ME), to: side(OTHER), value: '1000000000000000',
      status: 'ok', raw_input: '0x', ...(w.noNonce || w.bare?.includes(n) ? {} : { nonce: n }),
    }));
    const paid = { block_number: 1, timestamp: new Date(1_600_000_000 * 1000).toISOString(), hash: '0x' + 'f1'.repeat(32), from: side(FUNDER), to: side(ME), value: '50000000000000000', status: 'ok', raw_input: '0x', nonce: 3 };
    return json({ items: [...own, paid], next_page_params: null });
  }) as typeof fetch;
}

const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const lim = { maxTx: 500, maxToken: 250, maxInternal: 50 };
const read = (c: ChainDef, w: World) => fetchChain(createHttp({ fetch: world(w), cache: null }), c, ME, lim);

test('E: sassal.eth on OP Mainnet: 41 sent, nonces 9 to 40 listed: no gap, read in full, and no line about it', async () => {
  const h = await read(REGEN, { sent: 41, listed: range(9, 40) });
  assert.deepEqual(h.coverage.missing, []);
  assert.equal(h.coverage.status, 'scanned');
  assert.deepEqual(h.coverage.limitations, [], 'no line about the history before the regenesis');
  assert.equal(h.firstFunding, undefined, 'the payment in before the oldest listed send is no first funding: the first send is not listed');
});

test('E: in a scan that chain gives a score: no part `chain` in what is incomplete', async () => {
  const r = await scan(ME, { chainIds: [REGEN.id], fetch: world({ sent: 41, listed: range(9, 40) }), cache: false });
  assert.deepEqual(r.incomplete, []);
  assert.notEqual(r.score, null);
});

test('E: one transaction before the regenesis: the first funding counts as unknown there too', async () => {
  const h = await read(REGEN, { sent: 5, listed: range(1, 4) });
  assert.deepEqual(h.coverage.missing, [], 'one missing is no gap anyway (fewer than 3)');
  assert.equal(h.firstFunding, undefined);
});

test('E: a hole in the middle stays a gap in the index, also on a regenesis chain', async () => {
  const h = await read(REGEN, { sent: 41, listed: [...range(0, 19), ...range(29, 40)] });
  assert.deepEqual(h.coverage.missing, ['transactions (the explorer lists 32 of the 41 this address sent here)']);
});

test('E: the newest nonces missing stay a gap (the start is there, the end is not)', async () => {
  const h = await read(REGEN, { sent: 41, listed: range(0, 31) });
  assert.deepEqual(h.coverage.missing, ['transactions (the explorer lists 32 of the 41 this address sent here)']);
});

test('E: a chain without a regenesis keeps the gap rule as it was', async () => {
  const h = await read(PLAIN, { sent: 41, listed: range(9, 40) });
  assert.deepEqual(h.coverage.missing, ['transactions (the explorer lists 32 of the 41 this address sent here)']);
});

test('E: rows without a nonce prove nothing: the gap stays', async () => {
  const h = await read(REGEN, { sent: 41, listed: range(9, 40), noNonce: true });
  assert.deepEqual(h.coverage.missing, ['transactions (the explorer lists 32 of the 41 this address sent here)']);
});

test('E: a send without a nonce proves nothing either: every listed send must carry one', async () => {
  const h = await read(REGEN, { sent: 41, listed: range(9, 40), bare: [10, 20] });
  assert.deepEqual(h.coverage.missing, ['transactions (the explorer lists 32 of the 41 this address sent here)']);
});

test('E: a full list on a regenesis chain is unchanged: the first funding found', async () => {
  const h = await read(REGEN, { sent: 10, listed: range(0, 9) });
  assert.deepEqual(h.coverage.missing, []);
  assert.equal(h.firstFunding?.from, FUNDER);
});

test('E: the register marks only OP Mainnet with a regenesis, 11 November 2021', () => {
  assert.deepEqual(CHAINS.filter((c) => c.regenesis !== undefined).map((c) => [c.id, c.regenesis]), [[10, '11 November 2021']]);
});
