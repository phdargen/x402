import type { SettleResponse } from "@x402/core/types";
import type { SettleContext, SettleResultContext } from "@x402/core/server";
import { signClaimBatch, signRefund } from "../authorizerSigner";
import {
  isBatchSettlementDepositPayload,
  isBatchSettlementRefundPayload,
  isBatchSettlementVoucherPayload,
} from "../types";
import type { BatchSettlementPaymentResponseExtra, BatchSettlementVoucherClaim } from "../types";
import { computeChannelId } from "../utils";
import type { BatchSettlementEvmScheme } from "./scheme";
import type { Channel } from "./storage";
import { readExtraNumber, readExtraString } from "./utils";

/**
 * Lifecycle hook: runs before the facilitator settles a payment.
 *
 * For voucher payloads the server does NOT trigger an onchain settle.  Instead, it
 * increments the local `chargedCumulativeAmount` and returns a `skip` result so the
 * middleware responds immediately. Cooperative refund payloads proceed to settlement
 * enrichment before facilitator settlement.
 *
 * @param scheme - Owning `BatchSettlementEvmScheme` instance for storage access.
 * @param ctx - Settle lifecycle context (payload and requirements).
 * @returns Nothing to proceed; `abort` to fail; `skip` with a result to short-circuit settlement.
 */
export async function handleBeforeSettle(
  scheme: BatchSettlementEvmScheme,
  ctx: SettleContext,
): Promise<
  void | { abort: true; reason: string; message?: string } | { skip: true; result: SettleResponse }
> {
  const { paymentPayload, requirements } = ctx;

  const raw = paymentPayload.payload;
  const storage = scheme.getStorage();

  if (!isBatchSettlementVoucherPayload(raw)) {
    return;
  }

  const { voucher } = raw;
  const channelId = voucher.channelId;
  const channel = await storage.get(channelId);
  if (!channel) {
    return {
      abort: true,
      reason: "missing_batch_settlement_channel",
      message: "No channel record",
    };
  }

  const increment = BigInt(requirements.amount);
  const signedCap = BigInt(voucher.maxClaimableAmount);
  const prevCharged = BigInt(channel.chargedCumulativeAmount);
  const newCharged = prevCharged + increment;

  if (newCharged > signedCap) {
    return {
      abort: true,
      reason: "batch_settlement_charge_exceeds_signed_cumulative",
      message: `Charged ${newCharged.toString()} exceeds signed max ${signedCap.toString()}`,
    };
  }

  const updatedChannel: Channel = {
    channelId,
    channelConfig: channel.channelConfig,
    payer: channel.payer,
    chargedCumulativeAmount: newCharged.toString(),
    signedMaxClaimable: voucher.maxClaimableAmount,
    signature: voucher.signature,
    balance: channel.balance,
    totalClaimed: channel.totalClaimed,
    withdrawRequestedAt: channel.withdrawRequestedAt,
    refundNonce: channel.refundNonce,
    lastRequestTimestamp: Date.now(),
  };

  const swapped = await storage.compareAndSet(
    channelId,
    channel.chargedCumulativeAmount,
    updatedChannel,
  );
  if (!swapped) {
    return {
      abort: true,
      reason: "batch_settlement_channel_busy",
      message: "Concurrent request modified channel state",
    };
  }

  const skipExtra: BatchSettlementPaymentResponseExtra = {
    channelId: channelId as `0x${string}`,
    chargedCumulativeAmount: newCharged.toString(),
    balance: channel.balance,
    totalClaimed: channel.totalClaimed,
    withdrawRequestedAt: channel.withdrawRequestedAt,
    refundNonce: String(channel.refundNonce),
  };

  return {
    skip: true,
    result: {
      success: true,
      transaction: "",
      network: requirements.network,
      payer: channel.payer as `0x${string}`,
      amount: requirements.amount,
      extra: skipExtra,
    },
  };
}

