// Before you send: the spec's cases with a fake chain node and explorer. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { beforeYouSend, PLANNED_HASH, type SendCheck } from '../../src/features/before-you-send.ts';
import type { ScanSession } from '../../src/session.ts';
import { mkSession } from './fixtures.ts';
import { A, hist, ME, T0, tx } from '../helpers.ts';
import type { Transfer } from '../../src/history.ts';

const BINANCE = '0x28c6c06298d514db089934071355e5743bf21d60'; // Binance hot wallet (bundled label)
const LISTED_DEPOSIT = '0x000f9f5f6db6d63bb64bb55d58272a1ce660fd90'; // a Binance deposit address in the open label list (dawsbot/eth-labels, MIT)
const RPC = 'https://ethereum-rpc.publicnode.com';

/** My history on Ethereum: funded by Binance, a few contract calls and plain sends. */
function session(extra: Transfer[] = []): ScanSession {
  const rows = [
    tx({ from: BINANCE, to: ME, amount: 2, timestamp: T0 }),
    ...Array.from({ length: 4 }, (_, i) => tx({ to: A(0x50 + i), amount: 0, isCall: true, methodId: '0xa9059cbb', timestamp: T0 + 3600 * (i + 1) })),
    ...extra,
  ];
  return mkSession(ME, [hist(1, rows)]);
}

interface Dest { nonce: number; balance?: bigint; code?: string; txs?: object[]; status?: number }
const v2 = (from: string, to: string, eth: number, i: number) => ({
  block_number: 2000 + i, timestamp: new Date((T0 + i * 60) * 1000).toISOString(), hash: '0x' + (0xabc000 + i).toString(16).padStart(64, '0'),
  from: { hash: from, is_contract: false }, to: { hash: to, is_contract: false }, value: BigInt(Math.round(eth * 1e18)).toString(),
  gas_limit: '21000', gas_price: '1000000000', raw_input: '0x', status: 'ok',
});

function fakeFetch(dests: Record<string, Dest>, log: string[]) {
  return (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    log.push(url);
    const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
    if (url === RPC && init?.method === 'POST') {
      const calls = JSON.parse(String(init.body));
      const d = dests[calls[0].params[0]];
      return json(calls.map((c: any) => ({ jsonrpc: '2.0', id: c.id, result:
        c.method === 'eth_getTransactionCount' ? '0x' + d.nonce.toString(16)
        : c.method === 'eth_getBalance' ? '0x' + (d.balance ?? 0n).toString(16)
        : c.method === 'eth_getCode' ? d.code ?? '0x'
        : '0x1312d00' })));
    }
    const m = url.match(/eth\.blockscout\.com\/api\/v2\/addresses\/(0x[0-9a-f]{40})\/([a-z-]+)/);
    if (m) {
      const d = dests[m[1]];
      if (d?.status) return json({ message: 'Too many requests' }, d.status, { 'x-ratelimit-reset': '3000000' });
      return json({ items: m[2] === 'transactions' ? d?.txs ?? [] : [], next_page_params: null });
    }
    throw new Error('unexpected url in test: ' + url);
  }) as typeof fetch;
}

function addsUp(c: SendCheck) {
  assert.equal(c.before.score + c.changes.reduce((s, x) => s + x.delta, 0) + c.rest, c.after.score, 'before + changes + rest = after');
  assert.equal(100 + c.after.findings.reduce((s, f) => s + f.scoreImpact, 0), c.after.score);
  for (const f of c.after.findings) for (const e of f.evidence) if (e.txHash === PLANNED_HASH) assert.equal(e.url, undefined, 'the planned transfer is never linked');
}

test('a fresh destination: its first funds, a weak link while it only holds (rules 1.3.0), Possible 0.60 once it sends; one request', async () => {
  const D = A(0xf1);
  const log: string[] = [];
  const c = await beforeYouSend(session(), { chainId: 1, to: D, amount: 0.37 }, { fetch: fakeFetch({ [D]: { nonce: 0 } }, log) });
  assert.equal(c.destination.kind, 'fresh');
  assert.ok(c.destination.read);
  const ch = c.changes.find((x) => x.ruleId === 'linked_wallets.funded_by_you')!;
  assert.ok(ch, 'funded_by_you is new');
  assert.equal(ch.kind, 'new');
  assert.equal(ch.after.severity, 'high');
  assert.equal(ch.after.confidence, 0.3, 'its own count is 0: it never sent anything, so only a weak link');
  assert.deepEqual(ch.links.map((l) => [l.address, l.confidence, l.level]), [[D, 0.3, 'weak']]);
  assert.equal(c.whenItSends?.confidence, 0.6, 'its first own transaction is paid with your coins');
  assert.equal(c.whenItSends?.level, 'possible');
  assert.ok(c.whenItSends!.score <= c.after.score);
  assert.ok(ch.aboutDestination);
  assert.ok(ch.after.evidence.some((e) => e.txHash === PLANNED_HASH && /this transfer/.test(e.text)));
  assert.ok(c.delta < 0 && c.after.score === c.before.score + c.delta);
  assert.equal(c.requests, 1, 'only the RPC batch: an empty wallet has no lists to read');
  assert.equal(log.filter((u) => u.includes('blockscout')).length, 0);
  addsUp(c);
});

