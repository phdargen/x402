import type {
  FacilitatorContext,
  FacilitatorExtension,
  Network,
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import { getAddress } from "viem";
import type { FacilitatorEvmSigner } from "../../../signer";
import { VOUCHER_GATEWAY } from "../constants";
import type { VoucherGatewaySupportedInfo } from "../types";
import { GatewayChannelManager } from "./channelManager";
import {
  InMemoryGatewayChannelStorage,
  type GatewayChannelStorage,
  type GatewayFacilitatorDeps,
} from "./storage";
import { settleGatewayPayment } from "./settle";
import { verifyGatewayPayment } from "./verify";

export interface CreateVoucherGatewayFacilitatorExtensionConfig {
  /** Gateway contract address operated by this facilitator. */
  gateway: `0x${string}`;
  /** Facilitator withdrawDelay policy (seconds), advertised via /supported extensionInfo. */
  withdrawDelay: number;
  /** Optional persistent storage; defaults to in-memory. */
  storage?: GatewayChannelStorage;
  /** Optional ERC-6492 factory allowlist for counterfactual deposits. */
  eip6492AllowedFactories?: string[];
}

/**
 * Facilitator extension for voucher-gateway: owns gateway policy, storage, verify/settle,
 * and the async ChannelManager redemption loop.
 */
export interface VoucherGatewayFacilitatorExtension extends FacilitatorExtension {
  key: typeof VOUCHER_GATEWAY;
  readonly gateway: `0x${string}`;
  readonly withdrawDelay: number;
  readonly storage: GatewayChannelStorage;
  readonly eip6492AllowedFactories: string[];
  getSupportedInfo(network: Network): VoucherGatewaySupportedInfo;
  verify(
    signer: FacilitatorEvmSigner,
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    context?: FacilitatorContext,
  ): Promise<VerifyResponse>;
  settle(
    signer: FacilitatorEvmSigner,
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    context?: FacilitatorContext,
  ): Promise<SettleResponse>;
  createChannelManager(signer: FacilitatorEvmSigner, network: string): GatewayChannelManager;
}

/**
 * Creates the voucher-gateway facilitator extension.
 *
 * @param config - Gateway address, withdrawDelay, and optional storage.
 * @returns Extension ready for `facilitator.registerExtension(...)`.
 *
 * @example
 * ```typescript
 * const voucherGateway = createVoucherGatewayFacilitatorExtension({
 *   gateway,
 *   withdrawDelay: 900,
 *   storage,
 * });
 * facilitator
 *   .registerExtension(voucherGateway)
 *   .register(network, new BatchSettlementEvmScheme(evmSigner, authorizerSigner));
 * voucherGateway.createChannelManager(evmSigner, network).start({ distributeIntervalSecs: 60 });
 * ```
 */
export function createVoucherGatewayFacilitatorExtension(
  config: CreateVoucherGatewayFacilitatorExtensionConfig,
): VoucherGatewayFacilitatorExtension {
  const gateway = getAddress(config.gateway);
  const storage = config.storage ?? new InMemoryGatewayChannelStorage();
  const eip6492AllowedFactories = config.eip6492AllowedFactories ?? [];
  let channelManager: GatewayChannelManager | undefined;

  /**
   * Builds facilitator deps for verify/settle handlers.
   *
   * @param signer - Facilitator EVM signer.
   * @returns Gateway facilitator deps.
   */
  function deps(signer: FacilitatorEvmSigner): GatewayFacilitatorDeps {
    return {
      gateway,
      withdrawDelay: config.withdrawDelay,
      storage,
      signer,
      eip6492AllowedFactories,
    };
  }

  return {
    key: VOUCHER_GATEWAY,
    gateway,
    withdrawDelay: config.withdrawDelay,
    storage,
    eip6492AllowedFactories,
    getSupportedInfo(_: Network): VoucherGatewaySupportedInfo {
      return {
        gateway,
        withdrawDelay: config.withdrawDelay,
      };
    },
    verify(signer, payload, requirements, context) {
      return verifyGatewayPayment(deps(signer), payload, requirements, context);
    },
    settle(signer, payload, requirements, context) {
      return settleGatewayPayment(deps(signer), payload, requirements, context, receiver => {
        if (!channelManager) return Promise.resolve();
        return channelManager.distributeForReceiver(receiver);
      });
    },
    createChannelManager(signer: FacilitatorEvmSigner, network: string) {
      channelManager = new GatewayChannelManager(deps(signer), network);
      return channelManager;
    },
  };
}
