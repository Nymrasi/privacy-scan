// Builds src/data/services.json: wallets that are a service, never a person's other wallet.
// Source: the MIT-licensed dawsbot/eth-labels dataset (the same file as build-cex.ts).
// Run: node scripts/build-services.ts [path/to/accounts.csv]
//
// Why only these: contracts (routers, pools, bridges, tokens, airdrop contracts) are already
// recognised at scan time from the explorer's own `is_contract` flag, and exchanges are in cex.json.
// What is left are the service wallets that look like a person to a scanner: MEV bots, bundlers,
// deployers, relayers and solvers, oracle and AVS operators, market makers, payment processors,
// faucets and distributors. A shared funder or counterparty from this list never makes a link.
//
// Keys are the last 8 base-36 chars of cyrb53 (about 41 bits). A false match only ever removes a
// link (the safe direction): about 1 in 300 million per looked-up address with 8,600 entries.
import { readFileSync, writeFileSync } from 'node:fs';
import { addrKey } from '../src/hash.ts';

const SRC = 'https://raw.githubusercontent.com/dawsbot/eth-labels/HEAD/data/csv/accounts.csv';
const csv = process.argv[2] ? readFileSync(process.argv[2], 'utf8') : await (await fetch(SRC)).text();

/** Labels whose wallets are run by a service (mostly externally owned accounts). */
const SERVICE_LABELS = new Set(['mev-bot', 'mev-builder', 'pimlico', 'erc-4337-bundler', 'biconomy', 'stackup', 'contract-deployer',
  'avs-operator', 'oracle-dao', 'chainlink', 'wintermute', 'jump-trading', 'galaxy-digital', 'alameda-research', 'cumberland', 'b2c2',
  'gsr', 'amber-group', 'dwf-labs', 'flowdesk', 'otc', 'payments', 'alphapo', 'coinspaid', 'moonpay', 'transak', 'ramp-network', 'banxa',
  'mercuryo', 'bitpay', 'faucet', 'across-protocol', 'axelar', 'authereum', 'gelato', 'keep3r', 'layerzero', 'relay', 'socket', 'li-fi',
  'orbiter-finance', 'layerswap', 'owlto', 'meson', 'flashbots', 'bloxroute', 'airdrop-distributor']);
/** Name tags that mark a service wallet whatever the label. */
const TAG_RE = /relayer|solver|filler|keeper|bundler|deployer|market maker|\botc\b|payout|faucet|gas station|refuel|hot wallet|batch sender|multisender|disperse|airdrop|distributor|sequencer|batcher|batch submitter|builder|searcher|\bbot\b|oracle|operator/i;
/** Exchanges live in cex.json; these labels name people, not services. */
const CEX = new Set(('binance coinbase kraken okx okex bitget bybit kucoin huobi htx gate-io gateio gate bitfinex bitstamp gemini crypto-com '
  + 'cryptocom mexc deribit bilaxy upbit bithumb poloniex bittrex hitbtc bitmart lbank coinex probit bitflyer bitpanda bitvavo coincheck '
  + 'zaif liquid ftx blockchain-com robinhood ascendex bitmax bkex whitebit phemex woo bingx coinone korbit indodax wazirx cex-io exmo luno '
  + 'paribu btcturk bitkub coinspot independent-reserve swissborg nexo blockfi celsius exchange fiat-gateway').split(' '));
const PERSON = new Set(['friend-tech-users', 'airdrop-hunter', 'take-action', 'genesis-address', 'buidlguidl-builders', 'protocol-guild-member',
  'retropgf-recipient', 'sybil-delegate', 'maker-vault-owner', 'phish-hack', 'blocked', 'ico-wallets', 'parity-bug', 'proposer-fee-recipient', 'heist', 'exploit']);

/** Bridge protocols: their relayers and makers move other people's funds between chains. */
const BRIDGE_LABELS = new Set(['across-protocol', 'axelar', 'layerzero', 'relay', 'socket', 'li-fi', 'orbiter-finance', 'layerswap', 'owlto',
  'meson', 'bridge', 'hop-protocol', 'multichain', 'synapse', 'wormhole', 'celer-network', 'allbridge', 'stargate', 'connext', 'debridge',
  'xy-finance', 'interport-finance', 'rhino-fi', 'gas-zip']);

