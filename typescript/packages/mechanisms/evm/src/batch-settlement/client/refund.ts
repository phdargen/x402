import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  encodePaymentSignatureHeader,
} from "@x402/core/http";
import type { PaymentRequired } from "@x402/core/types";
import type { PaymentRequirements, PaymentPayloadResult, SettleResponse } from "@x402/core/types";
import { BATCH_SETTLEMENT_SCHEME } from "../constants";
import type {
  BatchSettlementPaymentRequirementsExtra,
  BatchSettlementVoucherPayload,
} from "../types";
import { computeChannelId } from "../utils";
import { processCorrectivePaymentRequired } from "./recovery";
import {
  type BatchSettlementClientDeps,
  buildChannelConfig,
  processSettleResponse,
  recoverSession,
} from "./session";
import { signVoucher } from "./voucher";

/**
 * Refund-specific server errors that the client cannot recover from automatically.
 * Seeing any of these means the user should adjust their request (or accept that the
 * channel has nothing left to refund) — retrying will not help.
 */
const NON_RECOVERABLE_REFUND_ERRORS: ReadonlySet<string> = new Set([
  "batch_settlement_refund_no_balance",
  "batch_settlement_refund_amount_invalid",
  "batch_settlement_refund_amount_exceeds_balance",
]);

/**
 * Caller-facing options for {@link refundChannel}.
 */
export interface RefundOptions {
  /** Token base units to refund; omit for a full refund (drains remaining balance). */
  amount?: string;
  /** Custom fetch implementation (defaults to `globalThis.fetch`). */
  fetch?: typeof fetch;
}

/**
 * Sends a cooperative refund request to the channel that backs `url`.
 *
 * Flow:
 * 1. Probe the URL with `GET` (no payment) to obtain the route's payment requirements.
 * 2. Build the `ChannelConfig` and resolve the local session (or recover it).
 * 3. Sign a zero-charge voucher (`maxClaimableAmount = chargedCumulativeAmount`)
 *    with `refund: true` and the optional `refundAmount` (partial refund).
 * 4. Send the voucher via `PAYMENT-SIGNATURE`. On a corrective 402, run the
 *    standard recovery path and retry once.
 * 5. Return the parsed `SettleResponse` from the server.
 *
 * @param ctx - Identity inputs (storage, signers, salt, payerAuthorizer).
 * @param url - Any protected route on the channel to refund (the resource handler is bypassed).
 * @param options - Optional `amount` (partial refund) and `fetch` override.
 * @returns The settle response describing the refund outcome.
 * @throws When the probe fails, the receiver lacks an authorizer, or recovery fails.
 */
export async function refundChannel(
  ctx: BatchSettlementClientDeps,
  url: string,
  options?: RefundOptions,
): Promise<SettleResponse> {
  const fetchImpl = options?.fetch ?? globalThis.fetch;
  if (!fetchImpl) {
    throw new Error("refund requires a fetch implementation (globalThis.fetch unavailable)");
  }

  const refundAmount = normalizeRefundAmount(options?.amount);
  const requirements = await probeRefundRequirements(url, fetchImpl);
  return executeRefund(ctx, url, requirements, refundAmount, fetchImpl);
}

/**
 * Probes a URL with an unauthenticated GET to retrieve batch-settlement payment
 * requirements via the 402 PAYMENT-REQUIRED header.
 *
 * @param url - The protected URL to probe.
 * @param fetchImpl - Fetch implementation used for the probe.
 * @returns Matching batch-settlement payment requirements for the route.
 */
async function probeRefundRequirements(
  url: string,
  fetchImpl: typeof fetch,
): Promise<PaymentRequirements> {
  const probe = await fetchImpl(url, { method: "GET" });
  if (probe.status !== 402) {
    throw new Error(`Refund probe expected 402, got ${probe.status}`);
  }

  const header = probe.headers.get("PAYMENT-REQUIRED");
  if (!header) {
    throw new Error("Refund probe response missing PAYMENT-REQUIRED header");
  }

  const paymentRequired = decodePaymentRequiredHeader(header);
  const requirements = paymentRequired.accepts.find(a => a.scheme === BATCH_SETTLEMENT_SCHEME);
  if (!requirements) {
    throw new Error(`No ${BATCH_SETTLEMENT_SCHEME} payment option at ${url}`);
  }

  const extra = requirements.extra as Partial<BatchSettlementPaymentRequirementsExtra> | undefined;
  if (!extra?.receiverAuthorizer) {
    throw new Error("Refund requires a configured receiverAuthorizer on the receiver");
  }

  return requirements;
}

/**
 * Builds and submits the refund voucher, retrying once after a corrective 402.
 *
 * @param ctx - Identity inputs (storage, signers, salt, payerAuthorizer).
 * @param url - The protected URL to send the refund voucher to.
 * @param requirements - Resolved payment requirements for this channel.
 * @param refundAmount - Optional partial refund amount in token base units.
 * @param fetchImpl - Fetch implementation used for the request.
 * @returns The parsed settle response.
 */
