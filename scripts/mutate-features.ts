// Mutation check for the features: break one rule at a time and prove a feature test
// fails. Run: node scripts/mutate-features.ts   (ONLY=<text> runs the mutants whose description has it)
// Same harness as scripts/mutate.ts: a temporary copy of src/ and test/, every anchor a literal string
// that must occur exactly once (a missing or ambiguous anchor is BAD: a mutant that never ran is never
// counted as killed). Runs the feature tests and the session tests only.
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type Mutant = { file: string; find: string; put: string; what: string };
const M = (file: string, find: string, put: string, what: string): Mutant => ({ file, find, put, what });

const MUTANTS: Mutant[] = [
  // The kernel: the session record and the replay flag
  M('src/scan.ts', 'keepSession(result, { me, histories: ctx.histories,', '((..._: unknown[]) => {})(result, { me, histories: ctx.histories,', 'the final result keeps no session'),
  M('src/detectors/funding-reuse.ts', '(!ctx.replay && looked >= MAX_LOOKUPS)', '(looked >= MAX_LOOKUPS)', 'a replay keeps the live cap of four funder lookups'),
  M('src/detectors/deposits.ts', '.slice(0, ctx.replay ? undefined : Math.max(0, MAX_CANDIDATES - labelled.length));', '.slice(0, Math.max(0, MAX_CANDIDATES - labelled.length));', 'a replay keeps the live cap of five recipients'),
  M('src/features/replay.ts', 'for (const [k, n] of known) cache.set(k, Promise.resolve(n));', '', "a feature's own nonce read is ignored"),
  M('src/features/replay.ts', "s.incomplete.length ? 'partial' : 'complete', {}, s.incomplete,", "'complete', {}, [],", 'a replay of a partial scan reads as complete'),
  M('src/features/replay.ts', 'const warning = poisoningWarning(ctx, rec);', 'const warning = null;', 'a replay drops the address-poisoning warning'),
  M('src/features/replay.ts', 'let findings = await runDetectors(DETECTOR_LIST, ctx, coverage);', 'let findings = await runDetectors(DETECTOR_LIST, ctx, []);', 'a bot or a service replays as a person'),
  // Fix plan
  M('src/features/fix-plan.ts', 'if (clearsName) gone.add(ENS_RECORDS);', '', 'clearing the primary name keeps its records'),
  M('src/features/fix-plan.ts', "(clearsName && f.id === OWNED_NAMES && f.severity === 'low' ? { ...f, severity: 'medium' as Severity } : f)", '(f)', 'an owned name costs no more without a primary name'),
  M('src/features/fix-plan.ts', "if (!item.gain && fs.some((f) => f.rawImpact < 0)) item.heldBy = result.breakdown.ceiling !== undefined ? 'ceiling' : 'cap';", '', 'a today-step with no points does not say why'),
  M('src/features/fix-plan.ts', 'item.gain = Math.max(0, whatIf(result.findings, [id]) - result.score);', 'item.gain = 0;', 'no today-step wins anything'),
  M('src/features/advice.json', '"cross_chain.received_only": {', '"cross_chain.received_only_x": {', 'a rule without advice'),
  // Before you send
  M('src/features/before-you-send.ts', 'const nonces = replayNonces(s, facts.nonce !== undefined ? [[`${chain.id}:${to}`, facts.nonce]] : []);', 'const nonces = replayNonces(s, []);', "the destination's own count does not reach the rules"),
  M('src/features/before-you-send.ts', ": service ? 'service'", ": false ? 'service'", 'a service destination reads as a wallet'),
  M('src/features/before-you-send.ts', 'facts.nonce >= SERVICE_NONCE ?', 'facts.nonce >= SERVICE_NONCE * 10 ?', 'a busy destination is not a service'),
  M('src/features/before-you-send.ts', 'if (lookalike(to, s.me)) return s.me;', '', 'an imitation of your own address passes'),
  M('src/features/before-you-send.ts', 'firstOwn, firstFunding: h.firstOwn ? h.firstFunding : fundingOf(signed, [...h.txs, ...h.internal]),', 'firstOwn, firstFunding: h.firstFunding,', 'a first send on a chain makes no funding'),
  M('src/features/before-you-send.ts', 'ownCount: h.ownCount + 1,', 'ownCount: h.ownCount,', 'the planned send is not your own transaction'),
  M('src/features/before-you-send.ts', 'const keep = new Set([...TIMING_RULES, ...(roundPlanned ? [] : [ROUND_RULE])]);', 'const keep = new Set([...(roundPlanned ? [] : [ROUND_RULE])]);', 'the timing rules move with a send time Nymra cannot know'),
  M('src/features/before-you-send.ts', "nonces: replayNonces(s, [[`${chain.id}:${to}`, 1]]),", 'nonces,', 'a fresh destination never shows what its first own transaction does'),
  // Compare
  M('src/features/compare.ts', 'if (look || na || nb) return { ...shell, confidence: 0, level: null, reasons: [] };', '', 'a look-alike or a service is weighed as a link'),
  M('src/features/compare.ts', 'if ((h.nonce ?? 0) >= SERVICE_NONCE) busy.push(', 'if ((h.nonce ?? 0) >= SERVICE_NONCE * 10) busy.push(', 'a busy chain links them'),
  M('src/features/compare.ts', 'if (serviceOf(fa.from, fa.cp) || serviceOf(fb.from, fb.cp) || busyOther(fa.from, [ha.chain.id])) continue;', '', 'a service or busy funder is a shared funder'),
  M('src/features/compare.ts', 'if (k > 40) continue;', '', 'a distributor is a shared funder'),
  M('src/features/compare.ts', 'if (rows && rows.length >= 200) continue;', '', 'a funder with 200 sends around the funding is a shared funder'),
  M('src/features/compare.ts', "const senderSigned = (t: Transfer) => t.kind !== 'token' || signedOn(t.from === a ? sa : sb, t.chainId) !== false;", 'const senderSigned = (_t: Transfer) => true;', 'a forged token event counts'),
  M('src/features/compare.ts', "const senderSigned = (t: Transfer) => t.kind !== 'token' ||", 'const senderSigned = (t: Transfer) =>', 'a signed transaction needs the sender scan to show it'),
  M('src/features/compare.ts', 'gaps: { a: [...sa.incomplete], b: [...sb.incomplete] },', 'gaps: { a: [], b: [] },', 'the gaps of both scans are dropped'),
  M('src/features/compare.ts', 'const conf = gap <= 3 * DAY ? Math.max(sharedFunderLink(k), scanConf(', 'const conf = gap <= 30 * DAY ? Math.max(sharedFunderLink(k), scanConf(', 'a funder weeks apart is as strong as days apart'),
  M('src/features/compare.ts', 'Math.min(0.95, r2(1 - reasons.reduce((p, x) => p * (1 - x.confidence), 1)))', 'Math.min(0.95, Math.max(...reasons.map((x) => x.confidence)))', 'two reasons do not combine'),
  // Link Graph
  M('src/features/link-graph.ts', 'const cap = (x: number) => Math.min(MAX_CONFIDENCE, r2(x));', 'const cap = (x: number) => r2(x);', 'a link or a path can be certain'),
  M('src/features/link-graph.ts', 'const q = from.p * l.confidence;', 'const q = l.confidence;', 'a path is as likely as its last link'),
  M('src/features/link-graph.ts', 'if (np && a !== start) away.set(a, np);', '', 'a service or a contract is a link'),
  M('src/features/link-graph.ts', 'if (p.pairs.has(k) && results.has(l.a) && results.has(l.b)) continue;', '', "a scan's link outvotes Compare on a pair both read"),
  M('src/features/link-graph.ts', "n.hop > limits.depth - 1 ? 'depth'", "n.hop > limits.depth ? 'depth'", 'the graph reads one hop too far'),
  M('src/features/link-graph.ts', '(last?.confidence ?? 0) < limits.follow ||', '', 'a weak link is followed'),
  M('src/features/link-graph.ts', 'const room = Math.min(limits.together, limits.reads - results.size - reading.size);', 'const room = limits.together;', 'the read limit is ignored'),
  M('src/features/link-graph.ts', 'const c = await compareWallets(so, s, { rerun: again });', 'const c = { ...(await compareWallets(so, s, { rerun: again })), level: null };', 'Compare never weighs a pair both read'),
  M('src/features/link-graph.ts', 'for (const t of pick) add(txProof(t,', 'for (const t of [] as Transfer[]) add(txProof(t,', 'a direct link carries no transactions'),
  M('src/features/link-graph.ts', 'const by = (list: Transfer[]) => [...list].sort((x, y) => x.timestamp - y.timestamp);', 'const by = (list: Transfer[]) => [...list].reverse();', 'the proof is not oldest first'),
  M('src/features/link-graph.ts', 'if (nodes.length > limits.nodes) {', 'if (false) {', 'a graph grows past its wallet limit'),
  M('src/features/link-graph.ts', 'if (results.size + reading.size >= limits.maxReads) throw', 'if (false) throw', 'a wallet can be followed past the read limit'),
  M('src/features/link-graph.ts', 'if ((hopOf.get(l.b) ?? 0) < (hopOf.get(l.a) ?? 0)) [l.a, l.b] = [l.b, l.a];', '', 'a link points toward the first wallet'),
  M('src/features/link-graph.ts', '.slice(0, limits.perWallet);', ';', 'one wallet draws every link it has'),
  M('src/features/link-graph.ts', 'if (!tagOnly) pairs.set(k, pairLink(c));', 'pairs.set(k, pairLink(c));', "a public tag on a person makes Compare's silence a verdict"),
  // Link Graph: exchange deposit addresses (his 18561, round 2)
  M('src/features/link-graph.ts', '.filter((d) => d.users.length && !inGraph.has(d.address) && !away.has(d.address))', '.filter((d) => !inGraph.has(d.address) && !away.has(d.address))', 'a deposit shows without a wallet of the graph'),
  M('src/features/link-graph.ts', '[...(p.deposits ?? new Map<string, GraphDeposit[]>())].filter(([a]) => !away.has(a)).flatMap', '[...(p.deposits ?? new Map<string, GraphDeposit[]>())].flatMap', 'a deposit address from a wallet that is no person shows'),
  M('src/features/link-graph.ts', "(entity && entity !== 'an exchange' ? entity : undefined)", '(entity)', "a deposit address gets an explorer tag's placeholder as its exchange name"),
  M('src/features/link-graph.ts', "if (d.how === 'label' && had.how !== 'label')", 'if (false)', "a forward outvotes the list on a deposit address's name"),
  M('src/features/link-graph.ts', "cap(how === 'label' ? (senders > 6 ? 0.7 : 0.92) : senders > 6 ? 0.6 : 0.8)", "(how === 'label' ? 0.92 : 0.8)", "a shared deposit address weighs as one customer's"),
  M('src/features/link-graph.ts', "  if (!t) return [addrProof(d.chainId, d.address, 'The deposit address')];", "  return [addrProof(d.chainId, d.address, 'The deposit address')];", "a forwarding deposit address carries no proof of its exchange's name"),
  M('src/features/link-graph.ts', '...h.otherSenders.map((o) =>', '...h.otherSenders.slice(0, 0).map((o) =>', 'a deposit address leaves out the other wallets that pay in'),
  M('src/features/link-graph.ts', 'title: ent ? `Both pay into the same ${ent} deposit address` : r.title,', 'title: r.title,', 'the shared deposit reason does not name the exchange'),
  M('src/features/link-graph.ts', 'd.users.sort((x, y) => y.count - x.count || x.address.localeCompare(y.address));', '', 'the wallets of a deposit address are not the most payments first'),
  M('src/features/link-graph.ts', ' || (l.a !== start && isDeposit.has(l.a)) || (l.b !== start && isDeposit.has(l.b))) all.delete(k);', ') all.delete(k);', 'a deposit address another scan linked is a wallet of the graph'),
  M('src/features/link-graph.ts', 'deposits.set(r.address, person ? await scanDeposits(r, s) : []);', 'deposits.set(r.address, []);', 'the graph reads no deposit address'),
  M('src/features/compare.ts', 'const again = o.rerun ?? ((s: ScanSession) => rerun(s));', 'const again = (s: ScanSession) => rerun(s);', "Compare ignores the caller's replay"),
  // Timeline
  M('src/features/timeline.ts', 'return hs.map(({ nonce: _today, ...h }) => {', 'return hs.map((h) => {', "today's chain count makes a chain active back in time"),
  M('src/features/timeline.ts', 'firstFunding: firstOwn ? h.firstFunding : undefined', 'firstFunding: h.firstFunding', 'funding counts before the first transaction it paid for'),
  M('src/features/timeline.ts', '(setName && T >= setName.timestamp ?', '(setName && T >= 0 ?', 'the primary name counts before the transaction that set it'),
  M('src/features/timeline.ts', "if (gap) await push(gap.to, 'month');", '', 'the line goes on across the unread gap'),
];

