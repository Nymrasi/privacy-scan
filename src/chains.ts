// Chain register. Adding a chain is one line. Only free sources: keyless where one exists.
//   bs(url)  Blockscout instance: Etherscan-compatible `/api` plus `/api/v2`. CORS `*`.
//   rs(id)   Routescan, keyless Etherscan-compatible API. CORS `*`.
//   es(id)   Etherscan V2 with a free key, through the Nymra relay (the key lives there).
//   esFree(id) Etherscan V2 without a key, straight from the browser or the bot (CORS `*`), one request per
//            5 s per IP. Free for Linea only (measured 2026-10-17: Base, BNB, OP and Robinhood Chain answer "not
//            supported for free", Arbitrum and Polygon want a key).
//   nr()     NodeReal MegaNode with a free key, through the relay. BNB Smart Chain.
//   al(net)  Alchemy's Transfers API with a free key, through the relay: the keyed second source of Base
//            and Polygon PoS on a server (`keyedAlt`).
// `cf: true` marks a Blockscout behind a Cloudflare bot wall: a real browser gets through,
// Node and curl get a 403 challenge. So these chains only scan from the browser (or a proxy).
// `traces: false` marks a chain whose nodes have no traces: internal native transfers are invisible.
import type { ChainId, SourceKind } from './types.ts';

export type SourceDef =
  | { kind: 'blockscout'; api: string; cf?: boolean }
  | { kind: 'routescan'; api: string }
  | { kind: 'etherscan'; api: string; chainid: number; keyed?: true; minGapMs?: number }
  | { kind: 'nodereal'; api: string; keyed: true }
  | { kind: 'alchemy'; api: string; keyed: true };

/** A source that needs the relay's API key: the scan reads it only through `opts.relay`. */
export const keyed = (s: SourceDef) => 'keyed' in s && s.keyed === true;
/** A source whose rows carry no calldata (NodeReal, Alchemy): a plain send and a paid contract call look alike. */
export const blind = (s: SourceDef) => s.kind === 'nodereal' || s.kind === 'alchemy';

export interface ChainDef {
  id: ChainId;
  name: string;
  native: string;
  source: SourceDef;
  /** Public JSON-RPC (CORS open): a cheap nonce + balance check before the explorer is asked. */
  rpc?: string;
  /** Explorer base for links; `${explorer}/tx/<hash>` and `${explorer}/address/<addr>`. */
  explorer: string;
  /** Second keyless source, used when the first refuses (rate limit or bot wall). */
  alt?: SourceDef;
  /**
   * A keyed second source for a road this chain's own explorer always refuses: a server. Cloudflare walls
   * Base and Polygon off from a server, and Blockscout PRO's free plan no longer serves them (402 "Featured
   * chain requires one of the following plans", measured 2026-10-17). Read only when the scan says the relay
   * holds its key (`ScanOptions.keyedAlts`, see chainForRoad); the browser never says so.
   */
  keyedAlt?: SourceDef;
  /** Scanned by default. Others only when asked for in `opts.chainIds`. */
  defaultOn: boolean;
  /**
   * The chain has ended: why, in plain words. It is never read on any road, also not when asked for in
   * `opts.chainIds` (its coverage is `skipped` with this reason), and the relay drops its RPC host. The line
   * stays in the register, so nobody puts the chain back by mistake.
   */
  retired?: string;
  /** False when the chain has no traces (no internal transfers anywhere). */
  traces?: boolean;
  /** Extra plain-language limits shown in the coverage of this chain. */
  limits?: string[];
}

