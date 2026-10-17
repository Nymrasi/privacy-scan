# Nymra scan rules

Rules version **1.4.0** (changes per version at the end). This file explains, in full, how the Privacy Score is computed and when
each finding fires. The code that does it is in [`src/score.ts`](src/score.ts) and
[`src/detectors/`](src/detectors). If this file and the code ever disagree, that is a bug: please
open an issue.

## What the score means

The Privacy Score runs from **0 to 100**.

- **100**: nothing we can see links this wallet to a person, an exchange account or other wallets.
- **0**: the wallet is fully exposed.

It measures how easy a wallet is to follow or connect, using only public data. It does not judge
whether the wallet did anything wrong, and it never states who owns a wallet.

| score | band |
|---|---|
| 80 to 100 | private |
| 60 to 79 | moderate |
| 35 to 59 | traceable |
| 0 to 34 | exposed |

## How the score is computed

Every scan starts at **100**. Each finding takes points off:

```
points = round(severity points x confidence)
```

| severity | points at confidence 1.0 |
|---|---|
| info | 0 |
| low | 4 |
| medium | 8 |
| high | 14 |
| critical | 22 |

`confidence` is a number from 0 to 1: how sure the engine is that the finding is real. A finding
at confidence 0.5 costs half its points.

One kind of leak should not drown out the rest, so each detector has a **cap**: the most points it
can take, whatever it finds.

| detector | cap |
|---|---|
| Public identity | 30 |
| Likely linked wallets | 25 |
| Funding source reuse | 20 |
| CEX exposure | 20 |
| Cross-chain traceability | 12 |
| Behavioral fingerprint | 12 |
| Recurring counterparties | 10 |

Within a detector the costliest finding counts first. Once the cap is reached, the remaining
findings of that detector still show, at 0 points. The caps add up to more than 100, so the score
stops at 0; if that happens, the cheapest findings are trimmed first.

**Named-wallet ceiling.** A wallet with a public label (an explorer name tag or an open label list
that names it, such as "Binance 14": an exchange, a service, a known entity) is identified: anyone
can see who it is. Its score is never above **34**, the top of the exposed band, whatever else the
scan finds. When this ceiling applies, the label finding takes the extra points itself, so its
`scoreImpact` can be larger than its `rawImpact`, and the result shows `breakdown.ceiling = 34`. It
applies only at confidence 0.9 or more. An ENS name is no ceiling: anyone can make one up, so it
shows a name, not who holds the wallet.

Every finding in a result carries `scoreImpact`, the points it actually cost, and `rawImpact`, the
points before the cap and the ceiling. They add up exactly: **score = 100 + sum of scoreImpact**.

## Worked example

[`fixtures/worked-example.json`](fixtures/worked-example.json) is what the engine returns for a small
synthetic wallet (`node scripts/make-example.ts` builds it with the real detectors, no network). On
Ethereum and on Base, its first transaction was paid with coins from one personal wallet that
funded three other fresh wallets the same day; it has back and forth with one friend; it pays into
an exchange deposit address that one other wallet also uses; and it sent a fresh wallet its first
funds.

| finding | severity | confidence | raw | counted |
|---|---|---|---|---|
| `cex_exposure.deposit_address` | critical (22) | 0.80 | -18 | -18 |
| `funding_reuse.shared_funder` | high (14) | 0.75 | -11 | -11 |
| `linked_wallets.shared_deposit` | high (14) | 0.70 | -10 | -10 |
| `linked_wallets.back_and_forth` | high (14) | 0.61 | -9 | -9 |
| `funding_reuse.same_funder_multichain` | medium (8) | 0.85 | -7 | -7 |
| `linked_wallets.funded_by_you` | high (14) | 0.60 | -8 | -6 |
| `recurring_counterparties.top` | medium (8) | 0.61 | -5 | -5 |
| `cross_chain.multichain_presence` | low (4) | 1.00 | -4 | -4 |

- `deposit_address`: critical is 22 points; 22 x 0.80 = 17.6, rounded to **18**.
- `linked_wallets` finds 10 + 9 + 8 = 27 points, more than its cap of 25. The costliest count first,
  so `funded_by_you` counts **6** of its 8, and the result lists `linked_wallets` under
  `breakdown.capped`.
