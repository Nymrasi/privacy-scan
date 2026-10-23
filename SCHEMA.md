# Nymra privacy scan: result schema

Schema version: **1**. Source of truth for the types: [`src/types.ts`](src/types.ts).
The score formula lives in [`RULES.md`](RULES.md) and [`src/score.ts`](src/score.ts).

## Using it

```ts
import { scan } from '@nymra/privacy-scan';          // real scan (runs in the browser and in Node)
import { mockScan, FIXTURES } from '@nymra/privacy-scan'; // streamed fixture, no network

const result = await scan('0xabc...', {
  onProgress: (e) => {
    // e.type: 'start' | 'chain' | 'finding' | 'partial' | 'done'
    if (e.type === 'partial' || e.type === 'done') render(e.result);
  },
});
```

The package ships TypeScript source with erasable syntax only. Node 23.6+ runs it directly,
Vite and esbuild import it as is. No build step.

Mock results for UI work: [`fixtures/bad.json`](fixtures/bad.json) (score 22, exposed),
[`fixtures/average.json`](fixtures/average.json) (66, moderate),
[`fixtures/good.json`](fixtures/good.json) (98, private). The real detectors and score formula
produce them from synthetic histories ([`scripts/fixtures.ts`](scripts/fixtures.ts)); a test fails
when a committed fixture is not what the engine gives, so regenerate with
`node scripts/make-fixtures.ts` after a rule changes. Their addresses are synthetic and unused
(checked on-chain 2026-10-16), except the exchange hot wallets they deal with. Their only name is
`alice.example`: `.example` is reserved for documentation and never delegated, so no ENS name can
ever be it, and a test fails on any other name.

## ScanResult

| field | type | meaning |
|---|---|---|
| `schemaVersion` | `1` | bumps on a breaking change |
| `address` | string | lowercase 0x address that was scanned |
| `scannedAt` | ISO string | when the scan started |
| `durationMs` | number | wall time of the scan |
| `status` | `running` \| `partial` \| `complete` | `running` while streaming. At the end `complete` only when everything was read; otherwise `partial`, and `incomplete` says what is missing |
| `addressType` | `eoa` \| `contract` \| `unknown` | a contract gets a note, not a person's score |
| `score` | 0..100 | **100 = nothing links this wallet to anything; 0 = fully exposed** |
| `band` | `private` (80+) \| `moderate` (60+) \| `traceable` (35+) \| `exposed` | label for the score |
| `breakdown` | ScoreBreakdown | points lost per detector, which detectors hit their cap, `ceiling: 34` when the named-wallet ceiling applied |
| `findings` | Finding[] | sorted: costliest first |
| `linkedWallets` | RelatedAddress[] | every `related` from every finding, merged per address, highest confidence first. Never the wallet itself and never a look-alike of it |
| `warnings` | Warning[] | safety warnings that are not findings and cost no points; today only `address_poisoning`. Empty when there are none (see below) |
| `unused` | `true`? | set when the address never sent a transaction and holds nothing on every chain read, and nothing names it: there is nothing to score (the score is 100 by construction). Show that instead of a band |
| `identity` | `{ ens?, labels[], service? }` | public name, and the explorer's name tags on the address itself (read from its own side of its rows: the explorer's address page carries none); `service` when the address itself is a known service (see below) |
| `coverage` | ChainCoverage[] | what was and was not seen per chain; show this next to the score |
| `incomplete` | Incomplete[] | what this scan could not read (a chain, one list of a chain, ENS and labels, funder or deposit checks). Empty when `status` is `complete`. **A partial score is computed from what was read only: show it as partial, with these lines, and offer a rescan** |
| `engine` | `{ name, version, rulesVersion }` | |
| `stats` | `{ requests, cached, waitedMs, rateLimitRemaining? }` | final result only: network requests, answers from the session cache, time spent waiting for rate-limit windows, lowest `x-ratelimit-remaining` an explorer reported |

Invariant: `100 + sum(findings[].scoreImpact) === score`.

## Finding

