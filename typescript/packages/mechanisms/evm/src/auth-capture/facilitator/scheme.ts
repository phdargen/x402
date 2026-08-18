/**
 * AuthCapture Scheme - Facilitator
 * Handles verification and settlement of auth-capture payments.
 *
 * Implements x402's SchemeNetworkFacilitator interface so the auth-capture scheme
 * is a drop-in for the x402 facilitator, just like ExactEvmScheme.
 *
 * Dispatches on `payload.type`: collect (authorize/charge) when absent, lifecycle
 * (capture/void/refund) when present. Operator type, not bytecode, selects the
 * settle target.
 */

import type {
  FacilitatorContext,
  PaymentPayload,
  PaymentRequirements,
  SchemeNetworkFacilitator,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import type { FacilitatorEvmSigner } from "../../signer";
import { AUTH_CAPTURE_SCHEME } from "../constants";
import type { AuthCaptureFacilitatorConfig } from "../types";
import { isAuthCaptureCollectPayload, isLifecyclePayload } from "../types";
import * as Errors from "../errors";
import { verifyCollect, settleCollect } from "./collect";
import { verifyLifecycle, settleLifecycle } from "./lifecycle";

export type { AuthCaptureFacilitatorConfig } from "../types";

/**
 * AuthCapture Facilitator Scheme - implements x402's SchemeNetworkFacilitator.
 *
 * Settle dispatch:
 *  - no `payload.type` + extra.paymentFlow escrow (default) → escrow.authorize()
 *  - no `payload.type` + extra.paymentFlow authorization → escrow.charge()
 *  - payload.type capture / void / refund → lifecycle
 *
 * Asset-transfer dispatch (extra.assetTransferMethod):
 *  - 'eip3009' (default) → ERC-3009 ReceiveWithAuthorization, EIP3009_TOKEN_COLLECTOR
 *  - 'permit2'           → Permit2 PermitTransferFrom, PERMIT2_TOKEN_COLLECTOR
 */
export class AuthCaptureEvmScheme implements SchemeNetworkFacilitator {
  readonly scheme = AUTH_CAPTURE_SCHEME;
  readonly caipFamily = "eip155:*";

  /**
   * Construct a facilitator-side auth-capture scheme bound to a specific signer.
   *
   * @param signer - Facilitator signer with onchain read + write capability.
   * @param config - Optional fee terms, operator allowlist, delegated refund funding.
   */
  constructor(
    private signer: FacilitatorEvmSigner,
    private config?: AuthCaptureFacilitatorConfig,
  ) {}

  /**
   * Return the EOA address(es) this facilitator submits transactions from.
   * Advertised via `/supported` so merchants can set
   * `extra.captureAuthorizer` for `operatorType: "delegated"`.
   *
   * @param _ - Unused network argument (interface compatibility).
   * @returns The facilitator's submitter address(es) on this network.
   */
  getSigners(_: string): string[] {
    return [...this.signer.getAddresses()];
  }

  /**
   * Facilitator-injected `extra` fields for `/supported`: optional receiver
   * authorizer, grouped fee terms, and the custom-operator allowlist.
   *
   * @param _ - Unused network argument (interface compatibility).
   * @returns Extra to merge into payment requirements, or undefined when empty.
   */
  getExtra(_: string): Record<string, unknown> | undefined {
    const extra: Record<string, unknown> = {};
    if (this.config?.receiverAuthorizer) {
      extra.receiverAuthorizer = this.config.receiverAuthorizer;
    }
    if (this.config?.feeTerms) {
      extra.feeRecipient = this.config.feeTerms.feeRecipient;
      extra.minFeeBps = this.config.feeTerms.minFeeBps;
      extra.maxFeeBps = this.config.feeTerms.maxFeeBps;
    }
    if (this.config?.operators && this.config.operators.length > 0 && this.signer.simulateCalls) {
      extra.operators = this.config.operators;
    }
    return Object.keys(extra).length > 0 ? extra : undefined;
  }

  /**
   * Verify a payment payload against the published requirements without
   * touching state.
   *
   * @param payload - The wire payload from the payer or resource server.
   * @param requirements - The server's published payment requirements.
   * @param _ - Unused FacilitatorContext (interface compatibility).
   * @returns A `VerifyResponse` with `isValid` and, on failure, a stable `invalidReason`.
   */
  async verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    _?: FacilitatorContext,
  ): Promise<VerifyResponse> {
    const raw = payload.payload;
    if (isLifecyclePayload(raw)) {
      return verifyLifecycle(this.signer, this.config, payload, requirements, raw);
    }
    if (isAuthCaptureCollectPayload(raw)) {
      return verifyCollect(this.signer, this.config, payload, requirements, raw);
    }
    if (typeof raw === "object" && raw !== null && "type" in raw) {
      return { isValid: false, invalidReason: Errors.ErrInvalidPayloadType };
    }
    return { isValid: false, invalidReason: Errors.ErrInvalidPayloadFormat };
  }

  /**
   * Verify-then-settle. Re-runs `verify()` against the payload, then submits
   * the collect or lifecycle call.
   *
   * @param payload - The wire payload from the payer or resource server.
   * @param requirements - The server's published payment requirements.
   * @param context - Optional facilitator context for extension hooks (e.g.
   *                  builder-code calldata suffixes).
   * @returns A `SettleResponse` with `success`, the transaction hash (on
   *          success), and a stable `errorReason` (on failure).
   */
  async settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    context?: FacilitatorContext,
  ): Promise<SettleResponse> {
    const raw = payload.payload;
    if (isLifecyclePayload(raw)) {
      return settleLifecycle(this.signer, this.config, payload, requirements, raw, context);
    }
    if (isAuthCaptureCollectPayload(raw)) {
      return settleCollect(this.signer, this.config, payload, requirements, raw, context);
    }
    return {
      success: false,
      errorReason:
        typeof raw === "object" && raw !== null && "type" in raw
          ? Errors.ErrInvalidPayloadType
          : Errors.ErrInvalidPayloadFormat,
      transaction: "",
      network: requirements.network,
    };
  }
}
