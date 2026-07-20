import type { PaymentRequirements } from "@x402/core/types";
import { getAddress } from "viem";
import type { EvmSchemeOptions } from "../../../shared/rpc";
import type {
  BatchSettlementDepositPolicy,
  BatchSettlementDepositStrategy,
} from "../../client/config";
import type { BatchSettlementClientDeps } from "../../client/channel";
import type { ChannelConfig } from "../../types";
import { MIN_WITHDRAW_DELAY } from "../../constants";
import type { GatewayClientStorage } from "./storage";

/** Runtime deps for gateway client payment construction and recovery. */
export interface GatewayClientPaymentDeps extends BatchSettlementClientDeps {
  gatewayStorage: GatewayClientStorage;
  depositPolicy?: BatchSettlementDepositPolicy;
  depositStrategy?: BatchSettlementDepositStrategy;
  extensionRpcOptions?: EvmSchemeOptions;
}

/**
 * Builds ChannelConfig for gateway mode: onchain receiver roles are the gateway.
 *
 * @param deps - Client identity inputs.
 * @param paymentRequirements - Server payment requirements.
 * @param gateway - Gateway contract address from the 402 extension.
 * @returns Channel config with gateway as receiver and receiverAuthorizer.
 */
export function buildGatewayChannelConfig(
  deps: BatchSettlementClientDeps,
  paymentRequirements: PaymentRequirements,
  gateway: `0x${string}`,
): ChannelConfig {
  const extra = paymentRequirements.extra as { withdrawDelay?: number } | undefined;
  return {
    payer: deps.signer.address,
    payerAuthorizer: getAddress(
      deps.payerAuthorizer ?? deps.voucherSigner?.address ?? deps.signer.address,
    ),
    receiver: getAddress(gateway),
    receiverAuthorizer: getAddress(gateway),
    token: paymentRequirements.asset as `0x${string}`,
    withdrawDelay:
      typeof extra?.withdrawDelay === "number" ? extra.withdrawDelay : MIN_WITHDRAW_DELAY,
    salt: deps.salt,
  };
}
