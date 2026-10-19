// No text the scan or the relay can show calls a source, a key or a quota "free", and none says the relay's key is
// "not set up yet": Nymra's words never call a part of it unfinished. Reads every string of the engine's source and
// of the relay, comments left out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
// Comments out: block comments, and line comments that start a line or follow a space (a URL's "//" stays).
const code = (f: string) => readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1');
const SAID = /\bfree\s+(?:[a-z-]+\s+){0,2}(?:explorers?|quota|keys?|API|plan|tier|sources?)\b|not set up yet|\bno key for [^'"`\n]*\byet\b/gi;

test('no text of the scan or the relay calls a source, key or quota "free", or says a key is not set up yet', () => {
  const files = [...walk('src'), 'proxy/proxy.ts'].filter((f) => /\.(ts|json)$/.test(f));
  assert.ok(files.length > 20, `read ${files.length} files`);
  const bad = files.flatMap((f) => [...code(f).matchAll(SAID)].map((m) => `${f}: ${m[0]}`));
  assert.deepEqual(bad, []);
});

test('the words test reads what it guards: the relay quota answer and the scan\'s key reason are in the files it reads', () => {
  assert.match(code('proxy/proxy.ts'), /The relay has spent its daily quota\./);
  assert.match(code('src/history.ts'), /which has no key for it\./);
});
