// Streams a fixture as if it were a live scan. For UI work before (or without) the network.
import bad from '../fixtures/bad.json' with { type: 'json' };
import average from '../fixtures/average.json' with { type: 'json' };
import good from '../fixtures/good.json' with { type: 'json' };
import workedExample from '../fixtures/worked-example.json' with { type: 'json' };
import type { ScanOptions, ScanResult } from './types.ts';

/** Mock results for UI work. `worked-example` is real detector output on a synthetic history (RULES.md, Worked example). */
export const FIXTURES = { bad, average, good, 'worked-example': workedExample } as unknown as Record<'bad' | 'average' | 'good' | 'worked-example', ScanResult>;

export async function mockScan(
  address: string,
  opts: ScanOptions & { fixture?: keyof typeof FIXTURES; stepMs?: number } = {},
): Promise<ScanResult> {
  const full = structuredClone(FIXTURES[opts.fixture ?? 'average']);
  full.address = address.toLowerCase();
  const step = opts.stepMs ?? 300;
  const wait = () => new Promise((r) => setTimeout(r, step));
  const emit = opts.onProgress ?? (() => {});
  emit({ type: 'start', address: full.address, chainIds: full.coverage.map((c) => c.chainId) });
  // As in a real scan: the quick check answers for the empty chains at once, the others take a while.
  for (const c of full.coverage) if (c.status === 'no_activity') emit({ type: 'chain', coverage: c });
  for (const c of full.coverage) {
    if (c.status === 'no_activity') continue;
    await wait();
    emit({ type: 'chain', coverage: c });
  }
  for (const f of full.findings) {
    await wait();
    emit({ type: 'finding', finding: f });
  }
  emit({ type: 'done', result: full });
  return full;
}
