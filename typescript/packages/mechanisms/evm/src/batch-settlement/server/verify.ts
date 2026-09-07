import type {
  VerifiedPaymentCanceledContext,
  VerifyContext,
  VerifyFailureContext,
  VerifyResultContext,
} from "@x402/core/server";
import { resolvePaymentFlow } from "@x402/core/server";
import type { VerifyResponse } from "@x402/core/types";
import type { SchemePaymentRequiredContext } from "@x402/core/types";
import { getAddress, verifyTypedData } from "viem";
import {
  type BatchSettlementDepositPayload,
  type BatchSettlementRefundPayload,
  type BatchSettlementVoucherPayload,
  isBatchSettlementDepositPayload,
  isBatchSettlementRefundPayload,
  isBatchSettlementVoucherPayload,
} from "../types";
import { BATCH_SETTLEMENT_SCHEME, voucherTypes } from "../constants";
import { createNonce, getEvmChainId } from "../../utils";
import { channelIdBindingError, computeChannelId, getBatchSettlementEip712Domain } from "../utils";
import { validateChannelConfig } from "../facilitator/utils";
import * as Errors from "../errors";
import type { BatchSettlementEvmScheme } from "./scheme";
import type { Channel, ChannelUpdateResult, PendingRequest } from "./storage";
import {
  buildChannelRow,
  readOnchainMirrors,
  resolveChargedBaseline,
} from "./utils";

// Framework cleanup hooks clear pending reservations for normal failures
// This bounded TTL releases channels when cleanup cannot run or complete
const MIN_PENDING_TTL_MS = 5_000; // 5 seconds
const MAX_PENDING_TTL_MS = 10 * 60 * 1000; // 600 seconds

/**
 * Computes the bounded pending reservation expiry time.
 *
 * @param maxTimeoutSeconds - Resource timeout from payment requirements.
 * @param now - Current wall-clock time in milliseconds.
 * @returns Expiry timestamp in milliseconds.
 */
