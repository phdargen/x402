import { getAddress, keccak256 } from "viem";
import type { FacilitatorEvmSigner } from "../signer";
import { verifyTypedDataSignature } from "../shared/verifySignature";
import {
  CAPTURE_TYPES,
  CHARGE_TYPES,
  OPERATOR_EIP712_DOMAIN,
  REFUND_TYPES,
  VOID_TYPES,
} from "./constants";
import type { AuthorizerSigner } from "./types";

/**
 * EIP-712 domain for operator Charge/Void/Capture/Refund signatures.
 * `verifyingContract` is the capture authorizer so a signature is bound to
 * its operator by the domain as well as by `paymentInfoHash`.
 *
 * @param chainId - EVM chain id.
 * @param captureAuthorizer - extra.captureAuthorizer (PaymentInfo.operator).
 * @returns Domain fields for `signTypedData` / `verifyTypedData`.
 */
export function getOperatorEip712Domain(
  chainId: number,
  captureAuthorizer: `0x${string}`,
): {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: `0x${string}`;
} {
  return {
    name: OPERATOR_EIP712_DOMAIN.name,
    version: OPERATOR_EIP712_DOMAIN.version,
    chainId,
    verifyingContract: getAddress(captureAuthorizer),
  };
}

export type ChargeDigest = {
  paymentInfoHash: `0x${string}`;
  amount: bigint | string;
  tokenCollector: `0x${string}`;
  collectorData: `0x${string}`;
  feeBps: number;
  feeReceiver: `0x${string}`;
};

export type CaptureDigest = {
  paymentInfoHash: `0x${string}`;
  amount: bigint | string;
  feeBps: number;
  feeReceiver: `0x${string}`;
  expectedCapturableAmount: bigint | string;
  expectedRefundableAmount: bigint | string;
};

export type RefundDigest = {
  paymentInfoHash: `0x${string}`;
  amount: bigint | string;
  tokenCollector: `0x${string}`;
  expectedCapturableAmount: bigint | string;
  expectedRefundableAmount: bigint | string;
};

/**
 * Sign a Charge digest.
 *
 * @param signer - Receiver-authorizer signer.
 * @param chainId - EVM chain id.
 * @param captureAuthorizer - Domain verifyingContract.
 * @param digest - Charge parameters.
 * @returns EIP-712 signature.
 */
export async function signCharge(
  signer: AuthorizerSigner,
  chainId: number,
  captureAuthorizer: `0x${string}`,
  digest: ChargeDigest,
): Promise<`0x${string}`> {
  return signer.signTypedData({
    domain: getOperatorEip712Domain(chainId, captureAuthorizer),
    types: CHARGE_TYPES,
    primaryType: "Charge",
    message: chargeMessage(digest),
  });
}

/**
 * Sign a Void digest.
 *
 * @param signer - Receiver-authorizer signer.
 * @param chainId - EVM chain id.
 * @param captureAuthorizer - Domain verifyingContract.
 * @param paymentInfoHash - Escrow payment identifier.
 * @returns EIP-712 signature.
 */
export async function signVoid(
  signer: AuthorizerSigner,
  chainId: number,
  captureAuthorizer: `0x${string}`,
  paymentInfoHash: `0x${string}`,
): Promise<`0x${string}`> {
  return signer.signTypedData({
    domain: getOperatorEip712Domain(chainId, captureAuthorizer),
    types: VOID_TYPES,
    primaryType: "Void",
    message: { paymentInfoHash },
  });
}

/**
 * Sign a Capture digest.
 *
 * @param signer - Receiver-authorizer signer.
 * @param chainId - EVM chain id.
 * @param captureAuthorizer - Domain verifyingContract.
 * @param digest - Capture parameters including expected balances.
 * @returns EIP-712 signature.
 */
export async function signCapture(
  signer: AuthorizerSigner,
  chainId: number,
  captureAuthorizer: `0x${string}`,
  digest: CaptureDigest,
): Promise<`0x${string}`> {
  return signer.signTypedData({
    domain: getOperatorEip712Domain(chainId, captureAuthorizer),
    types: CAPTURE_TYPES,
    primaryType: "Capture",
    message: captureMessage(digest),
  });
}

/**
 * Sign a Refund digest.
 *
 * @param signer - Receiver-authorizer signer.
 * @param chainId - EVM chain id.
 * @param captureAuthorizer - Domain verifyingContract.
 * @param digest - Refund parameters including expected balances.
 * @returns EIP-712 signature.
 */
export async function signRefund(
  signer: AuthorizerSigner,
  chainId: number,
  captureAuthorizer: `0x${string}`,
  digest: RefundDigest,
): Promise<`0x${string}`> {
  return signer.signTypedData({
    domain: getOperatorEip712Domain(chainId, captureAuthorizer),
    types: REFUND_TYPES,
    primaryType: "Refund",
    message: refundMessage(digest),
  });
}

/**
 * Verify a Charge signature (ECDSA or ERC-1271).
 *
 * @param facilitatorSigner - Used for `eth_getCode` / `isValidSignature`.
 * @param authorizer - extra.receiverAuthorizer.
 * @param chainId - EVM chain id.
 * @param captureAuthorizer - Domain verifyingContract.
 * @param digest - Charge parameters.
 * @param signature - Authorizer signature from the payload.
 * @returns True if the signature is valid for `authorizer`.
 */