- The counted points add up to -70: the score is 100 - 70 = **30**, band **exposed**.
- The linked wallets carry their word: the co-sender on the deposit address at 0.70 is **likely**,
  the friend (0.61), the fresh wallet (0.60) and the three wallets with the same funder (0.75 x 0.75 =
  0.56) are **possible**.

## Links are likelihoods

When a finding says two wallets are probably related, it gives a confidence for that link and the
reason (shared funder, back and forth transfers, same exchange deposit address). A link is
**never** a statement of who owns a wallet. A wallet that pays a friend twice looks the same on
chain as a wallet that pays its owner's other wallet. When two independent reasons point at the
same wallet, the confidences combine as `1 - (1 - a)(1 - b)`, capped at 0.95.

Every link is printed with a word for its confidence. These edges are the only ones: the code
exports them as `LINK_LEVELS` in [`src/score.ts`](src/score.ts), and the docs, the site and the
animations read them from there.

| confidence | word | meaning |
|---|---|---|
| 0.70 to 1.00 | **Likely** | a strong signal, or several independent ones that agree |
| 0.45 to 0.69 | **Possible** | worth knowing; other explanations are plausible |
| below 0.45 | **Weak** | shown for completeness; it barely moves the score |

Each linked wallet in a result carries its word in `level`.

**A service is never a link.** A wallet that sends to, or funds, thousands of people says nothing about
who you are. So these are never a shared funder, a back and forth partner, a deposit sender or a
recurring counterparty:

- **exchanges**: the explorer's tags and the bundled exchange list;
- **contracts**: bridges, DEX routers, aggregators, airdrop and faucet contracts, tokens, NFT
  marketplaces, multisigs; the explorer says per address whether it holds code;
