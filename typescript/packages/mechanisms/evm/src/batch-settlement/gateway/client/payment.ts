import type {
  PaymentPayloadContext,
  PaymentPayloadResult,
  PaymentRequirements,
} from "@x402/core/types";
import { getAddress } from "viem";
import {
  trySignEip2612PermitExtension,
  trySignErc20ApprovalExtension,
} from "../../../shared/extensions";
import { createBatchSettlementEIP3009DepositPayload } from "../../client/eip3009";
import { createBatchSettlementPermit2DepositPayload } from "../../client/permit2";
import {
  depositAmountForRequest,
  type BatchSettlementDepositStrategyContext,
} from "../../client/config";
import {
  BatchSettlementAssetTransferMethod,
  type BatchSettlementVoucherPayload,
  type ChannelConfig,
} from "../../types";
import { computeChannelId } from "../../utils";
import { VOUCHER_GATEWAY } from "../constants";
import type { GatewayConfig, VoucherGatewayExtensionInfo } from "../types";
import { computeGatewayId, readVoucherGatewayInfo, signGatewayVoucher } from "../utils";
import { buildGatewayChannelConfig, type GatewayClientPaymentDeps } from "./deps";
import { recoverGatewayChannel } from "./recovery";

export { buildGatewayChannelConfig, type GatewayClientPaymentDeps } from "./deps";

/**
 * Creates a gateway-mode payment payload (deposit or voucher) with voucher-gateway extension.
 *
 * @param deps - Client deps including gateway storage.
 * @param x402Version - Protocol version.
 * @param paymentRequirements - Selected payment requirements.
 * @param context - Payload context containing PaymentRequired extensions.
 * @returns Payment payload result with voucher-gateway extension attached.
 */
export async function createGatewayPaymentPayload(
  deps: GatewayClientPaymentDeps,
  x402Version: number,
  paymentRequirements: PaymentRequirements,
  context?: PaymentPayloadContext,
): Promise<PaymentPayloadResult> {
  const info = readVoucherGatewayInfo(context?.extensions);
  if (!info?.gateway) {
    throw new Error("voucher-gateway extension requires info.gateway");
  }
  const gateway = getAddress(info.gateway);

  const receiverAuthorizer = paymentRequirements.extra?.receiverAuthorizer;
  if (typeof receiverAuthorizer !== "string") {
    throw new Error("Payment requirements must include extra.receiverAuthorizer");
  }

  const config = buildGatewayChannelConfig(deps, paymentRequirements, gateway);
  const channelId = computeChannelId(config, paymentRequirements.network);
  const key = channelId.toLowerCase();

  let channelCtx = await deps.gatewayStorage.get(key);
  if (
    (channelCtx === undefined ||
      channelCtx.balance === undefined ||
      channelCtx.servers[getAddress(paymentRequirements.payTo).toLowerCase()] === undefined) &&
    deps.signer.readContract
  ) {
    channelCtx = await recoverGatewayChannel(deps, paymentRequirements, gateway);
  }
  channelCtx = channelCtx ?? { servers: {} };

  const serverKey = getAddress(paymentRequirements.payTo).toLowerCase();
  const serverCharged = BigInt(channelCtx.servers[serverKey]?.chargedCumulativeAmount ?? "0");
  const requestAmount = BigInt(paymentRequirements.amount);
  const gatewayMaxClaimable = (serverCharged + requestAmount).toString();

  const gatewayConfig: GatewayConfig = {
    channelId,
    receiver: getAddress(paymentRequirements.payTo),
    receiverAuthorizer: getAddress(receiverAuthorizer),
  };
  const gatewayId = computeGatewayId(gatewayConfig, paymentRequirements.network, gateway);

  const voucherSigner = deps.voucherSigner ?? deps.signer;
  const gatewayVoucher = await signGatewayVoucher(
    params =>
      voucherSigner.signTypedData({
        domain: params.domain,
        types: params.types,
        primaryType: params.primaryType,
        message: params.message,
      }),
    gatewayId,
    gatewayMaxClaimable,
    paymentRequirements.network,
    gateway,
  );

  const extensionInfo: VoucherGatewayExtensionInfo = {
    gateway,
    gatewayConfig,
    gatewayVoucher,
  };

  const needsInitialDeposit = !channelCtx.balance || channelCtx.balance === "0";
  const missingAggregate = !channelCtx.aggregateMaxClaimable || !channelCtx.aggregateSignature;
  const currentBalance = BigInt(channelCtx.balance ?? "0");
  // Top-up when aggregate charged + headroom would exceed balance; use aggregate ceiling.
  const aggregateCharged = BigInt(channelCtx.aggregateChargedCumulativeAmount ?? "0");
  const needsTopUp = !needsInitialDeposit && aggregateCharged + requestAmount > currentBalance;
  // After onchain recovery without a stored deposit-signed aggregate, re-deposit to refresh it.
  const needsAggregateRefresh = !needsInitialDeposit && missingAggregate;

  if (needsInitialDeposit || needsTopUp || needsAggregateRefresh) {
    const postDepositBalanceNeeded = needsInitialDeposit
      ? requestAmount // at least cover this request; deposit policy may deposit more
      : aggregateCharged + requestAmount;
    const minimumDepositAmount = postDepositBalanceNeeded - currentBalance;
    const computedDeposit = depositAmountForRequest(
      deps.depositPolicy,
      minimumDepositAmount > 0n ? minimumDepositAmount : requestAmount,
    );

    const strategyContext: BatchSettlementDepositStrategyContext = {
      paymentRequirements,
      channelConfig: config,
      channelId,
      clientContext: {
        balance: channelCtx.balance,
        totalClaimed: channelCtx.totalClaimed,
        chargedCumulativeAmount: channelCtx.aggregateChargedCumulativeAmount,
      },
      requestAmount: requestAmount.toString(),
      maxClaimableAmount: postDepositBalanceNeeded.toString(),
      currentBalance: currentBalance.toString(),
      minimumDepositAmount: (minimumDepositAmount > 0n ? minimumDepositAmount : 0n).toString(),
      depositAmount: computedDeposit,
    };

    let depositAmount = computedDeposit;
    const strategyResult = await deps.depositStrategy?.(strategyContext);
    if (strategyResult === false) {
      return createGatewayVoucherOnlyPayload(
        deps,
        x402Version,
        paymentRequirements,
        config,
        channelId,
        channelCtx,
        extensionInfo,
      );
    }
    if (strategyResult !== undefined) {
      depositAmount =
        typeof strategyResult === "bigint" ? strategyResult.toString() : strategyResult;
    }

    const postDepositBalance = (currentBalance + BigInt(depositAmount)).toString();

    const assetTransferMethod =
      (paymentRequirements.extra?.assetTransferMethod as BatchSettlementAssetTransferMethod) ??
      "eip3009";

    let result: PaymentPayloadResult;
    if (assetTransferMethod === "eip3009") {
      result = await createBatchSettlementEIP3009DepositPayload(
        deps.signer,
        x402Version,
        paymentRequirements,
        config,
        depositAmount,
        postDepositBalance,
        deps.voucherSigner,
      );
    } else if (assetTransferMethod === "permit2") {
      result = await createBatchSettlementPermit2DepositPayload(
        deps.signer,
        x402Version,
        paymentRequirements,
        config,
        depositAmount,
        postDepositBalance,
        deps.voucherSigner,
      );

      const eip2612Extensions = await trySignEip2612PermitExtension(
        deps.signer,
        deps.extensionRpcOptions,
        paymentRequirements,
        result,
        context,
        depositAmount,
      );
      if (eip2612Extensions) {
        result = { ...result, extensions: eip2612Extensions };
      } else {
        const erc20Extensions = await trySignErc20ApprovalExtension(
          deps.signer,
          deps.extensionRpcOptions,
          paymentRequirements,
          context,
          depositAmount,
        );
        if (erc20Extensions) {
          result = { ...result, extensions: erc20Extensions };
        }
      }
    } else {
      throw new Error(`unsupported batch-settlement assetTransferMethod: ${assetTransferMethod}`);
    }

    // Persist pending aggregate fields locally after we sign (response will confirm).
    channelCtx = {
      ...channelCtx,
      aggregateMaxClaimable: postDepositBalance,
      servers: channelCtx.servers,
    };
    await deps.gatewayStorage.set(key, channelCtx);

    return attachGatewayExtension(result, extensionInfo);
  }

  return createGatewayVoucherOnlyPayload(
    deps,
    x402Version,
    paymentRequirements,
    config,
    channelId,
    channelCtx,
    extensionInfo,
  );
}

