import type {
  FacilitatorContext,
  PaymentPayload,
  PaymentRequirements,
  VerifyResponse,
} from "@x402/core/types";
import { getAddress } from "viem";
import type { FacilitatorEvmSigner } from "../../../signer";
import { isBatchSettlementDepositPayload, isBatchSettlementVoucherPayload } from "../../types";
import { verifyDeposit } from "../../facilitator/deposit";
import { verifyVoucher } from "../../facilitator/voucher";
import { readChannelState } from "../../facilitator/utils";
import { batchSettlementGatewayABI } from "../abi";
import * as GwErrors from "../errors";
import type { GatewayConfig, GatewayVoucherFields, VoucherGatewayExtensionInfo } from "../types";
import { computeGatewayId, readVoucherGatewayInfo, verifyGatewayVoucherSignature } from "../utils";
import type { GatewayChannelStorage, GatewayFacilitatorDeps } from "./storage";

/**
 * Builds payment requirements that pass base channel-config validation for gateway channels
 * (onchain receiver roles are the gateway, not payTo).
 *
 * @param requirements - Original server payment requirements.
 * @param gateway - Gateway contract address.
 * @returns Rewritten requirements for base-scheme helpers.
 */
function gatewayBoundRequirements(
  requirements: PaymentRequirements,
  gateway: `0x${string}`,
): PaymentRequirements {
  return {
    ...requirements,
    payTo: gateway,
    extra: {
      ...requirements.extra,
      receiverAuthorizer: gateway,
    },
  };
}

/**
 * Validates gateway extension fields shared by deposit and voucher verify.
 *
 * @param extension - Facilitator gateway extension.
 * @param info - Parsed voucher-gateway info from the payload.
 * @param requirements - Server payment requirements.
 * @param channelId - Channel id from the aggregate voucher.
 * @param channelConfigReceiver - ChannelConfig.receiver from the payload.
 * @param channelConfigReceiverAuthorizer - ChannelConfig.receiverAuthorizer from the payload.
 * @param channelWithdrawDelay - ChannelConfig.withdrawDelay from the payload.
 * @returns Error response when invalid, otherwise validated gateway fields.
 */
async function validateGatewayExtensionFields(
  extension: GatewayFacilitatorDeps,
  info: VoucherGatewayExtensionInfo,
  requirements: PaymentRequirements,
  channelId: `0x${string}`,
  channelConfigReceiver: `0x${string}`,
  channelConfigReceiverAuthorizer: `0x${string}`,
  channelWithdrawDelay: number,
): Promise<
  | { ok: false; response: VerifyResponse }
  | {
      ok: true;
      gateway: `0x${string}`;
      gatewayConfig: GatewayConfig;
      gatewayVoucher: GatewayVoucherFields;
      distributedCumulative: string;
    }
