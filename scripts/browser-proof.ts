// Runs scan() inside a real (headless) Chrome, the way the website will, and prints timings.
// Usage: node scripts/browser-proof.ts <out.json> [--repeat N] [--reload] [--opts '{"chainIds":[1]}'] <address> [address ...]
//   --repeat N  scan every address N times in a row
//   --reload    a fresh page before every scan: no session cache, no remembered rate-limit windows
//               (what a user gets who reloads the site and scans again)
// Needs Google Chrome and bun (for the browser bundle). Dev tool only.
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const out = argv.shift()!;
let repeat = 1, reload = false, opts: Record<string, unknown> = {};
const addresses: string[] = [];
while (argv.length) {
  const a = argv.shift()!;
  if (a === '--repeat') repeat = Number(argv.shift());
  else if (a === '--reload') reload = true;
  else if (a === '--opts') opts = JSON.parse(argv.shift()!);
  else addresses.push(a);
}
const dir = mkdtempSync(join(tmpdir(), 'nymra-proof-'));
const root = new URL('..', import.meta.url).pathname;
execFileSync('bun', ['build', join(root, 'src/index.ts'), '--target=browser', '--format=esm', `--outfile=${join(dir, 'scan.js')}`], { stdio: 'inherit' });
const page = `<!doctype html><meta charset=utf-8><script type=module>
import { scan } from './scan.js';
window.runScan = async (address, opts) => {
  const t0 = performance.now(); let firstPartial = null; const chains = [];
  const r = await scan(address, { ...opts, onProgress: (e) => {
    if (e.type === 'partial' && firstPartial === null) firstPartial = Math.round(performance.now() - t0);
    if (e.type === 'chain') chains.push([e.coverage.name, Math.round(performance.now() - t0)]);
  } });
  return { firstPartialMs: firstPartial, totalMs: Math.round(performance.now() - t0), chainDoneMs: chains, result: r };
};
window.ready = true;
</script>`;
const server = createServer((req, res) => {
  const f = req.url === '/scan.js' ? readFileSync(join(dir, 'scan.js')) : page;
  res.writeHead(200, { 'content-type': req.url === '/scan.js' ? 'text/javascript' : 'text/html' });
  res.end(f);
}).listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const port = (server.address() as any).port;

const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new', '--disable-gpu', `--user-data-dir=${join(dir, 'prof')}`, '--remote-debugging-port=0',
  '--user-agent=Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  `http://127.0.0.1:${port}/`,
], { stdio: ['ignore', 'ignore', 'pipe'] });
const wsUrl: string = await new Promise((resolve) => {
  chrome.stderr!.on('data', (d) => { const m = String(d).match(/ws:\/\/\S+/); if (m) resolve(m[0]); });
});
const targets = await (await fetch(`http://${new URL(wsUrl).host}/json`)).json();
const ws = new WebSocket(targets.find((t: any) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0;
const pending = new Map<number, (v: any) => void>();
ws.addEventListener('message', (m) => { const j = JSON.parse(String(m.data)); pending.get(j.id)?.(j); });
const call = (method: string, params: any) => new Promise<any>((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async (expr: string) => (await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result;

while (!(await evaluate('window.ready === true')).result.value) await new Promise((r) => setTimeout(r, 200));
const results: any[] = [];
let run = 0;
for (const a of addresses) for (let k = 0; k < repeat; k++) {
  if (reload && run++ > 0) {
    await call('Page.reload', { ignoreCache: true });
    await new Promise((r) => setTimeout(r, 300));
    while (!(await evaluate('window.ready === true')).result?.value) await new Promise((r) => setTimeout(r, 200));
  }
  const started = new Date().toISOString();
  const r = await evaluate(`runScan(${JSON.stringify(a)}, ${JSON.stringify(opts)})`);
  const v = r.result?.value ?? { error: r.exceptionDetails?.exception?.description ?? 'failed' };
  results.push({ address: a, run: k + 1, started, ...v });
  writeFileSync(out, JSON.stringify(results, null, 2));
  const s = v.result;
  console.log(s
    ? `${a.slice(0, 10)} #${k + 1} score ${s.score} ${s.band} ${s.status} first ${v.firstPartialMs} ms total ${v.totalMs} ms, ${s.findings.length} findings, req ${s.stats?.requests} cached ${s.stats?.cached} waited ${s.stats?.waitedMs} ms, incomplete: ${s.incomplete.map((g: any) => g.reason).join(' | ') || 'none'}`
    : `${a} ERROR ${v.error}`);
}
writeFileSync(out, JSON.stringify(results, null, 2));
ws.close(); chrome.kill(); server.close();