const bs = (url: string, cf = false): SourceDef => ({ kind: 'blockscout', api: url, cf });
const rs = (id: ChainId): SourceDef => ({ kind: 'routescan', api: `https://api.routescan.io/v2/network/mainnet/evm/${id}/etherscan/api` });
export const es = (id: ChainId): SourceDef => ({ kind: 'etherscan', api: 'https://api.etherscan.io/v2/api', chainid: id, keyed: true });
/** Etherscan's keyless limit is one request per 5 s; a little over that keeps clear of it. */
export const ETHERSCAN_FREE_GAP_MS = 5200;
const esFree = (id: ChainId): SourceDef => ({ kind: 'etherscan', api: 'https://api.etherscan.io/v2/api', chainid: id, minGapMs: ETHERSCAN_FREE_GAP_MS });
const nr = (): SourceDef => ({ kind: 'nodereal', api: 'https://bsc-mainnet.nodereal.io/v1/', keyed: true });
/** The relay puts the key after `/v2/` (proxy/proxy.ts); the scan never sends one. */
const al = (net: string): SourceDef => ({ kind: 'alchemy', api: `https://${net}.g.alchemy.com/v2/`, keyed: true });
const alchemyLimit = (name: string) => `${name} is read through Alchemy: calldata and the explorer's labels are not listed, so contracts are only recognised by their tokens. Funder checks around a date are not available here.`;
/** Blast's team ended the chain (CoinDesk and Blast on X, 2 October 2026): withdrawals through its interface close on 26 October 2026, then it goes offline. */
const BLAST_RETIRED = 'Blast is retired: its team ended the chain (announced 2 October 2026; withdrawals through its own interface close on 26 October 2026), so Nymra does not read it.';
const BNB_LIMIT = 'BNB Smart Chain is read through NodeReal: internal BNB transfers and calldata are not listed, so contracts are only recognised by their tokens. Funder checks around a date are not available here.';
const RH_LIMIT = 'Robinhood Chain has no traces and no archive state: internal ETH transfers (for example a withdrawal paid out by a contract) are invisible. Normal transactions and token transfers are complete.';

