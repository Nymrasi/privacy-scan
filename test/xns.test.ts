// XNS (xns.name, 1.5.0): one registry on Ethereum gives an address at most one name, `label@namespace`
// (vitalik@eth), for good. The identity read asks getName(address) next to the ENS reads; the name is a
// medium finding like a primary ENS name and never the named-wallet ceiling; the relay lets that one call
// through and no other call to the registry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publicIdentity } from '../src/detectors/public-identity.ts';
import { fetchProfile, isXnsName, XNS_REGISTRY, xnsName } from '../src/sources/identity.ts';
import { createHttp } from '../src/sources/http.ts';
import { rpcProblem } from '../proxy/proxy.ts';
import { scoreFindings } from '../src/score.ts';
import { adviceFor } from '../src/features/fix-plan.ts';
import { ctx, ME } from './helpers.ts';

/** An ABI string return, as the registry answers getName. */
function abiString(s: string): string {
  const hex = Buffer.from(s, 'utf8').toString('hex');
  return '0x' + (32).toString(16).padStart(64, '0') + (hex.length / 2).toString(16).padStart(64, '0') + hex.padEnd(Math.ceil(hex.length / 64) * 64 || 64, '0');
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A fetch that answers the XNS call with `answer` and everything else of the identity read as empty. */
function identityFetch(answer: (body: any) => Response, seen: any[] = []) {
  return (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === 'POST' && url.includes('ethereum-rpc')) {
      const body = JSON.parse(String(init.body));
      seen.push(body);
      return answer(body);
    }
    if (url.includes('addresses:lookup')) return json({ items: [] });
    if (url.includes('bens.services.blockscout.com')) return json({ message: 'not found' }, 404);
    if (/\/api\/v2\/addresses\/0x[0-9a-f]{40}$/.test(url)) return json({ is_contract: false, ens_domain_name: null, public_tags: [], metadata: null });
    throw new Error('unexpected url: ' + url);
  }) as typeof fetch;
}

test('isXnsName: label@namespace in XNS\'s own format, anything else is no name', () => {
  for (const ok of ['vitalik@eth', 'alice@xns', 'a@b', '2-rich@4-real', 'gm@wen-lambo', 'x'.repeat(20) + '@xns']) assert.ok(isXnsName(ok), ok);
  for (const bad of ['', 'vitalik', 'vitalik.eth', '@vitalik@eth', 'a@b@c', 'Name@xns', 'x'.repeat(21) + '@xns', '-name@gm', 'name-@og', 'my--name@888', 'gm$web3@xyz', 'bob@', '@xns', 'someone_x'])
    assert.ok(!isXnsName(bad), bad);
});

test('xnsName: one getName(address) call to the registry, in a batch of one; empty and odd answers are no name', async () => {
  const seen: any[] = [];
  const http = createHttp({ fetch: identityFetch((b) => json([{ id: b[0].id, result: abiString('vitalik@eth') }]), seen), cache: null });
  assert.equal(await xnsName(http, ME), 'vitalik@eth');
  assert.equal(seen.length, 1);
  assert.ok(Array.isArray(seen[0]) && seen[0].length === 1);
  assert.equal(seen[0][0].method, 'eth_call');
  assert.equal(seen[0][0].params[0].to, XNS_REGISTRY);
  assert.equal(seen[0][0].params[0].data, '0x5fd4b08a' + ME.slice(2).padStart(64, '0'));
  assert.equal(rpcProblem(JSON.stringify(seen[0])), null, 'the relay lets this exact call through');
  const answers: [string, string][] = [['0x', ''], [abiString(''), ''], [abiString('someone_x'), ''], [abiString('Vitalik@ETH'), 'vitalik@eth']];
  for (const [result, want] of answers) {
    const h = createHttp({ fetch: identityFetch((b) => json([{ id: b[0].id, result }])), cache: null });
    assert.equal(await xnsName(h, ME), want, result);
  }
  const err = createHttp({ fetch: identityFetch((b) => json([{ id: b[0].id, error: { code: -32000, message: 'execution reverted' } }])), cache: null });
  await assert.rejects(xnsName(err, ME), /execution reverted/);
});

