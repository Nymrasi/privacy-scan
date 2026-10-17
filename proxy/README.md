# The relay

The scan runs in the browser and reads explorers directly. The relay (`proxy.ts`) is for the few
requests that cannot go that way:

1. **A refusal.** Blockscout allows 180 keyless requests a minute per explorer and per IP. A user on a
   shared IP (a VPN, Tor, an office) can hit that, and the explorers behind a bot check (Base,
   Arbitrum, Polygon, Robinhood Chain) refuse scripts and some VPN exits with an HTML "Just a moment..."
   page. After a 429 the scan waits up to 10 s; after a bot check, or a longer wait, it asks the relay,
   which reads Blockscout's PRO API with a free key.
2. **The keyed chain.** BNB Smart Chain (NodeReal) has no keyless source. The relay holds its free
   key, the browser never does. Linea needs none: Etherscan V2 answers it without a key, one request
   per 5 s. On a server, Base and Polygon PoS are read through Alchemy (`ALCHEMY_API_KEY`), because
   PRO's free plan no longer serves them (402 since 1 October 2026); only a server's own relay holds
   that key (the ASI agent's), and only it passes `keyedAlts: ['alchemy']`.
3. **A server.** All four bot-checked explorers refuse a server. A server-side caller reads through the
   relay with its own token (`BOT_TOKEN`). It is kept for the Telegram bot, which today is a helper in the
   community and scans nothing: the scan is the Terminal's.

The website serves this handler as a Cloudflare Pages Function at `https://nymra.si/p`
(it copies `proxy.ts` from a commit of this repository).
`worker.ts` + `wrangler.toml` run the same handler as a standalone Worker, if it ever needs its own host.

## What it does and refuses (each line is tested in `test/proxy.test.ts`)

| | |
|---|---|
| CORS | **none, ever.** The site calls `/p` on its own origin, so no CORS header is needed, and without one no other website can read an answer. A preflight (`OPTIONS`) gets 405 |
| Callers | a page of our own site calling its own `/p`: the relay's own origin is `https://nymra.si`, `https://www.nymra.si` or a Pages preview of the site, and the request carries that same `Origin` (a POST) or no `Origin` and `Sec-Fetch-Site: same-origin` (a GET). A server with `Authorization: Bearer <BOT_TOKEN>`. Everything else, also `www` calling the apex: 403 |
| Targets | only the hosts of `src/chains.ts`, BENS, the ENS RPC, `api.etherscan.io`, `bsc-mainnet.nodereal.io`, `base-mainnet.g.alchemy.com` and `polygon-mainnet.g.alchemy.com`, over https, without redirects (400). On each host only what the scan reads: on an explorer `GET /api/v2/addresses/<address>` and its `transactions`, `token-transfers` and `internal-transactions`; on Routescan and Etherscan `GET` with `module=account` and `action` `txlist`, `txlistinternal` or `tokentx`; on BENS `GET` of an address, `addresses:lookup` or a domain; on an RPC `POST` only; on an Alchemy host `POST /v2/` of `alchemy_getAssetTransfers` and nothing else (no other host gets that call). Anything else: 400, a wrong method 405 |
| Keys | `BLOCKSCOUT_PRO_KEY` as an `Authorization: Bearer` header; `ETHERSCAN_API_KEY` as `apikey` in the query (Etherscan has no header form); `NODEREAL_API_KEY` and `ALCHEMY_API_KEY` in the path (their only form). Every key is cut out of every answer, also URL-encoded, before it goes back |
| JSON-RPC | read calls only: `eth_getTransactionCount`, `eth_getBalance`, `eth_getCode`, `nr_getTransactionByAddress`, and `eth_call` only as an ENS `text(bytes32,string)` read (selector `0x59d1d43c`); at most 16 calls per batch; at most 4 KB (the largest body the scan sends, the ENS records batch, is 3,931 bytes) |
| Daily quota | PRO answers carry `x-credits-remaining`. Below 5,000 credits (about 250 calls) the relay stops using the key and answers 503 with `x-nymra-relay: quota`; the scan then lists the chain under `incomplete` with "the relay's free daily quota is spent". The quota resets at 00:00 UTC |
| Per caller | 300 requests a minute (the `RATE_LIMIT` binding on a Worker, a counter in memory on Pages), plus the WAF rule below |
| Upstream | 15 s timeout per call; a bot check upstream comes back as JSON 502 (`x-nymra-relay: blocked`), never as HTML |
| Logs | none. No `console` call in the code (a test checks it); Worker logs, observability and Logpush are off in `wrangler.toml` |

## Setup (click route, about 10 minutes; no key ever goes into a chat or a shell)

**1. Three free keys.**

- Blockscout PRO: [dev.blockscout.com](https://dev.blockscout.com), sign in, **API keys**, **Create**.
  Free plan: 100,000 credits a day, 5 requests a second.
- Etherscan: not needed. The scan reads Linea without a key (one request per 5 s); a key here only
  serves a Linea read that was refused, faster ([etherscan.io/register](https://etherscan.io/register),
  **API Dashboard**, **Add**; free plan 3 calls a second).
- NodeReal (for BNB Smart Chain): [nodereal.io](https://nodereal.io), **Sign up**, **MegaNode**,
  **Create API key**. Free plan: 10 million compute units a month; one history call costs 250.

**2. Put them in the Pages project.** Cloudflare dashboard, **Workers & Pages**, project **nymra**,
**Settings**, **Variables and Secrets**, **Add**. For each one choose type **Secret** (encrypted),
for **Production** and **Preview**:

| name | value |
|---|---|
| `BLOCKSCOUT_PRO_KEY` | the Blockscout key |
| `ETHERSCAN_API_KEY` | the Etherscan key |
| `NODEREAL_API_KEY` | the NodeReal key |
| `BOT_TOKEN` | only if the Telegram bot scans again: a long random string (a password manager can make one) |

Then **Deployments**, **Retry deployment** on the latest one, so the function gets the secrets.

**3. One WAF rule** (free plan: one rate-limiting rule, counted per IP, 10-second period). Dashboard,
zone **nymra.si**, **Security**, **WAF**, **Rate limiting rules**, **Create rule**:

| field | value |
|---|---|
| Rule name | `relay per IP` |
| If incoming requests match | Field **URI Path**, operator **equals**, value `/p` |
| With the same characteristics | IP (the only one on the free plan) |
| When rate exceeds | **60** requests per **10 seconds** |
| Then take action | **Block**, for **10 seconds** |

A heavy wallet (vitalik.eth: about 180 requests in 35 s, measured 2026-10-16) on an IP that every
explorer refuses sends nearly all of them here, about 50 per 10 s, so 60 does not stop a real user;
a script that drains the quota is stopped within 10 s. Users behind one VPN exit share the limit,
which is why it is generous.

**4. Check it** (after a deploy): open the terminal, scan a wallet, and confirm in the
result that BNB Smart Chain is `scanned` instead of `skipped`.

## The standalone Worker

```
npx wrangler deploy --config proxy/wrangler.toml      # creates the Worker
```

`wrangler.toml` sets `workers_dev = false` and `preview_urls = false`, so a deploy has no public
address until a route is added; logs, observability and Logpush are off; `RATE_LIMIT` is the binding
(300 per 60 s per caller and Cloudflare location). The secrets go in the Worker's own **Settings**,
**Variables and Secrets**, the same four names.

## For the bot

```ts
const r = await scan(address, {
  proxy: 'https://nymra.si/p',                       // every request through the relay
  fetch: (u, init) => fetch(u, { ...init, headers: { ...(init?.headers ?? {}), authorization: `Bearer ${BOT_TOKEN}` } }),
});
```

The bot has no Origin, so the relay knows it by its token and limits it by its token, not by its
server IP. Give it its own quota thinking: every bot scan is paid from the same 100,000 daily credits
(see SCHEMA.md for what a scan costs).

## Local preview

`npx wrangler pages dev dist` in the site's project serves the function on localhost. Allow that origin
only there, in its `.dev.vars` (never in production): `ALLOW_LOCALHOST=1`. Without it the relay refuses
`http://127.0.0.1` and `http://localhost` (403, "origin not allowed"). The scan then treats it as no
relay: BNB Smart Chain is skipped with its reason (a partial score), and a refused explorer read
waits out its own window.