// prettier-ignore
export const CHAINS: ChainDef[] = [
  { id: 1,        name: 'Ethereum',        native: 'ETH',  source: bs('https://eth.blockscout.com'), alt: rs(1),                rpc: 'https://ethereum-rpc.publicnode.com', explorer: 'https://eth.blockscout.com',               defaultOn: true },
  { id: 8453,     name: 'Base',            native: 'ETH',  source: bs('https://base.blockscout.com', true), keyedAlt: al('base-mainnet'), rpc: 'https://base-rpc.publicnode.com', explorer: 'https://base.blockscout.com', defaultOn: true },
  { id: 42161,    name: 'Arbitrum One',    native: 'ETH',  source: bs('https://arbitrum.blockscout.com', true),     rpc: 'https://arbitrum-one-rpc.publicnode.com', explorer: 'https://arbitrum.blockscout.com',          defaultOn: true },
  { id: 10,       name: 'OP Mainnet',      native: 'ETH',  source: bs('https://explorer.optimism.io'),              rpc: 'https://optimism-rpc.publicnode.com', explorer: 'https://explorer.optimism.io',             defaultOn: true },
  { id: 137,      name: 'Polygon PoS',     native: 'POL',  source: bs('https://polygon.blockscout.com', true), keyedAlt: al('polygon-mainnet'), rpc: 'https://polygon-bor-rpc.publicnode.com', explorer: 'https://polygon.blockscout.com', defaultOn: true },
  { id: 4663,     name: 'Robinhood Chain', native: 'ETH',  source: bs('https://robinhoodchain.blockscout.com', true), rpc: 'https://rpc.mainnet.chain.robinhood.com', explorer: 'https://robinhoodchain.blockscout.com',  defaultOn: true, traces: false, limits: [RH_LIMIT] },
  { id: 43114,    name: 'Avalanche C-Chain', native: 'AVAX', source: rs(43114),                                    rpc: 'https://avalanche-c-chain-rpc.publicnode.com/ext/bc/C/rpc', explorer: 'https://snowtrace.io',                     defaultOn: true },
  { id: 81457,    name: 'Blast',           native: 'ETH',  source: rs(81457),                                       rpc: 'https://blast-rpc.publicnode.com', explorer: 'https://blastexplorer.io',                     defaultOn: false, retired: BLAST_RETIRED },
  { id: 324,      name: 'ZKsync Era',      native: 'ETH',  source: bs('https://zksync.blockscout.com'),             rpc: 'https://mainnet.era.zksync.io', explorer: 'https://zksync.blockscout.com',            defaultOn: true },
  { id: 534352,   name: 'Scroll',          native: 'ETH',  source: bs('https://scrollscan.com'),                    rpc: 'https://scroll-rpc.publicnode.com', explorer: 'https://scrollscan.com',                   defaultOn: true },
  { id: 130,      name: 'Unichain',        native: 'ETH',  source: bs('https://unichain.blockscout.com'),           rpc: 'https://unichain-rpc.publicnode.com', explorer: 'https://unichain.blockscout.com',          defaultOn: true },
  { id: 100,      name: 'Gnosis',          native: 'XDAI', source: bs('https://gnosisscan.io'),                     rpc: 'https://gnosis-rpc.publicnode.com', explorer: 'https://gnosisscan.io',                    defaultOn: true },
  { id: 57073,    name: 'Ink',             native: 'ETH',  source: bs('https://explorer.inkonchain.com'),           rpc: 'https://rpc-gel.inkonchain.com', explorer: 'https://explorer.inkonchain.com',          defaultOn: true },
  { id: 1868,     name: 'Soneium',         native: 'ETH',  source: bs('https://soneium.blockscout.com'),            rpc: 'https://soneium-rpc.publicnode.com', explorer: 'https://soneium.blockscout.com',           defaultOn: true },
  { id: 56,       name: 'BNB Smart Chain', native: 'BNB',  source: nr(),                                           rpc: 'https://bsc-rpc.publicnode.com', explorer: 'https://bscscan.com',                      defaultOn: true, traces: false, limits: [BNB_LIMIT] },
  { id: 59144,    name: 'Linea',           native: 'ETH',  source: esFree(59144),                                    rpc: 'https://linea-rpc.publicnode.com', explorer: 'https://lineascan.build',                  defaultOn: true },
  { id: 42220,    name: 'Celo',            native: 'CELO', source: bs('https://celo.blockscout.com'),               rpc: 'https://celo-rpc.publicnode.com', explorer: 'https://celo.blockscout.com',              defaultOn: true },
  { id: 480,      name: 'World Chain',     native: 'ETH',  source: bs('https://worldchain-mainnet.explorer.alchemy.com'), rpc: 'https://worldchain-mainnet.g.alchemy.com/public', explorer: 'https://worldchain-mainnet.explorer.alchemy.com', defaultOn: false },
  { id: 34443,    name: 'Mode',            native: 'ETH',  source: bs('https://explorer.mode.network'),             rpc: 'https://mainnet.mode.network', explorer: 'https://explorer.mode.network',            defaultOn: false },
  { id: 42170,    name: 'Arbitrum Nova',   native: 'ETH',  source: bs('https://arbitrum-nova.blockscout.com'),      rpc: 'https://nova.arbitrum.io/rpc', explorer: 'https://arbitrum-nova.blockscout.com',     defaultOn: false },
  { id: 4326,     name: 'MegaETH',         native: 'ETH',  source: bs('https://megaeth.blockscout.com'),            rpc: 'https://mainnet.megaeth.com/rpc', explorer: 'https://megaeth.blockscout.com',           defaultOn: false },
  { id: 1135,     name: 'Lisk',            native: 'ETH',  source: bs('https://blockscout.lisk.com'),               rpc: 'https://rpc.api.lisk.com', explorer: 'https://blockscout.lisk.com',              defaultOn: false },
  { id: 360,      name: 'Shape',           native: 'ETH',  source: bs('https://shapescan.xyz'),                     rpc: 'https://mainnet.shape.network', explorer: 'https://shapescan.xyz',                    defaultOn: false },
  { id: 169,      name: 'Manta Pacific',   native: 'ETH',  source: bs('https://pacific-explorer.manta.network'),    rpc: 'https://pacific-rpc.manta.network/http', explorer: 'https://pacific-explorer.manta.network',   defaultOn: false },
  { id: 13371,    name: 'Immutable zkEVM', native: 'IMX',  source: bs('https://explorer.immutable.com'),            rpc: 'https://rpc.immutable.com', explorer: 'https://explorer.immutable.com',           defaultOn: false },
  { id: 30,       name: 'Rootstock',       native: 'RBTC', source: bs('https://rootstock.blockscout.com'),          rpc: 'https://public-node.rsk.co', explorer: 'https://rootstock.blockscout.com',         defaultOn: false },
  { id: 2020,     name: 'Ronin',           native: 'RON',  source: bs('https://explorer.roninchain.com'),           rpc: 'https://api.roninchain.com/rpc', explorer: 'https://explorer.roninchain.com',          defaultOn: false },
  { id: 592,      name: 'Astar',           native: 'ASTR', source: bs('https://astar.blockscout.com'),              rpc: 'https://evm.astar.network', explorer: 'https://astar.blockscout.com',             defaultOn: false },
  { id: 1313161554, name: 'Aurora',        native: 'ETH',  source: bs('https://explorer.mainnet.aurora.dev'),       rpc: 'https://mainnet.aurora.dev', explorer: 'https://explorer.mainnet.aurora.dev',      defaultOn: false },
  { id: 747,      name: 'Flow EVM',        native: 'FLOW', source: bs('https://evm.flow.com'),                      rpc: 'https://mainnet.evm.nodes.onflow.org', explorer: 'https://evm.flow.com',                     defaultOn: false },
  { id: 314,      name: 'Filecoin EVM',    native: 'FIL',  source: bs('https://filecoin.blockscout.com'),           rpc: 'https://api.node.glif.io', explorer: 'https://filecoin.blockscout.com',          defaultOn: false },
];