test('a listed exchange deposit address: it ties this wallet to that exchange account (critical 0.92), at most three requests', async () => {
  const S1 = A(0xe1), S2 = A(0xe2);
  const log: string[] = [];
  const txs = [v2(S1, LISTED_DEPOSIT, 0.4, 1), v2(S2, LISTED_DEPOSIT, 1.2, 2), v2(LISTED_DEPOSIT, BINANCE, 1.59, 3)].reverse();
  const c = await beforeYouSend(session(), { chainId: 1, to: LISTED_DEPOSIT, amount: 0.83 }, { fetch: fakeFetch({ [LISTED_DEPOSIT]: { nonce: 3, txs } }, log) });
  assert.equal(c.destination.label?.kind, 'deposit');
  assert.equal(c.destination.label?.entity, 'Binance');
  const dep = c.changes.find((x) => x.ruleId === 'cex_exposure.deposit_address')!;
  assert.equal(dep.kind, 'new');
  assert.equal(dep.after.severity, 'critical');
  assert.equal(dep.after.confidence, 0.92);
  const shared = c.changes.find((x) => x.ruleId === 'linked_wallets.shared_deposit')!;
  assert.ok(shared, 'the other senders become linked wallets');
  assert.deepEqual(shared.links.map((l) => l.address).sort(), [S1, S2].sort());
  assert.ok(c.requests <= 3, `requests ${c.requests}`);
  addsUp(c);
});

test('your own wallet: it already sent to you twice, so this third transfer links the two both ways', async () => {
  const MINE = A(0xd1);
  const s = session([tx({ from: MINE, to: ME, amount: 0.21, timestamp: T0 + 90000 }), tx({ from: MINE, to: ME, amount: 0.13, timestamp: T0 + 95000 })]);
  const log: string[] = [];
  const c = await beforeYouSend(s, { chainId: 1, to: MINE, amount: 0.07 }, { fetch: fakeFetch({ [MINE]: { nonce: 9, balance: 10n ** 17n } }, log) });
  const bf = c.changes.find((x) => x.ruleId === 'linked_wallets.back_and_forth')!;
  assert.equal(bf.kind, 'new');
  assert.deepEqual(bf.links.map((l) => l.address), [MINE]);
  assert.equal(c.requests, 1, 'a wallet that pays you is no candidate for a deposit check');
  assert.ok(!c.changes.some((x) => x.ruleId.startsWith('funding_reuse.')), 'it also funded this wallet first: that funder check is not new, so nothing appears from it');
  addsUp(c);
});

test('an address you paid before but the scan did not check: its facts count before and after, so only the new transfer shows', async () => {
  // Six plain recipients: the live scan checks five; the sixth is a deposit address it never read.
  const S1 = A(0xe7);
  const DEP = A(0xe8);
  const sends = [...Array.from({ length: 5 }, (_, i) => tx({ to: A(0x60 + i), amount: 0.2 + i / 10, timestamp: T0 + 7200 * (i + 2) })), tx({ to: DEP, amount: 0.31, timestamp: T0 + 90000 })];
  const txs = [v2(S1, DEP, 0.4, 1), v2(DEP, BINANCE, 0.7, 2)].reverse();
  const c = await beforeYouSend(session(sends), { chainId: 1, to: DEP, amount: 0.29 }, { fetch: fakeFetch({ [DEP]: { nonce: 2, txs } }, []) });
  assert.ok(c.before.findings.some((f) => f.id === 'cex_exposure.deposit_address'), 'checking it shows the deposit you already made');
  assert.ok(c.before.score < c.scanScore, 'so the score now is lower than the scan said');
  assert.ok(!c.changes.some((x) => x.ruleId === 'cex_exposure.deposit_address' && x.kind === 'new'), 'and the deposit is not new');
  addsUp(c);
});

test('the same address: nothing new, no request', async () => {
  const c = await beforeYouSend(session(), { chainId: 1, to: ME, amount: 1 }, { fetch: fakeFetch({}, []) });
  assert.equal(c.delta, 0);
  assert.equal(c.changes.length, 0);
  assert.equal(c.requests, 0);
});