/**
 * Builds a steady-state voucher payload echoing the last deposit-signed aggregate.
 *
 * @param deps - Client deps.
 * @param x402Version - Protocol version.
 * @param paymentRequirements - Payment requirements.
 * @param config - Gateway channel config.
 * @param channelId - Channel id.
 * @param channelCtx - Local gateway channel state.
 * @param channelCtx.aggregateMaxClaimable - Deposit aggregate ceiling from prior deposit.
 * @param channelCtx.aggregateSignature - Deposit aggregate signature from prior deposit.
 * @param extensionInfo - Gateway extension info with fresh GatewayVoucher.
 * @returns Voucher-only payment payload result.
 */
async function createGatewayVoucherOnlyPayload(
  deps: GatewayClientPaymentDeps,
  x402Version: number,
  paymentRequirements: PaymentRequirements,
  config: ChannelConfig,
  channelId: `0x${string}`,
  channelCtx: { aggregateMaxClaimable?: string; aggregateSignature?: `0x${string}` },
  extensionInfo: VoucherGatewayExtensionInfo,
): Promise<PaymentPayloadResult> {
  if (!channelCtx.aggregateMaxClaimable || !channelCtx.aggregateSignature) {
    throw new Error(
      "gateway voucher requires a prior deposit-signed aggregate voucher in client storage",
    );
  }

  const payload: BatchSettlementVoucherPayload = {
    type: "voucher",
    channelConfig: config,
    voucher: {
      channelId,
      maxClaimableAmount: channelCtx.aggregateMaxClaimable,
      signature: channelCtx.aggregateSignature,
    },
  };

  return attachGatewayExtension({ x402Version, payload }, extensionInfo);
}

/**
 * Merges voucher-gateway extension info onto a payment payload result.
 *
 * @param result - Base payment payload result.
 * @param info - Gateway extension info.
 * @returns Result with voucher-gateway extension.
 */
function attachGatewayExtension(
  result: PaymentPayloadResult,
  info: VoucherGatewayExtensionInfo,
): PaymentPayloadResult {
  return {
    ...result,
    extensions: {
      ...(result.extensions ?? {}),
      [VOUCHER_GATEWAY]: { info },
    },
  };
}
