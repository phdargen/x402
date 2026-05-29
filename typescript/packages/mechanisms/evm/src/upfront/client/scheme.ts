import {
  SchemeNetworkClient,
  PaymentRequirements,
  PaymentPayloadResult,
  PaymentPayloadContext,
} from "@x402/core/types";
import { ClientEvmSigner } from "../../signer";
import { ExactEvmScheme } from "../../exact/client/scheme";
import { ExactEvmSchemeOptions } from "../../exact/client/rpc";

/**
 * EVM client for the upfront scheme. Reuses exact EIP-3009 and Permit2 payload builders.
 */
export class UpfrontEvmScheme implements SchemeNetworkClient {
  readonly scheme = "upfront";
  private readonly exact: ExactEvmScheme;

  /**
   * Creates a new UpfrontEvmScheme instance.
   *
   * @param signer - EVM signer for payment payload creation
   * @param options - Optional RPC configuration for extension flows
   */
  constructor(signer: ClientEvmSigner, options?: ExactEvmSchemeOptions) {
    this.exact = new ExactEvmScheme(signer, options);
  }

  /**
   * Creates a payment payload for the upfront scheme using exact EIP-3009 or Permit2 paths.
   *
   * @param x402Version - x402 protocol version
   * @param paymentRequirements - Server payment requirements
   * @param context - Optional extension context from PaymentRequired
   * @returns Payment payload fields for the upfront scheme
   */
  createPaymentPayload(
    x402Version: number,
    paymentRequirements: PaymentRequirements,
    context?: PaymentPayloadContext,
  ): Promise<PaymentPayloadResult> {
    return this.exact.createPaymentPayload(x402Version, paymentRequirements, context);
  }
}
