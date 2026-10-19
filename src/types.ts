// Public types of the Nymra privacy scan. SCHEMA.md documents every field.
// Erasable TypeScript only (no enums, no namespaces), so Node runs this file as is.

/** EIP-155 chain id, e.g. 1 for Ethereum, 8453 for Base, 4663 for Robinhood Chain. */
export type ChainId = number;

/** Lowercase 0x-prefixed 20-byte hex address. */
export type Address = string;

export type Severity = 'info' | 'low' | 'medium' | 'high' | 'critical';

/** The seven V1 detectors. Every finding belongs to exactly one. */
export type DetectorId =
  | 'funding_reuse'
  | 'linked_wallets'
  | 'recurring_counterparties'
  | 'cex_exposure'
  | 'public_identity'
  | 'cross_chain'
  | 'behavioral_fingerprint';

export type EvidenceKind = 'tx' | 'address' | 'label' | 'stat' | 'ens' | 'pattern';

/** One piece of proof behind a finding. Every field except `kind` and `text` is optional. */
export interface Evidence {
  kind: EvidenceKind;
  /** Short human sentence, English, no em dash. */
  text: string;
  chainId?: ChainId;
  txHash?: string;
  address?: Address;
  /** Public label of `address`, e.g. "Binance hot wallet 14". */
  label?: string;
  /** Free value: an amount, a count, an hour histogram, an ENS name. */
  value?: string | number;
  /** Unix seconds. */
  timestamp?: number;
  /** Explorer link for `txHash` or `address` on `chainId`. */
  url?: string;
}

/** The word printed next to a link: `likely` (confidence 0.70+), `possible` (0.45+) or `weak`. See LINK_LEVELS in score.ts. */
export type LinkLevel = 'likely' | 'possible' | 'weak';

/** An address that is probably related to the scanned wallet. Never a claim of ownership. */
export interface RelatedAddress {
  address: Address;
  /** 0 to 1: how likely the link is real. */
  confidence: number;
  /** The word for `confidence`. Set on `ScanResult.linkedWallets`. */
  level?: LinkLevel;
  /** e.g. "shared funder", "back and forth transfers", "same CEX deposit address". */
  reasons: string[];
  chainIds: ChainId[];
  label?: string;
}

export interface Finding {
  /** Stable rule id, e.g. "funding_reuse.shared_funder". RULES.md lists each one. */
  id: string;
  /**
   * Unique within one result: the rule id, plus the subject when a rule can fire more than once
   * (e.g. "funding_reuse.same_funder_multichain:0xab..."). Stable across partial results: use it as a UI key.
   */
  key: string;
  detector: DetectorId;
  severity: Severity;
  /** 0 to 1: how sure the engine is that this finding is real. */
  confidence: number;
  /**
   * Points this finding takes off the score, after confidence weighting and the
   * per-detector cap. Always <= 0. Sum over all findings = score - 100.
   * A naming finding can exceed rawImpact when the named-wallet ceiling applies (see RULES.md).
   */
  scoreImpact: number;
  /** Points before the per-detector cap (also <= 0). Equal to scoreImpact unless capped. */
  rawImpact: number;
  title: string;
  /** Plain-language explanation, 1 to 3 sentences, English. */
  explanation: string;
  evidence: Evidence[];
  chains: ChainId[];
  related?: RelatedAddress[];
  /** True when this finding is only shown above the holder threshold. V1 threshold = 0, so always visible. */
  deep?: boolean;
}

/**
 * Something the user must know that is not a privacy leak and costs no points. Today one kind:
 * `address_poisoning`, addresses made to look like the scanned wallet or a wallet it uses.
 */
export interface Warning {
  id: 'address_poisoning';
  title: string;
  /** Plain-language explanation, English. */
  explanation: string;
  /**
   * Each look-alike and the address it imitates. Print both IN FULL, never shortened: shortened, a
   * look-alike reads exactly like the real address (that is the attack). Never a linked wallet.
   */
  lookalikes: { address: Address; imitates: Address; chainId: ChainId }[];
  evidence: Evidence[];
  chains: ChainId[];
}

export type ChainScanStatus = 'scanned' | 'no_activity' | 'partial' | 'error' | 'skipped';

export type SourceKind = 'blockscout' | 'routescan' | 'etherscan' | 'nodereal' | 'alchemy' | 'rpc';

