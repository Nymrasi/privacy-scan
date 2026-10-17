// Builds src/data/cex.json from the MIT-licensed dawsbot/eth-labels dataset.
// Run: node scripts/build-cex.ts [path/to/accounts.csv]   (downloads the CSV when no path given)
// Output keeps an 11-char base-36 hash (53 bits) of each whole address: a false match against a
// random address has a chance of about 1 in 200 billion, and the file shrinks to a third.
// A prefix would collide on vanity addresses (0x000000...), a hash of the whole address does not.
import { readFileSync, writeFileSync } from 'node:fs';
import { addrKey } from '../src/hash.ts';

const SRC = 'https://raw.githubusercontent.com/dawsbot/eth-labels/HEAD/data/csv/accounts.csv';
const csv = process.argv[2]
  ? readFileSync(process.argv[2], 'utf8')
  : await (await fetch(SRC)).text();

const CEX_LABELS = new Set(('binance coinbase kraken okx okex bitget bybit kucoin huobi htx gate-io gateio gate bitfinex bitstamp gemini '
  + 'crypto-com cryptocom mexc deribit bilaxy upbit bithumb poloniex bittrex hitbtc bitmart lbank coinex probit bitflyer bitpanda '
  + 'bitvavo coincheck zaif liquid ftx blockchain-com robinhood ascendex bitmax bkex whitebit phemex woo bingx coinone korbit indodax '
  + 'wazirx cex-io exmo luno paribu btcturk bitkub coinspot independent-reserve swissborg nexo blockfi celsius exchange fiat-gateway').split(' '));
const NAME_RE = /\b(binance|coinbase|kraken|okx|bybit|kucoin|huobi|htx|gate\.io|bitfinex|bitstamp|gemini|crypto\.com|mexc|bitget|upbit|bithumb)\b/i;
const SKIP_RE = /exploit|hack|charity|scam|phish|drainer/i;

function parseLine(line: string): string[] {
  const out: string[] = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

function entityOf(label: string, tag: string): string {
  let n = tag.split(':')[0].replace(/\bDep\b.*$/i, '').replace(/\b(Exchange|Hot Wallet|Cold Wallet|Deposit.*)$/i, '');
  n = n.replace(/\s+\d+$/, '').trim();
  const m = tag.match(NAME_RE);
  if (m && !n) n = m[1];
  if (!n) n = label.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  const canon: Record<string, string> = { 'Gate': 'Gate.io', 'Gate Io': 'Gate.io', 'Okex': 'OKX', 'Okx': 'OKX', 'Crypto Com': 'Crypto.com', 'Htx': 'HTX', 'Huobi': 'HTX', 'Fiat Gateway': 'Fiat gateway' };
  n = canon[n] ?? n;
  for (const [re, to] of MERGE) if (re.test(n)) return to;
  return n;
}
const MERGE: [RegExp, string][] = [
  [/^Coinbase( (Prime|Cold|Fees|Assets))?$/i, 'Coinbase'], [/^Binance( (Hot Wallet|Internal|JEX|Pool))?$/i, 'Binance'],
  [/^mexc(\.com)?$/i, 'MEXC'], [/^kucoin$/i, 'KuCoin'], [/^bybit$/i, 'Bybit'], [/^coinex( multisig)?$/i, 'CoinEx'],
  [/^Celsius( Network)?$/i, 'Celsius'], [/^bitmart$/i, 'BitMart'], [/^woo( x| network| x treasury)?$/i, 'WOO X'],
  [/^HTX|Huobi/i, 'HTX'], [/^Coincheck/i, 'Coincheck'], [/^BTC ?Turk$/i, 'BtcTurk'], [/^Exchange$/i, 'an exchange'],
];
// Labelled "exchange" in the dataset but not a custodial exchange a user deposits to.
const NOT_CEX = /^(0x|Tether.*|EURT|Euro Tether|Multichain|Arbitrum Foundation|Ethena|Cronos Coin|BitDAO|Alameda Research|Bitget (Wallet|Proxy)|Coinbase Wrapped Staked ETH|Binance USD|Wormhole|iSwap|Incognito Chain|Eth2|Fee Recipient|Jump Trading|Three Arrows Capital|Galaxy Digital|.* Token|HECO Chain|OKX (DEX|Labs|Football Cup)|Ondo Finance|WooFi|Biconomy|Arkham|DDEX|DEx\.top|Joyso|Ultimate Champions|Delta|BitKeep|Bitpie|Freewallet|Klever|Eidoo|Blockfolio|Fund|KeySecure|Silverway|Juno|PXN|GBX|Streamity|Bake\.io|BTC\.com Pool)$/i;

const lines = csv.split('\n');
const header = parseLine(lines[0]);
const iA = header.indexOf('address'), iL = header.indexOf('label'), iT = header.indexOf('nameTag');
// One entry per address; a named exchange beats the generic "an exchange", a deposit tag beats none.
const best = new Map<string, { ent: string; dep: boolean }>();
for (const line of lines.slice(1)) {
  if (!line.trim()) continue;
  const r = parseLine(line);
  const addr = r[iA]?.toLowerCase(), label = r[iL] ?? '', tag = r[iT] ?? '';
  if (!addr || !/^0x[0-9a-f]{40}$/.test(addr)) continue;
  if (!(CEX_LABELS.has(label) || NAME_RE.test(tag)) || SKIP_RE.test(tag) || SKIP_RE.test(label)) continue;
  const ent = entityOf(label, tag);
  if (NOT_CEX.test(ent)) continue;
  const dep = /\bDep\b|deposit address/i.test(tag) || ((label === 'deribit' || label === 'bilaxy' || label === 'bitget') && !tag);
  const prev = best.get(addr);
  if (!prev || (prev.ent === 'an exchange' && ent !== 'an exchange')) best.set(addr, { ent, dep: dep || !!prev?.dep });
  else if (dep) prev.dep = true;
}
const entities: string[] = [];
const eIdx = new Map<string, number>();
const hot = new Map<number, Set<string>>();
const dep = new Map<number, Set<string>>();
let n = 0;
for (const [addr, { ent, dep: isDep }] of best) {
  if (!eIdx.has(ent)) { eIdx.set(ent, entities.length); entities.push(ent); }
  const i = eIdx.get(ent)!;
  const bucket = isDep ? dep : hot;
  if (!bucket.has(i)) bucket.set(i, new Set());
  bucket.get(i)!.add(addrKey(addr));
  n++;
}
const pack = (m: Map<number, Set<string>>) => [...m.entries()].map(([i, s]) => [i, [...s].sort().join('')] as [number, string]);
const out = {
  v: 1,
  source: 'github.com/dawsbot/eth-labels (MIT), data/csv/accounts.csv',
  builtAt: new Date().toISOString().slice(0, 10),
  keyChars: 11,
  key: 'cyrb53(lowercase address) base36',
  entities,
  hot: pack(hot),
  deposit: pack(dep),
};
writeFileSync(new URL('../src/data/cex.json', import.meta.url), JSON.stringify(out));
console.log('entries', n, 'entities', entities.length, 'hot', [...hot.values()].reduce((a, s) => a + s.size, 0), 'deposit', [...dep.values()].reduce((a, s) => a + s.size, 0));
console.log(entities.slice(0, 60).join(', '));
