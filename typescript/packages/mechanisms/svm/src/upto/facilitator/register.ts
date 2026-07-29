import { x402Facilitator } from "@x402/core/facilitator";
import { Network } from "@x402/core/types";
import { type UptoSvmSigner } from "./channel";
import { UptoSvmScheme } from "./scheme";

/** Configuration for registering the upto SVM facilitator scheme to an x402Facilitator. */
export interface UptoSvmFacilitatorRegisterConfig {
  /** Transaction fee payer, channel rent payer, and zero-share channel payee. */
  feePayer: UptoSvmSigner;
  /** Voucher signer. Defaults to `feePayer` for self-facilitation. */
  receiverAuthorizer?: UptoSvmSigner;
  /** Networks to register (single network or array). */
  networks: Network | Network[];
  /** Optional custom RPC URL. */
  rpcUrl?: string;
  /** Optional forced-close grace period advertised as `extra.withdrawDelay`. */
  withdrawDelay?: number;
}

/**
 * Register the upto SVM facilitator scheme on an existing x402Facilitator.
 *
 * @param facilitator - The x402Facilitator to register on
 * @param config - Facilitator configuration
 * @returns The facilitator for chaining
 */
export function registerUptoSvmScheme(
  facilitator: x402Facilitator,
  config: UptoSvmFacilitatorRegisterConfig,
): x402Facilitator {
  facilitator.register(
    config.networks,
    new UptoSvmScheme(config.feePayer, config.receiverAuthorizer, {
      ...(config.rpcUrl ? { rpcUrl: config.rpcUrl } : {}),
      ...(config.withdrawDelay !== undefined ? { withdrawDelay: config.withdrawDelay } : {}),
    }),
  );
  return facilitator;
}