> {
  const gateway = getAddress(extension.gateway);
  const infoGateway = getAddress(info.gateway);

  if (infoGateway !== gateway) {
    return {
      ok: false,
      response: { isValid: false, invalidReason: GwErrors.ErrUnknownGateway },
    };
  }

  if (
    getAddress(channelConfigReceiver) !== gateway ||
    getAddress(channelConfigReceiverAuthorizer) !== gateway
  ) {
    return {
      ok: false,
      response: { isValid: false, invalidReason: GwErrors.ErrAddressMismatch },
    };
  }

  if (channelWithdrawDelay !== extension.withdrawDelay) {
    return {
      ok: false,
      response: {
        isValid: false,
        invalidReason: "invalid_batch_settlement_evm_withdraw_delay_mismatch",
      },
    };
  }

  const gatewayConfig = info.gatewayConfig;
  const gatewayVoucher = info.gatewayVoucher;
  if (!gatewayConfig || !gatewayVoucher) {
    return {
      ok: false,
      response: { isValid: false, invalidReason: GwErrors.ErrVoucherPayload },
    };
  }

  if (getAddress(gatewayConfig.receiver) !== getAddress(requirements.payTo)) {
    return {
      ok: false,
      response: { isValid: false, invalidReason: GwErrors.ErrReceiverMismatch },
    };
  }

  const requiredAuthorizer = requirements.extra?.receiverAuthorizer;
  if (
    typeof requiredAuthorizer !== "string" ||
    getAddress(gatewayConfig.receiverAuthorizer) !== getAddress(requiredAuthorizer)
  ) {
    return {
      ok: false,
      response: { isValid: false, invalidReason: GwErrors.ErrReceiverAuthorizerMismatch },
    };
  }

  if (gatewayConfig.channelId.toLowerCase() !== channelId.toLowerCase()) {
    return {
      ok: false,
      response: { isValid: false, invalidReason: GwErrors.ErrVoucherChannelMismatch },
    };
  }

  const expectedGatewayId = computeGatewayId(gatewayConfig, requirements.network, gateway);
  if (gatewayVoucher.gatewayId.toLowerCase() !== expectedGatewayId.toLowerCase()) {
    return {
      ok: false,
      response: { isValid: false, invalidReason: GwErrors.ErrVoucherChannelMismatch },
    };
  }

  let distributedCumulative = "0";
  try {
    const onchain = (await extension.signer.readContract({
      address: gateway,
      abi: batchSettlementGatewayABI,
      functionName: "distributedCumulative",
      args: [channelId, getAddress(gatewayConfig.receiver)],
    })) as bigint;
    distributedCumulative = onchain.toString();
  } catch {
    // Channel may not exist onchain yet (first deposit); treat as zero.
  }

  if (BigInt(gatewayVoucher.maxClaimableAmount) <= BigInt(distributedCumulative)) {
    return {
      ok: false,
      response: {
        isValid: false,
        invalidReason: GwErrors.ErrReceiverCumulativeBelowDistributed,
      },
    };
  }

  return {
    ok: true,
    gateway,
    gatewayConfig: {
      channelId: gatewayConfig.channelId,
      receiver: getAddress(gatewayConfig.receiver),
      receiverAuthorizer: getAddress(gatewayConfig.receiverAuthorizer),
    },
    gatewayVoucher,
    distributedCumulative,
  };
}

/**
 * Verifies a gateway deposit or voucher payment payload.
 *
 * @param extension - Facilitator gateway extension (config + storage).
 * @param payload - Full payment envelope.
 * @param requirements - Server payment requirements.
 * @param context - Optional facilitator context.
 * @returns Verify response with base channel snapshot and gateway extension info.
 */
export async function verifyGatewayPayment(
  extension: GatewayFacilitatorDeps,
  payload: PaymentPayload,
  requirements: PaymentRequirements,
  context?: FacilitatorContext,
): Promise<VerifyResponse> {
  const info = readVoucherGatewayInfo(payload.extensions);
  if (!info) {
    return { isValid: false, invalidReason: GwErrors.ErrVoucherPayload };
  }

  const raw = payload.payload;
  if (!isBatchSettlementDepositPayload(raw) && !isBatchSettlementVoucherPayload(raw)) {
    return { isValid: false, invalidReason: "invalid_batch_settlement_evm_payload_type" };
  }

  const channelId = raw.voucher.channelId;
  const validated = await validateGatewayExtensionFields(
    extension,
    info,
    requirements,
    channelId,
    raw.channelConfig.receiver,
    raw.channelConfig.receiverAuthorizer,
    raw.channelConfig.withdrawDelay,
  );
  if (!validated.ok) return validated.response;

  const { gateway, gatewayConfig, gatewayVoucher, distributedCumulative } = validated;

  const voucherSigOk = await verifyGatewayVoucherSignature({
    gateway,
    network: requirements.network,
    gatewayId: gatewayVoucher.gatewayId,
    maxClaimableAmount: gatewayVoucher.maxClaimableAmount,
    signature: gatewayVoucher.signature,
    payerAuthorizer: raw.channelConfig.payerAuthorizer,
    payer: raw.channelConfig.payer,
  });
  if (!voucherSigOk) {
    return {
      isValid: false,
      invalidReason: GwErrors.ErrVoucherSignature,
      payer: raw.channelConfig.payer,
    };
  }

  const storage = extension.storage;
  const prior = await storage.getServerCommitment(channelId, gatewayConfig.receiver);
  const priorCharged = BigInt(prior?.chargedCumulativeAmount ?? "0");
  const expectedCeiling = priorCharged + BigInt(requirements.amount);
  if (BigInt(gatewayVoucher.maxClaimableAmount) !== expectedCeiling) {
    return buildCumulativeMismatchResponse(
      extension.signer,
      storage,
      raw.channelConfig.payer,
      channelId,
      gateway,
      gatewayConfig,
      gatewayVoucher,
      distributedCumulative,
      prior,
    );
  }

  if (isBatchSettlementVoucherPayload(raw)) {
    const storedAggregate = await storage.getAggregate(channelId);
    if (
      !storedAggregate ||
      storedAggregate.voucher.maxClaimableAmount !== raw.voucher.maxClaimableAmount ||
      storedAggregate.voucher.signature !== raw.voucher.signature
    ) {
      return {
        isValid: false,
        invalidReason: GwErrors.ErrAggregateMismatch,
        payer: raw.channelConfig.payer,
      };
    }
  }

  // Accounting exclusivity: base totalClaimed must equal gateway distributedByChannel.
  try {
    const state = await readChannelState(extension.signer, channelId);
    if (state.balance > 0n) {
      const distributedByChannel = (await extension.signer.readContract({
        address: gateway,
        abi: batchSettlementGatewayABI,
        functionName: "distributedByChannel",
        args: [channelId],
      })) as bigint;
      if (state.totalClaimed !== distributedByChannel) {
        return {
          isValid: false,
          invalidReason: GwErrors.ErrAccountingMismatch,
          payer: raw.channelConfig.payer,
        };
      }
    }
  } catch {
    // First deposit path may not have onchain channel yet.
  }

  const boundRequirements = gatewayBoundRequirements(requirements, gateway);
  let base: VerifyResponse;
  if (isBatchSettlementDepositPayload(raw)) {
    base = await verifyDeposit(
      extension.signer,
      payload,
      raw,
      boundRequirements,
      context,
      extension.eip6492AllowedFactories,
    );
  } else {
    base = await verifyVoucher(extension.signer, raw, boundRequirements, raw.channelConfig);
  }

  if (!base.isValid) return base;

  const aggregateCharged = await storage.getAggregateCharged(channelId);

  return {
    ...base,
    extensions: {
      ...(base.extensions ?? {}),
      "voucher-gateway": {
        info: {
          gateway,
          aggregateChargedCumulativeAmount: aggregateCharged,
          gatewayState: {
            gatewayId: gatewayVoucher.gatewayId,
            distributedCumulative,
          },
        },
      },
    },
  };
}

