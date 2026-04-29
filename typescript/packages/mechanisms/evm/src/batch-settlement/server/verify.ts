import type {
  VerifiedPaymentCanceledContext,
  VerifyContext,
  VerifyFailureContext,
  VerifyResultContext,
} from "@x402/core/server";
import type { SchemePaymentRequiredContext } from "@x402/core/types";
import {
  type BatchSettlementDepositPayload,
  type BatchSettlementRefundPayload,
  type BatchSettlementVoucherPayload,
  isBatchSettlementDepositPayload,
  isBatchSettlementRefundPayload,
  isBatchSettlementVoucherPayload,
} from "../types";
import { BATCH_SETTLEMENT_SCHEME } from "../constants";
import type { ChannelConfig } from "../types";
import { createNonce } from "../../utils";
import type { BatchSettlementEvmScheme } from "./scheme";
import type { Channel, PendingRequest } from "./storage";
import { readExtraNumber, readExtraString } from "./utils";

const PENDING_GRACE_MS = 5_000;
const MIN_PENDING_TTL_MS = 5_000;
const MAX_PENDING_TTL_MS = 10 * 60 * 1000;

/**
 * Computes the bounded pending reservation expiry time.
 *
 * @param maxTimeoutSeconds - Resource timeout from payment requirements.
 * @param now - Current wall-clock time in milliseconds.
 * @returns Expiry timestamp in milliseconds.
 */
function pendingExpiresAt(maxTimeoutSeconds: number | undefined, now: number): number {
  const requestedMs = Math.max(0, maxTimeoutSeconds ?? 0) * 1000 + PENDING_GRACE_MS;
  const ttlMs = Math.min(MAX_PENDING_TTL_MS, Math.max(MIN_PENDING_TTL_MS, requestedMs));
  return now + ttlMs;
}

/**
 * Checks whether a pending reservation still blocks same-channel work.
 *
 * @param pending - Pending reservation to inspect.
 * @param now - Current wall-clock time in milliseconds.
 * @returns Whether the reservation exists and has not expired.
 */
function isPendingLive(pending: PendingRequest | undefined, now: number): boolean {
  return pending !== undefined && pending.expiresAt > now;
}

/**
 * Lifecycle hook: runs before the facilitator verifies a payment.
 *
 * For paid payloads, checks whether the client's cumulative amount matches server
 * state. If mismatched, aborts with `batch_settlement_cumulative_amount_mismatch`.
 *
 * Refund vouchers are zero-charge: the expected `maxClaimableAmount` equals
 * the existing `chargedCumulativeAmount`.
 *
 * When no local channel record exists, verification is delegated to the facilitator (which checks on-chain state);
 * `handleAfterVerify` then rebuilds the channel record from the verify response.
 *
 * @param scheme - Owning `BatchSettlementEvmScheme` instance for storage access.
 * @param ctx - Verify lifecycle context (payload, requirements, and related state).
 * @returns Nothing to continue verification; or an object with `abort` to fail with a reason.
 */
export async function handleBeforeVerify(
  scheme: BatchSettlementEvmScheme,
  ctx: VerifyContext,
): Promise<void | {
  abort: true;
  reason: string;
  message?: string;
}> {
  const { paymentPayload, requirements } = ctx;

  const raw = paymentPayload.payload;
  const isPaidPayload =
    isBatchSettlementVoucherPayload(raw) || isBatchSettlementDepositPayload(raw);
  const isZeroChargePayload = isBatchSettlementRefundPayload(raw);
  if (!isPaidPayload && !isZeroChargePayload) {
    return;
  }

  const channelId = raw.voucher.channelId;
  const now = Date.now();
  const pendingId = createNonce();
  let outcome:
    | { status: "reserved"; channelSnapshot?: Channel }
    | { status: "busy" }
    | { status: "mismatch"; channel: Channel }
    | undefined;

  await scheme.getStorage().updateChannel(channelId, current => {
    if (isPendingLive(current?.pendingRequest, now)) {
      outcome = { status: "busy" };
      return current;
    }

    const chargedCumulativeAmount =
      current?.chargedCumulativeAmount ??
      inferMissingLocalChargedAmount(
        raw.voucher.maxClaimableAmount,
        requirements.amount,
        isPaidPayload,
      );
    const expectedMaxClaimable = isZeroChargePayload
      ? BigInt(chargedCumulativeAmount)
      : BigInt(chargedCumulativeAmount) + BigInt(requirements.amount);

    if (BigInt(raw.voucher.maxClaimableAmount) !== expectedMaxClaimable) {
      if (current) {
        outcome = { status: "mismatch", channel: current };
      } else {
        outcome = {
          status: "mismatch",
          channel: buildProvisionalChannel(raw, chargedCumulativeAmount),
        };
      }
      return current;
    }

    const pendingRequest: PendingRequest = {
      pendingId,
      signedMaxClaimable: raw.voucher.maxClaimableAmount,
      expiresAt: pendingExpiresAt(requirements.maxTimeoutSeconds, now),
    };

    outcome = { status: "reserved", channelSnapshot: current };
    return {
      ...(current ?? buildProvisionalChannel(raw, chargedCumulativeAmount)),
      pendingRequest,
      lastRequestTimestamp: now,
    };
  });

  if (outcome?.status === "busy") {
    return {
      abort: true,
      reason: "batch_settlement_channel_busy",
      message: "Channel is already processing a request",
    };
  }

  if (outcome?.status === "mismatch") {
    scheme.rememberChannelSnapshot(paymentPayload, outcome.channel);
    return {
      abort: true,
      reason: "batch_settlement_cumulative_amount_mismatch",
      message: "Client voucher base does not match server state",
    };
  }

  if (outcome?.status === "reserved") {
    scheme.mergeRequestContext(paymentPayload, {
      channelId,
      pendingId,
      channelSnapshot: outcome.channelSnapshot,
    });
  }
}