test('fetchProfile: the XNS name lands in the profile; a failed read is a names gap, never a silent miss', async () => {
  const good = await fetchProfile(createHttp({ fetch: identityFetch((b) => json([{ id: b[0].id, result: abiString('vitalik@eth') }])), cache: null }), ME);
  assert.equal(good.profile.xns, 'vitalik@eth');
  assert.deepEqual(good.errors, []);
  const none = await fetchProfile(createHttp({ fetch: identityFetch((b) => json([{ id: b[0].id, result: abiString('') }])), cache: null }), ME);
  assert.equal(none.profile.xns, undefined);
  assert.deepEqual(none.errors, []);
  const down = await fetchProfile(createHttp({ fetch: identityFetch(() => json({ message: 'down' }, 500)), cache: null }), ME);
  assert.equal(down.profile.xns, undefined);
  assert.deepEqual(down.errors.map((e) => [e.part, e.name]), [['names', 'XNS name']]);
  assert.match(down.errors[0].reason, /^The XNS name of this address could not be read/);
});

test('public_identity: an XNS name is medium at confidence 1, says it stays, and is no ceiling', async () => {
  const fs = await publicIdentity.run(ctx([], { profile: { xns: 'vitalik@eth' } }));
  assert.deepEqual(fs.map((f) => f.id), ['public_identity.xns_name']);
  const f = fs[0];
  assert.equal(f.severity, 'medium');
  assert.equal(f.confidence, 1);
  assert.equal(f.title, 'Your wallet has an XNS name');
  assert.match(f.explanation, /XNS name vitalik@eth/);
  assert.match(f.explanation, /stays with its address for good/);
  assert.doesNotMatch(f.explanation, /[—·]/);
  assert.deepEqual(f.evidence, [{ kind: 'xns', text: 'XNS name: vitalik@eth', value: 'vitalik@eth', chainId: 1 }]);
  assert.deepEqual(f.chains, [1]);
  const s = scoreFindings(fs);
  assert.equal(s.score, 92, 'medium at confidence 1 costs 8');
  assert.equal(s.breakdown.ceiling, undefined, 'a name anyone can make up never sets the ceiling');
  // A contract or a service is spoken of in the third person.
  const it = await publicIdentity.run({ ...ctx([], { profile: { xns: 'xns@xns', isContract: true } }), thirdPerson: true });
  assert.equal(it.find((x) => x.id === 'public_identity.xns_name')!.title, 'This address has an XNS name');
  assert.match(it.find((x) => x.id === 'public_identity.xns_name')!.explanation, /finds this address/);
  // Both names: two findings, each its own.
  const both = await publicIdentity.run(ctx([], { profile: { ens: 'vitalik.eth', xns: 'vitalik@eth' } }));
  assert.deepEqual(both.map((x) => x.id), ['public_identity.ens_reverse', 'public_identity.xns_name']);
  assert.equal(adviceFor('public_identity.xns_name')?.kind, 'permanent', 'an XNS name cannot be removed, so the advice never says it can');
});

test('the relay: getName only on the registry, the right length; nothing else goes to the registry', () => {
  const call = (to: string, data: string) => JSON.stringify([{ jsonrpc: '2.0', id: 0, method: 'eth_call', params: [{ to, data }, 'latest'] }]);
  const arg = ME.slice(2).padStart(64, '0');
  assert.equal(rpcProblem(call(XNS_REGISTRY, '0x5fd4b08a' + arg)), null);
  assert.equal(rpcProblem(call(XNS_REGISTRY.toUpperCase().replace('0X', '0x'), '0x5fd4b08a' + arg)), null, 'the address in any case');
  assert.equal(rpcProblem(call('0x' + 'cd'.repeat(20), '0x5fd4b08a' + arg)), 'call not allowed', 'getName on another contract');
  assert.equal(rpcProblem(call(XNS_REGISTRY, '0xbf40fac1' + arg)), 'call not allowed', 'another call on the registry');
  assert.equal(rpcProblem(call(XNS_REGISTRY, '0x5fd4b08a' + arg + '00')), 'call not allowed', 'a longer body');
});
