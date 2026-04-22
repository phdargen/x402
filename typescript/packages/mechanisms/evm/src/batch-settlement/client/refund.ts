import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  encodePaymentSignatureHeader,
} from "@x402/core/http";
import type { PaymentRequired } from "@x402/core/types";
import type { PaymentRequirements, PaymentPayloadResult, SettleResponse } from "@x402/core/types";
import type { ClientEvmSigner } from "../../signer";
import { BATCH_SETTLEMENT_SCHEME } from "../constants";
import type {
  BatchSettlementPaymentRequirementsExtra,
  BatchSettlementVoucherPayload,
  ChannelConfig,
} from "../types";
import { computeChannelId } from "../utils";
import type { BatchSettlementClientContext, ClientSessionStorage } from "./storage";
import { signVoucher } from "./voucher";

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
 * Narrow view of the client scheme that the refund flow needs.
 *
 * Defining a structural contract here (rather than importing the scheme class)
 * keeps `refund.ts` decoupled from `scheme.ts` and breaks the import cycle.
 */
export interface RefundContext {
  storage: ClientSessionStorage;
  signer: ClientEvmSigner;
  voucherSigner?: ClientEvmSigner;
  buildChannelConfig(requirements: PaymentRequirements): ChannelConfig;
  recoverSession(requirements: PaymentRequirements): Promise<BatchSettlementClientContext>;
  processSettleResponse(settle: SettleResponse): Promise<void>;
  processCorrectivePaymentRequired(paymentRequired: PaymentRequired): Promise<boolean>;
}

/**
 * Sends a cooperative refund request to the channel that backs `url`.
 *
 * Flow:
 * 1. Probe the URL with `GET` (no payment) to obtain the route's payment requirements.
 * 2. Build the {@link ChannelConfig} and resolve the local session (or recover it).
 * 3. Sign a zero-charge voucher (`maxClaimableAmount = chargedCumulativeAmount`)
 *    with `refund: true` and the optional `refundAmount` (partial refund).
 * 4. Send the voucher via `PAYMENT-SIGNATURE`. On a corrective 402, run the
 *    standard recovery path and retry once.
 * 5. Return the parsed `SettleResponse` from the server.
 *
 * @param ctx - The scheme view providing storage, signers, and recovery helpers.
 * @param url - Any protected route on the channel to refund (the resource handler is bypassed).
 * @param options - Optional `amount` (partial refund) and `fetch` override.
 * @returns The settle response describing the refund outcome.
 * @throws When the probe fails, the receiver lacks an authorizer, or recovery fails.
 */
export async function refundChannel(
  ctx: RefundContext,
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
 * Reconciles local session state with the outcome of a cooperative refund.
 *
 * Deletes the session when the post-refund balance is zero (full refund),
 * otherwise updates `balance`, `chargedCumulativeAmount`, and `totalClaimed`
 * from the server snapshot (partial refund — channel stays open).
 *
 * @param storage - Client session storage.
 * @param channelKey - Lowercased channel id used as the storage key.
 * @param settleExtra - The `extra` block from the refund settle response.
 */
export async function updateSessionAfterRefund(
  storage: ClientSessionStorage,
  channelKey: string,
  settleExtra: Record<string, unknown>,
): Promise<void> {
  const balanceAfter =
    settleExtra.balance !== undefined ? BigInt(String(settleExtra.balance)) : undefined;

  if (balanceAfter === undefined || balanceAfter <= 0n) {
    await storage.delete(channelKey);
    return;
  }

  const prev = await storage.get(channelKey);
  const next: BatchSettlementClientContext = { ...(prev ?? {}) };
  next.balance = balanceAfter.toString();
  if (settleExtra.chargedCumulativeAmount !== undefined) {
    next.chargedCumulativeAmount = String(settleExtra.chargedCumulativeAmount);
  }
  if (settleExtra.totalClaimed !== undefined) {
    next.totalClaimed = String(settleExtra.totalClaimed);
  }
  await storage.set(channelKey, next);
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
 * @param ctx - The scheme view providing storage, signers, and recovery helpers.
 * @param url - The protected URL to send the refund voucher to.
 * @param requirements - Resolved payment requirements for this channel.
 * @param refundAmount - Optional partial refund amount in token base units.
 * @param fetchImpl - Fetch implementation used for the request.
 * @returns The parsed settle response.
 */
async function executeRefund(
  ctx: RefundContext,
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
      if (attempt >= maxAttempts) {
        throw new Error(`Refund failed: server returned 402 after ${attempt} attempt(s)`);
      }

      const requiredHeader = response.headers.get("PAYMENT-REQUIRED");
      if (!requiredHeader) {
        throw new Error("Refund 402 missing PAYMENT-REQUIRED header");
      }

      const paymentRequired = decodePaymentRequiredHeader(requiredHeader);
      const recovered = await ctx.processCorrectivePaymentRequired(paymentRequired);
      if (!recovered) {
        throw new Error(`Refund failed: ${paymentRequired.error ?? "unknown"}`);
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
    await ctx.processSettleResponse(settle);
    return settle;
  }

  throw new Error("Refund failed: retry budget exhausted");
}

/**
 * Builds the voucher payload (zero-charge `maxClaimableAmount`) for a refund.
 *
 * @param ctx - The scheme view providing storage, signers, and recovery helpers.
 * @param requirements - Resolved payment requirements for the channel.
 * @param refundAmount - Optional partial refund amount in token base units.
 * @returns A payment payload result wrapping the signed refund voucher.
 */
async function buildRefundVoucherPayload(
  ctx: RefundContext,
  requirements: PaymentRequirements,
  refundAmount: string | undefined,
): Promise<PaymentPayloadResult> {
  const config = ctx.buildChannelConfig(requirements);
  const channelId = computeChannelId(config);
  const key = channelId.toLowerCase();

  let session = await ctx.storage.get(key);
  if (session === undefined && ctx.signer.readContract) {
    session = await ctx.recoverSession(requirements);
  }
  if (session === undefined) {
    throw new Error(
      "Refund requires an existing channel session; deposit first or call from a context with an EVM RPC",
    );
  }

  const charged = session.chargedCumulativeAmount ?? "0";
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
