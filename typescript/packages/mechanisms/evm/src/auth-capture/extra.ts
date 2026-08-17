import { getAddress, isAddress, isAddressEqual, zeroAddress } from "viem";
import type { PaymentRequirements } from "@x402/core/types";
import { getEvmChainId } from "../utils";
import { extraAddress, isNonZeroAddress } from "./nonce";
import type {
  AuthCaptureCaptureMode,
  AuthCaptureExtra,
  AuthCaptureFacilitatorConfig,
  AuthCapturePaymentFlow,
  OperatorAllowlistEntry,
} from "./types";
import { isAuthCaptureExtra } from "./types";
import * as Errors from "./errors";

const MAX_FEE_BPS = 10_000;

export type NormalizedAuthCaptureExtra = AuthCaptureExtra & {
  paymentFlow: AuthCapturePaymentFlow;
  operatorType: "delegated" | "custom";
  assetTransferMethod: "eip3009" | "permit2";
  receiverAuthorizer: `0x${string}`;
  policy: `0x${string}`;
  captureMode: AuthCaptureCaptureMode;
};

/**
 * Parse and validate `requirements.extra` into a normalized form with defaults
 * applied. Returns a stable invalidReason on any spec violation.
 *
 * @param extra - Untrusted `requirements.extra`.
 * @returns Normalized extra, or an error code.
 */
export function parseAuthCaptureExtra(
  extra: unknown,
): { extra: NormalizedAuthCaptureExtra } | { error: string } {
  if (!isAuthCaptureExtra(extra)) {
    return { error: Errors.ErrInvalidAuthCaptureExtra };
  }
  const raw = extra as AuthCaptureExtra & { autoCapture?: unknown };

  if (raw.autoCapture === true) {
    return { error: Errors.ErrUnsupportedPaymentFlow };
  }

  const paymentFlow = raw.paymentFlow ?? "escrow";
  if (paymentFlow !== "escrow" && paymentFlow !== "authorization") {
    return { error: Errors.ErrUnsupportedPaymentFlow };
  }

  const captureMode = raw.captureMode ?? "sync";
  if (captureMode !== "sync" && captureMode !== "deferred") {
    return { error: Errors.ErrInvalidAuthCaptureExtra };
  }

  const operatorType = raw.operatorType ?? "delegated";
  if (operatorType === "policy") {
    return { error: Errors.ErrUnsupportedOperatorType };
  }
  if (operatorType !== "delegated" && operatorType !== "custom") {
    return { error: Errors.ErrUnsupportedOperatorType };
  }

  const assetTransferMethod = raw.assetTransferMethod ?? "eip3009";
  if (assetTransferMethod !== "eip3009" && assetTransferMethod !== "permit2") {
    return { error: Errors.ErrUnsupportedAssetTransferMethod };
  }

  if (
    !Number.isInteger(raw.minFeeBps) ||
    !Number.isInteger(raw.maxFeeBps) ||
    raw.minFeeBps < 0 ||
    raw.maxFeeBps < 0 ||
    raw.minFeeBps > MAX_FEE_BPS ||
    raw.maxFeeBps > MAX_FEE_BPS
  ) {
    return { error: Errors.ErrInvalidAuthCaptureExtra };
  }
  if (raw.minFeeBps > raw.maxFeeBps) {
    return { error: Errors.ErrInvalidAuthCaptureExtra };
  }

  if (!isAddress(raw.captureAuthorizer) || !isAddress(raw.feeRecipient)) {
    return { error: Errors.ErrInvalidAuthCaptureExtra };
  }

  const feeRecipient = getAddress(raw.feeRecipient);
  if (isAddressEqual(feeRecipient, zeroAddress) && (raw.minFeeBps !== 0 || raw.maxFeeBps !== 0)) {
    return { error: Errors.ErrInvalidAuthCaptureExtra };
  }

  return {
    extra: {
      ...raw,
      captureAuthorizer: getAddress(raw.captureAuthorizer),
      feeRecipient,
      paymentFlow,
      captureMode,
      operatorType,
      assetTransferMethod,
      receiverAuthorizer: extraAddress(raw.receiverAuthorizer),
      policy: extraAddress(raw.policy),
    },
  };
}

/**
 * Validate submitted feeBps / feeReceiver against the client-signed extra bounds.
 *
 * @param extra - Normalized extra.
 * @param feeBps - Fee submitted with charge/capture.
 * @param feeReceiver - Fee recipient submitted with charge/capture.
 * @returns An error code, or undefined when valid.
 */
export function validateSubmittedFee(
  extra: NormalizedAuthCaptureExtra,
  feeBps: number,
  feeReceiver: `0x${string}`,
): string | undefined {
  if (!Number.isInteger(feeBps) || feeBps < extra.minFeeBps || feeBps > extra.maxFeeBps) {
    return Errors.ErrFeeBpsOutOfRange;
  }
  if (!isAddress(feeReceiver)) {
    return Errors.ErrInvalidFeeReceiver;
  }
  const receiver = getAddress(feeReceiver);
  if (!isAddressEqual(extra.feeRecipient, zeroAddress)) {
    if (!isAddressEqual(receiver, extra.feeRecipient)) {
      return Errors.ErrInvalidFeeReceiver;
    }
  } else if (isAddressEqual(receiver, zeroAddress) && feeBps !== 0) {
    return Errors.ErrZeroFeeReceiver;
  }
  return undefined;
}