| field | type | meaning |
|---|---|---|
| `id` | string | stable rule id, `detector.rule`, e.g. `cex_exposure.deposit_address`. Every id is listed in RULES.md |
| `key` | string | unique within one result and stable across partial results: the rule id, plus `:<subject>` when a rule can fire more than once (`funding_reuse.same_funder_multichain:0x...`). Use it as the UI key |
| `detector` | DetectorId | one of the seven below |
| `severity` | `info` \| `low` \| `medium` \| `high` \| `critical` | |
| `confidence` | 0..1 | how sure the engine is that the finding is real |
| `scoreImpact` | number <= 0 | points this finding actually takes off the score |
| `rawImpact` | number <= 0 | points before the detector cap; differs from `scoreImpact` when capped, or (for a naming finding) when the named-wallet ceiling applied |
| `title` | string | short, English |
| `explanation` | string | 1 to 3 plain sentences, English |
| `evidence` | Evidence[] | the proof: tx, address, label, stat, ens or pattern |
| `chains` | ChainId[] | chains the finding is based on |
| `related` | RelatedAddress[]? | wallets this finding links to, each with its own confidence |
| `deep` | boolean? | shown only to holders over the gate's threshold. In V1 that threshold is 0, so all of it is visible |

`severity: info` costs 0 points; use it for reassuring notes ("funding source looks unique").

### Detectors (`DetectorId`)

| id | what it looks for |
|---|---|
| `funding_reuse` | the wallet whose coins paid for the first transaction on each chain, and whether it funded other wallets |
| `linked_wallets` | probable sibling wallets: shared funder, back and forth transfers, shared CEX deposit address |
| `recurring_counterparties` | a few wallets that make up most of the activity |
| `cex_exposure` | transfers with known exchange wallets, CEX funding, personal deposit addresses |
| `public_identity` | ENS reverse name, ENS text records, public labels |
| `cross_chain` | same address active on several chains, matching bridge flows |
| `behavioral_fingerprint` | hour-of-day pattern (time zone), round amounts, fixed gas setting, fixed timing |

**Hard rule:** a link between wallets is always a likelihood with a confidence, never a statement
of who owns a wallet. Explanations say "likely", "often", "may"; never "this is your wallet".

## Warning

Something the user must know that is not a privacy leak. Today one kind, `address_poisoning`:
addresses made to look like the scanned wallet or a wallet it uses (at least 3 + 4 or 4 + 3 equal
hex characters at the start and end), which sent dust or fake token transfers into its history.

| field | type | meaning |
|---|---|---|
| `id` | `address_poisoning` | |
| `title` | string | e.g. "3 look-alike addresses are in your history" |
| `explanation` | string | what it is and what to do (never copy an address from the history) |
| `lookalikes` | `{ address, imitates, chainId }[]` | each look-alike and the address it imitates (the wallet itself, or a counterparty) |
| `evidence` | Evidence[] | one `address` evidence per look-alike, its full address in `text` |
| `chains` | number[] | |

**Print these addresses in full, never shortened.** Shortened, a look-alike reads exactly like the
real address: that is the attack. A look-alike is never in `linkedWallets` or in a finding's
`related`.

## Evidence

```ts
{ kind: 'tx' | 'address' | 'label' | 'stat' | 'ens' | 'pattern',
  text: string,            // always present, human readable
  chainId?, txHash?, address?, label?, value?, timestamp?, url? }
```

`pattern` evidence for the time-zone finding carries a 24-value comma separated histogram in
`value` (transactions per UTC hour, 0 to 23), ready for a small bar chart.

## Service