/** What kind of service, for the explanation shown to the user. */
function kindOf(label: string, tag: string): string {
  if (BRIDGE_LABELS.has(label) || /\bbridge\b/i.test(tag)) return 'bridge';
  if (/mev|searcher|builder/i.test(label + ' ' + tag)) return 'bot';
  if (/bundler|relayer|solver|filler|keeper|sequencer|batch|oracle|operator|deployer|gelato|chainlink|flashbots|bloxroute/i.test(label + ' ' + tag)) return 'infrastructure';
  if (/faucet|airdrop|distributor|disperse|multisender|payout|refuel|gas station/i.test(label + ' ' + tag)) return 'distributor';
  if (/payments|alphapo|coinspaid|moonpay|transak|ramp|banxa|mercuryo|bitpay|hot wallet/i.test(label + ' ' + tag)) return 'payments';
  if (/otc|market maker|wintermute|jump|galaxy|alameda|cumberland|b2c2|gsr|amber|dwf|flowdesk/i.test(label + ' ' + tag)) return 'market maker';
  return 'service';
}

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

/** Name-tag heads that say what a wallet does, not who runs it. */
const GENERIC_HEAD = /^(mev bot|mev builder|builder|bundler|bot|relayer|deployer|contract deployer|operator|avs operator|bridge|null)$/i;

/** Who runs the wallet, from its name tag: "Axelar: Relayer 2" and "Alameda Research 22" name their entity. */
function entityOf(tag: string): string | undefined {
  const head = (tag.includes(':') ? tag.split(':')[0] : tag).replace(/\s+\d+$/, '').trim();
  if (!head || head.length > 40 || /0x|\.\.\.|\u2026/i.test(head) || GENERIC_HEAD.test(head)) return undefined;
  return head;
}

const lines = csv.split('\n');
const header = parseLine(lines[0]);
const iA = header.indexOf('address'), iL = header.indexOf('label'), iT = header.indexOf('nameTag');
const kinds = ['bot', 'infrastructure', 'distributor', 'payments', 'market maker', 'service', 'bridge'];
const NAMED_KINDS = new Set(['bridge', 'market maker', 'payments', 'distributor', 'service']);
const entities: string[] = [];
const groups = new Map<string, { k: number; e: number; keys: Set<string> }>();
const seen = new Set<string>();
for (const line of lines.slice(1)) {
  if (!line.trim()) continue;
  const r = parseLine(line);
  const addr = r[iA]?.toLowerCase(), label = r[iL] ?? '', tag = r[iT] ?? '';
  if (!addr || !/^0x[0-9a-f]{40}$/.test(addr) || seen.has(addr)) continue;
  if (CEX.has(label) || PERSON.has(label)) continue;
  if (!SERVICE_LABELS.has(label) && !TAG_RE.test(tag)) continue;
  seen.add(addr);
  const k = kinds.indexOf(kindOf(label, tag));
  // Names only where they are few and tell the user something: the bots and infrastructure wallets
  // (9,200 of them) carry about 2,400 names, which would add 25 KB gzip to the page for no new state.
  const name = NAMED_KINDS.has(kinds[k]) ? entityOf(tag) : undefined;
  let e = name === undefined ? -1 : entities.indexOf(name);
  if (name !== undefined && e < 0) e = entities.push(name) - 1;
  const g = groups.get(`${k}|${e}`) ?? { k, e, keys: new Set<string>() };
  groups.set(`${k}|${e}`, g);
  g.keys.add(addrKey(addr).slice(-8));
}
const out = {
  v: 2,
  source: 'github.com/dawsbot/eth-labels (MIT), data/csv/accounts.csv',
  builtAt: new Date().toISOString().slice(0, 10),
  keyChars: 8,
  key: 'last 8 chars of cyrb53(lowercase address) base36',
  kinds,
  entities,
  // [kind index, keys] or [kind index, keys, entity index]: the name goes last, so a reader of the
  // first two fields (the docs count them) reads this file as before.
  services: [...groups.values()].map((g) => (g.e < 0 ? [g.k, [...g.keys].sort().join('')] : [g.k, [...g.keys].sort().join(''), g.e])),
};
writeFileSync(new URL('../src/data/services.json', import.meta.url), JSON.stringify(out));
const perKind = new Map<string, number>();
for (const g of groups.values()) perKind.set(kinds[g.k], (perKind.get(kinds[g.k]) ?? 0) + g.keys.size);
console.log('services', seen.size, 'entities', entities.length, Object.fromEntries(perKind));
