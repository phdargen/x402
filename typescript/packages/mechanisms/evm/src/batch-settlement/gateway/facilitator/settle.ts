import type {
  FacilitatorContext,
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
} from "@x402/core/types";
import { getAddress } from "viem";
import {
  isBatchSettlementDepositPayload,
  isBatchSettlementSettlePayload,
  isBatchSettlementVoucherPayload,
} from "../../types";
import { settleDeposit } from "../../facilitator/deposit";
import { readChannelState } from "../../facilitator/utils";
import { batchSettlementGatewayABI } from "../abi";
import * as GwErrors from "../errors";
import {
  computeGatewayVoucherDigest,
  readVoucherGatewayInfo,
  verifyGatewayClaimAuthorizationSignature,
} from "../utils";
import { verifyGatewayPayment } from "./verify";
import { executeGatewayWithdraw } from "./withdraw";
import type { GatewayFacilitatorDeps } from "./storage";

/** Narrow callback used before server withdraw to flush pending credits. */
export type GatewayDistributeForReceiver = (receiver: `0x${string}`) => Promise<void>;

/**
 * Settles a gateway payment: deposit onchain + store commitments, voucher offchain commit,
 * or server withdraw via gateway.withdraw.
 *
 * @param deps - Facilitator gateway deps.
 * @param payload - Full payment envelope.
 * @param requirements - Server payment requirements (amount may be actual charge).
 * @param context - Optional facilitator context.
 * @param distributeForReceiver - Optional callback to flush pending credits before withdraw.
 * @returns Settle response.
 */
