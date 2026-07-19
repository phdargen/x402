import type { PaymentRequirements, SettleResponse } from "@x402/core/types";
import { getAddress } from "viem";
import { batchSettlementGatewayABI } from "../abi";
import * as GwErrors from "../errors";
import type { GatewayFacilitatorDeps } from "./storage";

/**
 * Calls gateway.withdraw(receiver, token) and returns the transferred amount.
 *
 * @param deps - Facilitator gateway deps.
 * @param receiver - Server payout address.
 * @param token - ERC-20 token address.
 * @param requirements - Payment requirements (network).
 * @returns Settle response with transferred amount.
 */
export async function executeGatewayWithdraw(
  deps: GatewayFacilitatorDeps,
  receiver: `0x${string}`,
  token: `0x${string}`,
  requirements: PaymentRequirements,
): Promise<SettleResponse> {
  const gateway = getAddress(deps.gateway);
  const receiverAddr = getAddress(receiver);
  const tokenAddr = getAddress(token);

  let amount = 0n;
  try {
    amount = (await deps.signer.readContract({
      address: gateway,
      abi: batchSettlementGatewayABI,
      functionName: "withdrawable",
      args: [receiverAddr, tokenAddr],
    })) as bigint;
  } catch (e) {
    return {
      success: false,
      errorReason: GwErrors.ErrWithdrawTransactionFailed,
      errorMessage: e instanceof Error ? e.message : String(e),
      transaction: "",
      network: requirements.network,
    };
  }

  if (amount === 0n) {
    return {
      success: true,
      transaction: "",
      network: requirements.network,
      amount: "0",
    };
  }

  try {
    await deps.signer.readContract({
      address: gateway,
      abi: batchSettlementGatewayABI,
      functionName: "withdraw",
      args: [receiverAddr, tokenAddr],
    });
  } catch (e) {
    return {
      success: false,
      errorReason: GwErrors.ErrWithdrawTransactionFailed,
      errorMessage: e instanceof Error ? e.message : String(e),
      transaction: "",
      network: requirements.network,
    };
  }

  try {
    const tx = await deps.signer.writeContract({
      address: gateway,
      abi: batchSettlementGatewayABI,
      functionName: "withdraw",
      args: [receiverAddr, tokenAddr],
    });
    const receipt = await deps.signer.waitForTransactionReceipt({ hash: tx });
    if (receipt.status !== "success") {
      return {
        success: false,
        errorReason: GwErrors.ErrWithdrawTransactionFailed,
        transaction: tx,
        network: requirements.network,
      };
    }
    return {
      success: true,
      transaction: tx,
      network: requirements.network,
      amount: amount.toString(),
    };
  } catch (e) {
    return {
      success: false,
      errorReason: GwErrors.ErrWithdrawTransactionFailed,
      errorMessage: e instanceof Error ? e.message : String(e),
      transaction: "",
      network: requirements.network,
    };
  }
}