function pendingExpiresAt(maxTimeoutSeconds: number | undefined, now: number): number {
  const requestedMs = Math.max(0, maxTimeoutSeconds ?? 0) * 1000;
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
 * Builds a fail-closed response when local verification state cannot be established.
 *
 * @returns An abort directive with a stable, non-sensitive reason.
 */
function verificationStateUnavailable(): {
  abort: true;
  reason: string;
  message: string;
} {
  return {
    abort: true,
    reason: Errors.ErrVerificationStateUnavailable,
    message: "Unable to establish channel verification state",
  };
}

/**
 * Lifecycle hook: runs before the facilitator verifies a payment.
 *
 * This phase performs no storage mutation. It binds the claimed `channelId` to the
 * payload's `channelConfig` and network, then reads a channel snapshot to detect a
 * cumulative-base mismatch. When the claimed id is malformed or does not match the
 * config, verification aborts before any storage access, so an unauthenticated
 * request can neither target another channel's file nor escape the storage root.
 *
 * Refund vouchers are zero-charge: the expected `maxClaimableAmount` equals
 * the existing `chargedCumulativeAmount`.
 *
 * When no local channel record exists, verification is delegated to the facilitator (which checks onchain state);
 * `handleAfterVerify` then creates the reservation and rebuilds the channel record from the verify response.
 *
 * @param scheme - Owning `BatchSettlementEvmScheme` instance for storage access.
 * @param ctx - Verify lifecycle context (payload, requirements, and related state).
 * @returns Nothing to continue verification; or an object with `abort` to fail with a reason.
 */
export async function handleBeforeVerify(
  scheme: BatchSettlementEvmScheme,
  ctx: VerifyContext,
): Promise<
  void | { abort: true; reason: string; message?: string } | { skip: true; result: VerifyResponse }
> {
  const { paymentPayload, requirements } = ctx;

  const raw = paymentPayload.payload;
  const isPaidPayload =
    isBatchSettlementVoucherPayload(raw) || isBatchSettlementDepositPayload(raw);
  const isZeroChargePayload = isBatchSettlementRefundPayload(raw);
  if (!isPaidPayload && !isZeroChargePayload) {
    return;
  }

  try {
    const bindErr = channelIdBindingError(
      raw.channelConfig,
      raw.voucher.channelId,
      requirements.network,
    );
    if (bindErr) {
      return {
        abort: true,
        reason: bindErr,
        message: "Channel id does not match channel config",
      };
    }

    const channelId = raw.voucher.channelId;
    const now = Date.now();
    const isUpfront = resolvePaymentFlow(scheme, requirements).paymentFlow === "upfront";
    const channelSnapshot = isUpfront ? undefined : await scheme.getStorage().get(channelId);
    const cumulative = checkCumulativeVoucherMatch(
      raw,
      channelSnapshot,
      requirements.amount,
      isPaidPayload,
      isZeroChargePayload,
    );

    if (!cumulative.ok) {
      scheme.rememberChannelSnapshot(paymentPayload, cumulative.channel);
      return {
        abort: true,
        reason: Errors.ErrCumulativeAmountMismatch,
        message: "Client voucher base does not match server state",
      };
    }

    scheme.mergeRequestContext(paymentPayload, {
      channelId,
      chargedBaseline: cumulative.chargedBaseline,
      ...(isUpfront ? {} : { pendingId: createNonce(), channelSnapshot }),
    });

    if (isUpfront) {
      if (
        isBatchSettlementVoucherPayload(raw) &&
        raw.channelConfig.payerAuthorizer !== "0x0000000000000000000000000000000000000000" &&
        isOnchainStateFresh(
          { onchainSyncedAt: scheme.cachedOnchainSyncedAt(channelId) },
          scheme.getOnchainStateTtlMs(),
          now,
        )
      ) {
        const storedBaseline = await validateUpfrontWarmChannelBaseline(
          scheme,
          paymentPayload,
          raw,
          channelId,
          requirements.amount,
          isPaidPayload,
          isZeroChargePayload,
        );
        if (storedBaseline?.abort) {
          return storedBaseline;
        }

        if (!(await verifyLocalVoucherSignature(raw, requirements.network))) {
          return {
            abort: true,
            reason: Errors.ErrInvalidVoucherSignature,
            message: "Voucher signature is invalid",
          };
        }
        scheme.mergeRequestContext(paymentPayload, { localVerify: true });
        return {
          skip: true,
          result: {
            isValid: true,
            payer: raw.channelConfig.payer,
          },
        };
      }
      return;
    }

    if (isBatchSettlementVoucherPayload(raw)) {
      const localResult = await verifyVoucherLocally(
        scheme,
        raw,
        requirements,
        channelSnapshot,
        now,
      );
      if (localResult) {
        scheme.mergeRequestContext(paymentPayload, { localVerify: true });
        return { skip: true, result: localResult };
      }
    }
  } catch {
    return verificationStateUnavailable();
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
  if (ctx.error !== Errors.ErrCumulativeAmountMismatch) {
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

  if (
    channelIdBindingError(raw.channelConfig, raw.voucher.channelId, paymentPayload.accepted.network)
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
    channelState: {
      channelId: channel.channelId,
      balance: channel.balance,
      totalClaimed: channel.totalClaimed,
      withdrawRequestedAt: channel.withdrawRequestedAt,
      refundNonce: String(channel.refundNonce),
      chargedCumulativeAmount: channel.chargedCumulativeAmount,
    },
    voucherState: {
      signedMaxClaimable: channel.signedMaxClaimable,
      signature: channel.signature as `0x${string}`,
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
): Promise<
  | void
  | { skipHandler: true; response?: { contentType?: string; body?: unknown } }
  | { abort: true; reason: string; message?: string }
> {
  const { paymentPayload, requirements, result } = ctx;
  if (!result.isValid || !result.payer) {
    return;
  }

  const raw = paymentPayload.payload;
  const isKnownPayload =
    isBatchSettlementVoucherPayload(raw) ||
    isBatchSettlementDepositPayload(raw) ||
    isBatchSettlementRefundPayload(raw);
  if (!isKnownPayload) {
    return;
  }

  if (resolvePaymentFlow(scheme, requirements).paymentFlow === "upfront") {
    const channelId = raw.voucher.channelId;
    const requestContext = scheme.readRequestContext(paymentPayload);
    if (requestContext?.localVerify !== true) {
      scheme.mergeRequestContext(paymentPayload, {
        channelId,
        ...(result.extra ? { verifyExtra: result.extra } : {}),
      });
      scheme.rememberOnchainSyncedAt(channelId, Date.now());
    }
    if (isBatchSettlementRefundPayload(raw)) {
      return {
        skipHandler: true,
        response: {
          contentType: "application/json",
          body: { message: "Refund acknowledged", channelId },
        },
      };
    }
    return;
  }

  let channelId: string;
  let signedMaxClaimable: string;
  let isRefundVoucher = false;

  if (isBatchSettlementDepositPayload(raw)) {
    channelId = raw.voucher.channelId;
    signedMaxClaimable = raw.voucher.maxClaimableAmount;
  } else if (isBatchSettlementVoucherPayload(raw)) {
    channelId = raw.voucher.channelId;
    signedMaxClaimable = raw.voucher.maxClaimableAmount;
  } else if (isBatchSettlementRefundPayload(raw)) {
    channelId = raw.voucher.channelId;
    signedMaxClaimable = raw.voucher.maxClaimableAmount;
    isRefundVoucher = true;
  } else {
    return;
  }

  const ex = result.extra ?? {};
  const mirrors = readOnchainMirrors(ex);
  const now = Date.now();

  const storage = scheme.getStorage();
  const requestContext = scheme.readRequestContext(paymentPayload);
  if (!requestContext?.pendingId) {
    return verificationStateUnavailable();
  }
  const pendingId = requestContext.pendingId;
  const localVerify = requestContext.localVerify === true;

  let outcome:
    | { status: "reserved" }
    | { status: "busy" }
    | { status: "stale"; channel: Channel }
    | undefined;

  let updateResult: ChannelUpdateResult;
  try {
    updateResult = await storage.updateChannel(channelId, current => {
      if (isPendingLive(current?.pendingRequest, now)) {
        outcome = { status: "busy" };
        return current;
      }

      const cumulative = checkCumulativeVoucherMatch(
        raw,
        current,
        requirements.amount,
        !isRefundVoucher,
        isRefundVoucher,
      );
      if (!cumulative.ok) {
        outcome = { status: "stale", channel: cumulative.channel };
        return current;
      }

      const pendingRequest: PendingRequest = {
        pendingId,
        signedMaxClaimable,
        expiresAt: pendingExpiresAt(requirements.maxTimeoutSeconds, now),
      };
      outcome = { status: "reserved" };
      return {
        ...buildChannelRow(
          raw,
          cumulative.chargedBaseline,
          { ...mirrors, onchainSyncedAt: localVerify ? current?.onchainSyncedAt : now },
          now,
        ),
        pendingRequest,
      };
    });
  } catch {
    return verificationStateUnavailable();
  }

  if (outcome?.status === "busy") {
    return {
      abort: true,
      reason: Errors.ErrChannelBusy,
      message: "Channel is already processing a request",
    };
  }

  if (outcome?.status === "stale") {
    scheme.rememberChannelSnapshot(paymentPayload, outcome.channel);
    return {
      abort: true,
      reason: Errors.ErrCumulativeAmountMismatch,
      message: "Client voucher base does not match server state",
    };
  }

  if (updateResult.status === "updated" && updateResult.channel) {
    scheme.mergeRequestContext(paymentPayload, { reservationCommitted: true });
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
  if (
    ctx.reason !== "handler_threw" &&
    ctx.reason !== "handler_failed" &&
    ctx.reason !== "after_verify_aborted"
  ) {
    return;
  }
  await scheme.clearPendingRequest(ctx.paymentPayload);
}

/**
 * Verifies a voucher against locally cached channel state when that state is fresh.
 *
 * @param scheme - Batch settlement scheme (TTL for onchain sync freshness).
 * @param raw - Decoded batch-settlement voucher payload.
 * @param requirements - Payment requirements (network, etc.).
 * @param channel - Cached channel row, if any.
 * @param now - Current wall-clock time in milliseconds.
 * @returns A {@link VerifyResponse}, or `undefined` to fall back to facilitator verification.
 */
async function verifyVoucherLocally(
  scheme: BatchSettlementEvmScheme,
  raw: BatchSettlementVoucherPayload,
  requirements: VerifyContext["requirements"],
  channel: Channel | undefined,
  now: number,
): Promise<VerifyResponse | undefined> {
  if (!channel || !isOnchainStateFresh(channel, scheme.getOnchainStateTtlMs(), now)) {
    return;
  }

  if (raw.channelConfig.payerAuthorizer === "0x0000000000000000000000000000000000000000") {
    return;
  }

  const payer = raw.channelConfig.payer;
  const configErr = validateChannelConfig(
    raw.channelConfig,
    raw.voucher.channelId,
    requirements as Parameters<typeof validateChannelConfig>[2],
  );
  if (configErr) {
    return invalidVerifyResponse(payer, configErr);
  }

  if (
    computeChannelId(raw.channelConfig, requirements.network).toLowerCase() !==
    channel.channelId.toLowerCase()
  ) {
    return invalidVerifyResponse(payer, Errors.ErrChannelIdMismatch);
  }

  const signatureOk = await verifyLocalVoucherSignature(raw, requirements.network);
  if (!signatureOk) {
    return invalidVerifyResponse(payer, Errors.ErrInvalidVoucherSignature);
  }

  const maxClaimableAmount = BigInt(raw.voucher.maxClaimableAmount);
  if (maxClaimableAmount > BigInt(channel.balance)) {
    return invalidVerifyResponse(payer, Errors.ErrCumulativeExceedsBalance);
  }

  if (maxClaimableAmount <= BigInt(channel.totalClaimed)) {
    return invalidVerifyResponse(payer, Errors.ErrCumulativeAmountBelowClaimed);
  }

  return {
    isValid: true,
    payer,
    extra: {
      channelId: raw.voucher.channelId,
      balance: channel.balance,
      totalClaimed: channel.totalClaimed,
      withdrawRequestedAt: channel.withdrawRequestedAt,
      refundNonce: channel.refundNonce.toString(),
    },
  };
}

/**
 * Returns whether cached onchain fields for a channel are still within the freshness window.
 *
 * @param channel - Cached channel row.
 * @param ttlMs - Maximum age of `onchainSyncedAt` in milliseconds.
 * @param now - Current wall-clock time in milliseconds.
 * @returns `true` if onchain sync time is present and still within `ttlMs` of `now`.
 */
function isOnchainStateFresh(
  channel: Pick<Channel, "onchainSyncedAt">,
  ttlMs: number,
  now: number,
): boolean {
  return channel.onchainSyncedAt !== undefined && now - channel.onchainSyncedAt <= ttlMs;
}

/**
 * Verifies the EIP-712 voucher signature against the payer authorizer.
 *
 * @param raw - Decoded batch-settlement voucher payload.
 * @param network - EVM network identifier for chain ID / domain.
 * @returns Whether the typed-data signature is valid.
 */
async function verifyLocalVoucherSignature(
  raw: BatchSettlementVoucherPayload,
  network: string,
): Promise<boolean> {
  try {
    return await verifyTypedData({
      address: getAddress(raw.channelConfig.payerAuthorizer),
      domain: getBatchSettlementEip712Domain(getEvmChainId(network)),
      types: voucherTypes,
      primaryType: "Voucher",
      message: {
        channelId: raw.voucher.channelId,
        maxClaimableAmount: BigInt(raw.voucher.maxClaimableAmount),
      },
      signature: raw.voucher.signature,
    });
  } catch {
    return false;
  }
}

/**
 * Builds a failed verify response with the payer address preserved for reporting.
 *
 * @param payer - Payer address from the payload.
 * @param invalidReason - Machine-readable failure reason.
 * @returns Invalid {@link VerifyResponse} with `isValid: false`.
 */
function invalidVerifyResponse(payer: `0x${string}`, invalidReason: string): VerifyResponse {
  return { isValid: false, invalidReason, payer };
}

/**
 * Re-validates an upfront warm-path voucher against persisted server state.
 *
 * Uses the in-process channel cache when available; falls back to one storage
 * read on cache miss (e.g. after server restart). Infer-only checks pass stale
 * client vouchers when onchain TTL is fresh — this closes that gap without a
 * storage read on every warm request once the cache is warm.
 *
 * @param scheme - Owning scheme instance.
 * @param paymentPayload - Request payment payload for snapshot enrichment.
 * @param raw - Batch settlement voucher payload.
 * @param channelId - Channel identifier.
 * @param price - Current request amount.
 * @param isPaidPayload - Whether the payload adds `price` to the local base.
 * @param isRefundVoucher - Whether the payload is a zero-charge refund voucher.
 * @returns Abort directive on mismatch; void when no stored baseline applies.
 */
async function validateUpfrontWarmChannelBaseline(
  scheme: BatchSettlementEvmScheme,
  paymentPayload: VerifyContext["paymentPayload"],
  raw:
    | BatchSettlementVoucherPayload
    | BatchSettlementDepositPayload
    | BatchSettlementRefundPayload,
  channelId: string,
  price: string,
  isPaidPayload: boolean,
  isRefundVoucher: boolean,
): Promise<void | { abort: true; reason: string; message?: string }> {
  let stored = scheme.cachedChannel(channelId);
  if (!stored) {
    stored = await scheme.getStorage().get(channelId);
    if (stored) {
      scheme.rememberCachedChannel(stored);
    }
  }
  if (!stored) {
    return;
  }

  const recheck = checkCumulativeVoucherMatch(
    raw,
    stored,
    price,
    isPaidPayload,
    isRefundVoucher,
  );
  if (!recheck.ok) {
    scheme.rememberChannelSnapshot(paymentPayload, recheck.channel);
    return {
      abort: true,
      reason: Errors.ErrCumulativeAmountMismatch,
      message: "Client voucher base does not match server state",
    };
  }

  scheme.mergeRequestContext(paymentPayload, { chargedBaseline: recheck.chargedBaseline });
}

function checkCumulativeVoucherMatch(
  raw:
    | BatchSettlementVoucherPayload
    | BatchSettlementDepositPayload
    | BatchSettlementRefundPayload,
  channelSnapshot: Channel | undefined,
  price: string,
  isPaidPayload: boolean,
  isRefundVoucher: boolean,
):
  | { ok: true; chargedBaseline: string }
  | { ok: false; chargedBaseline: string; channel: Channel } {
  const chargedBaseline = resolveChargedBaseline(
    channelSnapshot,
    raw.voucher.maxClaimableAmount,
    price,
    isPaidPayload,
  );
  const expected = isRefundVoucher
    ? BigInt(chargedBaseline)
    : BigInt(chargedBaseline) + BigInt(price);
  if (BigInt(raw.voucher.maxClaimableAmount) !== expected) {
    return {
      ok: false,
      chargedBaseline,
      channel:
        channelSnapshot ??
        buildChannelRow(raw, chargedBaseline, readOnchainMirrors(undefined), Date.now()),
    };
  }
  return { ok: true, chargedBaseline };
}