export async function verifyCharge(
  facilitatorSigner: FacilitatorEvmSigner,
  authorizer: `0x${string}`,
  chainId: number,
  captureAuthorizer: `0x${string}`,
  digest: ChargeDigest,
  signature: `0x${string}`,
): Promise<boolean> {
  return verifyTypedDataSignature(facilitatorSigner, {
    address: getAddress(authorizer),
    domain: getOperatorEip712Domain(chainId, captureAuthorizer),
    types: CHARGE_TYPES,
    primaryType: "Charge",
    message: chargeMessage(digest),
    signature,
  });
}

/**
 * Verify a Void signature (ECDSA or ERC-1271).
 *
 * @param facilitatorSigner - Used for `eth_getCode` / `isValidSignature`.
 * @param authorizer - extra.receiverAuthorizer.
 * @param chainId - EVM chain id.
 * @param captureAuthorizer - Domain verifyingContract.
 * @param paymentInfoHash - Escrow payment identifier.
 * @param signature - Authorizer signature from the payload.
 * @returns True if the signature is valid for `authorizer`.
 */
export async function verifyVoid(
  facilitatorSigner: FacilitatorEvmSigner,
  authorizer: `0x${string}`,
  chainId: number,
  captureAuthorizer: `0x${string}`,
  paymentInfoHash: `0x${string}`,
  signature: `0x${string}`,
): Promise<boolean> {
  return verifyTypedDataSignature(facilitatorSigner, {
    address: getAddress(authorizer),
    domain: getOperatorEip712Domain(chainId, captureAuthorizer),
    types: VOID_TYPES,
    primaryType: "Void",
    message: { paymentInfoHash },
    signature,
  });
}

/**
 * Verify a Capture signature (ECDSA or ERC-1271).
 *
 * @param facilitatorSigner - Used for `eth_getCode` / `isValidSignature`.
 * @param authorizer - extra.receiverAuthorizer.
 * @param chainId - EVM chain id.
 * @param captureAuthorizer - Domain verifyingContract.
 * @param digest - Capture parameters.
 * @param signature - Authorizer signature from the payload.
 * @returns True if the signature is valid for `authorizer`.
 */
export async function verifyCapture(
  facilitatorSigner: FacilitatorEvmSigner,
  authorizer: `0x${string}`,
  chainId: number,
  captureAuthorizer: `0x${string}`,
  digest: CaptureDigest,
  signature: `0x${string}`,
): Promise<boolean> {
  return verifyTypedDataSignature(facilitatorSigner, {
    address: getAddress(authorizer),
    domain: getOperatorEip712Domain(chainId, captureAuthorizer),
    types: CAPTURE_TYPES,
    primaryType: "Capture",
    message: captureMessage(digest),
    signature,
  });
}

/**
 * Verify a Refund signature (ECDSA or ERC-1271).
 *
 * @param facilitatorSigner - Used for `eth_getCode` / `isValidSignature`.
 * @param authorizer - extra.receiverAuthorizer.
 * @param chainId - EVM chain id.
 * @param captureAuthorizer - Domain verifyingContract.
 * @param digest - Refund parameters.
 * @param signature - Authorizer signature from the payload.
 * @returns True if the signature is valid for `authorizer`.
 */
export async function verifyRefund(
  facilitatorSigner: FacilitatorEvmSigner,
  authorizer: `0x${string}`,
  chainId: number,
  captureAuthorizer: `0x${string}`,
  digest: RefundDigest,
  signature: `0x${string}`,
): Promise<boolean> {
  return verifyTypedDataSignature(facilitatorSigner, {
    address: getAddress(authorizer),
    domain: getOperatorEip712Domain(chainId, captureAuthorizer),
    types: REFUND_TYPES,
    primaryType: "Refund",
    message: refundMessage(digest),
    signature,
  });
}

/**
 * EIP-712 Charge message fields (collectorData is hashed).
 *
 * @param digest - Charge parameters.
 * @returns Typed-data message.
 */
function chargeMessage(digest: ChargeDigest): Record<string, unknown> {
  return {
    paymentInfoHash: digest.paymentInfoHash,
    amount: BigInt(digest.amount),
    tokenCollector: getAddress(digest.tokenCollector),
    collectorDataHash: keccak256(digest.collectorData),
    feeBps: digest.feeBps,
    feeReceiver: getAddress(digest.feeReceiver),
  };
}

/**
 * EIP-712 Capture message fields.
 *
 * @param digest - Capture parameters.
 * @returns Typed-data message.
 */
function captureMessage(digest: CaptureDigest): Record<string, unknown> {
  return {
    paymentInfoHash: digest.paymentInfoHash,
    amount: BigInt(digest.amount),
    feeBps: digest.feeBps,
    feeReceiver: getAddress(digest.feeReceiver),
    expectedCapturableAmount: BigInt(digest.expectedCapturableAmount),
    expectedRefundableAmount: BigInt(digest.expectedRefundableAmount),
  };
}

/**
 * EIP-712 Refund message fields.
 *
 * @param digest - Refund parameters.
 * @returns Typed-data message.
 */
function refundMessage(digest: RefundDigest): Record<string, unknown> {
  return {
    paymentInfoHash: digest.paymentInfoHash,
    amount: BigInt(digest.amount),
    tokenCollector: getAddress(digest.tokenCollector),
    expectedCapturableAmount: BigInt(digest.expectedCapturableAmount),
    expectedRefundableAmount: BigInt(digest.expectedRefundableAmount),
  };
}