/** GIWA's mainnet (chain id 9134) is not live: docs.giwa.io says "in development" and GIWA said on X it has not launched (read October 2026). */
const GIWA_TESTNET_LIMIT = 'GIWA Sepolia is the testnet of GIWA Chain: its coins have no value. GIWA mainnet is not live yet.';

/**
 * Testnets: read only when asked for by id in `opts.chainIds`, never by default. They are NOT in `CHAINS`, so no
 * count, chain list or menu built from the register (site, docs, bot) sees them; only the scan's lookup knows them.
 * GIWA Sepolia (91342) proves the engine reads GIWA Chain before its mainnet exists: the same Blockscout road as
 * Ethereum, keyless, CORS `*`, no bot wall (measured October 2026). On mainnet day GIWA gets its own line in `CHAINS`.
 */
// prettier-ignore
export const TESTNETS: ChainDef[] = [
  { id: 91342,    name: 'GIWA Sepolia',    native: 'ETH',  source: bs('https://sepolia-explorer.giwa.io'),          rpc: 'https://sepolia-rpc.giwa.io', explorer: 'https://sepolia-explorer.giwa.io',          defaultOn: false, limits: [GIWA_TESTNET_LIMIT] },
];

/** Chains with no free source at all. Listed in coverage as `skipped`, with the reason. Empty since BNB and Linea came in through the relay. */
export const UNSUPPORTED: { id: ChainId; name: string; reason: string }[] = [];

export const CHAIN_BY_ID: Map<ChainId, ChainDef> = new Map([...CHAINS, ...TESTNETS].map((c) => [c.id, c]));

/**
 * The chain as this scan reads it: through its keyed second source when the relay holds that key
 * (`ScanOptions.keyedAlts`: the bot and the ASI agent), else the very same chain, as in the browser.
 */
export function chainForRoad(c: ChainDef, keyedAlts: readonly SourceKind[] = []): ChainDef {
  const k = c.keyedAlt;
  if (!k || !keyedAlts.includes(k.kind)) return c;
  return { ...c, source: k, alt: undefined, limits: [...(c.limits ?? []), alchemyLimit(c.name)] };
}

export function defaultChainIds(): ChainId[] {
  return CHAINS.filter((c) => c.defaultOn && !c.retired).map((c) => c.id);
}

export function txUrl(chainId: ChainId, hash: string): string | undefined {
  const c = CHAIN_BY_ID.get(chainId);
  return c ? `${c.explorer}/tx/${hash}` : undefined;
}

export function addressUrl(chainId: ChainId, address: string): string | undefined {
  const c = CHAIN_BY_ID.get(chainId);
  return c ? `${c.explorer}/address/${address}` : undefined;
}

export function chainName(chainId: ChainId): string {
  return CHAIN_BY_ID.get(chainId)?.name ?? UNSUPPORTED.find((u) => u.id === chainId)?.name ?? `Chain ${chainId}`;
}
