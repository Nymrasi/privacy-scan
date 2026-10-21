// addrKey: the key of an address in the bundled label sets, remembered per address.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addrKey, cyrb53, KEYS, KEYS_MAX } from '../src/hash.ts';
import { cexLabel, serviceIdentity } from '../src/labels.ts';

const worked = (a: string) => cyrb53(a.toLowerCase()).toString(36).padStart(11, '0');
const A = '0x28C6c06298d514Db089934071355E5743bf21d60';

test('addrKey: the same key as working it out, in any case, first time and after', () => {
  KEYS.clear();
  for (const a of [A, A.toLowerCase(), A.toUpperCase().replace('0X', '0x'), '0x0000000000000000000000000000000000000001']) {
    assert.equal(addrKey(a), worked(a), `first ${a}`);
    assert.equal(addrKey(a), worked(a), `again ${a}`);
  }
  assert.equal(addrKey(A), addrKey(A.toLowerCase()));
  assert.equal(addrKey(A).length, 11);
});

test('addrKey: remembers an address and answers from what it remembered', () => {
  KEYS.clear();
  const k = addrKey(A);
  assert.equal(KEYS.get(A), k, 'remembered');
  KEYS.set(A, 'remembered!');
  assert.equal(addrKey(A), 'remembered!', 'a second ask is not worked out again');
  KEYS.clear();
  assert.equal(addrKey(A), k);
});

test('addrKey: starts over past KEYS_MAX addresses', () => {
  KEYS.clear();
  for (let i = 0; i < KEYS_MAX; i++) addrKey('0x' + i.toString(16).padStart(40, '0'));
  assert.equal(KEYS.size, KEYS_MAX);
  addrKey(A);
  assert.equal(KEYS.size, 1, 'cleared before the next one');
  assert.equal(KEYS.get(A), worked(A));
  KEYS.clear();
});

test('addrKey: the label lists answer the same with a full and an empty memory', () => {
  // Binance 14 (an exchange hot wallet in cex.json) and a wallet on no list.
  const plain = '0x1111111111111111111111111111111111111111';
  KEYS.clear();
  const cold = [cexLabel(A), serviceIdentity(A), cexLabel(plain), serviceIdentity(plain)];
  const warm = [cexLabel(A), serviceIdentity(A), cexLabel(plain), serviceIdentity(plain)];
  assert.deepEqual(warm, cold);
  assert.equal(cold[0]?.kind, 'hot');
  assert.equal(cold[2], undefined);
});