`identity.service` is set when the bundled label lists name the scanned address itself as a
service, when the explorer tags it as one outright (`exchange` or `hot-wallet`, `deposit-address`,
`mev-bot`; a Farcaster account, a DAO voter or a contract deployer stays a person), or when it sent
50,000 or more transactions on one chain (`bot`: no person signs that many). Its traffic is the
service's, not a person's: like a contract it gets only the identity and cross-chain rules, so no
personal findings and no links. Show this state instead of a band ("This is a Binance exchange
wallet. Nymra scores personal wallets.").

```ts
{ kind: 'exchange' | 'deposit' | 'bridge' | 'bot' | 'infrastructure' | 'distributor' | 'payments' | 'market maker' | 'service',
  entity? /* "Binance", "Axelar"; absent for bots and infrastructure, whose list carries no names */ }
```

| kind | from | meaning |
|---|---|---|
| `exchange` | `cex.json`, or the explorer tag `exchange` / `hot-wallet` | an exchange's own wallet |
| `deposit` | `cex.json`, or the explorer tag `deposit-address` | a deposit address: the exchange holds its key for one customer |
| `bridge` | `services.json` | a wallet a bridge runs (relayer, maker) |
| `bot` | `services.json`, the explorer tag `mev-bot`, or 50,000+ transactions on one chain | MEV bots, block builders, and any address no person could have run |
| `infrastructure` | `services.json` | bundlers, relayers, keepers, oracles, operators, deployers |
| `distributor` | `services.json` | airdrop, faucet and payout wallets |
| `payments` | `services.json` | payment processors and on-ramps |
| `market maker` | `services.json` | market makers and OTC desks |
| `service` | `services.json` | another service wallet |

For a contract or a service, every finding and the poisoning warning speak of "this address", never
"you" ("This address carries a public label").

`serviceIdentity(address)` (package export) gives the same answer before a scan. A contract has its
own state (`addressType: 'contract'`); a contract can carry a `service` too.

## Incomplete

```ts
{ part: 'chain' | 'tokens' | 'internal' | 'oldest' | 'identity' | 'names' | 'lookups' | 'skipped' | 'aborted',
  chainId?, name /* "Base", "ENS and labels", "Other ENS names", "ENS records", "Funder and deposit checks" */,
  reason /* "Base: rate limit reached" */ }
```

`reason` is a plain sentence and never contains the address or a URL.

**How to read a gap.** A gap that can move the score a
long way, or past the named-wallet ceiling, means no score until it is read. A gap in a side list
means a score, marked partial, with its lines.

| part | what was not read | show |
|---|---|---|
| `chain` | a whole chain the wallet may use (a failed read, or a gap in the explorer's index) | no score; retry after the explorer's `x-ratelimit-reset` |
| `lookups` | funder and deposit checks of other wallets | no score |
| `identity` | the ENS name, the public labels or the contract check: a public label sets the named-wallet ceiling, the check the contract state | no score |
| `aborted` | the scan was stopped | no score |
| `tokens`, `internal`, `oldest` | one list of a chain | partial score |
| `names` | the other ENS names of the address, the records of its name: at most 8 points, never the ceiling | partial score |
| `skipped` | a chain only the relay can read, which it cannot serve today (no key for it, or its daily quota spent until 00:00 UTC; see `skipReason`), where the quick check saw the wallet send or hold something | partial score; a retry does not help |

A coverage row with `status: 'error'` always has a `chain` gap. `no_activity` and `skipped` rows are
never a failed read: the quick check found the chain empty, or the chain needs a key; a `skipped`
chain the wallet used shows up as part `skipped` above. When a read failed on a chain the wallet used
(the chain, or its `oldest` page), the findings that pick one chain's funder out of all of them
(`shared_funder`, `busy_funder`, `unique_funder`) wait for a full read: another chain never takes the
unread one's place. A gap in the explorer's index is the same every scan and holds
nothing back.

## RelatedAddress

```ts
{ address, confidence /* 0..1 */, level?: 'likely' | 'possible' | 'weak', reasons: string[], chainIds: ChainId[], label? }
```

`level` is set on every entry of `ScanResult.linkedWallets`: **likely** at 0.70 and up, **possible**
at 0.45 and up, else **weak**. The edges are exported as `LINK_LEVELS` (and `linkLevel(c)`) from the
package; never hardcode them.

## ChainCoverage

| field | meaning |
|---|---|
| `chainId`, `name` | |
| `status` | `scanned`, `no_activity`, `partial` (some data missing), `error`, `skipped` (not read: a chain outside the register, or a keyed chain whose key the relay lacks) |
| `source` | `blockscout`, `routescan`, `etherscan`, `nodereal`, `alchemy` (Base and Polygon PoS on a server, `keyedAlts`) or `rpc` |
| `txCount`, `tokenTransferCount` | how much was read |
| `internalTransfers` | `full`, `none` (the chain has no traces), `not_fetched` |
| `truncated` | history was cut at the page limit, or a later page could not be read (then `missing` has `older transactions (time limit)` or `older token transfers (time limit)`, and the pages read before it count); older activity not read |
| `limitations` | plain sentences to show the user |
| `missing` | parts that should have been read but were not, e.g. `internal transfers`; not empty means `partial`. `transactions (the explorer lists none of the 23 this address sent here)` means the explorer's index has a gap: the chain's RPC says the address sent transactions that the full list does not show. `incomplete` then carries it as `part: 'chain'` |
| `skipReason` | for a `skipped` chain that only the relay reads (BNB Smart Chain): `no_key`, the relay has no key for it, or there is no relay this page may use (it serves nymra.si only); `quota`, the relay's daily quota is spent and comes back at 00:00 UTC. A retry helps with neither |
| `precheck` | `{ sent, holds }` from the quick RPC check before reading: transactions the address sent on this chain (its nonce; 0 for a contract) and whether it holds the chain's coin. Absent when the check did not run or did not answer. `sent > 0` is what the site counts as an active chain |
| `firstSeen`, `lastSeen` | unix seconds |
| `durationMs`, `error` | |

Robinhood Chain (4663) always carries this limitation: no traces and no archive state, so
internal ETH transfers and the original funding are invisible there. Token transfers are complete.

## Progress events

| `type` | payload | when |
|---|---|---|
| `start` | `address`, `chainIds` | right away |
| `chain` | `coverage` | each chain finished (or failed) |
| `finding` | `finding` | each finding as soon as it is known |
| `partial` | `result` | a full, renderable result after each chain and each detector pass |
| `done` | `result` | the end; same object `scan()` resolves to |

Render `partial` results as they come: the first one lands within a few seconds.

## Data sources (preflight 2026-10-15)

**Choice: the scan runs in the user's browser, keyless.** The browser asks the explorers and RPC
nodes itself, so they see the user's IP address together with the scanned address, and rate limits
fall per user, not on one shared key. A Nymra server (the relay, `nymra.si/p`) sees the address only
when an explorer refuses the browser and that one request is retried through it, and for the two
keyed chains; it keeps no log. Node runs the same code for tests and a future API, minus the
Cloudflare-walled chains (see below).

| source | used for | key | CORS | verdict |
|---|---|---|---|---|
| Blockscout REST `/api/v2/addresses/<a>/{transactions,token-transfers,internal-transactions}` | history on every chain with a Blockscout explorer | none | `*` | **primary**. 50 rows a page, keyset paging, 180 requests a minute per instance. Each row says whether the other side is a contract and carries its public tags (exchange labels) |
| Blockscout Etherscan-compatible `/api` | | none | `*` | **not used**: keyless it allows about 10 requests an hour per IP |
| Blockscout `/api/v2/addresses/<a>` | primary ENS name, public tags, contract flag | none | `*` | used once per scan on Ethereum |
| Blockscout BENS `bens.services.blockscout.com/api/v1/1/...` | ENS names, namehash, resolver | none | echoes origin | used for ENS |
| `ethereum-rpc.publicnode.com` | ENS text records (`text()` eth_call) | none | `*` | used for ENS records |
| Routescan `api.routescan.io/v2/network/mainnet/evm/<id>/etherscan/api` | Avalanche (and Ethereum's second source) | none | `*` | used where Blockscout has no instance |
| Etherscan V2 `api.etherscan.io/v2/api` | a gap in Polygon PoS's own index | in the relay | `*` | **used through the relay only**, with its key, once per chain when the explorer lists fewer sent transactions than the nonce says. Without a key it answers one request per 5 s per IP, and not for every chain (measured 2026-10-17: Base, BNB Chain, OP and Robinhood Chain answer that they are not supported, Arbitrum and Polygon ask for a key) |
| Blockscout metadata service (labels) | | none | no CORS header | not usable from the browser |
| Ankr Advanced API | | key required now | | not used |
| Label dataset [`dawsbot/eth-labels`](https://github.com/dawsbot/eth-labels) (MIT, updated 2026-09) | CEX hot wallets and known deposit addresses | none | bundled | **used**: 41k exchange addresses, filtered into `src/data/cex.json`. Lookups happen locally |

**Cloudflare wall.** `base`, `arbitrum`, `polygon` and `robinhoodchain` Blockscout answer a Cloudflare
challenge (403) to curl and Node, from this Mac and from a NY server. From a real Chrome the same
`fetch()` returns 200 with JSON (tested headless Chrome with a normal user agent, 2026-10-15). So these
chains work in the browser scan and are marked `cf` in the register. In Node they come back as
`status: error` unless `opts.proxy` is set.

**Robinhood Chain (4663).** In the browser its Blockscout gives the full tx list and token
transfers. The chain has no traces and no archive state, so internal ETH transfers (and with that,
funding paid out by a contract) are invisible. Every result carries that limit in `coverage`.

**BNB Smart Chain** has no keyless source: the relay reads it with its key (see below).
Without a key, without a relay this page may use, or when the relay's daily quota is spent
(until 00:00 UTC), it shows in `coverage` as `skipped` with `skipReason`, never as a failed read;
where the quick check saw the wallet send or hold something there, `incomplete` carries part
`skipped`, so the score is partial. A keyless chain that only fell back to the relay and met its spent quota stays a failed
read: its own explorer answers again after its window.

**Rate limit (measured 2026-10-15).** Blockscout's keyless limits differ per API: the REST `/api/v2`
allows 180 requests a minute **per instance** (`x-ratelimit-limit: 180`, `x-ratelimit-reset` in ms,
about 60 s windows; each instance counts on its own, measured on 5 instances at once), the
Etherscan-compatible `/api` only 10 an hour. So the scan uses only `/api/v2`, and:

- one batched RPC call (nonce + balance) per chain first; an empty chain costs no explorer call;
- per active chain the three lists in parallel, paged 50 at a time, up to 500 transactions, 250
  token transfers and 50 internal transfers (one try, up to 90 s: Base needed 43 to 59 s for vitalik.eth),
  plus one page of the oldest for a long history, started as soon as the history is known to be long. The
  caps are counts, not a time budget, so two scans of the same wallet read the same rows;
- an address that is no person (code on any chain read, a bundled exchange or service label, 50,000 or
  more transactions sent on one chain, or the explorer's own exchange tag on its rows) reads only its
  newest page per chain: 50 transactions, token transfers only where it has no transaction, no internal
  transfers and no oldest page. Its card has no score and shows its names and where it is active, which
  that page holds. The scan cuts every chain to this shape however early it learned what the address is,
  so two scans still read the same rows; `opts.readAll` reads such an address in full;
- Ethereum's internal list asks its second source (Routescan) after 3 s without an answer, or at once
  when the first fails; the first answer counts;
- **pacing per host**: `x-ratelimit-remaining` and `x-ratelimit-reset` are CORS-exposed, so the
  browser reads them; with 4 or fewer requests left, new requests wait for the window instead of
  running into a 429. At most 4 requests run at once per host;
- **retries**: a 429 waits for `Retry-After` or `x-ratelimit-reset` (up to 65 s; with a fallback
  proxy configured, up to 10 s, then the proxy); 5xx, timeouts and network errors retry with
  exponential backoff and full jitter (400 ms base, 8 s cap, 3 retries);
- **a limit every user shares**: a keyed source through the relay (BNB Smart Chain's NodeReal, one key
  for every visitor) that answers `-32005` with the words of a rate (at its compute units a second,
  HTTP 200) or a 429 is waited out for up to a minute per request without spending those retries, in
  turns of half a second plus a random part that widens fast (at most 24), so the waiting visitors
  spread out. A public node's own `-32005` on this visitor, and a relay that is itself limited on a
  fallback read, keep the 3 retries; a `-32005` about a query that is too large is an answer;
- a bot wall (403 with an HTML challenge, or HTML instead of JSON) is not retried on the same road:
  Ethereum switches to Routescan, other chains use the fallback proxy when configured;
- extra lookups (funders, deposit addresses) have a fixed budget of 14, never sized to the quota
  left, so a wallet gets the same checks on every scan;
- every scan has a budget of 600 requests and a time limit of 150 s;
- answers are cached in memory for 10 minutes (`opts.cache: false` to read again,
  `clearSessionCache()` to forget): scanning the same wallet again in the same page costs no
  requests and gives the same result;
- anything that still could not be read is listed in `incomplete`, and the result is `partial`.

A typical wallet active on 3 chains costs about 25 to 40 requests, well under 180 a minute per explorer.

**The relay** ([`proxy/`](proxy), served by the website at `https://nymra.si/p`). The scan uses it
after a refusal it cannot wait out (a bot check, or a 429 window longer than 10 s), for the two
keyed chains, and for servers. It reads Blockscout through the PRO API with one key. See
[`proxy/README.md`](proxy/README.md) for its rules and its setup.

**What the relay's key buys (measured 2026-10-16).** Blockscout PRO prices a call in credits: 20 by
default, 30 for `token-transfers`, 40 for `internal-transactions`
([docs.blockscout.com/rate-limits](https://docs.blockscout.com/rate-limits)). The plan the relay uses has
100,000 credits a day (5 a second), Builder 100 million a month for $49 (15 a second). The scan
counts its own calls per kind (`stats.byKind`); a scan whose every Blockscout call goes through the
relay (a user that every explorer refuses) costs:

| wallet (measured) | transactions | token transfers | internal | address | credits | current plan, scans a day | Builder, scans a day |
|---|---|---|---|---|---|---|---|
| vitalik.eth, 15 active chains, histories cut at 500 | 91 | 47 | 12 | 1 | 3,730 | 26 | about 880 |
| TYPICAL_ROW |

Routescan (Avalanche), the public RPC nodes and BENS are keyless and cost nothing. Most scans
need the relay for a few calls or none, so a day of the current plan covers far more scans than the
table: it is the floor, for the worst case of a fully refused IP. Builder (100 million credits a
month, about 3.3 million a day) is a decision for later; the current plan is the one in use.

The keyed chain: BNB Smart Chain through NodeReal MegaNode (10 million compute units a month;
`nr_getTransactionByAddress` costs 250, a BNB scan 2 to 4 calls, so about 10,000 to 20,000 BNB
scans a month).

The keyed second source: Base and Polygon PoS through Alchemy's Transfers API, on a server only
(`opts.keyedAlts: ['alchemy']`, which the bot and the ASI agent pass when their relay holds the key).
A server meets Cloudflare's wall on both explorers, and Blockscout PRO's current plan no longer serves
them (402, measured 2026-10-17). One call lists one side of one list (`fromAddress` or `toAddress`:
both together would mean "from A to B"), so a wallet's three lists are six calls per chain, merged
newest first; `excludeZeroValue: false`, because Alchemy leaves out every transfer of value 0 unless
asked, and a contract call without value is a transaction too. Its plan: 30 million compute units a
month and 300 a second per app; a call costs 120, so a scan of both chains costs about 1,500 to 2,000
and the relay starts Alchemy calls at most 2 a second. Like NodeReal, Alchemy gives no calldata and no
explorer labels: those rows are `blind`, contracts are only recognised by their tokens, and there is
no funder check around a date. The quick nonce check still holds it to the chain: a list that misses
transactions the wallet sent makes the chain unread, never a score from half a history.

### Chain register

[`src/chains.ts`](src/chains.ts): one line per chain. Default on: Ethereum, Base, Arbitrum One,
OP Mainnet, Polygon PoS, Robinhood Chain, Avalanche, ZKsync Era, Scroll, Unichain, Gnosis,
Ink, Soneium, Celo. More EVM chains (World Chain, Mode, Arbitrum Nova, MegaETH, Lisk, Shape, Manta,
Immutable, Rootstock, Ronin, Astar, Aurora, Flow EVM, Filecoin EVM) are in the register and scan
when passed in `opts.chainIds`.
