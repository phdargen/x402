import { BaseError, ContractFunctionRevertedError } from "viem";
import type { FacilitatorEvmSigner } from "../../signer";
import { ESCROW_ABI_WITH_ERRORS } from "../abi";
import type { AuthCaptureCollectPayload } from "../types";
import { isEip3009Payload } from "../types";
import { ESCROW_ERROR_TO_INVALID_REASON, ErrSimulationFailed } from "../errors";

export const SAFETY_MARGIN_SECONDS = 6;

export const RECEIPT_TIMEOUT_MS = 60_000;

/**
 * Walk a viem error chain looking for a decoded custom-error name, then map
 * known names to a stable `invalidReason` via `ESCROW_ERROR_TO_INVALID_REASON`.
 * Anything unmapped returns `ErrSimulationFailed` so the wire never leaks raw
 * selectors.
 *
 * @param err - The error thrown by `readContract` / `simulateContract`.
 * @returns A stable wire-level `invalidReason` string.
 */
export function decodeRevertReason(err: unknown): string {
  if (err instanceof BaseError) {
    const revert = err.walk(
      (e): e is ContractFunctionRevertedError => e instanceof ContractFunctionRevertedError,
    );
    if (revert instanceof ContractFunctionRevertedError) {
      const errorName = revert.data?.errorName;
      if (errorName && errorName in ESCROW_ERROR_TO_INVALID_REASON) {
        return ESCROW_ERROR_TO_INVALID_REASON[errorName];
      }
    }
  }
  return ErrSimulationFailed;
}

/**
 * Collect-payload payer address.
 *
 * @param wirePayload - EIP-3009 or Permit2 collect payload.
 * @returns The `from` address.
 */
export function collectPayer(wirePayload: AuthCaptureCollectPayload): `0x${string}` {
  return isEip3009Payload(wirePayload)
    ? wirePayload.authorization.from
    : wirePayload.permit2Authorization.from;
}

/**
 * Simulate an escrow call via `eth_call` as the facilitator submitter.
 *
 * @param signer - Facilitator signer.
 * @param target - Escrow or custom operator.
 * @param functionName - Escrow ABI function.
 * @param args - Encoded arguments.
 * @param account - msg.sender for the eth_call.
 * @returns `"ok"` or a stable invalidReason.
 */
export async function simulateEscrowCall(
  signer: FacilitatorEvmSigner,
  target: `0x${string}`,
  functionName: "authorize" | "charge" | "capture" | "void" | "refund",
  args: readonly unknown[],
  account: `0x${string}`,
): Promise<"ok" | string> {
  try {
    await signer.readContract({
      address: target,
      abi: ESCROW_ABI_WITH_ERRORS,
      functionName,
      args,
      account,
    });
    return "ok";
  } catch (err) {
    return decodeRevertReason(err);
  }
}

/**
 * Submit a write and wait up to 60s for a successful receipt.
 *
 * @param signer - Facilitator signer.
 * @param target - Contract to call.
 * @param functionName - Escrow ABI function.
 * @param args - Encoded arguments.
 * @returns Transaction hash, or a failure reason.
 */
export async function submitEscrowCall(
  signer: FacilitatorEvmSigner,
  target: `0x${string}`,
  functionName: "authorize" | "charge" | "capture" | "void" | "refund",
  args: readonly unknown[],
): Promise<{ txHash: `0x${string}` } | { error: string; txHash?: `0x${string}` }> {
  try {
    const txHash = await signer.writeContract({
      address: target,
      abi: ESCROW_ABI_WITH_ERRORS,
      functionName,
      args,
    });

    const receiptPromise = signer.waitForTransactionReceipt({ hash: txHash });
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error("Transaction receipt timeout after 60s")),
        RECEIPT_TIMEOUT_MS,
      ),
    );
    const receipt = await Promise.race([receiptPromise, timeoutPromise]);

    if (receipt.status !== "success") {
      return { error: "reverted", txHash };
    }
    return { txHash };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Settlement failed" };
  }
}
