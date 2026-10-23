// Mutation check: break one rule at a time and prove a test fails. Run: npm run mutate
// Works on a temporary copy of src/, test/, fixtures/, proxy/ and scripts/, so the working tree is never touched.
// Every anchor must occur exactly once in its file; an anchor that is missing or ambiguous is
// reported as BAD (a mutant that never ran must not count as killed).
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type Mutant = { file: string; find: string; put: string; what: string };
const M = (file: string, find: string, put: string, what: string): Mutant => ({ file, find, put, what });

const MUTANTS: Mutant[] = [
  // public_identity
  M('src/detectors/public-identity.ts', 'if (p.ens) {', 'if (false) {', 'ens_reverse never fires'),
  M('src/detectors/public-identity.ts', 'if (recs.length) {', 'if (false) {', 'ens_records never fires'),
  M('src/detectors/public-identity.ts', 'if (tags.length) {', 'if (false) {', 'public_label never fires'),
  M('src/detectors/public-identity.ts', 'if (p.isContract) {', 'if (false) {', 'is_contract never fires'),
  // linked_wallets
  M('src/detectors/linked-wallets.ts', 'c.nIn >= 1 && c.nOut >= 1 && c.nIn + c.nOut >= 3', 'c.nIn + c.nOut >= 3', 'back_and_forth without the two-way rule'),
  M('src/detectors/linked-wallets.ts', '&& personal(c) && (c.signedToMe || c.plainSendTo)', '&& (c.signedToMe || c.plainSendTo)', 'back_and_forth links services and contracts'),
  M('src/detectors/deposits.ts', 'if (first && first.from === ctx.me) funded.push', 'if (first) funded.push', 'funded_by_you for any first funder'),
  M('src/detectors/linked-wallets.ts', "(x.how === 'label' ? (x.senders > 6 ? 0.35 : 0.8) : (x.senders > 6 ? 0.3 : 0.7))", "(x.how === 'label' ? 0.8 : 0.7)", 'shared_deposit ignores omnibus addresses'),
  M('src/detectors/linked-wallets.ts', 'confidence: round2(confOf(x) * (s.count >= 2 ? 1 : 0.9))', 'confidence: round2(conf * (s.count >= 2 ? 1 : 0.9))', 'every deposit address gets the confidence of the first'),
  M('src/detectors/context.ts', "if (t.dir === 'out') return signed.has(t.hash) || realToken(t);", "if (t.dir === 'out') return true;", 'a fake token can write an outgoing transfer'),
  M('src/detectors/context.ts', 'return realToken(t) || sent.has(t.token);', 'return true;', 'fake incoming tokens count'),
  M('src/detectors/context.ts', "export const realToken = (t: Transfer) => t.priced === true ||", "export const realToken = (t: Transfer) => true ||", 'every token is real'),
  M('src/detectors/context.ts', 'if (lookalike(c.address, ctx.me)) { c.poison = true; c.imitates = ctx.me; continue; }', '', 'a look-alike of the wallet counts as a person'),
  M('src/detectors/context.ts', 'if (better(best, a) || !better(a, best)) { a.poison = true; a.imitates = best.address; }', '', 'a look-alike of a counterparty counts as a person'),
  M('src/detectors/context.ts', 'const best = twins.reduce((x, y) => (better(y, x) ? y : x));', 'const best = twins[0];', 'an imitation points at another imitation'),
  M('src/detectors/context.ts', 'const rank = (c: Counterparty) => [c.nOut, c.nIn, -c.first.timestamp];', 'const rank = (c: Counterparty) => [c.nOut, c.nIn, 0];', 'the look-alike seen first is not the original'),
  M('src/detectors/context.ts', 'return (head >= 3 && tail >= 4) || (head >= 4 && tail >= 3);', 'return head >= 4 && tail >= 4;', 'a 3 + 4 look-alike is missed'),
  M('src/detectors/deposits.ts', "if (t.kind === 'token' && !realToken(t) && !mine.has(t.token)) continue;", '', 'fake-token co-senders count'),
  M('src/detectors/deposits.ts', 'if (lookalike(t.from, ctx.me)) { poisoners.add(t.from); continue; }', '', 'a look-alike of the wallet is a co-sender'),
  M('src/detectors/deposits.ts', 'for (const a of [...senders.keys()]) for (const b of senders.keys()) if (lookalike(a, b)) { senders.delete(a); senders.delete(b); }', '', 'look-alike co-senders count'),
  M('src/detectors/poisoning.ts', 'for (const d of rec?.deposits ?? []) for (const a of d.lookalikes) if (!found.has(a)) found.set(a, { address: a, imitates: ctx.me, chainId: d.chainId });', '', 'look-alikes on a deposit address are not in the warning'),
  M('src/scan.ts', 'if (r.address === me || lookalike(r.address, me)) continue;', 'if (r.address === me) continue;', 'a look-alike of the wallet can be a linked wallet'),
  M('src/detectors/deposits.ts', 'if (t.cp?.isContract || serviceOf(t.from, t.cp)) continue;', '', 'deposit senders include contracts and services'),
  // funding_reuse
  M('src/detectors/funding-reuse.ts', ": serviceOf(funder, f.cp) ? 'service' : 'eoa';", ": 'eoa';", 'a service funder is treated as a person'),
  M('src/detectors/funding-reuse.ts', 'if (info.siblings.length > MANY_SIBLINGS) info.busy = true;', '', 'a funder of 40+ wallets still links'),
  M('src/detectors/funding-reuse.ts', 'info.busy = rows.length >= BUSY;', 'info.busy = false;', 'a busy funder still links'),
  M('src/detectors/funding-reuse.ts', "if (f.kind === 'eoa') byFunder.set", "if (f.kind !== 'cex') byFunder.set", 'same_funder_multichain for contracts and services'),
  M('src/detectors/funding-reuse.ts', 'if (t.to === ctx.me || cexOf(t.to, t.cp) || t.cp?.isContract || serviceOf(t.to, t.cp)) continue;', 'if (t.to === ctx.me) continue;', 'siblings include contracts and services'),
  M('src/detectors/funding-reuse.ts', 'if (fs.some((f) => f.busy) || fs.length < 2) byFunder.delete(addr);', 'if (fs.some((f) => f.busy)) byFunder.delete(addr);', 'same_funder_multichain for a funder of one chain'),
  M('src/detectors/funding-reuse.ts', "for (const i of infos) if (i.kind === 'eoa' && (nonces.get(i.funder) ?? 0) >= SERVICE_NONCE) i.busy = true;", '', 'a funder with 2,000+ transactions is a person'),
  // cex_exposure
  M('src/detectors/cex-exposure.ts', ".filter((t) => t && cexOf(t.from, t.cp)?.kind === 'hot');", '.filter((t) => t && false);', 'funded_by_cex never fires'),
  M('src/detectors/deposits.ts', 'toCex.length / outs.length >= 0.6', 'toCex.length / outs.length >= 1.1', 'a sweeping deposit address is never detected'),
  M('src/detectors/cex-exposure.ts', "if (c.cex?.kind !== 'hot') continue;", '', 'direct counts every counterparty as an exchange'),
  // cross_chain
  M('src/detectors/cross-chain.ts', 'if (loss < -0.0001 || loss > 0.03) continue;', 'if (loss > 0.5) continue;', 'bridge_match accepts a big loss'),
  M('src/detectors/cross-chain.ts', 'if (lag < 0 || lag > MAX_LAG_S) continue;', 'if (lag > MAX_LAG_S) continue;', 'bridge_match accepts the wrong order'),
  M('src/detectors/cross-chain.ts', "severity: act.length >= 4 ? 'medium' : 'low'", "severity: 'low'", 'multichain_presence severity'),
  // behavioral_fingerprint
  M('src/detectors/behavioral-fingerprint.ts', 'if (q.len >= MIN_QUIET && q.len <= 12) {', 'if (q.len >= 1) {', 'timezone without the window rule'),
  M('src/detectors/behavioral-fingerprint.ts', 'if (share >= 0.4) {', 'if (share >= 0) {', 'round_amounts at any share'),
  M('src/detectors/behavioral-fingerprint.ts', 'if (share >= 0.5 && methods >= 2) {', 'if (share >= 2) {', 'fixed_gas never fires on gas limits'),
  M('src/detectors/behavioral-fingerprint.ts', 'if (med >= 300 && near >= 0.6) {', 'if (false) {', 'fixed_timing never fires'),
  // recurring_counterparties
  M('src/detectors/recurring-counterparties.ts', 'if (share < 0.4 || top[0].nIn + top[0].nOut < 4) return [];', 'if (false) return [];', 'recurring without its thresholds'),
  M('src/detectors/recurring-counterparties.ts', 'personal(c) && c.nIn + c.nOut > 0', 'c.nIn + c.nOut > 0', 'recurring counts services'),
  // shared rules
  M('src/detectors/context.ts', 'export const personal = (c: Counterparty) => !c.contractLike && !c.cex && !c.service && !c.poison;', 'export const personal = (c: Counterparty) => !c.cex && !c.poison;', 'contracts and services count as persons'),
  M('src/detectors/context.ts', 'return v < SERVICE_NONCE && (!mustHaveSent || v > 0);', 'return true;', 'a counterparty with 2,000+ transactions is a person'),
  M('src/detectors/context.ts', 'return v < SERVICE_NONCE && (!mustHaveSent || v > 0);', 'return v < SERVICE_NONCE;', 'a sender that never signed anything counts'),
  // funding and activity
  // 2026-10-16: a fixture never names a real person
  M('fixtures/worked-example.json', '"text": "Also paid in 2 times"', '"text": "Also paid in 2 times by x.eth"', 'a fixture names a real ENS name'),
  M('scripts/fixtures.ts', "export const EXAMPLE_NAME = 'alice.example';", "export const EXAMPLE_NAME = 'x.eth';", 'the example name is a .eth name'),
  // a contract or a service is spoken of in the third person
  M('src/scan.ts', '  ctx.thirdPerson = notPerson;', '', 'an exchange is told "your"'),
  M('src/detectors/public-identity.ts', "title: it ? 'This address carries a public label' : 'Your address carries a public label',", "title: 'Your address carries a public label',", 'an exchange "carries your" label'),
  M('src/detectors/poisoning.ts', 'const it = !!ctx.thirdPerson;', 'const it = false;', 'the poisoning warning of a service says "your history"'),
  // a relay that cannot serve a relay-only chain today
  M('src/history.ts', "(e.kind === 'needs_key' || (e.kind === 'quota' && keyed(chain.source)))", "(e.kind === 'needs_key')", 'a spent relay quota makes a relay-only chain a failed read'),
  M('src/history.ts', "(e.kind === 'needs_key' || (e.kind === 'quota' && keyed(chain.source)))", "(e.kind === 'needs_key' || e.kind === 'quota')", 'a keyless chain that met the relay quota is skipped'),
  M('src/scan.ts', "const why = c.skipReason === 'quota' ?", "const why = false ?", 'the quota gap does not say when it comes back'),
  // what paid for the first transaction
  M('src/history.ts', 'const paid = before.find((t) => t.amount >= need && t.amount >= total * FUNDING_SHARE);', 'const paid = [...before].reverse().find((t) => t.amount >= need);', 'the latest transfer that covers it is the funder (sprinkler dust)'),
  M('src/history.ts', 'const paid = before.find((t) => t.amount >= need && t.amount >= total * FUNDING_SHARE);', 'const paid = before.find((t) => t.amount >= need);', 'the first transfer that covers it, however small, is the funder'),
  M('src/history.ts', 'const paid = before.find((t) => t.amount >= need && t.amount >= total * FUNDING_SHARE);', 'const paid = before.find((t) => t.amount >= total * FUNDING_SHARE);', 'dust too small to pay for anything is funding'),
  M('src/history.ts', 'return paid && paid.from !== l1Alias(firstOwn.from) ? paid : undefined;', 'return paid;', 'its own L1 deposit is a third funder'),
  M('src/history.ts', 'const firstFunding = firstKnown && !oldFailed ? fundingOf(', 'const firstFunding = !oldFailed ? fundingOf(', 'a funder although the first transaction lies beyond what was read'),
  M('src/history.ts', 'const firstFunding = firstKnown && !oldFailed ? fundingOf(', 'const firstFunding = firstKnown ? fundingOf(', 'a funder although the oldest page failed'),
  // wallets that only received, a chain that could not be read, precompiles; services, bots and unused addresses
  M('src/detectors/funding-reuse.ts', '(s) => ({ address: s.address, chainId: f.chainId }), true);', '(s) => ({ address: s.address, chainId: f.chainId }));', 'a wallet that only received counts as a sibling'),
  M('src/detectors/deposits.ts', 'for (const f of fresh) if (sent.get(f.address) === 0) f.idle = true;', '', 'a funded wallet that never sent anything is a full link'),
  M('src/detectors/funding-reuse.ts', 'if (ctx.histories.some(fundingUnread)) return out;', '', 'another chain takes the place of an unread one'),
  M('src/history.ts', 'export const INTERNAL_TIMEOUT_MS = 90_000;', 'export const INTERNAL_TIMEOUT_MS = 60_000;', 'internal transfers get less time than Base needs'),
  M('src/detectors/context.ts', '|| system(a) || system(b)) return false;', ') return false;', 'a precompile imitates a system contract'),
  M('src/scan.ts', 'const notPerson = ctx.profile.isContract || !!selfService(ctx.me, ctx.profile, coverage);', 'const notPerson = ctx.profile.isContract;', 'an exchange or a bot gets personal findings and links'),
  M('src/scan.ts', "(sent >= BOT_COUNT ? { kind: 'bot' } : undefined)", 'undefined', 'an address with millions of transactions is a person'),
  M('src/scan.ts', 'const unused = !shown.length && coverage.length > 0', 'const unused = false && coverage.length > 0', 'a never used address does not say so'),
  M('src/history.ts', 'if (!firstOwn) return undefined;', "if (!firstOwn) return incoming.filter((t) => t.dir === 'in' && t.amount > 0)[0];", 'a chain the wallet never used has a funder'),
  M('src/history.ts', 'return h.filter(signedHere);', 'return h.filter((x) => x.txs.length + x.tokens.length + x.internal.length > 0);', 'received-only chains count as active'),
  M('src/detectors/cross-chain.ts', 'if (h.nonce !== undefined && h.nonce > 0) return', 'if (false) return', 'the evidence counts a page limit, not what was sent'),
  // a gap in the explorer's index
  M('src/history.ts', 'const gap = sent > 0 && !truncTx && (own.size === 0 || (sent - own.size >= 3 && own.size < sent * 0.9));', 'const gap = false;', 'an explorer gap reads as no activity'),
  M('src/history.ts', 'const sent = pre && !pre.code ? pre.nonce : 0;', 'const sent = pre ? pre.nonce : 0;', "a contract's nonce makes a gap"),
  // never a request the explorer refuses
  M('src/sources/explorer.ts', "if (action === 'txlistinternal') throw new HttpError(400, 'Blockscout cannot list internal transfers oldest first', 'http');", '', 'internal transfers asked oldest first (422)'),
  M('src/history.ts', "const oldIntPossible = chain.source.kind !== 'blockscout';", 'const oldIntPossible = true;', 'Blockscout asked for the oldest internal page'),
  M('src/detectors/context.ts', 'else if (!c.signedToMe && !sighted.has(c.address)) c.contractLike = true;', '', 'NodeReal-only counterparties count as persons'),
  // what a gap is, and a service is not a person
  M('src/scan.ts', 'if (pre && (pre.sent > 0 || pre.holds)) {', 'if (false) {', 'a key-skipped chain the wallet used is no gap'),
  M('src/history.ts', 'holds: p.balance > 0n', 'holds: false', 'a held balance on a key-skipped chain is not seen'),
  M('src/scan.ts', 'out.push({ part: e.part, chainId: 1, name: e.name, reason: e.reason })', "out.push({ part: 'identity', chainId: 1, name: e.name, reason: e.reason })", 'the side lists of a name count as identity gaps'),
  M('src/sources/identity.ts', "errors.push({ part: 'identity', name: 'ENS and labels', reason:", "errors.push({ part: 'names', name: 'ENS and labels', reason:", 'a failed name and label read counts as a side list'),
  M('src/labels.ts', "if (c) return { kind: c.kind === 'hot' ? 'exchange' : 'deposit', entity: c.entity };", '', 'an exchange wallet is not named as a service'),
  M('src/labels.ts', 'const label: ServiceLabel = e !== undefined ? { kind: d.kinds[k], entity: d.entities[e] } : { kind: d.kinds[k] };', 'const label: ServiceLabel = { kind: d.kinds[k] };', 'a service loses its name'),
  M('src/scan.ts', 'labels: profile?.tags ?? [], ...(service ? { service } : {}) }', 'labels: profile?.tags ?? [] }', 'the result never says it is a service'),
  M('src/history.ts', 'const s = r.from === me ? r._from : r.to === me ? r._to : undefined;', 'const s = r.from === me ? r._to : r.to === me ? r._from : undefined;', "the other side's tags are read as the wallet's own"),
  M('src/scan.ts', 'for (const n of h.self.names) if (!tags.includes(n)) tags.push(n);', '', 'explorer name tags on the wallet are dropped'),
  M('src/scan.ts', 'serviceIdentity(me) ?? serviceByTags(profile?.slugs, profile?.entity) ??', 'serviceIdentity(me) ??', 'an explorer-tagged exchange is no service'),
  M('src/detectors/context.ts', "const kind = slugs.includes('deposit-address') ? 'deposit' : slugs.some((s) => EXCHANGE_SLUGS.has(s)) ? 'exchange' : slugs.includes('mev-bot') ? 'bot' : undefined;", "const kind = slugs.length ? 'service' : undefined;", 'any explorer tag makes a person a service'),
  M('scripts/fixtures.ts', '  r.durationMs = durationMs;', '  r.durationMs = durationMs + 1;', 'a committed fixture differs from what the engine gives'),
  // score
  M('src/score.ts', 'if (naming && score > NAMED_CEILING) {', 'if (false) {', 'no named-wallet ceiling'),
  M('src/score.ts', 'const cost = Math.min(left, -f.rawImpact);', 'const cost = -f.rawImpact;', 'no detector caps'),
  M('src/score.ts', 'if (confidence >= LINK_LEVELS.likely) return', 'if (confidence > LINK_LEVELS.likely) return', 'the likely edge is not inclusive'),
  // http layer
  M('src/sources/http.ts', 'const RESERVE = 4;', 'const RESERVE = -1;', 'no pacing on a nearly spent quota'),
  M('src/sources/http.ts', "throw new HttpError(res.status, `${host} answered a bot check instead of data`, 'blocked');", "throw new HttpError(res.status, `${host} answered a bot check instead of data`, 'http');", 'a bot wall is not a fallback trigger'),
  M('src/sources/http.ts', 'if (cache && !rpcError(json)) cache.set(key, text);', '', 'no session cache'),
  M('src/sources/http.ts', 'const until = justWaited ? 0 :', 'const until = false ? 0 :', 'a request waits twice for one window'),
  // relay
  M('proxy/proxy.ts', "if (ORIGINS.includes(origin) || origin === 'https://nymra.pages.dev' || PREVIEW.test(origin)) return true;", 'return true;', 'any origin may call the relay'),
  M('proxy/proxy.ts', "for (const form of new Set([k, encodeURIComponent(k)])) out = out.split(form).join('[redacted]');", '', 'keys are not scrubbed from answers'),
  M('proxy/proxy.ts', "if (typeof m !== 'string' || !RPC_METHODS.has(m)) return 'method not allowed';", '', 'any JSON-RPC method passes'),
  M('proxy/proxy.ts', "if (up.keyed === 'pro' && creditsLow()) {", 'if (false) {', 'no quota guard'),
  M('proxy/proxy.ts', "headers: { authorization: `Bearer ${env.BLOCKSCOUT_PRO_KEY}` }", "headers: {}", 'the PRO key is not sent as a header'),
  M('proxy/proxy.ts', "const browserOk = originAllowed(own, env) && (origin === own || (!origin && req.headers.get('sec-fetch-site') === 'same-origin'));", 'const browserOk = originAllowed(origin, env) || originAllowed(own, env);', 'another of our hosts (or any page on ours) may call this relay cross-origin'),
  M('proxy/proxy.ts', "if (req.method === 'OPTIONS') return new Response(null, { status: 405, headers: { allow: 'GET, POST' } });", "if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: { 'access-control-allow-origin': '*' } });", 'a preflight gets CORS'),
  M('proxy/proxy.ts', 'const bad = targetProblem(req.method, target);', 'const bad = null;', 'any path and method on a register host'),
  M('proxy/proxy.ts', "if (m === 'eth_call' && (typeof data !== 'string' || !data.toLowerCase().startsWith(ENS_TEXT))) return 'call not allowed';", '', 'any contract call passes'),
  M('proxy/proxy.ts', 'export const MAX_BODY = 4096;', 'export const MAX_BODY = 8192;', 'an 8 KB body passes'),
  // Alchemy, the keyed second source of Base and Polygon PoS on a server: test/alchemy.test.ts
  M('src/chains.ts', 'if (!k || !keyedAlts.includes(k.kind)) return c;', 'if (!k) return c;', 'alchemy: read without the relay saying it holds the key (the browser road changes)'),
  M('src/scan.ts', '.filter((c) => !c.retired).map((c) => chainForRoad(c, opts.keyedAlts));', '.filter((c) => !c.retired);', 'alchemy: the scan ignores keyedAlts'),
  M('src/chains.ts', "keyedAlt: al('base-mainnet'), ", '', 'alchemy: Base has no second source'),
  M('src/chains.ts', 'limits: [...(c.limits ?? []), alchemyLimit(c.name)]', 'limits: c.limits', 'alchemy: the coverage does not say what the source lacks'),
  M('src/sources/explorer.ts', 'withMetadata: true, excludeZeroValue: false,', 'withMetadata: true, excludeZeroValue: true,', 'alchemy: contract calls without value are left out'),
  M('src/sources/explorer.ts', 'withMetadata: true, excludeZeroValue: false,', 'excludeZeroValue: false,', 'alchemy: no timestamps'),
  M('src/sources/explorer.ts', "const sides = q.filter === 'from' ? ['fromAddress'] : q.filter === 'to' ? ['toAddress'] : ['fromAddress', 'toAddress'];", "const sides = ['fromAddress'];", 'alchemy: only the sent side is read'),
  M('src/sources/explorer.ts', "const sides = q.filter === 'from' ? ['fromAddress'] : q.filter === 'to' ? ['toAddress'] : ['fromAddress', 'toAddress'];", "const sides = ['fromAddress', 'toAddress'];", 'alchemy: a funder check reads both sides'),
  M('src/sources/explorer.ts', 'if (!seen.has(id)) { seen.add(id); all.push(x); }', 'all.push(x);', 'alchemy: a send to itself counts twice'),
  M('src/sources/explorer.ts', "all.sort((a, b) => (order === 'asc' ? block(a) - block(b) : block(b) - block(a)));", '', 'alchemy: the two sides are not merged in block order'),
  M('src/sources/explorer.ts', 'for (const x of rows) { out.push(x); if (out.length >= want) break; }\n      pageKey = rows.length && j?.result?.pageKey ? String(j.result.pageKey) : undefined;', 'for (const x of rows) { out.push(x); if (out.length >= want) break; }\n      pageKey = undefined;', 'alchemy: only the first page is read'),
  M('src/sources/explorer.ts', "fromBlock: hexOf(q.startblock ?? 0), toBlock: q.endblock !== undefined ? hexOf(q.endblock) : 'latest'", "fromBlock: '0x0', toBlock: 'latest'", 'alchemy: a block window is ignored'),
  M('src/sources/explorer.ts', "if (j?.error) throw new Error(`${chain.name}: ${String(j.error.message ?? 'Alchemy error').slice(0, 120)}`);", 'if (j?.error) return out;', 'alchemy: an error answer reads as an empty list'),
  M('src/sources/explorer.ts', 'value: hexOrDec(raw.value), _blind: true };', 'value: hexOrDec(x.value), _blind: true };', 'alchemy: the rounded value instead of the raw one'),
  M('src/sources/explorer.ts', 'value: hexOrDec(raw.value), _blind: true };', 'value: hexOrDec(raw.value) };', 'alchemy: its rows pass for rows with calldata'),
  M('src/detectors/funding-reuse.ts', '|| blind(h.chain.source)) return info;', "|| h.chain.source.kind === 'nodereal') return info;", 'alchemy: a funder check on a source without calldata'),
  M('proxy/proxy.ts', "if (road === 'alchemy') return method !== 'POST' ? 'method not allowed' : target.pathname === '/v2/' && !target.search ? null : 'path not allowed';", "if (road === 'alchemy') return null;", 'alchemy: any method and path on an Alchemy host'),
  M('proxy/proxy.ts', "if (alchemy !== (m === ALCHEMY_METHOD)) return 'method not allowed';", '', 'alchemy: an Alchemy host takes any call'),
  M('proxy/proxy.ts', "if (ROADS.get(target.host) === 'alchemy' && env.ALCHEMY_API_KEY) {", 'if (false) {', 'alchemy: the key is not put in'),
  M('proxy/proxy.ts', "|| ROADS.get(target.host) === 'alchemy') && !up.keyed) {", ') && !up.keyed) {', 'alchemy: without the key the call goes out keyless'),
  M('proxy/proxy.ts', 'env.NODEREAL_API_KEY, env.ALCHEMY_API_KEY, env.BOT_TOKEN]', 'env.NODEREAL_API_KEY, env.BOT_TOKEN]', 'alchemy: its key is not scrubbed from answers'),
  // Blast retired: test/retired.test.ts
  M('src/chains.ts', 'defaultOn: false, retired: BLAST_RETIRED }', 'defaultOn: true, retired: BLAST_RETIRED }', 'blast: on by default'),
  M('src/chains.ts', 'defaultOn: false, retired: BLAST_RETIRED }', 'defaultOn: false }', 'blast: not marked retired'),
  M('src/scan.ts', '.filter((c) => c !== undefined).filter((c) => !c.retired).map(', '.filter((c) => c !== undefined).map(', 'blast: a retired chain is read when asked for'),
  M('src/scan.ts', 'wanted.filter((id) => !CHAIN_BY_ID.has(id) || CHAIN_BY_ID.get(id)!.retired)', 'wanted.filter((id) => !CHAIN_BY_ID.has(id))', 'blast: a retired chain asked for leaves no coverage line'),
  M('proxy/proxy.ts', '  if (c.retired) continue;\n', '', 'blast: the relay still lets a retired chain through'),
  // ENS weight 1.4.0: test/score.test.ts, test/detectors.test.ts, test/fixtures.test.ts
  M('src/detectors/public-identity.ts', "id: 'public_identity.ens_reverse', detector: 'public_identity', severity: 'medium', confidence: 1,", "id: 'public_identity.ens_reverse', detector: 'public_identity', severity: 'critical', confidence: 1,", 'ens: a bare ENS name is critical'),
  M('src/score.ts', "export const NAMING_RULES = ['public_identity.public_label'];", "export const NAMING_RULES = ['public_identity.ens_reverse', 'public_identity.public_label'];", 'ens: an ENS name sets the ceiling'),
  M('src/score.ts', "export const NAMING_RULES = ['public_identity.public_label'];", 'export const NAMING_RULES: string[] = [];', 'ens: a public label sets no ceiling'),
  M('src/score.ts', "export const RULES_VERSION = '1.4.0';", "export const RULES_VERSION = '1.3.0';", 'ens: the rules version is not raised'),
  M('src/detectors/public-identity.ts', "severity: social.length ? 'high' : 'medium', confidence: 0.95,", "severity: 'medium', confidence: 0.95,", 'ens: records with real handles cost no more than the bare name'),
  // addrKey remembers each address (2026-10-21): test/hash.test.ts
  M('src/hash.ts', '    KEYS.set(address, k);\n', '', 'l85: addrKey forgets every address'),
  M('src/hash.ts', '  let k = KEYS.get(address);', '  let k: string | undefined;', 'l85: addrKey never asks what it remembered'),
  M('src/hash.ts', '    if (KEYS.size >= KEYS_MAX) KEYS.clear();\n', '', 'l85: KEYS grows without end'),
  M('src/hash.ts', "k = cyrb53(address.toLowerCase())", "k = cyrb53(address)", 'l85: a checksummed address gets another key'),
  // A lost internal list gives its place on the host back (2026-10-21): test/http.test.ts, test/scan.test.ts
  M('src/history.ts', 'won.then(() => done.abort(), () => {});', 'won.then(() => {}, () => {});', 'l85: the lost internal list keeps its place on Blockscout'),
  M('src/sources/explorer.ts', ', ...(q.signal ? { signal: q.signal } : {}) });', ' });', 'l85: a Blockscout list never hears it is no longer needed'),
  M('src/sources/http.ts', '        if (stop) signals.push(stop);\n', '', "l85: a call's own signal never reaches the request"),
  M('src/sources/http.ts', '        if (stop?.aborted) throw unwanted();\n        const msg = e instanceof Error', '        const msg = e instanceof Error', 'l85: a call no longer needed is tried again'),
  // default chains (2026-10-21): only the register's default chains are read, and none of them straight from Etherscan V2
  M('src/chains.ts', '  { id: 42220,', "  { id: 990002, name: 'Another chain', native: 'ETH', source: esFree(990002), rpc: 'https://another-rpc.test', explorer: 'https://another.test', defaultOn: true },\n  { id: 42220,", 'default chains: a paced keyless chain on by default'),
  M('src/chains.ts', "explorer: 'https://celo.blockscout.com',              defaultOn: true", "explorer: 'https://celo.blockscout.com',              defaultOn: false", 'default chains: Celo off by default'),
  M('src/sources/http.ts', '          if (!call.signal) inflight.set(key, p);', '          inflight.set(key, p);', 'l85: a call that can give up is shared with another caller'),
  // L100 2026-10-23: a later page that fails keeps the pages read (A); Arbitrum One's slow token pages wait longer, once (B)
  M('src/sources/explorer.ts', "      if (out.length > 0 && e instanceof HttpError && e.kind !== 'aborted') { out.cut = true; break; }\n", '', 'l100: a failed later page throws the read pages away'),
  M('src/sources/explorer.ts', "e instanceof HttpError && e.kind !== 'aborted') { out.cut", "e instanceof HttpError) { out.cut", 'l100: an abort is kept as a cut list'),
  M('src/sources/explorer.ts', "      if (out.length > 0 && e instanceof HttpError && e.kind", "      if (e instanceof HttpError && e.kind", 'l100: a refused first page passes as an empty cut list'),
  M('src/history.ts', '{ timeoutMs: chain.tokenPageMs, timeoutRetries: 0 }', '{ timeoutMs: chain.tokenPageMs, timeoutRetries: 1 }', 'l100: a slow token page gets a second try'),
  M('src/history.ts', '{ timeoutMs: chain.tokenPageMs, timeoutRetries: 0 }', '{ timeoutMs: 15000, timeoutRetries: 0 }', 'l100: a slow token page waits the usual 15 s'),
  M('src/chains.ts', 'tokenPageMs: 30_000, ', '', 'l100: Arbitrum One waits the usual 15 s for a token page'),
  M('src/history.ts', "    if (tokCut) coverage.missing.push('older token transfers (time limit)');\n", '', 'l100: a cut token list is no gap'),
  M('src/history.ts', "const txCut = !!(first.cut || (intR.status === 'fulfilled' && intR.value.cut));", "const txCut = !!(first.cut || (intR.status === 'fulfilled' && intR.value.cut)) || tokCut;", 'l100: a cut token list reads as unread transactions'),
  M('src/history.ts', "    if (tokCut) coverage.limitations.push(", "    if (false) coverage.limitations.push(", 'l100: a cut token list says nothing in its limits'),
  M('src/history.ts', 'if (truncTx || truncInt || txCut || tokens.length >= lim.maxToken) coverage.limitations.push(txCut', 'if (truncated) coverage.limitations.push(cut', 'l100: a cut token list speaks of a long transaction history'),
];

const root = new URL('..', import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), 'nymra-mutate-'));
for (const d of ['src', 'test', 'fixtures', 'proxy', 'scripts']) cpSync(join(root, d), join(dir, d), { recursive: true });
cpSync(join(root, 'package.json'), join(dir, 'package.json'));
const tests = readdirSync(join(dir, 'test')).filter((f) => f.endsWith('.test.ts')).map((f) => join('test', f));
const run = () => spawnSync(process.execPath, ['--test', '--test-timeout=60000', ...tests], { cwd: dir, encoding: 'utf8' });

const base = run();
if (base.status !== 0) { console.log('baseline FAILS: fix the tests first'); console.log(base.stdout.slice(-2000)); process.exit(1); }

let killed = 0, survived = 0, bad = 0;
// ONLY=<text>: run just the mutants whose description contains it (a quick re-check after a fix).
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
