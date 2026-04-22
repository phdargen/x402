import { PaymentRequirements, VerifyResponse } from "@x402/core/types";
import { FacilitatorEvmSigner } from "../../signer";
import { BatchSettlementVoucherPayload, ChannelConfig } from "../types";
import { getEvmChainId } from "../../utils";
import * as Errors from "./errors";
import {
  validateChannelConfig,
  verifyBatchSettlementVoucherTypedData,
  readChannelState,
} from "./utils";

/**
 * Verifies a cumulative voucher payload against onchain channel state.
 *
 * @param signer - Facilitator signer used for on-chain reads and signature verification.
 * @param payload - The voucher payload (channelId, maxClaimableAmount, signature).
 * @param requirements - Server payment requirements (asset, network, amount).
 * @param channelConfig - Reconstructed channel configuration for the payer/receiver pair.
 * @returns A {@link VerifyResponse} indicating validity and returning channel state in `extra`.
 */
export async function verifyVoucher(
  signer: FacilitatorEvmSigner,
  payload: BatchSettlementVoucherPayload,
  requirements: PaymentRequirements,
  channelConfig: ChannelConfig,
): Promise<VerifyResponse> {
  const channelId = payload.channelId;
  const chainId = getEvmChainId(requirements.network);

  const configErr = validateChannelConfig(channelConfig, channelId, requirements);
  if (configErr) {
    return { isValid: false, invalidReason: configErr, payer: channelConfig.payer };
  }

  const voucherOk = await verifyBatchSettlementVoucherTypedData(
    signer,
    {
      channelId,
      maxClaimableAmount: payload.maxClaimableAmount,
      payerAuthorizer: channelConfig.payerAuthorizer,
      payer: channelConfig.payer,
      signature: payload.signature,
    },
    chainId,
  );
  if (!voucherOk) {
    return {
      isValid: false,
      invalidReason: Errors.ErrInvalidVoucherSignature,
      payer: channelConfig.payer,
    };
  }

  const state = await readChannelState(signer, channelId);

  if (state.balance === 0n) {
    return { isValid: false, invalidReason: Errors.ErrChannelNotFound, payer: channelConfig.payer };
  }

  const maxClaimableAmount = BigInt(payload.maxClaimableAmount);

  if (maxClaimableAmount > state.balance) {
    return {
      isValid: false,
      invalidReason: Errors.ErrCumulativeExceedsBalance,
      payer: channelConfig.payer,
    };
  }

  const isRefundVoucher = payload.refund === true;
  const belowClaimed = isRefundVoucher
    ? maxClaimableAmount < state.totalClaimed
    : maxClaimableAmount <= state.totalClaimed;
  if (belowClaimed) {
    return {
      isValid: false,
      invalidReason: Errors.ErrCumulativeAmountBelowClaimed,
      payer: channelConfig.payer,
    };
  }

  return {
    isValid: true,
    payer: channelConfig.payer,
    extra: {
      channelId,
      balance: state.balance.toString(),
      totalClaimed: state.totalClaimed.toString(),
      withdrawRequestedAt: state.withdrawRequestedAt,
      refundNonce: state.refundNonce.toString(),
    },
  };
}
