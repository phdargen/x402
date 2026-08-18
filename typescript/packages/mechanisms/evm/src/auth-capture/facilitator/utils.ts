import { BaseError, ContractFunctionRevertedError, type Log } from "viem";
import type { FacilitatorEvmSigner } from "../../signer";
import { ESCROW_ABI_WITH_ERRORS, ESCROW_VIEW_ABI } from "../abi";
import { AUTH_CAPTURE_ESCROW_ADDRESS } from "../constants";
import type { AuthCaptureCollectPayload, PaymentState } from "../types";
import { isEip3009Payload } from "../types";
import { ESCROW_ERROR_TO_INVALID_REASON, ErrSimulationFailed } from "../errors";

export const SAFETY_MARGIN_SECONDS = 6;

export const RECEIPT_TIMEOUT_MS = 60_000;

/** Backoff delays between paymentState eth_call retries (RPC index lag after authorize). */
export const PAYMENT_STATE_RETRY_DELAYS_MS = [200, 400, 800, 1600] as const;

/** Initial read plus one attempt per retry delay. */
export const PAYMENT_STATE_MAX_ATTEMPTS = PAYMENT_STATE_RETRY_DELAYS_MS.length + 1;

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
  options?: { gas?: bigint; dataSuffix?: `0x${string}` },
): Promise<
  { txHash: `0x${string}`; logs?: readonly Log[] } | { error: string; txHash?: `0x${string}` }
> {
  try {
    const txHash = await signer.writeContract({
      address: target,
      abi: ESCROW_ABI_WITH_ERRORS,
      functionName,
      args,
      gas: options?.gas,
      dataSuffix: options?.dataSuffix,
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
    return { txHash, logs: receipt.logs };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Settlement failed" };
  }
}

/**
 * Normalize viem `paymentState` return shapes to a flat PaymentState.
 *
 * @param raw - Value from `readContract(paymentState)`.
 * @returns Parsed state, or undefined when unrecognized.
 */
export function normalizePaymentState(raw: unknown): PaymentState | undefined {
  if (raw === null || raw === undefined) return undefined;

  if (typeof raw === "object" && !Array.isArray(raw) && "state" in raw) {
    return normalizePaymentState((raw as { state: unknown }).state);
  }

  if (Array.isArray(raw)) {
    if (raw.length < 3) return undefined;
    return {
      hasCollectedPayment: Boolean(raw[0]),
      capturableAmount: BigInt(raw[1] as bigint | number | string),
      refundableAmount: BigInt(raw[2] as bigint | number | string),
    };
  }

  if (typeof raw === "object") {
    const s = raw as Record<string, unknown>;
    if (
      s.capturableAmount === undefined &&
      s.refundableAmount === undefined &&
      s.hasCollectedPayment === undefined
    ) {
      return undefined;
    }
    return {
      hasCollectedPayment: Boolean(s.hasCollectedPayment),
      capturableAmount: BigInt(s.capturableAmount as bigint | number | string),
      refundableAmount: BigInt(s.refundableAmount as bigint | number | string),
    };
  }

  return undefined;
}

/**
 * Read AuthCaptureEscrow.paymentState once.
 *
 * @param signer - Facilitator signer.
 * @param paymentInfoHash - Escrow payment identifier.
 * @returns Onchain balances, or undefined when the read fails.
 */
export async function readPaymentStateOnce(
  signer: FacilitatorEvmSigner,
  paymentInfoHash: `0x${string}`,
): Promise<PaymentState | undefined> {
  try {
    const raw = await signer.readContract({
      address: AUTH_CAPTURE_ESCROW_ADDRESS,
      abi: ESCROW_VIEW_ABI,
      functionName: "paymentState",
      args: [paymentInfoHash],
    });
    return normalizePaymentState(raw);
  } catch {
    return undefined;
  }
}

/**
 * Delay for a fixed duration (paymentState RPC retry backoff).
 *
 * @param ms - Sleep duration in milliseconds.
 * @returns A promise that resolves after `ms`.
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Compare onchain paymentState balances to signed lifecycle expectations.
 *
 * @param state - Escrow paymentState read from chain.
 * @param expectedCapturable - Signed expected capturable balance.
 * @param expectedRefundable - Signed expected refundable balance.
 * @returns True when both balances match exactly.
 */
function paymentStateBalancesMatch(
  state: PaymentState,
  expectedCapturable: bigint,
  expectedRefundable: bigint,
): boolean {
  return (
    state.capturableAmount === expectedCapturable && state.refundableAmount === expectedRefundable
  );
}

/**
 * Detect empty paymentState that likely reflects RPC index lag after authorize.
 *
 * @param state - Escrow paymentState read from chain.
 * @param expectedCapturable - Signed expected capturable balance.
 * @returns True when the read looks like a stale zero state despite an expected hold.
 */
function isLikelyStalePaymentState(state: PaymentState, expectedCapturable: bigint): boolean {
  return (
    expectedCapturable > 0n &&
    !state.hasCollectedPayment &&
    state.capturableAmount === 0n &&
    state.refundableAmount === 0n
  );
}

/**
 * Read paymentState with exponential backoff when the RPC may not yet reflect a fresh authorize.
 *
 * @param signer - Facilitator signer.
 * @param paymentInfoHash - Escrow payment identifier.
 * @param expectedCapturable - Signed expected capturable balance.
 * @param expectedRefundable - Signed expected refundable balance.
 * @returns Parsed state and read metadata.
 */
export async function readPaymentStateForBalances(
  signer: FacilitatorEvmSigner,
  paymentInfoHash: `0x${string}`,
  expectedCapturable: bigint,
  expectedRefundable: bigint,
): Promise<{ state?: PaymentState; readFailed: boolean; attempts: number }> {
  for (let attempt = 0; ; attempt++) {
    const state = await readPaymentStateOnce(signer, paymentInfoHash);

    if (state && paymentStateBalancesMatch(state, expectedCapturable, expectedRefundable)) {
      return { state, readFailed: false, attempts: attempt + 1 };
    }

    if (state && !isLikelyStalePaymentState(state, expectedCapturable)) {
      return { state, readFailed: false, attempts: attempt + 1 };
    }

    if (attempt === PAYMENT_STATE_RETRY_DELAYS_MS.length) {
      return { readFailed: true, attempts: attempt + 1 };
    }

    await sleep(PAYMENT_STATE_RETRY_DELAYS_MS[attempt]!);
  }
}