/**
 * Enriches cooperative refund vouchers with facilitator settlement fields.
 *
 * @param scheme - Owning `BatchSettlementEvmScheme` instance for storage and signer access.
 * @param ctx - Settlement context for the current payment.
 * @returns Additive refund settlement fields, or nothing for non-refund payloads.
 */
export async function handleEnrichSettlementPayload(
  scheme: BatchSettlementEvmScheme,
  ctx: SettleContext,
): Promise<Record<string, unknown> | void> {
  const { paymentPayload, requirements } = ctx;
  const raw = paymentPayload.payload;
  if (!isBatchSettlementRefundPayload(raw)) {
    return;
  }

  const channelId = computeChannelId(raw.channelConfig);
  if (raw.voucher.channelId !== channelId) {
    throw new Error("refund channelId does not match channelConfig");
  }

  const channel = await scheme.getStorage().get(channelId);
  if (!channel) {
    throw new Error("missing_batch_settlement_channel");
  }
  if (BigInt(raw.voucher.maxClaimableAmount) !== BigInt(channel.chargedCumulativeAmount)) {
    throw new Error("batch_settlement_stale_cumulative_amount");
  }
  if (raw.voucher.signature !== channel.signature) {
    throw new Error("batch_settlement_refund_signature_mismatch");
  }

  const config = raw.channelConfig;

  const claimEntry: BatchSettlementVoucherClaim = {
    voucher: {
      channel: config,
      maxClaimableAmount: raw.voucher.maxClaimableAmount,
    },
    signature: raw.voucher.signature,
    totalClaimed: channel.chargedCumulativeAmount,
  };

  const remainder = BigInt(channel.balance) - BigInt(channel.chargedCumulativeAmount);
  if (remainder <= 0n) {
    throw new Error("batch_settlement_refund_no_balance");
  }

  let refundAmountBig = remainder;
  if (raw.amount !== undefined) {
    if (!/^\d+$/.test(raw.amount)) {
      throw new Error("batch_settlement_refund_amount_invalid");
    }
    const requested = BigInt(raw.amount);
    if (requested <= 0n) {
      throw new Error("batch_settlement_refund_amount_invalid");
    }
    refundAmountBig = requested;
  }

  const refundAmount = refundAmountBig.toString();
  const nonce = String(channel.refundNonce ?? 0);

  const receiverAuthorizerSigner = scheme.getReceiverAuthorizerSigner();

  const refundAuthorizerSignature = receiverAuthorizerSigner
    ? await signRefund(
        receiverAuthorizerSigner,
        channelId as `0x${string}`,
        refundAmount,
        nonce,
        requirements.network,
      )
    : undefined;

  const claimAuthorizerSignature = receiverAuthorizerSigner
    ? await signClaimBatch(receiverAuthorizerSigner, [claimEntry], requirements.network)
    : undefined;

  scheme.rememberChannelSnapshot(paymentPayload, channel);

  return {
    ...(raw.amount === undefined ? { amount: refundAmount } : {}),
    refundNonce: nonce,
    claims: [claimEntry],
    refundAuthorizerSignature,
    claimAuthorizerSignature,
  };
}

/**
 * Lifecycle hook: runs after the facilitator settles a payment.
 *
 * Updates channel state to reflect the settlement outcome — adjusting charged amounts,
 * balances, and handling cooperative-refund cleanup (channel record deletion).
 *
 * @param scheme - Owning `BatchSettlementEvmScheme` instance for storage access.
 * @param ctx - Post-settle lifecycle context.
 * @param ctx.paymentPayload - Payment payload that was settled (possibly rewritten).
 * @param ctx.requirements - Requirements used for settlement.
 * @param ctx.result - Facilitator settle response.
 * @returns Resolves when session updates are complete (no return value).
 */
