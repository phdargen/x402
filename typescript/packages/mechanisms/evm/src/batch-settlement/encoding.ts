/**
 * @file Encoding helpers for batch-settlement deposit collectors.
 */
import { encodeAbiParameters, keccak256 } from "viem";

/**
 * Computes the ERC-3009 nonce used by the deposit collector:
 * `keccak256(abi.encode(channelId, salt))`.
 *
 * @param channelId - The `bytes32` channel id binding the authorization to a channel.
 * @param salt - Random salt provided by the client to make the nonce unique per deposit.
 * @returns The `bytes32` ERC-3009 nonce.
 */
export function buildErc3009DepositNonce(
  channelId: `0x${string}`,
  salt: `0x${string}`,
): `0x${string}` {
  return keccak256(
    encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [channelId, BigInt(salt)]),
  );
}

/**
 * Encodes the `collectorData` payload for `ERC3009DepositCollector.collect()`:
 * `abi.encode(validAfter, validBefore, salt, signature)`.
 *
 * @param validAfter - Earliest unix timestamp the authorization is valid (decimal string).
 * @param validBefore - Latest unix timestamp the authorization is valid (decimal string).
 * @param salt - Random salt provided by the client (hex string).
 * @param signature - ERC-3009 `ReceiveWithAuthorization` signature.
 * @returns ABI-encoded collector data passed to `deposit(..., collector, collectorData)`.
 */
export function buildErc3009CollectorData(
  validAfter: string,
  validBefore: string,
  salt: `0x${string}`,
  signature: `0x${string}`,
): `0x${string}` {
  return encodeAbiParameters(
    [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes" }],
    [BigInt(validAfter), BigInt(validBefore), BigInt(salt), signature],
  );
}