/** What the engine could and could not see on one chain. Shown to the user next to the score. */
export interface ChainCoverage {
  chainId: ChainId;
  name: string;
  status: ChainScanStatus;
  source: SourceKind;
  txCount: number;
  tokenTransferCount: number;
  /** Internal (contract to wallet) native transfers: full, none (chain has no traces), or not fetched. */
  internalTransfers: 'full' | 'none' | 'not_fetched';
  /** True when the history was cut at the page limit; older activity was not read. */
  truncated: boolean;
  /** Plain-language limits, e.g. "No traces on this chain: internal ETH transfers are invisible." */
  limitations: string[];
  /**
   * Parts that should have been read but were not (rate limit, timeout, explorer error), e.g.
   * "internal transfers". Empty when the chain was read in full. Not empty = status `partial`.
   */
  missing: string[];
  /**
   * The quick check before reading, from the chain's public RPC: transactions the address sent here
   * (its nonce; 0 for a contract, whose nonce counts the contracts it created) and whether it holds
   * the chain's coin. Absent when the check did not run or did not answer.
   */
  precheck?: { sent: number; holds: boolean };
  /**
   * Why a `skipped` chain was not read: `no_key`, the relay has no key for it yet; `quota`, the relay's
   * free daily quota is spent (it comes back at 00:00 UTC). Neither is helped by a retry.
   */
  skipReason?: 'no_key' | 'quota';
  firstSeen?: number;
  lastSeen?: number;
  durationMs: number;
  error?: string;
}

/**
 * What a known service address is: `exchange` an exchange's own wallet, `deposit` a deposit address
 * an exchange holds the key of, `bridge` a wallet a bridge runs (relayer, maker), the rest from the
 * open service list (MEV and other bots, bundlers and deployers, airdrop and payout wallets, payment
 * processors, market makers).
 */
export type ServiceKind = 'exchange' | 'deposit' | 'bridge' | 'bot' | 'infrastructure' | 'distributor' | 'payments' | 'market maker' | 'service';

/** The scanned address itself is a service, not a person's wallet. */
export interface ServiceIdentity {
  kind: ServiceKind;
  /** Who runs it, when the list names it, e.g. "Binance", "Axelar". */
  entity?: string;
}

export type ScoreBand = 'exposed' | 'traceable' | 'moderate' | 'private';

export interface ScoreBreakdown {
  base: 100;
  /** Points lost per detector, after the cap. Negative or 0. */
  byDetector: Record<DetectorId, number>;
  /** Detectors whose raw total was cut by the cap. */
  capped: DetectorId[];
  /** Set when the named-wallet ceiling applied (the score was lowered to this value). */
  ceiling?: number;
}

export interface ScanResult {
  schemaVersion: 1;
  address: Address;
  /** ISO 8601. */
  scannedAt: string;
  durationMs: number;
  /**
   * 'running' while streaming. At the end: 'complete' when everything was read, else 'partial', and
   * `incomplete` says what is missing. A partial score is computed from what was read only.
   */
  status: 'running' | 'partial' | 'complete';
  addressType: 'eoa' | 'contract' | 'unknown';
  /** 0 to 100. 100 = nothing links this wallet to anything; 0 = fully exposed. */
  score: number;
  band: ScoreBand;
  breakdown: ScoreBreakdown;
  findings: Finding[];
  /** Union of every finding's `related`, merged per address, highest confidence first. */
  linkedWallets: RelatedAddress[];
  /** Safety warnings that are not findings and cost no points (address poisoning). Empty when there are none. */
  warnings: Warning[];
  identity: {
    ens?: string;
    /** The explorer's name tags on the scanned address itself, e.g. "Binance 14", "Vitalik Buterin". */
    labels: string[];
    /**
     * Set when the bundled label lists name the scanned address itself as a service, or the explorer
     * tags it as an exchange, a deposit address or an MEV bot. Its score describes the service's
     * traffic, not a person: show this state instead of a band and links.
     */
    service?: ServiceIdentity;
    /**
     * Set when the address holds code on a chain the scan read (a contract): those chains in register
     * order, and its name on them. The name is a tag seen on a chain that holds the code, never a tag that
     * only another chain gives this address. Absent name: no chain with the code names it.
     */
    contract?: { chains: ChainId[]; name?: string };
    /** The chains each label in `labels` was seen on. */
    labelChains?: Record<string, ChainId[]>;
  };
  /**
   * Set when the address never sent a transaction and holds nothing on every chain read, and nothing
   * names it: there is nothing to score (the score is 100 by construction). Show that instead of a band.
   */
  unused?: true;
  coverage: ChainCoverage[];
  /** What this scan could not read. Empty when `status` is 'complete'. Show it next to a partial score. */
  incomplete: Incomplete[];
  engine: { name: 'nymra-privacy-scan'; version: string; rulesVersion: string };
  /** Final result only: network requests, cache hits, time spent waiting for rate limits, lowest headroom seen. */
  stats?: { requests: number; cached: number; waitedMs: number; byKind?: Record<string, number>; rateLimitRemaining?: number };
}

