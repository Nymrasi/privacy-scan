# privacy-scan

**The engine behind the Nymra Privacy Score, with every rule and the score formula in the open.**
Give it an EVM address: it reads the public
history on every supported chain and returns a Privacy Score from 0 to 100, with findings in plain
language about what links the wallet to other wallets, exchanges and names.

Nymra's first tools run on it, inside the browser. It reads public explorer APIs on each EVM chain
Nymra covers, such as Ethereum, Base and Polygon, most of them without a key.
BNB Smart Chain needs a key, which lives in the relay, never in the browser.

> A link between wallets is always a likelihood with a confidence. This engine never states who owns
> a wallet: its explanations say "likely", never "this is your wallet".

- [`RULES.md`](RULES.md): the score formula and every rule, with its thresholds.
- [`SCHEMA.md`](SCHEMA.md): the result format, the data sources and the rate limits.
- Docs for people: [nymra.si/docs](https://nymra.si/docs/).

## What it finds

| Detector | Looks for | Cap |
|---|---|---|
| `public_identity` | A primary ENS name, its text records, other names the address owns, public labels | 30 |
| `linked_wallets` | Back and forth transfers, wallets this address funded first, a shared exchange deposit address | 25 |
| `funding_reuse` | Whose coins paid for the first transaction on each chain, and the other wallets that wallet funded | 20 |
| `cex_exposure` | Funding from an exchange, transfers with exchange wallets, deposit addresses | 20 |
| `cross_chain` | One address on several chains, bridge transfers that match on both sides | 12 |
| `behavioral_fingerprint` | Active hours, round amounts, fixed gas, a fixed rhythm, the wallet app | 12 |
| `recurring_counterparties` | A few personal wallets that make up most of the transfers | 10 |

The cap is the most points a detector can take off the score.

## The score

Every wallet starts at 100. A finding costs `round(severity points × confidence)`; within a detector
the costliest finding counts first, and a detector never takes more than its cap. The score is what
is left, never below 0.

| Severity | info | low | medium | high | critical |
|---|---|---|---|---|---|
| Points at confidence 1.0 | 0 | 4 | 8 | 14 | 22 |

Bands: **private** 80 to 100, **moderate** 60 to 79, **traceable** 35 to 59, **exposed** 0 to 34.
A wallet with a public label (an explorer name tag or an open label list, at confidence 0.9 or more)
never scores above 34. An ENS name does not set that ceiling: anyone can make one up, so it costs its
own points (medium) and no more. Every finding carries the points it cost (`scoreImpact`), and they add up exactly to
`score - 100`. Every link between wallets carries a word for its confidence: likely from 0.70,
possible from 0.45, else weak (`LINK_LEVELS`).

## Privacy by design

- The scan runs in the browser and reads public block explorers (Blockscout, Routescan) and public
  RPC nodes directly. A request takes the relay in [`proxy/`](proxy) only when an explorer
  refuses the browser (a rate limit or a bot check), and for the two keyed chains. The relay answers
  only our own site, forwards to register hosts only and keeps no log of a URL, an address or an IP.
- The exchange and service label lists ship with the engine, so a label lookup stays on the device.
- A wallet that serves everyone (an exchange, a bridge, a router, a bot, a faucet, a market maker) is
  never counted as a link between wallets.
- The engine sends no telemetry and never logs a URL, because a URL carries the address.

## Use

In a browser app, with a bundler (Vite, esbuild, Rollup):

```ts
import { scan } from '@nymrasi/privacy-scan';

const result = await scan('0x...', {
  onProgress: (e) => {
    if (e.type === 'partial' || e.type === 'done') render(e.result);
  },
});
console.log(result.score, result.band, result.findings);
```

Install it from GitHub: `npm install github:nymrasi/privacy-scan`. The bundle is about 550 KB
minified, 330 KB gzipped (280 KB with Brotli), most of it the two label lists: load it with a
dynamic `import()` on the scan page. For UI work without network, `mockScan` streams one of the
results in [`fixtures/`](fixtures/).

Options worth knowing: `relay: 'https://nymra.si/p'` (the relay for refusals and the keyed chains),
`chainIds`, `signal`, `cache: false` (scanning the same wallet again in the same page normally reads
a 10-minute memory cache and costs no requests), and on a server `keyedAlts: ['alchemy']` when its
relay holds an Alchemy key (Base and Polygon PoS are then read through Alchemy; see below).

From Node, run it from a clone: Node 23.6+ runs the TypeScript as is, but it does not strip types
from files inside `node_modules`.

```sh
cd privacy-scan
node scripts/scan.ts 0xd8da6bf26964af9d7eed9e03e53415d37aa96045
node scripts/scan.ts 0x... 1,8453 --json
```

From Node or a server, the Base, Arbitrum, Polygon and Robinhood Chain explorers answer a bot
challenge; they work from a browser. A server reads them through the relay (it uses Blockscout's PRO
API with its own key); see [`proxy/README.md`](proxy/README.md). The relay's PRO plan no longer serves Base
and Polygon (402 "Featured chain ... requires one of the following plans", measured 2026-10-17), so a
server whose relay holds an Alchemy key passes `keyedAlts: ['alchemy']` and reads those two through
Alchemy's Transfers API instead. Like NodeReal it gives no calldata and no explorer labels, and the
coverage of both chains says so. The browser never passes it and reads their own explorers.

## Chains

Every EVM chain Nymra covers has one line in [`src/chains.ts`](src/chains.ts); the ones marked
`defaultOn` are scanned by default, and every count comes from the register. BNB
Smart Chain (through NodeReal) is read through the relay, which holds a key for it; without a
relay this page may use, it shows as skipped, with the reason.

**Robinhood Chain (4663):** transaction logs are complete, but the chain has no traces and no
archive state, so internal ETH transfers, and funding paid out by a contract, are invisible there.
Every result says so in its coverage.

**Rate limits:** keyless Blockscout allows 180 requests a minute per explorer. The scan checks each
chain with one RPC call first, reads fixed page counts per active chain (so the same wallet always
reads the same data), paces itself on the explorer's `x-ratelimit-remaining`, waits out a 429
(`Retry-After` or `x-ratelimit-reset`) with backoff and jitter, and has a fixed budget for extra
lookups. Whatever still could not be read is listed in `incomplete`, and the result is `partial`.
A typical wallet active on 3 chains costs 25 to 40 requests.

## Limits

- It reads EVM chains only. An address that is not `0x` with 40 hex characters is refused, so a
  Bitcoin or Solana wallet cannot be scanned.
- A chain it could not read counts as not read, never as a chain without activity. The result is
  then `partial` and lists what is missing, and its score is computed from what was read only.
- On a long history it reads the newest 500 transactions, 250 token transfers and 50 internal
  transfers per chain, plus the oldest 50 for funding, and marks the chain `truncated`. What lies
  in between is not read. A contract, a service or a bot gets no score and reads only its newest
  50 transactions per chain.
- A link between two wallets is a likelihood with a confidence (likely, possible or weak), and a
  high confidence is still not proof. The engine never says who owns a wallet.
- It uses public data only: what explorers and nodes show about the chain, and open label lists.
  Whoever holds private records, such as an exchange that knows its customers, can link more than
  this scan shows.
- Explorers and nodes sometimes answer late, stop answering for a while once their limit is hit, or
  leave transactions out of their index. The scan waits and tries again, notices a gap when a
  chain's node counts clearly more sent transactions than its explorer lists, and reports whatever
  it still could not read.
- The exchange and service lists and the explorers' name tags are far from complete, and a tag can
  be wrong. An exchange wallet that is on no list is read as a personal wallet, unless its own
  transaction count marks it as a service.
- Robinhood Chain has no traces, so internal transfers there stay invisible, and every result on
  that chain says so.

## Develop

```sh
npm install          # TypeScript and Node types, for type checking only
npm test             # node --test, no network
npm run typecheck
node scripts/build-cex.ts                       # rebuild the exchange label list
node scripts/build-services.ts                  # rebuild the service label list
node scripts/make-fixtures.ts                   # rebuild the mock results
node scripts/browser-proof.ts out.json 0x...    # real scans in headless Chrome
```

A change to a rule updates `RULES.md` and `RULES_VERSION` in the same pull request. See
[CONTRIBUTING.md](CONTRIBUTING.md).

## Data and credits

- History: public [Blockscout](https://www.blockscout.com/) explorers and
  [Routescan](https://routescan.io/), keyless; quick checks over public RPC nodes, mostly
  [PublicNode](https://www.publicnode.com/).
- ENS: Blockscout's ENS service and a public Ethereum node.
- BNB Smart Chain: [NodeReal MegaNode](https://nodereal.io/meganode) (key in the relay).
  Base and Polygon PoS on a server: [Alchemy's Transfers API](https://www.alchemy.com/docs/reference/alchemy-getassettransfers)
  (key in the relay).
  A gap in Polygon PoS's own index: [Etherscan API V2](https://docs.etherscan.io/) (key in the relay).
- Exchange and service labels: [dawsbot/eth-labels](https://github.com/dawsbot/eth-labels) (MIT),
  filtered into `src/data/cex.json` and `src/data/services.json`, plus the explorer's own public tags.

## Security

Report a vulnerability to **contact@nymra.si** or through this repository's Security tab, never in
a public issue. See [SECURITY.md](SECURITY.md).

How to tell Nymra from someone posing as Nymra is in the organization's
[security policy](https://github.com/nymrasi/.github/blob/main/SECURITY.md#impersonation). The
website and the access server are not public.

## Links

[Website](https://nymra.si) | [Docs](https://nymra.si/docs/) | [X](https://x.com/nymrasi) | [Telegram](https://t.me/nymrasi)

## License

[MIT](LICENSE)