- **known service wallets** (the bundled service list, about 9,500 wallets from the open dataset
  [`dawsbot/eth-labels`](https://github.com/dawsbot/eth-labels), MIT): MEV bots, ERC-4337
  bundlers, contract deployers, bridge relayers and solvers, oracle and AVS operators, market
  makers, payment processors, faucets and payout wallets;
- **anything the explorer tags publicly** (a name tag such as "Across Protocol: Relayer");
- **busy wallets**: a wallet that sent **2,000 or more transactions** on the chain where you dealt
  with it (its own count, read from that chain's RPC) is a service or a bot, such as a bridge maker
  or a solver that no list names. A funder that sent 200 or more transactions in the 6 days around
  your funding, or funded more than 40 other wallets in that window, is a service or a distributor;
- **wallets that never send**: a back and forth partner, a deposit co-sender or another wallet your
  funder paid must have signed at least one transaction on that chain. One that never did can only
  appear through a forged token event, or it only received (a gift, an address from a tutorial). A
  fresh wallet you funded that never sent anything is a weak link at most (see `funded_by_you`);
- **look-alikes** (see "Address poisoning" below).

**Only real transfers count.** A token contract can write any transfer it likes into any history,
so "you sent 500 USDT to X" may never have happened. A token transfer you did not sign counts only
when the token is real: priced on the explorer, held by 10,000 or more addresses, or one of the
major tokens listed by contract address in [`src/detectors/context.ts`](src/detectors/context.ts)
(for the sources that give no prices). An incoming token also counts when you sent that same token
yourself. A symbol proves nothing: anyone can deploy a token called "USDT".

## Address poisoning (a warning, not a finding)

Scammers create addresses that start and end like yours, or like a wallet you often pay, and send
you dust or fake token transfers from them, hoping you later copy one from your history. An address
is a **look-alike** when it shares at least the first 3 and last 4, or the first 4 and last 3, hex
characters with your address or with one of your counterparties (two random addresses match like
that about once in 130 million pairs). Of two look-alike counterparties, the original is the one you
sent more to; on a tie, the one that appeared first, because a poisoner reacts to a real transfer.
Precompiles and system contracts (an address with 30 or more leading zero hex characters, such as
`0x...01` or ZKsync's `0x...8001`) all look alike by design and are never a look-alike.

A look-alike is **never** a linked wallet. The scan lists them in `warnings` (`address_poisoning`),
each with the address it imitates, and they cost no points. Always print them in full: shortened,
a look-alike reads exactly like the real address.

## The rules

### Public identity (`public_identity`)

| rule | fires when | severity | confidence |
|---|---|---|---|
| `ens_reverse` | the address has a primary ENS name | medium | 1.0 |
| `ens_records` | that name carries text records such as X (Twitter), GitHub, website, email, Discord, Telegram, LinkedIn, Farcaster, name or location | high (medium if only name or location) | 0.95 |
| `owned_names` | the address owns ENS names other than its primary name | low (medium without a primary name) | 0.9 |
| `public_label` | an explorer name tag or an open label list names the address | critical | 1.0 |
| `is_contract` | the address is a smart contract (an EIP-7702 wallet counts as a wallet) | info | 1.0 |

For a contract, and for an address that is itself a service, only the public identity and
cross-chain rules run: their traffic says nothing about a person's habits, and they make no links.
An address is a service when the bundled lists name it (an exchange wallet or deposit address, a
bridge, bot or other service wallet), when the explorer tags it as an exchange, a deposit address or
an MEV bot, or when it sent **50,000 or more transactions** on one chain (no person signs that
many). The result says so in `identity.service`.

A name that merely points at an address, but is owned by someone else, is ignored: anyone can
point a name at any address.

### Likely linked wallets (`linked_wallets`)

| rule | fires when | severity | confidence |
|---|---|---|---|
| `back_and_forth` | a personal wallet (it signed a transaction to you, or you sent it plain value) both sent to and received from you, at least 3 transfers in total. Exchanges, contracts and services are excluded | high at 0.6 and up, else medium | `min(0.85, 0.35 + 0.08 x min(in, out) + 0.02 x (in + out))` |
| `funded_by_you` | among the wallets you sent plain value to (up to 5 checked), one has a short history (under 50 transactions, so we see all of it) whose first incoming funds were your transfer | high | 0.6; 0.3 for a wallet that never sent a transaction itself (a gift, a payment or a cold wallet) |
| `shared_deposit` | another wallet pays into the same exchange deposit address as you (exchange gas top-ups, contracts, token contracts, services, look-alikes and fake tokens excluded) | high (medium when the deposit address has more than 6 senders) | 0.8 for a listed deposit address, 0.7 for a detected one; 0.35 / 0.3 with more than 6 senders. Each deposit address keeps its own confidence |

### Funding source reuse (`funding_reuse`)

**The funder** on a chain is the wallet whose coins paid for the first transaction the address
signed there. Nothing leaves a wallet without its signature, so all the native coin (ETH, POL, AVAX
...) that came in before that transaction, in plain transfers or contract payouts, was still there
when it was signed. The funder sent the **earliest single transfer that could pay for it on its
own** (at least its value plus its gas limit times its gas price, what the network required the
wallet to hold to send it), counting only transfers of at least **10%** of everything that came in
before it. So:

- on a chain where the address never signed a transaction there is **no funder**, whoever sent it
  coins: those are gifts or dust, not a trail it left;
- dust and sprinkles are never the funder, also on a chain where dust covers the gas: they are far
  under 10% of the real money (vitalik.eth on Base got 0.0000029 ETH from a sprinkler
  three months after the 0.016 ETH that paid);
- a deposit from the address's own L1 account (Arbitrum and the OP Stack show the L1 sender as its
  address plus `0x1111...1111`) means it funded itself: no funder;
- when no single transfer qualifies (several small deposits), when the first transaction is older
  than what was read, or when funding paid out by a contract long ago is no longer listed, the
  funder is unknown and no funding finding fires;
- when a read failed on a chain the address used (the chain itself, or the oldest page of a long
  history), `shared_funder`, `busy_funder` and `unique_funder` do not fire in that scan: they pick
  one chain's funder out of all of them, and another chain must not take the unread one's place.
  The result lists that chain as not read. A gap in the explorer's index is the same in every scan
  and holds nothing back.

| rule | fires when | severity | confidence |
|---|---|---|---|
| `shared_funder` | the funder is a personal wallet and sent plain value to `k` other personal wallets (1 to 40) within 3 days of funding you, each of which sent a transaction there itself | `k` = 1: medium; 2 to 15: high; 16 to 40: medium | `k` = 1: 0.55; 2 to 5: 0.75; 6 to 15: 0.55; 16 to 40: 0.35 |
| `same_funder_multichain` | the same personal funder (not an exchange, contract, service or busy funder) paid for your first transaction on 2 or more chains. One finding for the rule, every such funder in its evidence | medium | 0.85 |
| `busy_funder` | the funder sent 200 or more transactions in that 6-day window, or funded more than 40 other wallets in it (a service, a bot or a distributor) | low | 0.5 |
| `unique_funder` | we looked and the funder funded nobody else in that window | info | 0.8 |

Each wallet found by `shared_funder` is listed as a linked wallet at 0.75 times the finding's
confidence. A funder that is an exchange is reported under CEX exposure instead. Up to 4 funders
are checked per scan.

### CEX exposure (`cex_exposure`)

| rule | fires when | severity | confidence |
|---|---|---|---|
| `funded_by_cex` | your first transaction on a chain was paid with coins from an exchange wallet (see "The funder") | high | 1.0 |
| `direct` | transfers to or from known exchange wallets | medium at 3 or more, else low | 1.0 |
| `deposit_address` | you sent to an exchange deposit address: either listed as one, or seen forwarding at least 60% of what it sends to exchange wallets | critical (high when the address has more than 6 senders) | listed 0.92, detected 0.8; with more than 6 senders 0.7 / 0.6 |

Exchange wallets come from the explorer's own public tags and from the open dataset [`dawsbot/eth-labels`](https://github.com/dawsbot/eth-labels)
(MIT): about 5,000 exchange wallets and 30,000 known deposit addresses across 338 exchanges. The
list ships with the scanner, so label lookups never leave your device. Up to 5 candidate deposit
addresses are checked per scan.

### Cross-chain traceability (`cross_chain`)

| rule | fires when | severity | confidence |
|---|---|---|---|
| `multichain_presence` | the address **sent** transactions on 2 or more chains (the chain's own count from its RPC, or a transaction it signed). Coins and tokens that others sent to it do not count | medium at 4 or more chains, else low | 1.0 |
| `received_only` | others sent to the address on a chain where it never sent a transaction | info | 1.0 |
| `bridge_match` | an amount (at least 0.001) leaves one chain and 0% to 3% less of the same asset (ETH-like native coin, or the same stablecoin) arrives at this address on another chain within 45 minutes | medium | `min(0.85, 0.55 + 0.1 x (matches - 1))` |

### Behavioral fingerprint (`behavioral_fingerprint`)

| rule | fires when | severity | confidence |
|---|---|---|---|
| `timezone` | at least 25 transactions you signed, with a run of 5 to 12 near-silent hours (each hour at most 2% of activity) | medium at 0.6 and up, else low | `min(0.9, 0.3 + 0.05 x (hours - 5) + 0.4 x min(1, transactions / 100))` |
| `round_amounts` | at least 8 outgoing transfers and 40% or more are round (at most 2 significant digits, like 0.05, 1.5 or 20; stablecoins: multiples of 10) | medium at 60%, else low | `min(0.9, 0.4 + transfers / 60)` |
| `fixed_gas` | at least 10 contract calls and 50% or more use one exact gas limit across 2 or more different functions; or, on Ethereum, 50% or more of at least 10 transactions paid one exact gas price | low | `min(0.85, 0.4 + share / 2)`, or 0.7 |
| `fixed_timing` | at least 10 transactions, a typical gap of 5 minutes or more, and 60% of gaps within 3% (at least 60 s) of it | low | `min(0.85, share)` |
| `wallet_software` | the address delegates to a smart account (EIP-7702), which names the wallet app | low | 0.9 |

The time zone assumes the silent hours are night, centred on 03:00 local time, and is reported as a
range of plus or minus one hour.

### Recurring counterparties (`recurring_counterparties`)

| rule | fires when | severity | confidence |
|---|---|---|---|
| `top` | at least 10 transfers with personal wallets (contracts, exchanges and services excluded), the top 3 carry 40% or more, and the top one has at least 4 | medium at 60%, else low | `min(0.9, 0.5 + transfers / 100)` |

## What the scan reads, and its limits

- The scan runs in your browser and asks public block explorers (Blockscout, Routescan) and public
  RPC nodes directly. Like any website you visit, they see your IP address together with the
  address you scan.
- Nymra's relay at `https://nymra.si/p` sees the address only when an explorer refuses your browser
  (a rate limit or a bot check): that one request is retried through the relay. BNB Smart Chain and
  Linea always go through it, because it holds their free API keys. The relay keeps no log (no URL,
  no address, no IP) and forwards only to the hosts in the chain register.
- Per chain it reads the newest 500 transactions, the newest 250 token transfers and 50 internal
  transfers, plus the oldest 50 for funding. A longer history is marked `truncated`. These are
  counts, not a time limit, so two scans of the same wallet read the same data. An explorer gets up
  to 90 seconds for the internal transfers (Base needed 43 to 59 for vitalik.eth's).
- When something could not be read (a rate limit, a timeout, a bot check), the result is
  `partial` and lists what is missing. A partial score is computed from what was read only.
- When a chain's RPC says the address sent transactions there but the explorer's complete list
  shows none of them (or far fewer: at least 3 and more than 10% missing), the explorer's index has
  a gap. The chain is `partial`, never "no activity", and the result says how many are missing.
- A chain where the address never sent a transaction and holds no native coin is checked with one
  cheap RPC call and not read further. Tokens it only received there are not listed.
- Token transfers count only when they really happened (see "Only real transfers count"), so
  airdrop spam and address poisoning do not create links.
- **Robinhood Chain** has no traces and no archive state: internal ETH transfers, and funding paid
  out by a contract, are invisible there.
- **BNB Smart Chain and Linea** have no free keyless explorer API: they are read through the relay,
  which holds a free key for each. Without the key they show as `skipped`, with the reason, never as
  a failed read.
- Every result lists, per chain, what was read and what was not (`coverage`).

## Changes

### 1.4.0 (2026-10-17)

- **ENS names**: an ENS name can be made up, so it no longer marks a wallet as identified. A primary
  ENS name (`ens_reverse`) is medium (8 points), no longer critical (22), and it no longer sets the
  named-wallet ceiling. Its records with real handles (X, GitHub, email, website, Telegram, LinkedIn,
  Farcaster, Discord) stay high, above the bare name, because they lead to an account. Owned names
  stay low. The ceiling of 34 now comes from a public label only (an exchange, a service, a known
  entity), because a label says who it is.

### 1.3.0 (2026-10-16)

- **Funding**: the funder sent the earliest transfer that could pay for your first transaction on its
  own, counting only transfers of at least 10% of what came in before it; no longer the latest one in
  the 30 days before. Dust that lands after the real money (a sprinkler on Base) is never the funder,
  and money that sat for months before the first transaction still counts. Your own deposit from L1
  is no funder. The words say what is measured: "your first transaction was paid with coins from".
- **Unread funding**: when a read failed on a used chain, `shared_funder`, `busy_funder` and
  `unique_funder` wait for a full read instead of picking another chain.
- **Wallets that only received**: another wallet your funder paid must have sent a transaction
  itself; a fresh wallet you funded that never sent one is at most a weak link (0.3).
- **Services**: an exchange wallet or deposit address, a listed bridge, bot or service wallet, an
  address the explorer tags as one, or one with 50,000 or more transactions on a chain gets only the
  identity and cross-chain rules, like a contract. The result names it in `identity.service`.
- **Look-alikes**: precompiles and system contracts are never one.

### 1.2.0 (2026-10-16)

- **Funding**: the funder is what paid for the first transaction you signed on a chain (the latest
  transfer in the 30 days before it that covers it), no longer the oldest coin that ever arrived.
  No funder on a chain you never used. Dust and gifts no longer make funding findings or links.
- **Activity**: a chain counts as active only when the address sent a transaction there. New info
  rule `cross_chain.received_only` lists the chains where it only received.
- **Services by their own count**: a counterparty with 2,000 or more transactions on that chain is a
  service or a bot and never a link; a funder like that is a busy funder. A back and forth partner or
  a deposit co-sender must have sent at least one transaction there.
- **Address poisoning**: look-alikes (3 + 4 or 4 + 3 equal hex characters) are never a link; they
  are reported in the new `warnings` list. Token transfers count only when the token is real.
- **Explorer gaps**: a chain whose RPC count of sent transactions the explorer does not show is
  `partial`, never "no activity".
- `same_funder_multichain` is one finding for the rule, with every funder in its evidence and no
  address or name in its title. Each shared deposit address keeps its own confidence.

### 1.1.0 (2026-10-16)

- **Named-wallet ceiling**: a wallet with a public name never scores above 34; `public_label` is
  critical.
- **A service is never a link**: exchanges, contracts, about 9,500 service wallets from eth-labels,
  explorer-tagged addresses, and busy funders (200 or more transactions in the 6 days around your
  funding, or more than 40 wallets funded in it).
- `funded_by_you` only for a fresh wallet with under 50 transactions.
- Read limits per chain: 500 transactions, 250 token transfers, 50 internal transfers.
- Exchange tags from the explorers count as exchange labels.

### 1.0.0 (2026-10-15)

- First public rules.