/**
 * Builds a corrective verify failure for per-server cumulative mismatch.
 *
 * @param signer - Facilitator signer for onchain reads.
 * @param storage - Gateway storage.
 * @param payer - Client payer address.
 * @param channelId - Channel id.
 * @param gateway - Gateway address.
 * @param gatewayConfig - Gateway config.
 * @param gatewayVoucher - Submitted gateway voucher.
 * @param distributedCumulative - Onchain distributed cumulative.
 * @param prior - Prior stored commitment, if any.
 * @returns Invalid verify response with gateway extension snapshot.
 */
async function buildCumulativeMismatchResponse(
  signer: FacilitatorEvmSigner,
  storage: GatewayChannelStorage,
  payer: `0x${string}`,
  channelId: `0x${string}`,
  gateway: `0x${string}`,
  gatewayConfig: GatewayConfig,
  gatewayVoucher: GatewayVoucherFields,
  distributedCumulative: string,
  prior: Awaited<ReturnType<GatewayChannelStorage["getServerCommitment"]>>,
): Promise<VerifyResponse> {
  let channelExtra: Record<string, unknown> | undefined;
  try {
    const state = await readChannelState(signer, channelId);
    channelExtra = {
      channelId,
      balance: state.balance.toString(),
      totalClaimed: state.totalClaimed.toString(),
      withdrawRequestedAt: state.withdrawRequestedAt,
      refundNonce: state.refundNonce.toString(),
      chargedCumulativeAmount: await storage.getAggregateCharged(channelId),
    };
  } catch {
    // omit
  }

  return {
    isValid: false,
    invalidReason: GwErrors.ErrCumulativeMismatch,
    payer,
    extra: channelExtra,
    extensions: {
      "voucher-gateway": {
        info: {
          gateway,
          gatewayState: {
            gatewayId: gatewayVoucher.gatewayId,
            distributedCumulative,
            ...(prior
              ? {
                  voucherState: {
                    maxClaimableAmount: prior.gatewayVoucher.maxClaimableAmount,
                    signature: prior.gatewayVoucher.signature,
                  },
                  claimAuthorization: prior.claimAuthorization,
                }
              : {}),
          },
          gatewayConfig,
        },
      },
    },
  };
}