async function executeRefund(
  ctx: BatchSettlementClientDeps,
  url: string,
  requirements: PaymentRequirements,
  refundAmount: string | undefined,
  fetchImpl: typeof fetch,
): Promise<SettleResponse> {
  const maxAttempts = 2;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const voucherPayload = await buildRefundVoucherPayload(ctx, requirements, refundAmount);
    const headers = {
      "PAYMENT-SIGNATURE": encodePaymentSignatureHeader({
        x402Version: voucherPayload.x402Version,
        accepted: requirements,
        payload: voucherPayload.payload as Record<string, unknown>,
        ...(voucherPayload.extensions ? { extensions: voucherPayload.extensions } : {}),
      }),
    };

    const response = await fetchImpl(url, { method: "GET", headers });

    if (response.status === 402) {
      // A 402 may carry either a PAYMENT-RESPONSE (settle aborted with a structured SettleResponse)
      // or a PAYMENT-REQUIRED (verify aborted with corrective hints).
      // Settle-side aborts for refunds are non-recoverable, so fail fast instead of retrying
      const settleHeader = response.headers.get("PAYMENT-RESPONSE");
      if (settleHeader) {
        const settle = decodePaymentResponseHeader(settleHeader);
        throw new Error(formatRefundFailure(settle));
      }

      const requiredHeader = response.headers.get("PAYMENT-REQUIRED");
      if (!requiredHeader) {
        throw new Error("Refund 402 missing PAYMENT-REQUIRED header");
      }

      const paymentRequired: PaymentRequired = decodePaymentRequiredHeader(requiredHeader);
      const errorCode = paymentRequired.error;
      if (errorCode && NON_RECOVERABLE_REFUND_ERRORS.has(errorCode)) {
        throw new Error(`Refund failed: ${errorCode}`);
      }

      if (attempt >= maxAttempts) {
        throw new Error(`Refund failed: server returned 402 after ${attempt} attempt(s)`);
      }

      const recovered = await processCorrectivePaymentRequired(ctx, paymentRequired);
      if (!recovered) {
        throw new Error(`Refund failed: ${errorCode ?? "unknown"}`);
      }
      continue;
    }

    const settleHeader = response.headers.get("PAYMENT-RESPONSE");
    if (!settleHeader) {
      throw new Error(
        `Refund response missing PAYMENT-RESPONSE header (status ${response.status})`,
      );
    }

    const settle = decodePaymentResponseHeader(settleHeader);
    await processSettleResponse(ctx.storage, settle);
    return settle;
  }

  throw new Error("Refund failed: retry budget exhausted");
}

/**
 * Builds the voucher payload (zero-charge `maxClaimableAmount`) for a refund.
 *
 * @param ctx - Identity inputs (storage, signers, salt, payerAuthorizer).
 * @param requirements - Resolved payment requirements for the channel.
 * @param refundAmount - Optional partial refund amount in token base units.
 * @returns A payment payload result wrapping the signed refund voucher.
 */
async function buildRefundVoucherPayload(
  ctx: BatchSettlementClientDeps,
  requirements: PaymentRequirements,
  refundAmount: string | undefined,
): Promise<PaymentPayloadResult> {
  const config = buildChannelConfig(ctx, requirements);
  const channelId = computeChannelId(config);
  const key = channelId.toLowerCase();

  let session = await ctx.storage.get(key);
  if (session === undefined && ctx.signer.readContract) {
    session = await recoverSession(ctx, requirements);
  }
  if (session === undefined) {
    throw new Error(
      "Refund requires an existing channel session; deposit first or call from a context with an EVM RPC",
    );
  }

  // Skip the network round-trip when our local view of the channel already shows it is fully drained
  const charged = session.chargedCumulativeAmount ?? "0";
  if (session.balance !== undefined && BigInt(session.balance) <= BigInt(charged)) {
    throw new Error(
      `Refund failed: channel has no remaining balance (balance=${session.balance}, chargedCumulativeAmount=${charged})`,
    );
  }

  const voucherSigner = ctx.voucherSigner ?? ctx.signer;
  const voucher = await signVoucher(voucherSigner, channelId, charged, requirements.network);

  const payload: BatchSettlementVoucherPayload = {
    type: "voucher",
    channelConfig: config,
    ...voucher,
    refund: true,
    ...(refundAmount !== undefined ? { refundAmount } : {}),
  };

  return {
    x402Version: 2,
    payload,
  };
}

/**
 * Builds a human-readable error message from a settle failure response.
 *
 * @param settle - The decoded SettleResponse from the server's 402 reply.
 * @returns A formatted error string suitable for `throw new Error(...)`.
 */
function formatRefundFailure(settle: SettleResponse): string {
  const reason = settle.errorReason ?? "unknown_settlement_error";
  const message = settle.errorMessage;
  if (message && message !== reason) {
    return `Refund failed: ${reason}: ${message}`;
  }
  return `Refund failed: ${reason}`;
}

/**
 * Validates and normalises the optional `refundAmount` argument.
 *
 * @param amount - Raw amount from caller (string of base units).
 * @returns The same string when valid, or `undefined` when omitted.
 */
function normalizeRefundAmount(amount: string | undefined): string | undefined {
  if (amount === undefined) return undefined;
  if (!/^\d+$/.test(amount) || amount === "0") {
    throw new Error(`Invalid refund amount "${amount}": must be a positive integer string`);
  }
  return amount;
}
