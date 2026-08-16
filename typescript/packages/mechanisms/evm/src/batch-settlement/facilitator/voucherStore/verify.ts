import type { PaymentRequirements, VerifyResponse } from "@x402/core/types";
import type {
  BatchSettlementChannelSnapshot,
  BatchSettlementCorrectiveVerifyExtra,
  BatchSettlementDelegatedVerifyExtra,
  BatchSettlementDepositPayload,
  BatchSettlementVoucherPayload,
} from "../../types";
import * as Errors from "../../errors";
import type { BatchSettlementVoucherStore } from "./store";

/**
 * Adds facilitator-managed custody to a verified payload.
 *
 * The onchain and signature rules are unchanged — `runBaseVerify` is the same
 * `verifyVoucher` / `verifyDeposit` used in self-managed mode. On top of that this adds
 * the two rules the custodian owns: the watermark (`maxClaimableAmount` must equal
 * `chargedCumulativeAmount + requirements.amount`) and a short-lived exclusive lock per
 * channel, so a second in-flight request for the same channel is rejected rather than
 * racing the first one's commit.
 *
 * @param store - Facilitator voucher store.
 * @param payload - Voucher or deposit payload being verified.
 * @param requirements - Payment requirements for this request.
 * @param runBaseVerify - Scheme verification shared with self-managed mode.
 * @returns Verify response whose `extra` carries the snapshot plus the watermark.
 */
export async function delegatedVerify(
  store: BatchSettlementVoucherStore,
  payload: BatchSettlementVoucherPayload | BatchSettlementDepositPayload,
  requirements: PaymentRequirements,
  runBaseVerify: () => Promise<VerifyResponse>,
): Promise<VerifyResponse> {
  const base = await runBaseVerify();
  if (!base.isValid) {
    return base;
  }

  const payer = payload.channelConfig.payer;
  const outcome = await store.reserve({
    channelConfig: payload.channelConfig,
    voucher: payload.voucher,
    snapshot: verifiedSnapshot(payload.voucher.channelId, base.extra),
    amount: requirements.amount,
    maxTimeoutSeconds: requirements.maxTimeoutSeconds,
  });

  if (outcome.status === "busy") {
    return {
      isValid: false,
      invalidReason: Errors.ErrChannelBusy,
      invalidMessage: "Channel is already processing a request",
      payer,
    };
  }

  if (outcome.status === "mismatch") {
    const corrective: BatchSettlementCorrectiveVerifyExtra = {
      channelState: outcome.channelState,
      ...(outcome.voucherState ? { voucherState: outcome.voucherState } : {}),
    };
    return {
      isValid: false,
      invalidReason: Errors.ErrCumulativeAmountMismatch,
      invalidMessage: "Client voucher base does not match the stored cumulative amount",
      payer,
      extra: corrective,
    };
  }

  const verified: BatchSettlementDelegatedVerifyExtra = outcome.channelState;
  return { isValid: true, payer, extra: verified };
}

/**
 * Reads the channel snapshot the scheme's own verification produced.
 *
 * @param channelId - Channel the payload targets.
 * @param extra - `extra` from the base verify response.
 * @returns Channel snapshot to mirror into the store.
 */
function verifiedSnapshot(
  channelId: `0x${string}`,
  extra: Record<string, unknown> | undefined,
): BatchSettlementChannelSnapshot {
  return {
    channelId,
    balance: String(extra?.balance ?? "0"),
    totalClaimed: String(extra?.totalClaimed ?? "0"),
    withdrawRequestedAt: Number(extra?.withdrawRequestedAt ?? 0),
    refundNonce: String(extra?.refundNonce ?? "0"),
  };
}