test('a contract (an app): no link to a person', async () => {
  const ROUTER = A(0xc1);
  const c = await beforeYouSend(session(), { chainId: 1, to: ROUTER, amount: 0.41 }, { fetch: fakeFetch({ [ROUTER]: { nonce: 1, code: '0x6080604052' } }, []) });
  assert.equal(c.destination.kind, 'contract');
  assert.ok(c.changes.every((x) => x.links.length === 0), 'no wallet link');
  addsUp(c);
});

test('an EIP-7702 wallet is a wallet, not a contract', async () => {
  const W = A(0xc2);
  const c = await beforeYouSend(session(), { chainId: 1, to: W, amount: 0.41 }, { fetch: fakeFetch({ [W]: { nonce: 4, code: '0xef0100' + 'ab'.repeat(20), txs: [] } }, []) });
  assert.equal(c.destination.kind, 'wallet');
});

test('a round amount just over the threshold: round_amounts is new; without an amount it stays as it was', async () => {
  // Seven plain sends, three round (0.1, 0.2, 1): below the 8-send minimum.
  const sends = [0.1, 0.2, 1, 0.137, 0.283, 0.0919, 0.371].map((a, i) => tx({ to: A(0x90 + i), amount: a, timestamp: T0 + 7200 * (i + 2) }));
  const D = A(0x9f);
  const dests = { [D]: { nonce: 2, balance: 1n, txs: [v2(A(0x77), D, 1, 1), v2(D, A(0x78), 0.5, 2)] } };
  const c = await beforeYouSend(session(sends), { chainId: 1, to: D, amount: 0.5 }, { fetch: fakeFetch(dests, []) });
  const r = c.changes.find((x) => x.ruleId === 'behavioral_fingerprint.round_amounts');
  assert.ok(r && r.kind === 'new', 'a round 0.5 makes it 4 of 8');
  addsUp(c);
  const none = await beforeYouSend(session(sends), { chainId: 1, to: D }, { fetch: fakeFetch(dests, []) });
  assert.ok(none.noAmount);
  assert.ok(!none.changes.some((x) => x.ruleId === 'behavioral_fingerprint.round_amounts'));
  const odd = await beforeYouSend(session(sends), { chainId: 1, to: D, amount: 0.4837 }, { fetch: fakeFetch(dests, []) });
  assert.ok(!odd.changes.some((x) => x.ruleId === 'behavioral_fingerprint.round_amounts'), 'a non-round amount adds no round finding');
  // A wallet that already sends round amounts (5 of 8): a non-round transfer leaves that finding as it is.
  const roundy = [0.1, 0.2, 1, 0.5, 2, 0.137, 0.283, 0.0919].map((a, i) => tx({ to: A(0xa0 + i), amount: a, timestamp: T0 + 7200 * (i + 2) }));
  const kept = await beforeYouSend(session(roundy), { chainId: 1, to: D, amount: 0.4837 }, { fetch: fakeFetch(dests, []) });
  const rb = kept.before.findings.find((f) => f.id === 'behavioral_fingerprint.round_amounts')!;
  const ra = kept.after.findings.find((f) => f.id === 'behavioral_fingerprint.round_amounts')!;
  assert.equal(rb.severity, 'medium');
  assert.deepEqual([ra.severity, ra.confidence], [rb.severity, rb.confidence], 'not diluted by a transfer that only exists as a plan');
});

test('when the destination cannot be read, it says so and never calls it clean', async () => {
  const D = A(0xb1);
  const c = await beforeYouSend(session(), { chainId: 1, to: D, amount: 0.37 }, { fetch: fakeFetch({ [D]: { nonce: 0, balance: 5n, status: 429 } }, []) });
  assert.equal(c.destination.kind, 'wallet');
  assert.equal(c.destination.read, false);
  assert.match(c.destination.unread ?? '', /could not be read|budget|rate limit/);
  assert.ok(!c.changes.some((x) => x.ruleId === 'linked_wallets.funded_by_you'), 'an unread history is never taken as empty');
});

test('timing rules stay as they were: Nymra does not know when you will send', async () => {
  // 30 signed sends between 08:00 and 20:00 UTC give a time zone finding.
  const day = 86400;
  const rows = Array.from({ length: 30 }, (_, i) => tx({ to: A(0x200 + (i % 3)), amount: 0.0123 + i / 1000, isCall: true, methodId: '0x12345678', timestamp: T0 - (T0 % day) + (i % 10) * day + (8 + (i % 12)) * 3600 }));
  const s = session(rows);
  const W = A(0xa9);
  const c = await beforeYouSend(s, { chainId: 1, to: W, amount: 0.0731 }, { fetch: fakeFetch({ [W]: { nonce: 0 } }, []) });
  const tz = (r: typeof c.before) => r.findings.find((f) => f.id === 'behavioral_fingerprint.timezone');
  assert.ok(tz(c.before), 'the wallet has a time zone finding');
  assert.deepEqual(tz(c.after)?.confidence, tz(c.before)?.confidence);
  assert.ok(!c.changes.some((x) => x.ruleId === 'behavioral_fingerprint.timezone'));
});

