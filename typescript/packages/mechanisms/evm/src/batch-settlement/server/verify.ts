import type { VerifyContext, VerifyResultContext } from "@x402/core/server";
import type { PaymentRequiredErrorDetails } from "@x402/core/types";
import { isBatchSettlementDepositPayload, isBatchSettlementVoucherPayload } from "../types";
import type { ChannelConfig } from "../types";
import type { BatchSettlementEvmScheme } from "./scheme";
import type { Channel } from "./storage";
import { readExtraNumber, readExtraString } from "./utils";

/**
 * Lifecycle hook: runs before the facilitator verifies a payment.
 *
 * For voucher payloads, checks whether the client's cumulative amount matches server
 * state. If stale, aborts with `batch_settlement_stale_cumulative_amount` and includes
 * recovery metadata in the 402 response.
 *
 * Refund vouchers (`refund: true`) are zero-charge: the expected
 * `maxClaimableAmount` equals the existing `chargedCumulativeAmount`.
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
  errorDetails?: PaymentRequiredErrorDetails;
}> {
  const { paymentPayload, requirements } = ctx;

  const raw = paymentPayload.payload;
  if (!isBatchSettlementVoucherPayload(raw)) {
    return;
  }

  const isRefund = raw.refund === true;
  const channel = await scheme.getStorage().get(raw.channelId);

  if (!channel) {
    return;
  }

  const expectedMaxClaimable = isRefund
    ? BigInt(channel.chargedCumulativeAmount)
    : BigInt(channel.chargedCumulativeAmount) + BigInt(requirements.amount);

  if (BigInt(raw.maxClaimableAmount) === expectedMaxClaimable) {
    return;
  }

  return {
    abort: true,
    reason: "batch_settlement_stale_cumulative_amount",
    message: "Client voucher base does not match server state",
    errorDetails: {
      recoverable: true,
      data: {
        channelId: channel.channelId,
        chargedCumulativeAmount: channel.chargedCumulativeAmount,
        signedMaxClaimable: channel.signedMaxClaimable,
        signature: channel.signature,
      },
    },
  };
}

/**
 * Lifecycle hook: runs after the facilitator verifies a payment.
 *
 * Persists channel state (balance, totalClaimed, voucher info) so that
 * subsequent requests can correctly calculate cumulative amounts and detect stale state.
 *
 * For refund vouchers (`refund: true`), additionally returns a `skipHandler`
 * directive so that the resource server bypasses the application handler and settles inline.
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
    channelConfig = raw.deposit.channelConfig;
    payer = channelConfig?.payer ?? result.payer;
  } else if (isBatchSettlementVoucherPayload(raw)) {
    channelId = raw.channelId;
    signedMaxClaimable = raw.maxClaimableAmount;
    signature = raw.signature;
    channelConfig = raw.channelConfig;
    payer = channelConfig?.payer ?? result.payer;
    isRefundVoucher = raw.refund === true;
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
  const resolvedConfig = channelConfig ?? prev?.channelConfig;
  if (!resolvedConfig) {
    return;
  }
  const channel: Channel = {
    channelId,
    channelConfig: resolvedConfig,
    payer: payer.toLowerCase(),
    chargedCumulativeAmount: prev?.chargedCumulativeAmount ?? totalClaimed,
    signedMaxClaimable,
    signature,
    balance,
    totalClaimed,
    withdrawRequestedAt,
    refundNonce,
    lastRequestTimestamp: Date.now(),
  };
  await storage.compareAndSet(channelId, prev?.chargedCumulativeAmount ?? totalClaimed, channel);

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
