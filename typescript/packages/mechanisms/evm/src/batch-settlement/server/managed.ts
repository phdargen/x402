import type {
  SettleContext,
  SettleFailureContext,
  SettleResultContext,
  VerifiedPaymentCanceledContext,
  VerifyContext,
  VerifyFailureContext,
  VerifyResultContext,
} from "@x402/core/server";
import type { SchemePaymentRequiredContext } from "@x402/core/types";
import {
  isBatchSettlementDepositPayload,
  isBatchSettlementRefundPayload,
  isBatchSettlementVoucherPayload,
} from "../types";
import type { BatchSettlementChannelStateExtra, BatchSettlementVoucherStateExtra } from "../types";
import { BATCH_SETTLEMENT_SCHEME } from "../constants";
import { channelIdBindingError } from "../utils";
import * as Errors from "../errors";
import type { Channel } from "./storage";
import { abortIfBelowMinDeposit, writeCorrectiveAcceptExtra } from "./verify";
import { buildRefundSettlementFields } from "./settle";
import { readChannelStateExtra, readExtraNumber, readExtraString } from "./utils";
import type { BatchSettlementEvmScheme } from "./scheme";

/**
 * Pass-through verify: min-deposit + channel-id binding only.
 *
 * @param scheme - Owning scheme.
 * @param ctx - Verify lifecycle context.
 * @returns Abort on binding/min-deposit failure; otherwise continue to facilitator `/verify`.
 */
export async function handleManagedBeforeVerify(
  scheme: BatchSettlementEvmScheme,
  ctx: VerifyContext,
): Promise<void | { abort: true; reason: string; message?: string }> {
  const { paymentPayload, requirements } = ctx;
  const raw = paymentPayload.payload;
  const isPaidPayload =
    isBatchSettlementVoucherPayload(raw) || isBatchSettlementDepositPayload(raw);
  const isZeroChargePayload = isBatchSettlementRefundPayload(raw);
  if (!isPaidPayload && !isZeroChargePayload) {
    return;
  }

  const minDepositAbort = await abortIfBelowMinDeposit(scheme, raw, requirements);
  if (minDepositAbort) {
    return minDepositAbort;
  }

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
}

/**
 * After facilitator verify: stash a channel view for refund enrichment / replica,
 * or stash corrective extras. Refunds skip the resource handler.
 *
 * @param scheme - Owning scheme.
 * @param ctx - Post-verify context.
 * @returns `skipHandler` for refunds; otherwise void.
 */
export async function handleManagedAfterVerify(
  scheme: BatchSettlementEvmScheme,
  ctx: VerifyResultContext,
): Promise<
  | void
  | { skipHandler: true; response?: { contentType?: string; body?: unknown } }
  | { abort: true; reason: string; message?: string }
> {
  const { paymentPayload, result } = ctx;
  const raw = paymentPayload.payload;
  if (
    !isBatchSettlementVoucherPayload(raw) &&
    !isBatchSettlementDepositPayload(raw) &&
    !isBatchSettlementRefundPayload(raw)
  ) {
    return;
  }

  if (!result.isValid) {
    if (result.invalidReason === Errors.ErrCumulativeAmountMismatch) {
      const ex = result.extra ?? {};
      const channelState = readCorrectiveChannelState(ex);
      const voucherState = readCorrectiveVoucherState(ex);
      if (channelState || voucherState) {
        scheme.mergeRequestContext(paymentPayload, {
          correctiveChannelState: channelState,
          correctiveVoucherState: voucherState,
        });
      }
    }
    return;
  }

  const ex = result.extra ?? {};
  const now = Date.now();
  const channelSnapshot: Channel = {
    channelId: raw.voucher.channelId,
    channelConfig: raw.channelConfig,
    chargedCumulativeAmount: readExtraString(ex, "chargedCumulativeAmount", "0"),
    signedMaxClaimable: raw.voucher.maxClaimableAmount,
    signature: raw.voucher.signature,
    balance: readExtraString(ex, "balance", "0"),
    totalClaimed: readExtraString(ex, "totalClaimed", "0"),
    withdrawRequestedAt: readExtraNumber(ex, "withdrawRequestedAt", 0),
    refundNonce: readExtraNumber(ex, "refundNonce", 0),
    lastRequestTimestamp: now,
  };

  const pendingId = typeof ex.pendingId === "string" && ex.pendingId ? ex.pendingId : undefined;

  scheme.mergeRequestContext(paymentPayload, {
    channelId: raw.voucher.channelId,
    channelSnapshot,
    ...(pendingId ? { pendingId, reservationCommitted: true } : {}),
  });

  if (isBatchSettlementRefundPayload(raw)) {
    return {
      skipHandler: true,
      response: {
        contentType: "application/json",
        body: { message: "Refund acknowledged", channelId: raw.voucher.channelId },
      },
    };
  }
}

