import {
  PaymentPayload,
  PaymentRequirements,
  SchemeNetworkFacilitator,
  FacilitatorContext,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import { FacilitatorEvmSigner } from "../../signer";
import { ExactEvmScheme, ExactEvmSchemeConfig } from "../../exact/facilitator/scheme";

/**
 * EVM facilitator for upfront. Verify and settle use the same EIP-3009 / Permit2 paths as exact.
 */
export class UpfrontEvmScheme implements SchemeNetworkFacilitator {
  readonly scheme = "upfront";
  readonly caipFamily = "eip155:*";
  private readonly exact: ExactEvmScheme;

  /**
   * Creates a new UpfrontEvmScheme facilitator instance.
   *
   * @param signer - Facilitator EVM signer
   * @param config - Optional exact facilitator configuration
   */
  constructor(signer: FacilitatorEvmSigner, config?: ExactEvmSchemeConfig) {
    this.exact = new ExactEvmScheme(signer, config);
  }

  /**
   * Returns mechanism-specific extra metadata from the exact facilitator.
   *
   * @param network - Network identifier
   * @returns Mechanism-specific extra metadata, if any
   */
  getExtra(network: string): Record<string, unknown> | undefined {
    return this.exact.getExtra(network);
  }

  /**
   * Returns facilitator signer addresses from the exact facilitator.
   *
   * @param network - Network identifier
   * @returns Facilitator signer addresses
   */
  getSigners(network: string): string[] {
    return this.exact.getSigners(network);
  }

  /**
   * Verifies an upfront payment payload against the given requirements.
   *
   * @param payload - Payment payload
   * @param requirements - Payment requirements
   * @param context - Facilitator extension context
   * @returns Verification result
   */
  verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    context?: FacilitatorContext,
  ): Promise<VerifyResponse> {
    return this.exact.verify(payload, requirements, context);
  }

  /**
   * Settles an upfront payment on-chain via the exact facilitator path.
   *
   * @param payload - Payment payload
   * @param requirements - Payment requirements
   * @param context - Facilitator extension context
   * @returns Settlement result (re-verifies before broadcasting, same as exact)
   */
  settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    context?: FacilitatorContext,
  ): Promise<SettleResponse> {
    return this.exact.settle(payload, requirements, context);
  }
}