/**
 * Adds server channel state to corrective 402 responses for cumulative mismatches.
 *
 * @param scheme - Owning `BatchSettlementEvmScheme` instance for storage access.
 * @param ctx - Payment-required response context.
 */
export async function handleEnrichPaymentRequiredResponse(
  scheme: BatchSettlementEvmScheme,
  ctx: SchemePaymentRequiredContext,
): Promise<void> {
  if (ctx.error !== "batch_settlement_cumulative_amount_mismatch") {
    return;
  }

  const { paymentPayload } = ctx;
  if (!paymentPayload) {
    return;
  }

  const raw = paymentPayload.payload;
  if (
    !isBatchSettlementVoucherPayload(raw) &&
    !isBatchSettlementDepositPayload(raw) &&
    !isBatchSettlementRefundPayload(raw)
  ) {
    return;
  }

  const channel =
    scheme.takeChannelSnapshot(paymentPayload) ??
    (await scheme.getStorage().get(raw.voucher.channelId));
  if (!channel) {
    return;
  }

  const accept = ctx.requirements.find(
    req =>
      req.scheme === BATCH_SETTLEMENT_SCHEME && req.network === paymentPayload.accepted.network,
  );
  if (!accept) {
    return;
  }

  accept.extra = {
    ...accept.extra,
    ChannelState: {
      channelId: channel.channelId,
      chargedCumulativeAmount: channel.chargedCumulativeAmount,
      signedMaxClaimable: channel.signedMaxClaimable,
      signature: channel.signature,
    },
  };
}

/**
 * Lifecycle hook: runs after the facilitator verifies a payment.
 *
 * Persists channel state (balance, totalClaimed, voucher info) so that
 * subsequent requests can correctly calculate cumulative amounts and detect stale state.
 *
 * For refund payloads, additionally returns a `skipHandler` directive so that
 * the resource server bypasses the application handler and settles inline.
 *
 * @param scheme - Owning `BatchSettlementEvmScheme` instance for storage access.
 * @param ctx - Post-verify lifecycle context.
 * @param ctx.paymentPayload - Incoming payment payload that was verified.
 * @param ctx.requirements - Requirements used for verification.
 * @param ctx.result - Facilitator verify response.
 * @returns Optional `skipHandler` directive when this is a refund voucher; otherwise void.
 */
