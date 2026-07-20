import type {
  FacilitatorContext,
  PaymentPayload,
  PaymentRequirements,
  VerifyResponse,
} from "@x402/core/types";
import { getAddress } from "viem";
import type { FacilitatorEvmSigner } from "../../../signer";
import { multicall } from "../../../multicall";
import { getEvmChainId } from "../../../utils";
import { batchSettlementABI } from "../../abi";
import { BATCH_SETTLEMENT_ADDRESS } from "../../constants";
import * as Errors from "../../errors";
import { verifyDeposit } from "../../facilitator/deposit";
import {
  readChannelState,
  validateChannelConfig,
  verifyBatchSettlementVoucherTypedData,
} from "../../facilitator/utils";
import {
  isBatchSettlementDepositPayload,
  isBatchSettlementVoucherPayload,
  type BatchSettlementVoucherPayload,
  type ChannelState,
} from "../../types";
import { batchSettlementGatewayABI } from "../abi";
import * as GwErrors from "../errors";
import type { GatewayConfig, GatewayVoucherFields, VoucherGatewayExtensionInfo } from "../types";
import { computeGatewayId, readVoucherGatewayInfo, verifyGatewayVoucherSignature } from "../utils";
import type { GatewayChannelStorage, GatewayFacilitatorDeps } from "./storage";

type GatewayVoucherOnchainSnapshot = {
  channelState: ChannelState;
  distributedCumulative: bigint;
  distributedByChannel: bigint;
};

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
 * Validates gateway extension fields shared by deposit and voucher verify (no RPC).
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
function validateGatewayExtensionFields(
  extension: GatewayFacilitatorDeps,
  info: VoucherGatewayExtensionInfo,
  requirements: PaymentRequirements,
  channelId: `0x${string}`,
  channelConfigReceiver: `0x${string}`,
  channelConfigReceiverAuthorizer: `0x${string}`,
  channelWithdrawDelay: number,
):
  | { ok: false; response: VerifyResponse }
  | {
      ok: true;
      gateway: `0x${string}`;
      gatewayConfig: GatewayConfig;
      gatewayVoucher: GatewayVoucherFields;
    } {
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

  return {
    ok: true,
    gateway,
    gatewayConfig: {
      channelId: gatewayConfig.channelId,
      receiver: getAddress(gatewayConfig.receiver),
      receiverAuthorizer: getAddress(gatewayConfig.receiverAuthorizer),
    },
    gatewayVoucher,
  };
}

/**
 * Soft-reads onchain `distributedCumulative` for the deposit verify path.
 *
 * @param signer - Facilitator signer.
 * @param gateway - Gateway address.
 * @param channelId - Channel id.
 * @param receiver - Server receiver.
 * @returns Distributed cumulative as a decimal string (defaults to `"0"`).
 */
async function readDistributedCumulativeSoft(
  signer: FacilitatorEvmSigner,
  gateway: `0x${string}`,
  channelId: `0x${string}`,
  receiver: `0x${string}`,
): Promise<string> {
  try {
    const onchain = (await signer.readContract({
      address: gateway,
      abi: batchSettlementGatewayABI,
      functionName: "distributedCumulative",
      args: [channelId, getAddress(receiver)],
    })) as bigint;
    return onchain.toString();
  } catch {
    // Channel may not exist onchain yet (first deposit); treat as zero.
    return "0";
  }
}

/**
 * Reads channel state plus gateway distribution counters in a single Multicall3.
 *
 * @param signer - Facilitator signer for onchain reads.
 * @param gateway - Gateway contract address.
 * @param channelId - Channel id.
 * @param receiver - Server receiver (`payTo`) for per-server `distributedCumulative`.
 * @returns Combined onchain snapshot.
 */
async function readGatewayVoucherOnchainSnapshot(
  signer: FacilitatorEvmSigner,
  gateway: `0x${string}`,
  channelId: `0x${string}`,
  receiver: `0x${string}`,
): Promise<GatewayVoucherOnchainSnapshot> {
  const settlement = getAddress(BATCH_SETTLEMENT_ADDRESS);
  const gatewayAddr = getAddress(gateway);
  const receiverAddr = getAddress(receiver);

  const mcResults = await multicall(signer.readContract.bind(signer), [
    { address: settlement, abi: batchSettlementABI, functionName: "channels", args: [channelId] },
    {
      address: settlement,
      abi: batchSettlementABI,
      functionName: "pendingWithdrawals",
      args: [channelId],
    },
    {
      address: settlement,
      abi: batchSettlementABI,
      functionName: "refundNonce",
      args: [channelId],
    },
    {
      address: gatewayAddr,
      abi: batchSettlementGatewayABI,
      functionName: "distributedCumulative",
      args: [channelId, receiverAddr],
    },
    {
      address: gatewayAddr,
      abi: batchSettlementGatewayABI,
      functionName: "distributedByChannel",
      args: [channelId],
    },
  ]);

  const [chRes, wdRes, rnRes, distCumRes, distByChRes] = mcResults;
  if (chRes.status === "failure" || wdRes.status === "failure" || rnRes.status === "failure") {
    throw new Error(`${Errors.ErrRpcReadFailed}: multicall returned failure for ${channelId}`);
  }

  const [balance, totalClaimed] = chRes.result as [bigint, bigint];
  const [, wdInitiatedAt] = wdRes.result as [bigint, bigint];
  const refundNonce = rnRes.result as bigint;

  return {
    channelState: {
      balance,
      totalClaimed,
      withdrawRequestedAt: Number(wdInitiatedAt),
      refundNonce,
    },
    distributedCumulative: distCumRes.status === "success" ? (distCumRes.result as bigint) : 0n,
    distributedByChannel: distByChRes.status === "success" ? (distByChRes.result as bigint) : 0n,
  };
}

