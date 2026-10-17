# Real wallet checks

Run on 15 October 2026, 20:05 to 20:15 UTC, with `node scripts/browser-proof.ts`: the scan runs
inside headless Chrome exactly as on the website (keyless, straight from the browser to the
explorers), default chain set (15 chains scanned, BNB Chain and Linea listed as skipped).
Engine 0.1.0, rules 1.0.0.

Two ordinary wallets were picked at random from recent blocks (one on Ethereum, one on Robinhood
Chain). Their addresses are left out of this public file on purpose.

## Results

| wallet | expected | score | band | first result | full result | requests | verdict |
|---|---|---|---|---|---|---|---|
| vitalik.eth `0xd8dA...6045` | public person, fully exposed | 27 | exposed | 0.55 s | 17.8 s | 185 | correct |
| Binance 14 hot wallet `0x28C6...1d60` | exchange wallet, publicly labelled | 34 | exposed | 0.09 s | 14.4 s | 96 | correct |
| USDC token contract `0xA0b8...eB48` | a contract, not a person | 92 | private, marked contract | 0.11 s | 17.4 s | 162 | correct |
| fresh never-used address `0x5b2e...9e0b` | nothing to see | 100 | private | 0.05 s | 0.3 s | 17 | correct |
| ordinary Ethereum wallet (Ethereum and Base) | some leaks, no identity | 77 | moderate | 0.05 s | 3.1 s | 49 | plausible |
| ordinary Robinhood Chain wallet (Robinhood and Ethereum) | some leaks, no identity | 77 | moderate | 0.04 s | 17.0 s | 39 | plausible |

"First result" is the first `partial` event, ready to render. The full result includes the extra
lookups (funders, deposit addresses). Every scan finished under 20 s; the target was a first result
within 20 s.

## What each scan found

**vitalik.eth** (score 27). ENS primary name `vitalik.eth` (critical, -22) and ENS records for X,
GitHub and a website (-8, capped). Transfers with Binance, Coinbase and SideShift (-8). Activity on
all 15 scanned chains (-8). Sent the very first funds to 2 fresh wallets (-8, confidence 0.6, worded
as a likelihood). 64% round outgoing amounts (-7). Same first funder on ZKsync Era and Scroll
(-7). A quiet window of 21:00 to 07:00 UTC, read as UTC+0 to UTC+2 (-5). Owns other ENS names, and
delegates to `AmbireAccount7702` via EIP-7702, which shows the wallet app (both 0 points, cap reached).
Expected: a famous, named wallet scores exposed. It does.

**Binance 14** (score 34). Publicly labelled as a Binance exchange wallet (critical; the named-wallet
ceiling applies, so this finding carries -38). First funds came from another Binance wallet (-14).
Active on 11 chains (-8). Transfers with Binance and Coinbase wallets (-6). Expected: a known
exchange wallet is identified. Before the ceiling existed it read 58 to 62 (traceable or moderate),
which would have misled a user; that run is why the ceiling is in the rules.

**USDC contract** (score 92). Recognised as a contract (`USDC`), so only the identity and cross-chain
rules run: active on 14 chains (-8). No person-style findings. Expected.

**Fresh address** (score 100). One RPC call per chain (nonce and balance) found nothing, so no
explorer was asked for history. 17 requests, 0.3 s. Expected.

**Ordinary Ethereum wallet** (score 77). Back and forth with one personal wallet, 4 out and 4 in
(-12, confidence 0.83, worded as a likelihood). A quiet window of 02:00 to 10:00 UTC, read as UTC-4
to UTC-2 (-7). Active on Ethereum and Base (-4). Plausible for a normal user.

**Ordinary Robinhood Chain wallet** (score 77). Robinhood Chain read in the browser through its
Blockscout (transactions and token transfers; internal transfers marked as not available on this
chain). A bridge match: 0.108 ETH out on Robinhood Chain, 0.107 ETH in on Ethereum one minute
later (-6, confidence 0.75). Quiet window read as UTC+1 to UTC+3 (-6). One transfer with a labelled
exchange (-4). Active on 2 chains (-4). Half of its transfers with personal wallets go to 3 wallets
(-3). Plausible.

## Timing per chain (vitalik.eth, the heaviest)

Polygon 4.5 s, Arbitrum 7.4 s, OP 7.6 s, Ethereum 9.8 s, Base 11.4 s, ZKsync Era 14.9 s,
Robinhood Chain 12.3 s, Celo 10.8 s, the rest under 6 s. Big histories are read newest first
within a 10 s paging budget per chain, so the explorers' speed sets the total, not the wallet size.

## Limits seen

- Robinhood Chain's explorer is the slowest (about 12 s for a few hundred transfers) and, like
  Base, Arbitrum and Polygon, only answers a real browser. From Node these four come back as
  `error` unless a proxy is set.
- Keyless Blockscout allows 180 requests a minute per explorer. The vitalik.eth scan alone used
  185 requests across 15 explorers; four heavy scans in a row brought the lowest headroom down to
  20. A user who scans many big wallets back to back can hit a 429; the scan then shows the chain
  as `error` (or uses the fallback proxy if configured).
- Results depend a little on explorer speed: when the oldest page of a huge history times out, the
  funding of that chain is not known for that run.