test('a look-alike of a wallet you paid: the check names the address it imitates, in full', async () => {
  const REAL = '0x983f20a7c0b1d2e3f4a5b6c7d8e9f0a1b2c34689';
  const FAKE = '0x983193aed1c2b3a4f5e6d7c8b9a0f1e2d3c44689'; // 0x983 ... 4689, the 2026-10-16 case
  const paid = [tx({ to: REAL, amount: 0.4, timestamp: T0 + 9000 }), tx({ to: REAL, amount: 0.5, timestamp: T0 + 9900 })];
  const c = await beforeYouSend(session(paid), { chainId: 1, to: FAKE, amount: 0.5 }, { fetch: fakeFetch({ [FAKE]: { nonce: 3 } }, []) });
  assert.equal(c.destination.imitates, REAL);
  const mine = await beforeYouSend(session(), { chainId: 1, to: ME.slice(0, 5) + 'abcdef'.repeat(5) + 'abc' + ME.slice(-4), amount: 0.1 }, { fetch: fakeFetch({ [ME.slice(0, 5) + 'abcdef'.repeat(5) + 'abc' + ME.slice(-4)]: { nonce: 1 } }, []) });
  assert.equal(mine.destination.imitates, ME, 'an imitation of your own address');
  const honest = await beforeYouSend(session(paid), { chainId: 1, to: REAL, amount: 0.5 }, { fetch: fakeFetch({ [REAL]: { nonce: 3 } }, []) });
  assert.equal(honest.destination.imitates, undefined, 'the real one is not a look-alike of itself');
});

test('a service is never a link: a listed service wallet, and a wallet with 2,000 or more sent transactions', async () => {
  const BUSY = A(0xb5);
  const c = await beforeYouSend(session(), { chainId: 1, to: BUSY, amount: 0.37 }, { fetch: fakeFetch({ [BUSY]: { nonce: 2600, balance: 10n ** 18n } }, []) });
  assert.equal(c.destination.kind, 'service');
  assert.deepEqual(c.destination.service, { kind: 'busy', sent: 2600 });
  assert.ok(!c.changes.some((x) => x.links.some((l) => l.address === BUSY)), 'no link to a busy wallet');
  const ex = await beforeYouSend(session(), { chainId: 1, to: BINANCE, amount: 0.37 }, { fetch: fakeFetch({ [BINANCE]: { nonce: 9_000_000, balance: 10n ** 20n } }, []) });
  assert.equal(ex.destination.kind, 'service');
  assert.deepEqual(ex.destination.service, { kind: 'exchange', entity: 'Binance' });
});

test('the first transaction on a chain you only received on: what pays for it becomes your funding there', async () => {
  // Base: Binance sent 1 ETH a week ago, and this wallet never signed anything on Base.
  const now = Math.floor(Date.now() / 1000);
  const got = tx({ chainId: 8453, from: BINANCE, to: ME, amount: 1, timestamp: now - 7 * 86400 });
  // Ethereum: funded by a person, then one contract call.
  const eth = [tx({ from: A(0x77), to: ME, amount: 1, timestamp: now - 90 * 86400 }), tx({ to: A(0x50), amount: 0, isCall: true, methodId: '0xa9059cbb', timestamp: now - 89 * 86400 })];
  const s = mkSession(ME, [hist(1, eth), hist(8453, [got])]);
  assert.equal(s.histories[1].firstFunding, undefined, 'before: coins that arrived where it never signed are no funding');
  const D = A(0xd8);
  const RPC_BASE = 'https://base-rpc.publicnode.com';
  const f = fakeFetch({ [D]: { nonce: 4, balance: 1n } }, []);
  const fetch = (async (input: string | URL, init?: RequestInit) => (String(input) === RPC_BASE ? f(RPC, init) : f(String(input).replace('base.blockscout.com', 'eth.blockscout.com'), init))) as typeof globalThis.fetch;
  const c = await beforeYouSend(s, { chainId: 8453, to: D, amount: 0.2 }, { fetch });
  const ch = c.changes.find((x) => x.ruleId === 'cex_exposure.funded_by_cex');
  assert.ok(ch && ch.kind === 'new', 'funded straight from an exchange on Base, from this transfer on');
  assert.ok(c.changes.some((x) => x.ruleId === 'cross_chain.multichain_presence'), 'Base becomes a chain you are active on');
});