/**
 * Default feeBps / feeReceiver when no authorizer signature covers the call:
 * the equal-bound value (or minFeeBps) and extra.feeRecipient.
 *
 * @param extra - Normalized extra.
 * @returns Fee parameters to submit with charge.
 */
export function defaultSubmittedFee(extra: NormalizedAuthCaptureExtra): {
  feeBps: number;
  feeReceiver: `0x${string}`;
} {
  return { feeBps: extra.minFeeBps, feeReceiver: extra.feeRecipient };
}

/**
 * Check operator-type, policy, allowlist, and lifecycle-relay rules.
 *
 * @param extra - Normalized extra.
 * @param submitters - Facilitator signer addresses.
 * @param config - Facilitator config (allowlist).
 * @param isLifecycle - True when the payload is capture/void/refund.
 * @returns An error code, or undefined when admitted.
 */
export function validateOperator(
  extra: NormalizedAuthCaptureExtra,
  submitters: readonly `0x${string}`[],
  config: AuthCaptureFacilitatorConfig | undefined,
  isLifecycle: boolean,
): string | undefined {
  if (isNonZeroAddress(extra.policy)) {
    return Errors.ErrInvalidPolicy;
  }

  if (extra.operatorType === "custom") {
    if (!isOperatorAdmitted(extra.captureAuthorizer, config?.operators)) {
      return Errors.ErrOperatorNotAdmitted;
    }
    if (isLifecycle) {
      return Errors.ErrLifecycleNotRelayed;
    }
    return undefined;
  }

  // delegated
  if (!isSubmitter(extra.captureAuthorizer, submitters)) {
    return Errors.ErrOperatorNotAdmitted;
  }
  if (isLifecycle && !isNonZeroAddress(extra.receiverAuthorizer)) {
    return Errors.ErrLifecycleNotRelayed;
  }
  return undefined;
}

/**
 * Whether `address` is one of the facilitator's submitters.
 *
 * @param address - Candidate operator address.
 * @param submitters - Facilitator signer addresses.
 * @returns True when the address is a submitter.
 */
function isSubmitter(address: `0x${string}`, submitters: readonly `0x${string}`[]): boolean {
  return submitters.some(s => isAddressEqual(s, address));
}

/**
 * Whether a custom operator is on the facilitator's allowlist.
 *
 * @param address - extra.captureAuthorizer.
 * @param operators - Allowlist from facilitator config.
 * @returns True when admitted as `"custom"`.
 */
function isOperatorAdmitted(
  address: `0x${string}`,
  operators: OperatorAllowlistEntry[] | undefined,
): boolean {
  if (!operators || operators.length === 0) return false;
  return operators.some(entry => {
    if (entry.operatorType !== "custom") return false;
    if (entry.address === "*") return true;
    return isAddress(entry.address) && isAddressEqual(entry.address, address);
  });
}

/**
 * Resolve the onchain target for a settle call from operatorType, not bytecode.
 * `"delegated"` always calls the canonical escrow; `"custom"` calls
 * extra.captureAuthorizer.
 *
 * @param extra - Normalized extra.
 * @param escrowAddress - Canonical AuthCaptureEscrow address.
 * @returns Address to pass to writeContract / simulate.
 */
export function resolveSettleTarget(
  extra: NormalizedAuthCaptureExtra,
  escrowAddress: `0x${string}`,
): `0x${string}` {
  return extra.operatorType === "custom" ? extra.captureAuthorizer : escrowAddress;
}

/**
 * Common scheme / network / extra / operator checks (spec verification
 * steps 2–5). Returns the normalized extra on success.
 *
 * @param payloadScheme - payload.accepted.scheme.
 * @param payloadNetwork - payload.accepted.network.
 * @param requirements - Published requirements.
 * @param scheme - Expected scheme id.
 * @param submitters - Facilitator signer addresses.
 * @param config - Facilitator config.
 * @param isLifecycle - True for capture/void/refund payloads.
 * @returns Normalized extra, or an invalidReason.
 */
export function verifyCommon(
  payloadScheme: string,
  payloadNetwork: string,
  requirements: PaymentRequirements,
  scheme: string,
  submitters: readonly `0x${string}`[],
  config: AuthCaptureFacilitatorConfig | undefined,
  isLifecycle: boolean,
): { extra: NormalizedAuthCaptureExtra } | { error: string } {
  if (payloadScheme !== scheme || requirements.scheme !== scheme) {
    return { error: Errors.ErrUnsupportedScheme };
  }
  if (payloadNetwork !== requirements.network) {
    return { error: Errors.ErrNetworkMismatch };
  }
  try {
    getEvmChainId(requirements.network);
  } catch {
    return { error: Errors.ErrInvalidNetwork };
  }
  const parsed = parseAuthCaptureExtra(requirements.extra);
  if ("error" in parsed) {
    return parsed;
  }
  const operatorError = validateOperator(parsed.extra, submitters, config, isLifecycle);
  if (operatorError) {
    return { error: operatorError };
  }
  return parsed;
}
