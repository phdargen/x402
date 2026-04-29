import type { VerifyContext, VerifyResultContext } from "@x402/core/server";
import type { SchemePaymentRequiredContext } from "@x402/core/types";
import {
  isBatchSettlementDepositPayload,
  isBatchSettlementRefundPayload,
  isBatchSettlementVoucherPayload,
} from "../types";
import { BATCH_SETTLEMENT_SCHEME } from "../constants";
import type { ChannelConfig } from "../types";
import type { BatchSettlementEvmScheme } from "./scheme";
import type { Channel } from "./storage";
import { readExtraNumber, readExtraString } from "./utils";

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

  const channel = await scheme.getStorage().get(raw.voucher.channelId);

  if (!channel) {
    return;
  }

  const expectedMaxClaimable = isZeroChargePayload
    ? BigInt(channel.chargedCumulativeAmount)
    : BigInt(channel.chargedCumulativeAmount) + BigInt(requirements.amount);

  if (BigInt(raw.voucher.maxClaimableAmount) === expectedMaxClaimable) {
    return;
  }

  scheme.rememberChannelSnapshot(paymentPayload, channel);

  return {
    abort: true,
    reason: "batch_settlement_cumulative_amount_mismatch",
    message: "Client voucher base does not match server state",
  };
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
    return;
  }

  const raw = paymentPayload.payload;
  let channelId: string;
  let signedMaxClaimable: string;
  let signature: `0x${string}`;
  let payer: string;
  let channelConfig: ChannelConfig | undefined;
  let isRefundVoucher = false;

  if (isBatchSettlementDepositPayload(raw)) {
    channelId = raw.voucher.channelId;
    signedMaxClaimable = raw.voucher.maxClaimableAmount;
    signature = raw.voucher.signature;
    channelConfig = raw.channelConfig;
    payer = channelConfig?.payer ?? result.payer;
  } else if (isBatchSettlementVoucherPayload(raw)) {
    channelId = raw.voucher.channelId;
    signedMaxClaimable = raw.voucher.maxClaimableAmount;
    signature = raw.voucher.signature;
    channelConfig = raw.channelConfig;
    payer = channelConfig?.payer ?? result.payer;
  } else if (isBatchSettlementRefundPayload(raw)) {
    channelId = raw.voucher.channelId;
    signedMaxClaimable = raw.voucher.maxClaimableAmount;
    signature = raw.voucher.signature;
    channelConfig = raw.channelConfig;
    payer = channelConfig?.payer ?? result.payer;
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
  const prev = await storage.get(channelId);
  const expectedCharged = prev?.chargedCumulativeAmount ?? totalClaimed;
  const resolvedConfig = channelConfig ?? prev?.channelConfig;
  if (!resolvedConfig) {
    return;
  }
  await storage.updateChannel(channelId, current => {
    if (current && current.chargedCumulativeAmount !== expectedCharged) {
      return current;
    }

    const channel: Channel = {
      channelId,
      channelConfig: resolvedConfig,
      payer: payer.toLowerCase(),
      chargedCumulativeAmount: current?.chargedCumulativeAmount ?? totalClaimed,
      signedMaxClaimable,
      signature,
      balance,
      totalClaimed,
      withdrawRequestedAt,
      refundNonce,
      lastRequestTimestamp: Date.now(),
      pendingRequest: current?.pendingRequest,
    };
    return channel;
  });

  if (isRefundVoucher) {
    return {
      skipHandler: true,
      response: {
        contentType: "application/json",
        body: { message: "Refund acknowledged", channelId },
      },
    };
  }
}
