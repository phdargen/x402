import type { PaymentPayload, PaymentRequirements, SettleResponse } from "@x402/core/types";
import type { SettleContext, SettleResultContext } from "@x402/core/server";
import { signClaimBatch, signRefund } from "../authorizerSigner";
import { BATCH_SETTLEMENT_SCHEME } from "../constants";
import {
  isBatchSettlementDepositPayload,
  isBatchSettlementRefundWithSignaturePayload,
  isBatchSettlementVoucherPayload,
} from "../types";
import type {
  BatchSettlementPaymentResponseExtra,
  BatchSettlementVoucherClaim,
  BatchSettlementVoucherPayload,
} from "../types";
import { computeChannelId } from "../utils";
import type { BatchSettlementEvmScheme } from "./scheme";
import type { Channel } from "./storage";
import {
  buildRefundResponseSnapshot,
  emptyResponseSnapshot,
  readExtraNumber,
  readExtraString,
} from "./utils";

/**
 * Lifecycle hook: runs before the facilitator settles a payment.
 *
 * For voucher payloads the server does NOT trigger an onchain settle.  Instead, it
 * increments the local `chargedCumulativeAmount` and returns a `skip` result so the
 * middleware responds immediately.  If the client requests a
 * cooperative refund, the payload is rewritten to a `refund` settle
 * action that the facilitator will execute onchain.
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
  if (requirements.scheme !== BATCH_SETTLEMENT_SCHEME) {
    return;
  }

  const raw = paymentPayload.payload;
  const storage = scheme.getStorage();

  if (!isBatchSettlementVoucherPayload(raw)) {
    return;
  }

  const channelId = raw.channelId;
  const channel = await storage.get(channelId);
  if (!channel) {
    return {
      abort: true,
      reason: "missing_batch_settlement_channel",
      message: "No channel record",
    };
  }

  if (raw.refund === true) {
    return buildRefundSettlePayload(scheme, paymentPayload, requirements, channel, raw);
  }

  const increment = BigInt(requirements.amount);
  const signedCap = BigInt(raw.maxClaimableAmount);
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
    signedMaxClaimable: raw.maxClaimableAmount as string,
    signature: raw.signature as `0x${string}`,
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
 * Builds a `refundWithSignature` settle payload for a zero-charge refund voucher
 * and rewrites the in-flight `paymentPayload.payload` so the facilitator submits
 * the cooperative refund on-chain.
 *
 * Refund amount semantics:
 * - When the client supplied `raw.refundAmount`, that is used (partial refund).
 *   The amount is clamped at the channel's available remainder
 *   (`balance - chargedCumulativeAmount`).
 * - Otherwise the entire remainder is refunded (full refund) and the channel
 *   will be torn down in `handleAfterSettle`.
 *
 * @param scheme - Owning `BatchSettlementEvmScheme` instance for signer access.
 * @param paymentPayload - The in-flight payment payload whose `payload` field will be rewritten.
 * @param requirements - Payment requirements for the route (network is read for signing).
 * @param channel - Current server-side channel record.
 * @param raw - The original voucher payload carrying `refund: true`.
 * @returns Either `void` to proceed, or an `abort` directive on misuse.
 */