/**
 * Copies facilitator-supplied corrective extras onto the matching 402 accept.
 *
 * @param scheme - Owning scheme.
 * @param ctx - Payment-required response context.
 */
export async function handleManagedEnrichPaymentRequiredResponse(
  scheme: BatchSettlementEvmScheme,
  ctx: SchemePaymentRequiredContext,
): Promise<void> {
  if (ctx.error !== Errors.ErrCumulativeAmountMismatch || !ctx.paymentPayload) {
    return;
  }

  const requestContext = scheme.takeRequestContext(ctx.paymentPayload);
  const channelState = requestContext?.correctiveChannelState;
  const voucherState = requestContext?.correctiveVoucherState;
  if (!channelState || !voucherState) {
    return;
  }

  const accept = ctx.requirements.find(
    req =>
      req.scheme === BATCH_SETTLEMENT_SCHEME &&
      req.network === ctx.paymentPayload?.accepted.network,
  );
  if (!accept) {
    return;
  }

  writeCorrectiveAcceptExtra(accept, channelState, voucherState);
}

/**
 * Managed settle is always forwarded; no local voucher short-circuit.
 *
 * @param _scheme - Owning scheme (unused).
 * @param _ctx - Settle context (unused).
 */
export async function handleManagedBeforeSettle(
  _scheme: BatchSettlementEvmScheme,
  _ctx: SettleContext,
): Promise<void> {
  void _scheme;
  void _ctx;
}

/**
 * Echoes verify `pendingId` onto `/settle` and completes a managed refund.
 * Never sets `claimAuthorizerSignature`.
 *
 * @param scheme - Owning scheme.
 * @param ctx - Settlement context.
 * @returns Additive settle fields, or nothing when there is nothing to attach.
 */
export async function handleManagedEnrichSettlementPayload(
  scheme: BatchSettlementEvmScheme,
  ctx: SettleContext,
): Promise<Record<string, unknown> | void> {
  const { paymentPayload, requirements } = ctx;
  const raw = paymentPayload.payload;
  const pendingId = scheme.readRequestContext(paymentPayload)?.pendingId;
  const pendingFields = pendingId ? { pendingId } : {};

  if (isBatchSettlementRefundPayload(raw)) {
    const snapshot = scheme.readRequestContext(paymentPayload)?.channelSnapshot;
    if (!snapshot) {
      throw new Error(Errors.ErrMissingChannel);
    }

    return {
      ...(await buildRefundSettlementFields({
        channel: snapshot,
        raw,
        channelId: raw.voucher.channelId,
        network: requirements.network,
        refundSigner: scheme.getRefundAuthorizerSigner(),
        includeClaimAuthorizerSignature: false,
      })),
      ...pendingFields,
    };
  }

  if (isBatchSettlementVoucherPayload(raw) || isBatchSettlementDepositPayload(raw)) {
    return pendingId ? pendingFields : undefined;
  }
}

/**
 * Replica upsert after a successful managed settle. Not read on the hot path.
 *
 * @param scheme - Owning scheme.
 * @param ctx - Post-settle context.
 */
