/**
 * @file Onchain `x402ChargeCounts` calldata suffix for facilitator-managed claims.
 *
 * Spec layout: `[function args][magic][abi.encode(uint64[] chargeCounts)][any further suffix]`.
 * `chargeCounts[i]` is the unattested delta for `voucherClaims[i]`, not a lifetime total.
 */
import {
  decodeAbiParameters,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  type Hex,
} from "viem";
import { appendDataSuffix } from "../../shared/extensions";
import { batchSettlementABI } from "../abi";

/** `bytes4(keccak256("x402ChargeCounts(uint64[])"))`. */
export const CHARGE_COUNTS_MAGIC = "0x50b180c6" as const;

const CHARGE_COUNTS_ABI = [{ type: "uint64[]" }] as const;

/** Offset word + length word preceding a dynamic ABI array. */
const DYNAMIC_ARRAY_HEADER_BYTES = 64;

/** One word per `uint64` element (left-padded). */
const WORD_BYTES = 32;

/**
 * Encodes the scheme-local charge-count suffix: `magic || abi.encode(uint64[])`.
 *
 * @param counts - One unattested delta per `voucherClaims` row, in batch order.
 * @returns Hex suffix to append after the claim function arguments.
 */
export function encodeChargeCountsSuffix(counts: readonly (number | bigint)[]): Hex {
  const encoded = encodeAbiParameters(CHARGE_COUNTS_ABI, [
    counts.map(count => BigInt(count)),
  ] as const);
  return `${CHARGE_COUNTS_MAGIC}${encoded.slice(2)}` as Hex;
}

/**
 * Composes the claim `dataSuffix`: charge-count first, optional builder-code second.
 *
 * Builder-code is appended last so the ERC-8021 marker stays at the end of calldata.
 *
 * @param chargeCounts - One unattested delta per `voucherClaims` row.
 * @param builderSuffix - Optional ERC-8021 suffix from `resolveDataSuffix`.
 * @returns Combined hex suffix for `writeContract({ dataSuffix })`.
 */
export function composeClaimDataSuffix(
  chargeCounts: readonly (number | bigint)[],
  builderSuffix?: Hex,
): Hex {
  return appendDataSuffix(encodeChargeCountsSuffix(chargeCounts), builderSuffix);
}

/**
 * ABI-decodes a `claim` / `claimWithSignature` transaction and reads the charge-count suffix.
 *
 * Empty leftover or no magic means no attestation. A later suffix (including ERC-8021)
 * is ignored: the `uint64[]` is sized as `64 + n*32` bytes after the magic.
 *
 * @param calldata - Full transaction input.
 * @returns Decoded counts, or `undefined` when the calldata is not a claim or has no suffix.
 */
export function parseChargeCountsFromCalldata(calldata: Hex): bigint[] | undefined {
  const leftover = leftoverAfterClaimArgs(calldata);
  if (leftover === undefined) {
    return undefined;
  }
  return parseChargeCountsSuffix(leftover);
}

/**
 * Decodes `magic || abi.encode(uint64[])` from the start of a leftover blob.
 *
 * @param leftover - Bytes after the claim function arguments (may continue into another suffix).
 * @returns Decoded counts, or `undefined` when the leftover does not start with the magic.
 */
export function parseChargeCountsSuffix(leftover: Hex): bigint[] | undefined {
  const hex = strip0x(leftover).toLowerCase();
  const magic = strip0x(CHARGE_COUNTS_MAGIC).toLowerCase();
  if (hex.length < magic.length || !hex.startsWith(magic)) {
    return undefined;
  }

  const encoded = hex.slice(magic.length);
  if (encoded.length < DYNAMIC_ARRAY_HEADER_BYTES * 2) {
    return undefined;
  }

  const length = Number(
    BigInt(`0x${encoded.slice(WORD_BYTES * 2, DYNAMIC_ARRAY_HEADER_BYTES * 2)}`),
  );
  if (!Number.isSafeInteger(length) || length < 0) {
    return undefined;
  }

  const sizedBytes = DYNAMIC_ARRAY_HEADER_BYTES + length * WORD_BYTES;
  if (encoded.length < sizedBytes * 2) {
    return undefined;
  }

  try {
    const [counts] = decodeAbiParameters(
      CHARGE_COUNTS_ABI,
      `0x${encoded.slice(0, sizedBytes * 2)}`,
    );
    return [...counts];
  } catch {
    return undefined;
  }
}

/**
 * Returns the bytes after a `claim` / `claimWithSignature` encoding, if any.
 *
 * @param calldata - Full transaction input.
 * @returns Leftover hex (may be `0x`), or `undefined` when the selector is not a claim.
 */
function leftoverAfterClaimArgs(calldata: Hex): Hex | undefined {
  let decoded: ReturnType<typeof decodeFunctionData<typeof batchSettlementABI>>;
  try {
    decoded = decodeFunctionData({ abi: batchSettlementABI, data: calldata });
  } catch {
    return undefined;
  }

  if (decoded.functionName !== "claim" && decoded.functionName !== "claimWithSignature") {
    return undefined;
  }

  const encoded = encodeFunctionData({
    abi: batchSettlementABI,
    functionName: decoded.functionName,
    args: decoded.args,
  });

  const callHex = strip0x(calldata).toLowerCase();
  const encodedHex = strip0x(encoded).toLowerCase();
  if (!callHex.startsWith(encodedHex)) {
    return undefined;
  }

  return `0x${callHex.slice(encodedHex.length)}` as Hex;
}

/**
 * Strips an optional `0x` prefix.
 *
 * @param hex - Hex string.
 * @returns Hex without prefix.
 */
function strip0x(hex: string): string {
  return hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
}