export async function buildRefundSettlePayload(
  scheme: BatchSettlementEvmScheme,
  paymentPayload: PaymentPayload,
  requirements: PaymentRequirements,
  channel: Channel,
  raw: BatchSettlementVoucherPayload,
): Promise<void | { abort: true; reason: string; message?: string }> {
  const channelId = raw.channelId;
  const config = channel.channelConfig;

  const claimEntry: BatchSettlementVoucherClaim = {
    voucher: {
      channel: config,
      maxClaimableAmount: raw.maxClaimableAmount as string,
    },
    signature: raw.signature as `0x${string}`,
    totalClaimed: channel.chargedCumulativeAmount,
  };

  const remainder = BigInt(channel.balance) - BigInt(channel.chargedCumulativeAmount);
  if (remainder <= 0n) {
    return {
      abort: true,
      reason: "batch_settlement_refund_no_balance",
      message: "Channel has no remaining balance to refund",
    };
  }

  let refundAmountBig = remainder;
  if (raw.refundAmount !== undefined) {
    const requested = BigInt(raw.refundAmount);
    if (requested <= 0n) {
      return {
        abort: true,
        reason: "batch_settlement_refund_amount_invalid",
        message: "refundAmount must be a positive integer",
      };
    }
    if (requested > remainder) {
      return {
        abort: true,
        reason: "batch_settlement_refund_amount_exceeds_balance",
        message: `refundAmount ${requested.toString()} exceeds remainder ${remainder.toString()}`,
      };
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

  const responseExtra = buildRefundResponseSnapshot(channel, {
    settleAction: "refundWithSignature",
    config,
    amount: refundAmount,
    nonce,
    claims: [claimEntry],
    refundAuthorizerSignature,
    claimAuthorizerSignature,
  });

  (paymentPayload as { payload: unknown }).payload = {
    settleAction: "refundWithSignature",
    config,
    amount: refundAmount,
    nonce,
    claims: [claimEntry],
    refundAuthorizerSignature,
    claimAuthorizerSignature,
    responseExtra,
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
  if (requirements.scheme !== BATCH_SETTLEMENT_SCHEME || !result.success) {
    return;
  }

  const raw = paymentPayload.payload;
  const storage = scheme.getStorage();

  if (isBatchSettlementRefundWithSignaturePayload(raw)) {
    const channelId = computeChannelId(raw.config);
    const prevChannel = await storage.get(channelId);
    const fallback =
      prevChannel?.channelId !== undefined
        ? buildRefundResponseSnapshot(prevChannel, raw)
        : (raw.responseExtra ?? emptyResponseSnapshot(channelId));

    const extra = result.extra;
    const refundedAmount = readExtraString(extra, "refundedAmount", raw.amount);

    result.extra = {
      channelId:
        typeof extra?.channelId === "string" && extra.channelId
          ? extra.channelId
          : fallback.channelId,
      chargedCumulativeAmount: readExtraString(
        extra,
        "chargedCumulativeAmount",
        fallback.chargedCumulativeAmount,
      ),
      balance: readExtraString(extra, "balance", fallback.balance),
      totalClaimed: readExtraString(extra, "totalClaimed", fallback.totalClaimed),
      withdrawRequestedAt: readExtraNumber(
        extra,
        "withdrawRequestedAt",
        fallback.withdrawRequestedAt,
      ),
      refundNonce: readExtraString(extra, "refundNonce", fallback.refundNonce),
      refund: true,
      refundedAmount,
    };

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
    const resolvedConfig = raw.deposit.channelConfig ?? prevChannel?.channelConfig;
    if (!resolvedConfig) {
      return;
    }
    const prevCharged =
      prevChannel?.chargedCumulativeAmount ?? readExtraString(ex, "totalClaimed", "0");
    const chargedActual = (BigInt(prevCharged) + BigInt(requirements.amount)).toString();
    const signedMaxClaimable = raw.voucher.maxClaimableAmount;
    const payer = resolvedConfig.payer ?? result.payer ?? "";
    const depositAmount = raw.deposit.amount;
    const fallback: BatchSettlementPaymentResponseExtra = {
      channelId,
      chargedCumulativeAmount: chargedActual,
      balance: (BigInt(prevChannel?.balance ?? "0") + BigInt(depositAmount)).toString(),
      totalClaimed: prevChannel?.totalClaimed ?? "0",
      withdrawRequestedAt: prevChannel?.withdrawRequestedAt ?? 0,
      refundNonce: String(prevChannel?.refundNonce ?? 0),
    };
    const responseExtra = {
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
      channelConfig: resolvedConfig,
      payer: payer.toLowerCase(),
      chargedCumulativeAmount: chargedActual,
      signedMaxClaimable,
      signature: raw.voucher.signature,
      balance: responseExtra.balance,
      totalClaimed: responseExtra.totalClaimed,
      withdrawRequestedAt: responseExtra.withdrawRequestedAt,
      refundNonce: parseInt(responseExtra.refundNonce, 10) || 0,
      lastRequestTimestamp: Date.now(),
    };
    await storage.set(channelId, channel);
    result.extra = responseExtra;
  }
}
