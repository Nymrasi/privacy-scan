// The seven V1 detectors, in the order they appear in RULES.md.
import type { Detector } from './context.ts';
import { publicIdentity } from './public-identity.ts';
import { linkedWallets } from './linked-wallets.ts';
import { fundingReuse } from './funding-reuse.ts';
import { cexExposure } from './cex-exposure.ts';
import { crossChain } from './cross-chain.ts';
import { behavioralFingerprint } from './behavioral-fingerprint.ts';
import { recurringCounterparties } from './recurring-counterparties.ts';

export const DETECTOR_LIST: Detector[] = [publicIdentity, linkedWallets, fundingReuse, cexExposure, crossChain, behavioralFingerprint, recurringCounterparties];
export { publicIdentity, linkedWallets, fundingReuse, cexExposure, crossChain, behavioralFingerprint, recurringCounterparties };