export async function handleAfterSettle(
  scheme: BatchSettlementEvmScheme,
  ctx: SettleResultContext,
): Promise<void> {
  const { paymentPayload, requirements, result } = ctx;
  if (!result.success) {
    return;
  }

  const raw = paymentPayload.payload;
  const storage = scheme.getStorage();

  if (isBatchSettlementRefundPayload(raw)) {
    const channelId = computeChannelId(raw.channelConfig);
    const prevChannel = await storage.get(channelId);

    if (raw.amount === undefined) {
      return;
    }

    const refundedAmount = raw.amount;

    const remainderAfter = prevChannel
      ? BigInt(prevChannel.balance) -
        BigInt(prevChannel.chargedCumulativeAmount) -
        BigInt(refundedAmount)
      : 0n;

    if (!prevChannel || remainderAfter <= 0n) {
      await storage.delete(channelId);
      return;
    }

    const updatedChannel: Channel = {
      ...prevChannel,
      balance: (BigInt(prevChannel.balance) - BigInt(refundedAmount)).toString(),
      refundNonce: (prevChannel.refundNonce ?? 0) + 1,
      lastRequestTimestamp: Date.now(),
    };
    await storage.set(channelId, updatedChannel);
    return;
  }

  if (isBatchSettlementVoucherPayload(raw)) {
    return;
  }

  if (isBatchSettlementDepositPayload(raw)) {
    const channelId = raw.voucher.channelId;
    const ex = result.extra ?? {};
    const prevChannel = await storage.get(channelId);
    const config = raw.channelConfig;
    const prevCharged =
      prevChannel?.chargedCumulativeAmount ?? readExtraString(ex, "totalClaimed", "0");
    const chargedActual = (BigInt(prevCharged) + BigInt(requirements.amount)).toString();
    const signedMaxClaimable = raw.voucher.maxClaimableAmount;
    const payer = config.payer;
    const depositAmount = raw.deposit.amount;
    const fallback: BatchSettlementPaymentResponseExtra = {
      channelId,
      chargedCumulativeAmount: chargedActual,
      balance: (BigInt(prevChannel?.balance ?? "0") + BigInt(depositAmount)).toString(),
      totalClaimed: prevChannel?.totalClaimed ?? "0",
      withdrawRequestedAt: prevChannel?.withdrawRequestedAt ?? 0,
      refundNonce: String(prevChannel?.refundNonce ?? 0),
    };
    const channelFields = {
      channelId:
        typeof ex.channelId === "string" && ex.channelId ? ex.channelId : fallback.channelId,
      chargedCumulativeAmount: chargedActual,
      balance: readExtraString(ex, "balance", fallback.balance),
      totalClaimed: readExtraString(ex, "totalClaimed", fallback.totalClaimed),
      withdrawRequestedAt: readExtraNumber(ex, "withdrawRequestedAt", fallback.withdrawRequestedAt),
      refundNonce: readExtraString(ex, "refundNonce", fallback.refundNonce),
    };

    const channel: Channel = {
      channelId,
      channelConfig: config,
      payer: payer.toLowerCase(),
      chargedCumulativeAmount: chargedActual,
      signedMaxClaimable,
      signature: raw.voucher.signature,
      balance: channelFields.balance,
      totalClaimed: channelFields.totalClaimed,
      withdrawRequestedAt: channelFields.withdrawRequestedAt,
      refundNonce: parseInt(channelFields.refundNonce, 10) || 0,
      lastRequestTimestamp: Date.now(),
    };
    scheme.rememberChannelSnapshot(paymentPayload, channel);
    await storage.set(channelId, channel);
  }
}

/**
 * Supplies server-owned settlement response fields from the channel snapshot.
 *
 * @param scheme - Owning `BatchSettlementEvmScheme` instance for snapshot access.
 * @param ctx - Settlement result context for the current payment.
 * @returns Additive response extra fields, or nothing when no snapshot exists.
 */
export async function handleEnrichSettlementResponse(
  scheme: BatchSettlementEvmScheme,
  ctx: SettleResultContext,
): Promise<Record<string, unknown> | void> {
  const raw = ctx.paymentPayload.payload;
  if (isBatchSettlementVoucherPayload(raw)) {
    return;
  }

  const channel = scheme.takeChannelSnapshot(ctx.paymentPayload);
  if (!channel) {
    return;
  }

  return { chargedCumulativeAmount: channel.chargedCumulativeAmount };
}
