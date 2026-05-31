import { base58 } from "@scure/base";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { optionalEnv, requireEnv } from "./env.js";

/**
 * Creates an EVM account from `EVM_PRIVATE_KEY`.
 *
 * @returns Viem account for signing
 */
export function createEvmAccountFromEnv(): PrivateKeyAccount {
  return privateKeyToAccount(requireEnv("EVM_PRIVATE_KEY") as `0x${string}`);
}

/**
 * Creates an optional EVM account from `EVM_PRIVATE_KEY` when set.
 *
 * @returns Viem account or undefined
 */
export function optionalEvmAccountFromEnv(): PrivateKeyAccount | undefined {
  const key = optionalEnv("EVM_PRIVATE_KEY") as `0x${string}` | undefined;
  return key ? privateKeyToAccount(key) : undefined;
}

/**
 * Creates an SVM signer from `SVM_PRIVATE_KEY` when set.
 *
 * @returns Solana key pair signer or undefined
 */
export async function optionalSvmSignerFromEnv() {
  const key = optionalEnv("SVM_PRIVATE_KEY");
  if (!key) {
    return undefined;
  }
  return createKeyPairSignerFromBytes(base58.decode(key));
}

/**
 * Creates an SVM signer from `SVM_PRIVATE_KEY`.
 *
 * @returns Solana key pair signer
 */
export async function createSvmSignerFromEnv() {
  return createKeyPairSignerFromBytes(base58.decode(requireEnv("SVM_PRIVATE_KEY")));
}
