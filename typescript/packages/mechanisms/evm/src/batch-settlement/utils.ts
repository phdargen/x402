import { concat, getAddress, hashTypedData, padHex, slice, toHex } from "viem";
import { BATCH_SETTLEMENT_ADDRESS, BATCH_SETTLEMENT_DOMAIN, channelConfigTypes } from "./constants";
import { ErrChannelIdMismatch, ErrInvalidChannelId } from "./errors";
import type { ChannelConfig } from "./types";
import { getEvmChainId } from "../utils";

/** Canonical `bytes32` channel id: `0x` followed by exactly 64 hex digits. */
const CHANNEL_ID_RE = /^0x[0-9a-fA-F]{64}$/;

/** Low 96 bits of a left-padded channel salt (12-byte channel index). */
const UINT96_MASK = (1n << 96n) - 1n;

/**
 * Caller-supplied channel discriminator. Prefer a small index (`0`, `1`, `2`);
 * a full `bytes32` hex value is still accepted for compatibility.
 */
export type ChannelSalt = bigint | number | `0x${string}`;

/**
 * Left-pads a channel salt to `bytes32`.
 *
 * @param salt - Channel index (`0`, `1`, `2`, …) or hex value.
 * @returns A `0x`-prefixed 32-byte hex string.
 */
export function normalizeChannelSalt(salt: ChannelSalt): `0x${string}` {
  if (typeof salt === "number") {
    if (!Number.isInteger(salt) || salt < 0 || !Number.isSafeInteger(salt)) {
      throw new Error("salt must be a non-negative safe integer");
    }
    return padHex(toHex(BigInt(salt)), { size: 32 });
  }
  if (typeof salt === "bigint") {
    if (salt < 0n || salt >= 1n << 256n) {
      throw new Error("salt must be a non-negative integer that fits in 32 bytes");
    }
    return padHex(toHex(salt), { size: 32 });
  }
  if (typeof salt !== "string" || !/^0x[0-9a-fA-F]+$/.test(salt)) {
    throw new Error("salt must be a 0x-prefixed hex value");
  }
  const value = BigInt(salt);
  if (value >= 1n << 256n) {
    throw new Error("salt must fit in 32 bytes");
  }
  return padHex(toHex(value), { size: 32 });
}

/**
 * Narrows an untrusted value to a canonical `bytes32` channel id string.
 *
 * @param value - The value to test.
 * @returns `true` when `value` is a `0x`-prefixed 64-hex-digit string.
 */
export function isCanonicalChannelId(value: unknown): value is `0x${string}` {
  return typeof value === "string" && CHANNEL_ID_RE.test(value);
}

/**
 * Validates canonical `bytes32` form and normalizes to lowercase.
 *
 * @param channelId - Untrusted channel identifier from a request payload.
 * @returns The lowercased channel id.
 * @throws When `channelId` is not a canonical `bytes32` string. The message is generic
 *   so untrusted input is never echoed into logs.
 */
export function normalizeChannelId(channelId: string): `0x${string}` {
  if (!isCanonicalChannelId(channelId)) {
    throw new Error(ErrInvalidChannelId);
  }
  return channelId.toLowerCase() as `0x${string}`;
}

/**
 * Binds a claimed channel id to a channel config and network.
 *
 * @param config - The immutable channel configuration from the payload.
 * @param claimedChannelId - The channel id the client claims the config resolves to.
 * @param networkOrChainId - CAIP-2 network identifier or numeric EVM chain id.
 * @returns An error code when the id is malformed or does not match the config, else `undefined`.
 */
export function channelIdBindingError(
  config: ChannelConfig,
  claimedChannelId: string,
  networkOrChainId: string | number,
): string | undefined {
  if (!isCanonicalChannelId(claimedChannelId)) return ErrInvalidChannelId;
  if (computeChannelId(config, networkOrChainId).toLowerCase() !== claimedChannelId.toLowerCase()) {
    return ErrChannelIdMismatch;
  }
  return undefined;
}

/**
 * Computes the chain-bound channel id from a {@link ChannelConfig} struct.
 *
 * @param config - The immutable channel configuration.
 * @param networkOrChainId - CAIP-2 network identifier or numeric EVM chain id.
 * @returns The `bytes32` channel id as a hex string.
 */
export function computeChannelId(
  config: ChannelConfig,
  networkOrChainId: string | number,
): `0x${string}` {
  const chainId =
    typeof networkOrChainId === "number" ? networkOrChainId : getEvmChainId(networkOrChainId);
  return hashTypedData({
    domain: getBatchSettlementEip712Domain(chainId),
    types: channelConfigTypes,
    primaryType: "ChannelConfig",
    message: {
      payer: config.payer,
      payerAuthorizer: config.payerAuthorizer,
      receiver: config.receiver,
      receiverAuthorizer: config.receiverAuthorizer,
      token: config.token,
      withdrawDelay: config.withdrawDelay,
      salt: config.salt,
    },
  });
}

/**
 * Returns the full EIP-712 domain for the batch-settlement contract on the given chain.
 *
 * @param chainId - Numeric EVM chain id.
 * @returns EIP-712 domain with `name`, `version`, `chainId`, and checksummed `verifyingContract`.
 */
export function getBatchSettlementEip712Domain(chainId: number) {
  return {
    ...BATCH_SETTLEMENT_DOMAIN,
    chainId,
    verifyingContract: getAddress(BATCH_SETTLEMENT_ADDRESS),
  } as const;
}

/**
 * Packs `ChannelConfig.salt` as `bytes12(entropy) || bytes20(refundAuthorizer)`.
 *
 * When the high 12 bytes of `entropy` are zero (left-padded `0`, `1`, `2`, …),
 * entropy is the low 96 bits so incrementing the salt opens distinct channels.
 * Otherwise the first 12 bytes are kept (full `bytes32` / random-salt compat).
 *
 * @param entropy - Channel index or 32-byte salt.
 * @param refundAuthorizer - Server refund-authorizer address committed into the channel id.
 * @returns A `bytes32` salt.
 */
export function packRefundAuthorizerSalt(
  entropy: `0x${string}`,
  refundAuthorizer: `0x${string}`,
): `0x${string}` {
  const padded = padHex(entropy, { size: 32 });
  const high12 = slice(padded, 0, 12);
  const entropy12 =
    BigInt(high12) === 0n ? padHex(toHex(BigInt(padded) & UINT96_MASK), { size: 12 }) : high12;
  return concat([entropy12, getAddress(refundAuthorizer)]);
}

/**
 * Unpacks the refund-authorizer address from a packed `ChannelConfig.salt`.
 *
 * @param salt - Channel salt (`bytes12 || bytes20`).
 * @returns Checksummed refund-authorizer address.
 */
export function unpackRefundAuthorizer(salt: `0x${string}`): `0x${string}` {
  return getAddress(slice(salt, 12, 32));
}