const root = new URL('..', import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), 'nymra-mutate-features-'));
for (const d of ['src', 'test', 'fixtures']) cpSync(join(root, d), join(dir, d), { recursive: true });
cpSync(join(root, 'package.json'), join(dir, 'package.json'));
const tests = [join('test', 'session.test.ts'), ...readdirSync(join(dir, 'test/features')).filter((f) => f.endsWith('.test.ts')).map((f) => join('test/features', f))];
const run = () => spawnSync(process.execPath, ['--test', '--test-timeout=60000', ...tests], { cwd: dir, encoding: 'utf8' });

const base = run();
if (base.status !== 0) { console.log('baseline FAILS: fix the tests first'); console.log(base.stdout.slice(-2000)); process.exit(1); }

let killed = 0, survived = 0, bad = 0;
const only = process.env.ONLY;
for (const m of only ? MUTANTS.filter((x) => x.what.includes(only)) : MUTANTS) {
  const path = join(dir, m.file);
  const orig = readFileSync(path, 'utf8');
  const n = orig.split(m.find).length - 1;
  if (n !== 1) { bad++; console.log(`BAD      ${m.file}: anchor found ${n} times (${m.what})`); continue; }
  writeFileSync(path, orig.replace(m.find, m.put));
  const r = run();
  writeFileSync(path, orig);
  if (r.status !== 0) { killed++; console.log(`killed   ${m.what}`); }
  else { survived++; console.log(`SURVIVED ${m.what}  (${m.file})`); }
}
rmSync(dir, { recursive: true, force: true });
console.log(`\n${killed + survived + bad} mutants: ${killed} killed, ${survived} survived, ${bad} bad anchors`);
process.exit(survived || bad ? 1 : 0);