/** One thing a scan could not read. */
export interface Incomplete {
  /**
   * `chain`: the whole chain; `tokens` / `internal` / `oldest`: one list of a chain; `identity`: the
   * ENS name, public labels or contract check (a public label sets the named-wallet ceiling); `names`: the other
   * ENS names of the address or the records of its name (side lists, no ceiling); `lookups`: funder or
   * deposit checks; `skipped`: a chain this scan does not read (it needs a key the relay lacks) where
   * the quick check saw the wallet send or hold something; `aborted`: the scan was stopped.
   */
  part: 'chain' | 'tokens' | 'internal' | 'oldest' | 'identity' | 'names' | 'lookups' | 'skipped' | 'aborted';
  chainId?: ChainId;
  /** Chain name, or "ENS and labels", "Other ENS names", "ENS records", "Funder and deposit checks". */
  name: string;
  /** Plain sentence, e.g. "Base: rate limit reached". Never contains the address. */
  reason: string;
}

export type ScanProgress =
  | { type: 'start'; address: Address; chainIds: ChainId[] }
  | { type: 'chain'; coverage: ChainCoverage }
  | { type: 'finding'; finding: Finding }
  /** A full intermediate result; render it as is. Sent after each chain and each detector pass. */
  | { type: 'partial'; result: ScanResult }
  | { type: 'done'; result: ScanResult };

export interface ScanOptions {
  /** Chains to scan. Default: every chain in the register with `defaultOn: true`. */
  chainIds?: ChainId[];
  onProgress?: (event: ScanProgress) => void;
  /** Abort the scan. Partial data gathered so far is still returned. */
  signal?: AbortSignal;
  /** Max transactions read per chain (newest first). Default 500; token transfers 250, internal 150. */
  maxTxPerChain?: number;
  /** Per-request timeout in ms. Default 12000. */
  requestTimeoutMs?: number;
  /** Override fetch (tests, proxy). Default globalThis.fetch. */
  fetch?: typeof fetch;
  /** Optional proxy base: every request is rewritten to `${proxy}?u=<encoded url>`. */
  proxy?: string;
  /** Proxy used only when a direct request is refused (rate limit or bot wall). See proxy/README.md. */
  fallbackProxy?: string;
  /**
   * The Nymra relay that holds the API keys of Linea and BNB Smart Chain (`https://nymra.si/p`).
   * Default: `fallbackProxy`. Without one, those two chains show as `skipped`.
   */
  relay?: string;
  /**
   * Keyed second sources whose key the relay holds. `['alchemy']`: Base and Polygon PoS are read through
   * Alchemy's Transfers API (a server, which their explorers always refuse). Only the bot and the ASI agent
   * pass it; default none, so the browser reads every chain from its own explorer.
   */
  keyedAlts?: Array<'alchemy'>;
  /** Skip the cheap RPC nonce + balance check and read every chain from its explorer. */
  noPrecheck?: boolean;
  /**
   * Read every list in full also for an address that is no person (a contract, a service, a bot). Default
   * false: such an address reads only the newest page of each chain, which is all its card shows (history.ts
   * QUICK_ROWS).
   */
  readAll?: boolean;
  /** Holder gate: findings marked `deep` are withheld when holderBalance < threshold. V1 threshold 0. */
  gate?: { threshold: number; holderBalance: number };
  /** Most network requests this scan may make. Default 600. */
  requestBudget?: number;
  /** Time limit of the whole scan, ms. Default 150000. What was not read by then is listed in `incomplete`. */
  timeLimitMs?: number;
  /** Reuse answers from earlier scans in this page (in memory, 10 minutes). Default true. */
  cache?: boolean;
}