/**
 * Verifies an aggregate voucher against a prefetched channel snapshot (no extra RPC).
 *
 * @param signer - Facilitator signer for signature verification.
 * @param payload - Voucher payload.
 * @param requirements - Gateway-bound payment requirements.
 * @param state - Prefetched channel state from {@link readGatewayVoucherOnchainSnapshot}.
 * @returns Verify response with channel state in `extra`.
 */
async function verifyGatewayAggregateVoucher(
  signer: FacilitatorEvmSigner,
  payload: BatchSettlementVoucherPayload,
  requirements: PaymentRequirements,
  state: ChannelState,
): Promise<VerifyResponse> {
  const { voucher, channelConfig } = payload;
  const channelId = voucher.channelId;

  const configErr = validateChannelConfig(channelConfig, channelId, requirements);
  if (configErr) {
    return { isValid: false, invalidReason: configErr, payer: channelConfig.payer };
  }

  const voucherOk = await verifyBatchSettlementVoucherTypedData(
    signer,
    {
      channelId,
      maxClaimableAmount: voucher.maxClaimableAmount,
      payerAuthorizer: channelConfig.payerAuthorizer,
      payer: channelConfig.payer,
      signature: voucher.signature,
    },
    getEvmChainId(requirements.network),
  );
  if (!voucherOk) {
    return {
      isValid: false,
      invalidReason: Errors.ErrInvalidVoucherSignature,
      payer: channelConfig.payer,
    };
  }

  if (state.balance === 0n) {
    return { isValid: false, invalidReason: Errors.ErrChannelNotFound, payer: channelConfig.payer };
  }

  const maxClaimableAmount = BigInt(voucher.maxClaimableAmount);
  if (maxClaimableAmount > state.balance) {
    return {
      isValid: false,
      invalidReason: Errors.ErrCumulativeExceedsBalance,
      payer: channelConfig.payer,
    };
  }
  if (maxClaimableAmount <= state.totalClaimed) {
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

/**
 * Verifies a gateway deposit or voucher payment payload.
 *
 * Voucher verify packs channel + gateway view reads into one Multicall3 and runs
 * aggregate voucher checks against that snapshot (no second channel read).
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
  const validated = validateGatewayExtensionFields(
    extension,
    info,
    requirements,
    channelId,
    raw.channelConfig.receiver,
    raw.channelConfig.receiverAuthorizer,
    raw.channelConfig.withdrawDelay,
  );
  if (!validated.ok) return validated.response;

  const { gateway, gatewayConfig, gatewayVoucher } = validated;

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

  const boundRequirements = gatewayBoundRequirements(requirements, gateway);

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

    let snapshot: GatewayVoucherOnchainSnapshot;
    try {
      snapshot = await readGatewayVoucherOnchainSnapshot(
        extension.signer,
        gateway,
        channelId,
        gatewayConfig.receiver,
      );
    } catch {
      return {
        isValid: false,
        invalidReason: Errors.ErrRpcReadFailed,
        payer: raw.channelConfig.payer,
      };
    }

    const distributedCumulative = snapshot.distributedCumulative.toString();

    // Onchain floor first (gateway analog of cumulative_below_claimed).
    if (BigInt(gatewayVoucher.maxClaimableAmount) <= snapshot.distributedCumulative) {
      return buildCorrectiveVerifyResponse(
        extension.signer,
        storage,
        GwErrors.ErrReceiverCumulativeBelowDistributed,
        raw.channelConfig.payer,
        channelId,
        gateway,
        gatewayConfig,
        gatewayVoucher,
        distributedCumulative,
        prior,
        snapshot.channelState,
      );
    }

    const priorCharged = BigInt(prior?.chargedCumulativeAmount ?? "0");
    const expectedCeiling = priorCharged + BigInt(requirements.amount);
    if (BigInt(gatewayVoucher.maxClaimableAmount) !== expectedCeiling) {
      return buildCorrectiveVerifyResponse(
        extension.signer,
        storage,
        GwErrors.ErrCumulativeMismatch,
        raw.channelConfig.payer,
        channelId,
        gateway,
        gatewayConfig,
        gatewayVoucher,
        distributedCumulative,
        prior,
        snapshot.channelState,
      );
    }

    // Accounting exclusivity: base totalClaimed must equal gateway distributedByChannel.
    if (
      snapshot.channelState.balance > 0n &&
      snapshot.channelState.totalClaimed !== snapshot.distributedByChannel
    ) {
      return {
        isValid: false,
        invalidReason: GwErrors.ErrAccountingMismatch,
        payer: raw.channelConfig.payer,
      };
    }

    const base = await verifyGatewayAggregateVoucher(
      extension.signer,
      raw,
      boundRequirements,
      snapshot.channelState,
    );
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

  // Deposit path: soft-read distributedCumulative only; verifyDeposit owns further RPCs.
  const distributedCumulative = await readDistributedCumulativeSoft(
    extension.signer,
    gateway,
    channelId,
    gatewayConfig.receiver,
  );

  if (BigInt(gatewayVoucher.maxClaimableAmount) <= BigInt(distributedCumulative)) {
    return buildCorrectiveVerifyResponse(
      extension.signer,
      storage,
      GwErrors.ErrReceiverCumulativeBelowDistributed,
      raw.channelConfig.payer,
      channelId,
      gateway,
      gatewayConfig,
      gatewayVoucher,
      distributedCumulative,
      prior,
    );
  }

  const priorCharged = BigInt(prior?.chargedCumulativeAmount ?? "0");
  const expectedCeiling = priorCharged + BigInt(requirements.amount);
  if (BigInt(gatewayVoucher.maxClaimableAmount) !== expectedCeiling) {
    return buildCorrectiveVerifyResponse(
      extension.signer,
      storage,
      GwErrors.ErrCumulativeMismatch,
      raw.channelConfig.payer,
      channelId,
      gateway,
      gatewayConfig,
      gatewayVoucher,
      distributedCumulative,
      prior,
    );
  }

  // Accounting exclusivity before deposit (channel may not exist yet).
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

  const base = await verifyDeposit(
    extension.signer,
    payload,
    raw,
    boundRequirements,
    context,
    extension.eip6492AllowedFactories,
  );
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
 * Builds a corrective verify failure for stale per-server cumulatives.
 *
 * Used for both `cumulative_mismatch` and `receiver_cumulative_below_distributed`.
 * Nested `extra.channelState` / `extra.voucherState` match the client-facing 402 shape
 * so the resource server can forward them unchanged.
 *
 * @param signer - Facilitator signer for onchain reads.
 * @param storage - Gateway storage.
 * @param invalidReason - Corrective error code.
 * @param payer - Client payer address.
 * @param channelId - Channel id.
 * @param gateway - Gateway address.
 * @param gatewayConfig - Gateway config.
 * @param gatewayVoucher - Submitted gateway voucher (provides gatewayId).
 * @param distributedCumulative - Onchain distributed cumulative.
 * @param prior - Prior stored commitment, if any.
 * @param prefetchedChannelState - Optional channel state from a prior multicall.
 * @returns Invalid verify response with gateway extension snapshot.
 */
async function buildCorrectiveVerifyResponse(
  signer: FacilitatorEvmSigner,
  storage: GatewayChannelStorage,
  invalidReason: string,
  payer: `0x${string}`,
  channelId: `0x${string}`,
  gateway: `0x${string}`,
  gatewayConfig: GatewayConfig,
  gatewayVoucher: GatewayVoucherFields,
  distributedCumulative: string,
  prior: Awaited<ReturnType<GatewayChannelStorage["getServerCommitment"]>>,
  prefetchedChannelState?: ChannelState,
): Promise<VerifyResponse> {
  const aggregate = await storage.getAggregate(channelId);
  const aggregateCharged = await storage.getAggregateCharged(channelId);

  let channelState: Record<string, unknown> | undefined;
  try {
    const state = prefetchedChannelState ?? (await readChannelState(signer, channelId));
    channelState = {
      channelId,
      balance: state.balance.toString(),
      totalClaimed: state.totalClaimed.toString(),
      withdrawRequestedAt: state.withdrawRequestedAt,
      refundNonce: state.refundNonce.toString(),
      chargedCumulativeAmount: aggregateCharged,
    };
  } catch {
    // Channel may not exist onchain yet.
  }

  const voucherState = aggregate
    ? {
        signedMaxClaimable: aggregate.voucher.maxClaimableAmount,
        signature: aggregate.voucher.signature,
      }
    : undefined;

  return {
    isValid: false,
    invalidReason,
    payer,
    extra: {
      ...(channelState ? { channelState } : {}),
      ...(voucherState ? { voucherState } : {}),
    },
    extensions: {
      "voucher-gateway": {
        info: {
          gateway,
          gatewayConfig,
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
        },
      },
    },
  };
}
