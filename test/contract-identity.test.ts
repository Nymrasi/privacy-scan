// One address can be a different thing on each chain. 0x0bd7...ad73 is WETH on Robinhood Chain
// and a wallet flagged as phishing on Ethereum; 0x4985...2b2b is Uniswap V4's Pool Manager on Base and an
// ordinary address on Ethereum. A contract is named after the chain that holds its code, every label says
// the chain it came from, and the code's chain is the one that holds it, never Ethereum by default.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contractOf, withSelf } from '../src/scan.ts';
import { publicIdentity } from '../src/detectors/public-identity.ts';
import type { Profile } from '../src/detectors/context.ts';
import { ctx, hist } from './helpers.ts';

const ETH = 1, BASE = 8453, RH = 4663;
const self = (...names: string[]) => ({ self: { names, slugs: [] } });

// WETH: Ethereum's rows name the address (no code there), Robinhood Chain's rows name it and hold its code.
const wethProfile = (): Profile => withSelf(
  { isContract: false, ensRecords: {}, ownedNames: [], tags: [] },
  [hist(ETH, [], { code: false, ...self('Fake_Phishing7031016') }), hist(RH, [], { code: true, ...self('WETH') })],
);

test('a contract is named after the chain that holds its code, never after a label of another chain', () => {
  const p = wethProfile();
  assert.equal(p.isContract, true);
  assert.deepEqual(p.codeChains, [RH]);
  assert.deepEqual(p.tagChains, { Fake_Phishing7031016: [ETH], WETH: [RH] });
  assert.deepEqual(contractOf(p), { chains: [RH], name: 'WETH' });
  // The address page is Ethereum's: its tag and its contract name only name code that lives there.
  const usdc = withSelf({ isContract: true, codeChains: [ETH], ensRecords: {}, ownedNames: [], tags: ['Circle: USDC Token'], tagChains: { 'Circle: USDC Token': [ETH] }, contractName: 'FiatTokenProxy' }, [hist(ETH, [], { code: true })]);
  assert.deepEqual(contractOf(usdc), { chains: [ETH], name: 'Circle: USDC Token' });
  const nameless = withSelf({ isContract: false, ensRecords: {}, ownedNames: [], tags: [], contractName: 'PoolManager' }, [hist(ETH, [], { code: false }), hist(BASE, [], { code: true })]);
  assert.deepEqual(contractOf(nameless), { chains: [BASE] }, "Ethereum's contract name never names code on Base");
});

test('every public label says the chain it came from, and the code says where it is', async () => {
  const out = await publicIdentity.run(ctx([], { profile: wethProfile() }));
  const label = out.find((f) => f.id === 'public_identity.public_label')!;
  assert.deepEqual(label.evidence.map((e) => [e.text, e.label]), [['Fake_Phishing7031016 on Ethereum', 'Fake_Phishing7031016'], ['WETH on Robinhood Chain', 'WETH']]);
  assert.deepEqual([...label.chains].sort(), [ETH, RH].sort());
  assert.match(label.explanation, /Fake_Phishing7031016 on Ethereum, WETH on Robinhood Chain/);
  const code = out.find((f) => f.id === 'public_identity.is_contract')!;
  assert.deepEqual(code.chains, [RH]);
  assert.equal(code.evidence[0].chainId, RH);
  assert.match(code.evidence[0].text, /code on Robinhood Chain/);
  assert.doesNotMatch(code.evidence[0].text, /Ethereum/);
});

test('a wallet whose labels all come from Ethereum keeps Ethereum', async () => {
  const p = withSelf({ isContract: false, ensRecords: {}, ownedNames: [], tags: [] }, [hist(ETH, [], { code: false, ...self('Vitalik Buterin') })]);
  const label = (await publicIdentity.run(ctx([], { profile: p }))).find((f) => f.id === 'public_identity.public_label')!;
  assert.deepEqual(label.chains, [ETH]);
  assert.deepEqual(label.evidence.map((e) => e.text), ['Vitalik Buterin on Ethereum']);
  // A label seen on several chains names them all, as a list a person would write.
  const many = withSelf({ isContract: false, ensRecords: {}, ownedNames: [], tags: [] }, [1, 8453, 42161].map((id) => hist(id, [], { code: false, ...self('smart.jesse.xyz') })));
  const row = (await publicIdentity.run(ctx([], { profile: many }))).find((f) => f.id === 'public_identity.public_label')!.evidence[0].text;
  assert.equal(row, 'smart.jesse.xyz on Ethereum, Base and Arbitrum One');
  assert.equal(p.isContract, false);
  assert.equal(p.codeChains, undefined);
});