export async function handleManagedAfterSettle(
  scheme: BatchSettlementEvmScheme,
  ctx: SettleResultContext,
): Promise<void> {
  const { paymentPayload, result } = ctx;
  if (!result.success) {
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

  const storage = scheme.getStorage();
  const channelId = raw.voucher.channelId;
  const channelState = readChannelStateExtra(result.extra);
  const now = Date.now();
  const charged =
    (channelState && readExtraString(channelState, "chargedCumulativeAmount", "")) ||
    scheme.readRequestContext(paymentPayload)?.channelSnapshot?.chargedCumulativeAmount ||
    "0";

  if (isBatchSettlementRefundPayload(raw)) {
    const balance = readExtraString(channelState, "balance", "0");
    if (BigInt(balance) <= BigInt(charged)) {
      await storage.updateChannel(channelId, current => (current ? undefined : current));
      return;
    }
  }

  await storage.updateChannel(channelId, current => {
    const base = current ?? scheme.readRequestContext(paymentPayload)?.channelSnapshot;
    return {
      channelId,
      channelConfig: raw.channelConfig,
      chargedCumulativeAmount: charged || base?.chargedCumulativeAmount || "0",
      signedMaxClaimable: raw.voucher.maxClaimableAmount,
      signature: raw.voucher.signature,
      balance: readExtraString(channelState, "balance", base?.balance ?? "0"),
      totalClaimed: readExtraString(channelState, "totalClaimed", base?.totalClaimed ?? "0"),
      withdrawRequestedAt: readExtraNumber(
        channelState,
        "withdrawRequestedAt",
        base?.withdrawRequestedAt ?? 0,
      ),
      refundNonce: readExtraNumber(channelState, "refundNonce", base?.refundNonce ?? 0),
      lastRequestTimestamp: now,
    };
  });
}

/**
 * No-op: managed settlement extras come from the facilitator `/settle` response.
 *
 * @param _scheme - Owning scheme (unused).
 * @param _ctx - Settlement result context (unused).
 */
export async function handleManagedEnrichSettlementResponse(
  _scheme: BatchSettlementEvmScheme,
  _ctx: SettleResultContext,
): Promise<void> {
  void _scheme;
  void _ctx;
}

/**
 * No-op: managed mode holds no local admission lock.
 *
 * @param _scheme - Owning scheme (unused).
 * @param _ctx - Verify failure context (unused).
 */
export async function handleManagedVerifyFailure(
  _scheme: BatchSettlementEvmScheme,
  _ctx: VerifyFailureContext,
): Promise<void> {
  void _scheme;
  void _ctx;
}

/**
 * No-op: managed mode holds no local admission lock.
 *
 * @param _scheme - Owning scheme (unused).
 * @param _ctx - Settle failure context (unused).
 */
export async function handleManagedSettleFailure(
  _scheme: BatchSettlementEvmScheme,
  _ctx: SettleFailureContext,
): Promise<void> {
  void _scheme;
  void _ctx;
}

/**
 * No-op: managed mode holds no local admission lock.
 *
 * @param _scheme - Owning scheme (unused).
 * @param _ctx - Cancellation context (unused).
 */
export async function handleManagedVerifiedPaymentCanceled(
  _scheme: BatchSettlementEvmScheme,
  _ctx: VerifiedPaymentCanceledContext,
): Promise<void> {
  void _scheme;
  void _ctx;
}

/**
 * Reads a corrective channel snapshot from facilitator verify extras.
 *
 * @param extra - Verify response extra.
 * @returns Typed channel state, or undefined.
 */
function readCorrectiveChannelState(
  extra: Record<string, unknown>,
): BatchSettlementChannelStateExtra | undefined {
  const value = extra.channelState;
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  return value as BatchSettlementChannelStateExtra;
}

/**
 * Reads a corrective voucher proof from facilitator verify extras.
 *
 * @param extra - Verify response extra.
 * @returns Typed voucher state, or undefined.
 */
function readCorrectiveVoucherState(
  extra: Record<string, unknown>,
): BatchSettlementVoucherStateExtra | undefined {
  const value = extra.voucherState;
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  return value as BatchSettlementVoucherStateExtra;
}
