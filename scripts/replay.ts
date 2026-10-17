// Re-scores wallets on recorded explorer answers, so a fix is measured before and after on exactly
// the same data and costs no explorer quota. Reads a recorded answer cache (read only):
// one file per request, keyed sha1("<METHOD> <url> <body>"), recorded in a real Chrome.
//
//   node scripts/replay.ts [--engine <dir>] [--tag <name>] [--live] label=0xaddress ...
//
// --engine  another copy of this package (e.g. `git archive <sha>` in /tmp): the "before".
// --live    a request that is not recorded goes to the network and is kept in .lab/cache. Without it
//           the request answers 400, and the coverage of that chain shows the gap.
// FAIL=<host,host>  those hosts answer a bot check (403 HTML), as when an explorer refuses.
// Results: .lab/replay/<label>.<tag>.json (gitignored), plus a summary on stdout.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = resolve(import.meta.dirname, '..');
// Recordings in .lab/recorded by default; NYMRA_LAB_CACHE points anywhere else.
const RECORDED = process.env.NYMRA_LAB_CACHE ?? join(ROOT, '.lab/recorded');
const OWN = join(ROOT, '.lab/cache');
const OUT = join(ROOT, '.lab/replay');
mkdirSync(OWN, { recursive: true });
mkdirSync(OUT, { recursive: true });

const args = process.argv.slice(2);
const opt = (name: string) => { const i = args.indexOf(name); if (i < 0) return undefined; const v = args[i + 1]; args.splice(i, 2); return v; };
const flag = (name: string) => { const i = args.indexOf(name); if (i < 0) return false; args.splice(i, 1); return true; };
const engineDir = resolve(opt('--engine') ?? ROOT);
const live = flag('--live');
const tag = opt('--tag') ?? (engineDir === ROOT ? 'after' : 'before');
const chainIds = process.env.CHAINS ? process.env.CHAINS.split(',').map(Number) : undefined;
const failHosts = new Set((process.env.FAIL ?? '').split(',').filter(Boolean));

const { scan } = await import(pathToFileURL(join(engineDir, 'src/scan.ts')).href);

const keyOf = (method: string, url: string, body: string | null) => createHash('sha1').update(`${method} ${url} ${body ?? ''}`).digest('hex');

function makeFetch(stats: { replayed: number; missing: number; live: number; missed: string[] }): typeof fetch {
  return async (input: any, init?: RequestInit) => {
    // A browser normalizes the URL before it is recorded (`https://host` becomes `https://host/`).
    const url = new URL(typeof input === 'string' ? input : input.url).href;
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = typeof init?.body === 'string' ? init.body : null;
    const k = keyOf(method, url, body);
    if (failHosts.has(new URL(url).host)) return new Response('<html><title>Just a moment...</title></html>', { status: 403, headers: { 'content-type': 'text/html' } });
    for (const dir of [RECORDED, OWN]) {
      const f = join(dir, `${k}.json`);
      if (!existsSync(f)) continue;
      const c = JSON.parse(readFileSync(f, 'utf8'));
      stats.replayed++;
      return new Response(c.body, { status: c.status, headers: { 'content-type': 'application/json', ...c.headers } });
    }
    if (live) {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(20000) });
      const text = await res.text();
      const headers = Object.fromEntries([...res.headers.entries()].filter(([h]) => h.startsWith('x-ratelimit') || h === 'retry-after'));
      writeFileSync(join(OWN, `${k}.json`), JSON.stringify({ url, method, status: res.status, headers, body: text }));
      stats.live++;
      return new Response(text, { status: res.status, headers: { 'content-type': res.headers.get('content-type') ?? 'application/json', ...headers } });
    }
    stats.missing++;
    stats.missed.push(`${method} ${new URL(url).host}${new URL(url).pathname.replace(/0x[0-9a-f]{40}/gi, '<a>')}`);
    return new Response('{"error":"not recorded"}', { status: 400, headers: { 'content-type': 'application/json' } });
  };
}

const short = (a: string) => `${a.slice(0, 6)}...${a.slice(-4)}`;
for (const t of args) {
  const [label, address] = t.includes('=') ? t.split('=') : [t, t];
  const stats = { replayed: 0, missing: 0, live: 0, missed: [] as string[] };
  const r = await scan(address, { fetch: makeFetch(stats), cache: false, chainIds, timeLimitMs: 600_000 });
  writeFileSync(join(OUT, `${label}.${tag}.json`), JSON.stringify({ label, address, tag, engine: engineDir, stats, result: r }, null, 2));
  const act = r.coverage.filter((c: any) => c.status !== 'no_activity' && c.status !== 'skipped');
  console.log(`\n=== ${label} ${short(address)} [${tag}] score ${r.score} ${r.band} status ${r.status} replayed=${stats.replayed} missing=${stats.missing} live=${stats.live}`);
  console.log(`  coverage: ${act.map((c: any) => `${c.name}:${c.status}`).join(', ')}`);
  for (const f of r.findings) console.log(`  ${String(f.scoreImpact).padStart(4)} ${f.severity.padEnd(8)} ${f.confidence.toFixed(2)} ${f.id}: ${f.title}`);
  for (const l of r.linkedWallets) console.log(`  LINK ${l.address} ${l.confidence.toFixed(2)} ${l.level ?? ''} [${l.reasons.join('; ')}] chains=${l.chainIds.join(',')}`);
  for (const w of r.warnings ?? []) console.log(`  WARN ${w.id}: ${w.title}`);
  for (const i of r.incomplete ?? []) console.log(`  INCOMPLETE ${i.reason}`);
  if (stats.missed.length) console.log(`  missed: ${[...new Set(stats.missed)].slice(0, 12).join(' | ')}`);
}
