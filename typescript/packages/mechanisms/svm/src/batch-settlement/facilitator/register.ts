import { x402Facilitator } from "@x402/core/facilitator";
import { Network } from "@x402/core/types";
import type { FacilitatorSvmSigner } from "../../signer";
import { BatchSvmScheme, type BatchSvmFacilitatorConfig } from "./scheme";

/** Configuration for registering the batch-settlement SVM facilitator scheme. */
export interface BatchSvmFacilitatorRegisterConfig extends BatchSvmFacilitatorConfig {
  /** The operator signer: open fee payer/co-signer and settlement submitter. */
  signer: FacilitatorSvmSigner;
  /** Networks to register (single network or array). */
  networks: Network | Network[];
}

/**
 * Register the batch-settlement SVM facilitator scheme on an existing x402Facilitator.
 *
 * @param facilitator - The x402Facilitator to register on
 * @param config - Facilitator configuration
 * @returns The facilitator for chaining
 */
export function registerBatchSvmScheme(
  facilitator: x402Facilitator,
  config: BatchSvmFacilitatorRegisterConfig,
): x402Facilitator {
  const { networks, signer, ...rest } = config;
  facilitator.register(networks, new BatchSvmScheme(signer, rest));
  return facilitator;
}
