// BNB Smart Chain through NodeReal, on NodeReal's own answer (test/data/nodereal-bybit-exploiter-1.json, as it came
// through the Nymra relay). NodeReal names a transfer's time `blockTimeStamp`; the engine read `blockTimestamp`, so
// every BSC row had time 0. For a wallet that sent nothing on BSC (Bybit Exploiter 1: 42 transfers in, 24 token
// transfers, none out) the chain was first seen at Infinity and last seen at -Infinity, which the Terminal could not
// draw: it threw in the coverage table and kept an early partial, "Private 100", on screen.
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { scan } from '../src/index.ts';
import { noderealRow } from '../src/sources/explorer.ts';
import { clearSessionCache, resetHostState } from '../src/sources/http.ts';

beforeEach(() => { clearSessionCache(); resetHostState(); });

const REAL = JSON.parse(readFileSync(new URL('./data/nodereal-bybit-exploiter-1.json', import.meta.url), 'utf8'));
const ME: string = REAL.address;
const EXTERNAL: any[] = REAL.external.result.transfers;
const TOKENS: any[] = REAL.token.result.transfers;
const TIMES = [...EXTERNAL, ...TOKENS].map((t) => Number(t.blockTimeStamp));

/** NodeReal through the relay answers `answer`; BSC's node says the wallet holds BNB and sent nothing; the rest is empty. */
function fetchWith(answer: { external: any[]; tokens: any[] }) {
  return (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.startsWith('https://relay.test/p?u=')) {
      const inner = decodeURIComponent(url.split('?u=')[1]);
      assert.ok(inner.startsWith('https://bsc-mainnet.nodereal.io/'), `only NodeReal goes through the relay here: ${inner}`);
      const p = JSON.parse(String(init!.body)).params[0];
      const mine = String(p.address).toLowerCase() === ME;
      const list = !mine ? [] : p.category[0] === 'external' ? answer.external : answer.tokens;
      return json({ jsonrpc: '2.0', id: 1, result: { pageKey: '', transfers: p.order === 'asc' ? [...list].reverse() : list } });
    }
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      const calls = Array.isArray(body) ? body : [body];
      const out = calls.map((c: any) => ({ jsonrpc: '2.0', id: c.id, result: c.method === 'eth_getBalance' && url.includes('bsc') ? '0x5af3107a4000' : c.method === 'eth_getCode' ? '0x' : '0x0' }));
      return json(Array.isArray(body) ? out : out[0]);
    }
    if (/\/api\/v2\/addresses\/0x[0-9a-f]{40}$/.test(url)) return json({ is_contract: false, public_tags: [], metadata: null });
    if (url.includes('bens.services.blockscout.com')) return url.includes('addresses:lookup') ? json({ items: [] }) : new Response('{"message":"not found"}', { status: 404 });
    return json({ items: [], next_page_params: null, status: '0', message: 'No transactions found', result: [] });
  }) as typeof fetch;
}

test('NodeReal rows: the time is blockTimeStamp, as NodeReal sends it (its own rows)', () => {
  const a = noderealRow('txlist', EXTERNAL[0]);
  assert.equal(a.timeStamp, String(EXTERNAL[0].blockTimeStamp));
  const b = noderealRow('tokentx', TOKENS[0]);
  assert.equal(b.timeStamp, String(TOKENS[0].blockTimeStamp));
  assert.ok(EXTERNAL.every((x) => noderealRow('txlist', x).timeStamp === String(x.blockTimeStamp)), 'every row keeps its own time');
});

test('BNB Smart Chain on the real answer for Bybit Exploiter 1: first and last seen are the rows\' own days, never Infinity', async () => {
  const r = await scan(ME, { chainIds: [56], fetch: fetchWith({ external: EXTERNAL, tokens: TOKENS }), relay: 'https://relay.test/p', cache: false });
  const c = r.coverage.find((x) => x.chainId === 56)!;
  assert.equal(c.status, 'scanned');
  assert.equal(c.txCount, EXTERNAL.length);
  assert.equal(c.tokenTransferCount, TOKENS.length);
  assert.equal(c.firstSeen, Math.min(...TIMES));
  assert.equal(c.lastSeen, Math.max(...TIMES));
  for (const x of r.coverage) {
    if (x.firstSeen !== undefined) assert.ok(Number.isFinite(x.firstSeen), `${x.name}: first seen ${x.firstSeen}`);
    if (x.lastSeen !== undefined) assert.ok(Number.isFinite(x.lastSeen), `${x.name}: last seen ${x.lastSeen}`);
  }
});

test('Rows that carry no time leave a chain\'s days unknown, never Infinity (the min of nothing)', async () => {
  const strip = (xs: any[]) => xs.map(({ blockTimeStamp: _t, ...x }) => x);
  const r = await scan(ME, { chainIds: [56], fetch: fetchWith({ external: strip(EXTERNAL), tokens: strip(TOKENS) }), relay: 'https://relay.test/p', cache: false });
  const c = r.coverage.find((x) => x.chainId === 56)!;
  assert.equal(c.txCount, EXTERNAL.length, 'the rows were read');
  assert.equal(c.firstSeen, undefined);
  assert.equal(c.lastSeen, undefined);
});
