import { SettleResponse, Network } from "@x402/core/types";
import { getAddress } from "viem";
import { FacilitatorEvmSigner } from "../../signer";
import { DeferredSettleActionPayload } from "../types";
import { deferredEscrowABI } from "../abi";
import { DEFERRED_ESCROW_ADDRESS } from "../constants";
import * as Errors from "./errors";

/**
 * Executes settle on the escrow contract.
 * Transfers all claimed-but-unsettled funds to the service's current payTo address.
 *
 * @param signer - The facilitator EVM signer.
 * @param payload - The settle action payload with service id.
 * @param network - The network identifier for the response.
 * @returns Settlement outcome with transaction hash or error reason.
 */
export async function executeSettle(
  signer: FacilitatorEvmSigner,
  payload: DeferredSettleActionPayload,
  network: Network,
): Promise<SettleResponse> {
  try {
    const tx = await signer.writeContract({
      address: getAddress(DEFERRED_ESCROW_ADDRESS),
      abi: deferredEscrowABI,
      functionName: "settle",
      args: [payload.serviceId],
    });

    const receipt = await signer.waitForTransactionReceipt({ hash: tx });

    if (receipt.status !== "success") {
      return {
        success: false,
        errorReason: Errors.ErrSettleTransactionFailed,
        transaction: tx,
        network,
      };
    }

    return {
      success: true,
      transaction: tx,
      network,
    };
  } catch {
    return {
      success: false,
      errorReason: Errors.ErrSettleTransactionFailed,
      transaction: "",
      network,
    };
  }
}
