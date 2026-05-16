import { keccak256, toBytes, concat } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { toClientEvmSigner } from "@x402/evm";

/**
 * Derives a deterministic session key from a wallet delegation signature.
 * The key is unique per player per salt -- never stored in the JS bundle.
 */
export function deriveSessionKey(delegationSignature: `0x${string}`, channelSalt: `0x${string}`) {
  const sessionPrivateKey = keccak256(
    concat([toBytes(delegationSignature), toBytes(channelSalt)]),
  );
  const sessionAccount = privateKeyToAccount(sessionPrivateKey);
  const voucherSigner = toClientEvmSigner(sessionAccount);

  return { sessionPrivateKey, sessionAccount, voucherSigner };
}

export function generateChannelSalt(): `0x${string}` {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return ("0x" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")) as `0x${string}`;
}

export function buildDelegationMessage(channelSalt: `0x${string}`): string {
  return `x402 Game Session\nChannel: ${channelSalt}`;
}
