import type { PaymentRequirements, SettleResponse } from "@x402/core/types";
import type {
  BatchSettlementChannelSnapshot,
  BatchSettlementDepositPayload,
  BatchSettlementPaymentResponseExtra,
  BatchSettlementVoucherPayload,
} from "../../types";
import * as Errors from "../../errors";
import type { BatchSettlementVoucherStore } from "./store";

/**
 * Settles a facilitator-managed paid request.
 *
 * No transaction is submitted: the durable write of the voucher and the advanced
 * watermark *is* the settlement. The charge is `requirements.amount` on this call, which
 * may be below the amount seen at verify (dynamic pricing) but never above it, and never
 * beyond what the client's voucher covers.
 *
 * @param store - Facilitator voucher store.
 * @param payload - Voucher payload being settled.
 * @param requirements - Payment requirements carrying the settle-time charge.
 * @returns Settle response with an empty transaction and the committed channel state.
 */
export async function settleDelegatedVoucher(
  store: BatchSettlementVoucherStore,
  payload: BatchSettlementVoucherPayload,
  requirements: PaymentRequirements,
): Promise<SettleResponse> {
  const { voucher } = payload;
  const payer = payload.channelConfig.payer;
  const outcome = await store.commitVoucher(voucher, requirements.amount);

  if (outcome.status === "missing") {
    return failure(requirements, payer, Errors.ErrMissingChannel, "No channel record");
  }

  if (outcome.status === "busy") {
    return failure(
      requirements,
      payer,
      Errors.ErrChannelBusy,
      "No matching reservation for this voucher",
    );
  }

  if (outcome.status === "over_charge") {
    return failure(
      requirements,
      payer,
      Errors.ErrChargeExceedsSignedCumulative,
      `Charged ${outcome.charged} exceeds ${outcome.limit}`,
    );
  }

  const extra: BatchSettlementPaymentResponseExtra = {
    chargedAmount: requirements.amount,
    channelState: outcome.channelState,
  };

  return {
    success: true,
    payer,
    transaction: "",
    network: requirements.network,
    amount: "",
    extra,
  };
}

/**
 * Records a settled deposit in the facilitator's store and adds the watermark to the
 * deposit response, so the client sees the same channel-state contract as a paid voucher.
 *
 * @param store - Facilitator voucher store.
 * @param payload - Deposit payload that was settled.
 * @param requirements - Payment requirements carrying the settle-time charge.
 * @param result - Response from the onchain deposit.
 * @returns The deposit response, enriched with the committed channel state.
 */
export async function persistDepositSettlement(
  store: BatchSettlementVoucherStore,
  payload: BatchSettlementDepositPayload,
  requirements: PaymentRequirements,
  result: SettleResponse,
): Promise<SettleResponse> {
  if (!result.success) {
    await store.release(payload.voucher.channelId, payload.voucher.signature);
    return result;
  }

  const channelState = await store.commitDeposit({
    channelConfig: payload.channelConfig,
    voucher: payload.voucher,
    snapshot: settledSnapshot(payload.voucher.channelId, result.extra),
    actual: requirements.amount,
  });

  const extra: BatchSettlementPaymentResponseExtra = {
    chargedAmount: requirements.amount,
    channelState,
  };

  return { ...result, extra: { ...result.extra, ...extra } };
}

/**
 * Reads the post-deposit channel snapshot the deposit handler returned.
 *
 * @param channelId - Channel the deposit targeted.
 * @param extra - `extra` from the deposit settle response.
 * @returns Channel snapshot to mirror into the store.
 */
function settledSnapshot(
  channelId: `0x${string}`,
  extra: Record<string, unknown> | undefined,
): BatchSettlementChannelSnapshot {
  const state = (extra?.channelState ?? {}) as Record<string, unknown>;
  return {
    channelId,
    balance: String(state.balance ?? "0"),
    totalClaimed: String(state.totalClaimed ?? "0"),
    withdrawRequestedAt: Number(state.withdrawRequestedAt ?? 0),
    refundNonce: String(state.refundNonce ?? "0"),
  };
}

/**
 * Builds a failed settle response and keeps the payer for reporting.
 *
 * @param requirements - Payment requirements (network).
 * @param payer - Payer address from the channel config.
 * @param errorReason - Machine-readable failure reason.
 * @param errorMessage - Human-readable detail.
 * @returns Failed {@link SettleResponse}.
 */
function failure(
  requirements: PaymentRequirements,
  payer: `0x${string}`,
  errorReason: string,
  errorMessage: string,
): SettleResponse {
  return {
    success: false,
    errorReason,
    errorMessage,
    transaction: "",
    network: requirements.network,
    payer,
  };
}