export async function handleAfterVerify(
  scheme: BatchSettlementEvmScheme,
  ctx: VerifyResultContext,
): Promise<void | { skipHandler: true; response?: { contentType?: string; body?: unknown } }> {
  const { paymentPayload, result } = ctx;
  if (!result.isValid || !result.payer) {
    await scheme.clearPendingRequest(paymentPayload);
    return;
  }

  const raw = paymentPayload.payload;
  let channelId: string;
  let signedMaxClaimable: string;
  let signature: `0x${string}`;
  let channelConfig: ChannelConfig;
  let isRefundVoucher = false;

  if (isBatchSettlementDepositPayload(raw)) {
    channelId = raw.voucher.channelId;
    signedMaxClaimable = raw.voucher.maxClaimableAmount;
    signature = raw.voucher.signature;
    channelConfig = raw.channelConfig;
  } else if (isBatchSettlementVoucherPayload(raw)) {
    channelId = raw.voucher.channelId;
    signedMaxClaimable = raw.voucher.maxClaimableAmount;
    signature = raw.voucher.signature;
    channelConfig = raw.channelConfig;
  } else if (isBatchSettlementRefundPayload(raw)) {
    channelId = raw.voucher.channelId;
    signedMaxClaimable = raw.voucher.maxClaimableAmount;
    signature = raw.voucher.signature;
    channelConfig = raw.channelConfig;
    isRefundVoucher = true;
  } else {
    return;
  }

  const ex = result.extra ?? {};
  const balance = readExtraString(ex, "balance", "0");
  const totalClaimed = readExtraString(ex, "totalClaimed", "0");
  const withdrawRequestedAt = readExtraNumber(ex, "withdrawRequestedAt", 0);
  const refundNonce = readExtraNumber(ex, "refundNonce", 0);

  const storage = scheme.getStorage();
  const requestContext = scheme.readRequestContext(paymentPayload);
  if (!requestContext?.pendingId) {
    return;
  }

  const updateResult = await storage.updateChannel(channelId, current => {
    if (!current || current.pendingRequest?.pendingId !== requestContext.pendingId) {
      return current;
    }

    const channel: Channel = {
      channelId,
      channelConfig,
      chargedCumulativeAmount: current.chargedCumulativeAmount,
      signedMaxClaimable,
      signature,
      balance,
      totalClaimed,
      withdrawRequestedAt,
      refundNonce,
      lastRequestTimestamp: Date.now(),
      pendingRequest: current.pendingRequest,
    };
    return channel;
  });
  if (updateResult.status === "updated" && updateResult.channel) {
    scheme.rememberChannelSnapshot(paymentPayload, updateResult.channel);
  }

  if (isRefundVoucher && updateResult.status === "updated") {
    return {
      skipHandler: true,
      response: {
        contentType: "application/json",
        body: { message: "Refund acknowledged", channelId },
      },
    };
  }
}

/**
 * Cleanup hook: clears this request's reservation after verify throws.
 *
 * @param scheme - Owning `BatchSettlementEvmScheme` instance.
 * @param ctx - Verify failure context for the current payment.
 */
export async function handleVerifyFailure(
  scheme: BatchSettlementEvmScheme,
  ctx: VerifyFailureContext,
): Promise<void> {
  await scheme.clearPendingRequest(ctx.paymentPayload);
}

/**
 * Cleanup hook: clears this request's reservation when handler work is canceled.
 *
 * @param scheme - Owning `BatchSettlementEvmScheme` instance.
 * @param ctx - Verified-payment cancellation context.
 */
export async function handleVerifiedPaymentCanceled(
  scheme: BatchSettlementEvmScheme,
  ctx: VerifiedPaymentCanceledContext,
): Promise<void> {
  if (ctx.reason !== "handler_threw" && ctx.reason !== "handler_failed") {
    return;
  }
  await scheme.clearPendingRequest(ctx.paymentPayload);
}

/**
 * Builds the minimal local channel record needed to reserve missing state.
 *
 * @param raw - Batch-settlement payload containing channel config and voucher.
 * @param chargedCumulativeAmount - Local charged base inferred before facilitator verification.
 * @returns Provisional channel state.
 */
function buildProvisionalChannel(
  raw: BatchSettlementVoucherPayload | BatchSettlementDepositPayload | BatchSettlementRefundPayload,
  chargedCumulativeAmount: string,
): Channel {
  return {
    channelId: raw.voucher.channelId,
    channelConfig: raw.channelConfig,
    chargedCumulativeAmount,
    signedMaxClaimable: raw.voucher.maxClaimableAmount,
    signature: raw.voucher.signature,
    balance: "0",
    totalClaimed: "0",
    withdrawRequestedAt: 0,
    refundNonce: 0,
    lastRequestTimestamp: Date.now(),
  };
}

/**
 * Infers the local charged base when storage has no channel record.
 *
 * @param signedMaxClaimable - Client-signed cumulative voucher cap.
 * @param price - Current request amount.
 * @param isPaidPayload - Whether the payload should add `price` to the local base.
 * @returns Inferred charged base as a decimal string.
 */
function inferMissingLocalChargedAmount(
  signedMaxClaimable: string,
  price: string,
  isPaidPayload: boolean,
): string {
  if (!isPaidPayload) {
    return signedMaxClaimable;
  }

  const signed = BigInt(signedMaxClaimable);
  const amount = BigInt(price);
  if (signed < amount) {
    return "0";
  }
  return (signed - amount).toString();
}
