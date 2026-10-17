// CLI: node scripts/scan.ts <address> [chainId,chainId,...]
// Prints progress timing and the result summary; --json prints the full result.
import { scan } from '../src/index.ts';

const [addr, chains] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const json = process.argv.includes('--json');
const t0 = Date.now();
let first = 0;
const r = await scan(addr, {
  chainIds: chains ? chains.split(',').map(Number) : undefined,
  onProgress: (e) => {
    const t = ((Date.now() - t0) / 1000).toFixed(1);
    if (e.type === 'partial' && !first) first = Date.now() - t0;
    if (!json && e.type === 'chain') console.error(`${t}s chain ${e.coverage.name}: ${e.coverage.status} tx=${e.coverage.txCount} tok=${e.coverage.tokenTransferCount}${e.coverage.error ? ' ' + e.coverage.error : ''}`);
  },
});
if (json) { console.log(JSON.stringify(r, null, 2)); process.exit(0); }
console.log(`\n${r.address} score ${r.score} (${r.band}) status ${r.status} first partial ${(first / 1000).toFixed(1)}s total ${(r.durationMs / 1000).toFixed(1)}s ens=${r.identity.ens ?? 'n/a'} type=${r.addressType}`);
for (const f of r.findings) console.log(`${String(f.scoreImpact).padStart(4)} ${f.severity.padEnd(8)} c=${f.confidence} ${f.id}: ${f.title}\n       ${f.explanation}`);
console.log('linked:', r.linkedWallets.slice(0, 5).map((l) => `${l.address} ${l.confidence} [${l.reasons.join('; ')}]`).join('\n        '));