export async function settleGatewayPayment(
  deps: GatewayFacilitatorDeps,
  payload: PaymentPayload,
  requirements: PaymentRequirements,
  context?: FacilitatorContext,
  distributeForReceiver?: GatewayDistributeForReceiver,
): Promise<SettleResponse> {
  const info = readVoucherGatewayInfo(payload.extensions);
  if (!info) {
    return {
      success: false,
      errorReason: GwErrors.ErrVoucherPayload,
      transaction: "",
      network: requirements.network,
    };
  }

  const raw = payload.payload;

  if (isBatchSettlementSettlePayload(raw)) {
    const receiver = info.receiver;
    if (!receiver) {
      return {
        success: false,
        errorReason: GwErrors.ErrSettleTargetMissing,
        transaction: "",
        network: requirements.network,
      };
    }

    if (distributeForReceiver) {
      await distributeForReceiver(getAddress(receiver));
    }

    return executeGatewayWithdraw(deps, getAddress(receiver), getAddress(raw.token), requirements);
  }

  if (!isBatchSettlementDepositPayload(raw) && !isBatchSettlementVoucherPayload(raw)) {
    return {
      success: false,
      errorReason: "invalid_batch_settlement_evm_payload_type",
      transaction: "",
      network: requirements.network,
    };
  }

  const claimAuthorization = info.claimAuthorization;
  if (!claimAuthorization) {
    return {
      success: false,
      errorReason: GwErrors.ErrServerSettlementPayload,
      transaction: "",
      network: requirements.network,
      payer: raw.channelConfig.payer,
    };
  }

  // Re-verify against the authorized max (accepted.amount), not the actual charge.
  const authorizedRequirements: PaymentRequirements = {
    ...requirements,
    amount: payload.accepted.amount,
  };
  const verified = await verifyGatewayPayment(deps, payload, authorizedRequirements, context);
  if (!verified.isValid) {
    return {
      success: false,
      errorReason: verified.invalidReason ?? GwErrors.ErrVoucherPayload,
      errorMessage: verified.invalidMessage,
      transaction: "",
      network: requirements.network,
      payer: verified.payer,
      extensions: verified.extensions,
      extra: verified.extra,
    };
  }

  const gateway = getAddress(deps.gateway);
  const gatewayConfig = info.gatewayConfig!;
  const gatewayVoucher = info.gatewayVoucher!;
  const channelId = raw.voucher.channelId;

  const authorizedAmount = BigInt(payload.accepted.amount);
  const actualPrice = BigInt(requirements.amount);
  if (actualPrice > authorizedAmount) {
    return {
      success: false,
      errorReason: GwErrors.ErrServerSettlementPayload,
      errorMessage: "actualPrice exceeds authorized amount",
      transaction: "",
      network: requirements.network,
      payer: raw.channelConfig.payer,
    };
  }

  const expectedTotalClaimed =
    BigInt(gatewayVoucher.maxClaimableAmount) - authorizedAmount + actualPrice;
  if (BigInt(claimAuthorization.totalClaimed) !== expectedTotalClaimed) {
    return {
      success: false,
      errorReason: GwErrors.ErrServerSettlementPayload,
      errorMessage: "claimAuthorization.totalClaimed mismatch",
      transaction: "",
      network: requirements.network,
      payer: raw.channelConfig.payer,
    };
  }

  const gatewayVoucherDigest = computeGatewayVoucherDigest(
    gatewayVoucher.gatewayId,
    gatewayVoucher.maxClaimableAmount,
    requirements.network,
    gateway,
  );

  const claimOk = await verifyGatewayClaimAuthorizationSignature({
    gateway,
    network: requirements.network,
    gatewayVoucherDigest,
    totalClaimed: claimAuthorization.totalClaimed,
    signature: claimAuthorization.signature,
    receiverAuthorizer: gatewayConfig.receiverAuthorizer,
  });
  if (!claimOk) {
    return {
      success: false,
      errorReason: GwErrors.ErrClaimAuthorizationSignature,
      transaction: "",
      network: requirements.network,
      payer: raw.channelConfig.payer,
    };
  }

  let transaction = "";
  let balance = "0";
  let totalClaimed = "0";
  let withdrawRequestedAt = 0;
  let refundNonce = "0";

  if (isBatchSettlementDepositPayload(raw)) {
    const boundRequirements: PaymentRequirements = {
      ...authorizedRequirements,
      payTo: gateway,
      extra: {
        ...authorizedRequirements.extra,
        receiverAuthorizer: gateway,
      },
    };
    const depositResult = await settleDeposit(
      deps.signer,
      payload,
      raw,
      boundRequirements,
      context,
      undefined,
      deps.eip6492AllowedFactories,
    );
    if (!depositResult.success) {
      return depositResult;
    }
    transaction = depositResult.transaction;
    const channelState = (
      depositResult.extra as
        | {
            channelState?: {
              balance?: string;
              totalClaimed?: string;
              withdrawRequestedAt?: number;
              refundNonce?: string;
            };
          }
        | undefined
    )?.channelState;
    balance = String(channelState?.balance ?? "0");
    totalClaimed = String(channelState?.totalClaimed ?? "0");
    withdrawRequestedAt = Number(channelState?.withdrawRequestedAt ?? 0);
    refundNonce = String(channelState?.refundNonce ?? "0");

    // Deposit aggregate must equal post-deposit balance.
    if (raw.voucher.maxClaimableAmount !== balance) {
      return {
        success: false,
        errorReason: GwErrors.ErrAggregateMismatch,
        errorMessage: "deposit aggregate voucher must equal post-deposit balance",
        transaction,
        network: requirements.network,
        payer: raw.channelConfig.payer,
      };
    }

    await deps.storage.setAggregate(channelId, {
      channel: raw.channelConfig,
      voucher: raw.voucher,
    });
  } else {
    const state = await readChannelState(deps.signer, channelId);
    balance = state.balance.toString();
    totalClaimed = state.totalClaimed.toString();
    withdrawRequestedAt = state.withdrawRequestedAt;
    refundNonce = state.refundNonce.toString();
  }

  const priorAggregateCharged = BigInt(await deps.storage.getAggregateCharged(channelId));
  const newAggregateCharged = (priorAggregateCharged + actualPrice).toString();
  await deps.storage.setAggregateCharged(channelId, newAggregateCharged);

  await deps.storage.setServerCommitment(channelId, gatewayConfig.receiver, {
    gatewayConfig: {
      channelId: gatewayConfig.channelId,
      receiver: getAddress(gatewayConfig.receiver),
      receiverAuthorizer: getAddress(gatewayConfig.receiverAuthorizer),
    },
    gatewayVoucher,
    claimAuthorization,
    chargedCumulativeAmount: claimAuthorization.totalClaimed,
  });

  let distributedCumulative = "0";
  try {
    distributedCumulative = (
      (await deps.signer.readContract({
        address: gateway,
        abi: batchSettlementGatewayABI,
        functionName: "distributedCumulative",
        args: [channelId, getAddress(gatewayConfig.receiver)],
      })) as bigint
    ).toString();
  } catch {
    // ignore
  }

  return {
    success: true,
    transaction,
    network: requirements.network,
    payer: raw.channelConfig.payer,
    amount: "",
    extra: {
      chargedAmount: actualPrice.toString(),
      channelState: {
        channelId,
        balance,
        totalClaimed,
        withdrawRequestedAt,
        refundNonce,
        chargedCumulativeAmount: newAggregateCharged,
      },
    },
    extensions: {
      "voucher-gateway": {
        info: {
          gateway,
          gatewayState: {
            gatewayId: gatewayVoucher.gatewayId,
            distributedCumulative,
            claimAuthorization,
          },
        },
      },
    },
  };
}
