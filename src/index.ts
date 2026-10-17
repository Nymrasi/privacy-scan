// Public entry of @nymra/privacy-scan.
export type * from './types.ts';
export { scan, isAddress, ENGINE_VERSION, clearSessionCache } from './scan.ts';
export { mockScan, FIXTURES } from './mock.ts';
export { scoreFindings, bandFor, linkLevel, LINK_LEVELS, NAMED_CEILING, RULES_VERSION, SEVERITY_POINTS, DETECTOR_CAPS, DETECTORS } from './score.ts';
export { CHAINS, UNSUPPORTED, CHAIN_BY_ID, defaultChainIds, chainName, txUrl, addressUrl } from './chains.ts';
export type { ChainDef, SourceDef } from './chains.ts';
export { cexLabel, cexStats, serviceIdentity } from './labels.ts';
/** Address poisoning: `lookalike(a, b)` for two lowercase addresses, the engine's 3 + 4 or 4 + 3 rule. */
export { lookalike } from './detectors/context.ts';
export { sessionOf } from './session.ts';
export type { ScanSession } from './session.ts';
export * from './features/index.ts';
