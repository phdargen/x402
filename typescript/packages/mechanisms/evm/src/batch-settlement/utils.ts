import { encodeAbiParameters, getAddress, keccak256 } from "viem";
import { channelConfigComponents } from "./abi";
import { BATCH_SETTLEMENT_ADDRESS, BATCH_SETTLEMENT_DOMAIN } from "./constants";
import type { ChannelConfig } from "./types";

const channelConfigAbiType = [{ type: "tuple", components: channelConfigComponents }] as const;

/**
 * Computes the channel id from a {@link ChannelConfig} struct, matching the on-chain
 * `getChannelId`: `keccak256(abi.encode(channelConfig))`.
 *
 * @param config - The immutable channel configuration.
 * @returns The `bytes32` channel id as a hex string.
 */
export function computeChannelId(config: ChannelConfig): `0x${string}` {
  const encoded = encodeAbiParameters(channelConfigAbiType, [
    {
      payer: config.payer,
      payerAuthorizer: config.payerAuthorizer,
      receiver: config.receiver,
      receiverAuthorizer: config.receiverAuthorizer,
      token: config.token,
      withdrawDelay: config.withdrawDelay,
      salt: config.salt,
    },
  ]);
  return keccak256(encoded);
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
