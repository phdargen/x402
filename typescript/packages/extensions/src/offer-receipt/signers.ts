/**
 * Signer factory functions for the offer-receipt extension
 *
 * This module provides factory functions to create OfferReceiptSigner instances
 * for both JWS and EIP-712 formats.
 *
 * @example
 * ```typescript
 * import { createJWSSigner, createEIP712Signer } from "@x402/extensions/offer-receipt";
 *
 * // JWS signer
 * const jwsSigner = createJWSSigner("did:web:api.example.com#key-1", "ES256K", async (payload) => {
 *   // Sign the payload and return JWS string
 *   return signWithYourKey(payload);
 * });
 *
 * // EIP-712 signer with viem wallet client
 * const eip712Signer = createEIP712Signer(
 *   `did:pkh:eip155:1:${account.address}`,
 *   1,
 *   walletClient.signTypedData
 * );
 * ```
 */

import type { OfferReceiptSigner, OfferInput, JWSSigner } from "./types";
import {
  createOfferJWS,
  createReceiptJWS,
  createOfferEIP712,
  createReceiptEIP712,
  type SignTypedDataFn,
} from "./signing";

/**
 * Create a JWS-based OfferReceiptSigner
 *
 * @param kid - Key identifier DID (e.g., did:web:api.example.com#key-1)
 * @param algorithm - JWS algorithm (e.g., ES256K, EdDSA, ES256)
 * @param signFn - Function that signs payload bytes and returns JWS string
 * @returns OfferReceiptSigner for use with createOfferReceiptExtension
 *
 * @example
 * ```typescript
 * import { createJWSSigner } from "@x402/extensions/offer-receipt";
 * import { SignJWT, importPKCS8 } from "jose";
 *
 * const privateKey = await importPKCS8(pemKey, "ES256K");
 * const kid = "did:web:api.example.com#key-1";
 *
 * const signer = createJWSSigner(kid, "ES256K", async (payload) => {
 *   return new SignJWT(JSON.parse(new TextDecoder().decode(payload)))
 *     .setProtectedHeader({ alg: "ES256K", kid })
 *     .sign(privateKey);
 * });
 * ```
 */
export function createJWSSigner(
  kid: string,
  algorithm: string,
  signFn: (payload: Uint8Array) => Promise<string>,
): OfferReceiptSigner {
  const jwsSigner: JWSSigner = {
    kid,
    format: "jws",
    algorithm,
    sign: signFn,
  };

  return {
    kid,
    format: "jws",

    async signOffer(resourceUrl: string, input: OfferInput, metadata?: Record<string, unknown>) {
      return createOfferJWS(resourceUrl, input, jwsSigner, metadata);
    },

    async signReceipt(
      resourceUrl: string,
      payer: string,
      network: string,
      transaction?: string,
      metadata?: Record<string, unknown>,
    ) {
      return createReceiptJWS({ resourceUrl, payer, network, transaction, metadata }, jwsSigner);
    },
  };
}

/**
 * Create an EIP-712 based OfferReceiptSigner
 *
 * @param kid - Key identifier DID (e.g., did:pkh:eip155:1:0x...)
 * @param chainId - Chain ID for EIP-712 domain
 * @param signTypedData - Function to sign EIP-712 typed data (from viem wallet client)
 * @returns OfferReceiptSigner for use with createOfferReceiptExtension
 *
 * @example
 * ```typescript
 * import { createEIP712Signer } from "@x402/extensions/offer-receipt";
 * import { createWalletClient, http } from "viem";
 * import { privateKeyToAccount } from "viem/accounts";
 *
 * const account = privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`);
 * const walletClient = createWalletClient({
 *   account,
 *   transport: http()
 * });
 *
 * const signer = createEIP712Signer(
 *   `did:pkh:eip155:1:${account.address}`,
 *   1, // mainnet
 *   walletClient.signTypedData
 * );
 * ```
 */
export function createEIP712Signer(
  kid: string,
  chainId: number,
  signTypedData: SignTypedDataFn,
): OfferReceiptSigner {
  return {
    kid,
    format: "eip712",

    async signOffer(resourceUrl: string, input: OfferInput, metadata?: Record<string, unknown>) {
      const signed = await createOfferEIP712(resourceUrl, input, chainId, signTypedData, metadata);
      return {
        format: "eip712" as const,
        payload: signed.payload,
        signature: signed.signature,
      };
    },

    async signReceipt(
      resourceUrl: string,
      payer: string,
      network: string,
      transaction?: string,
      metadata?: Record<string, unknown>,
    ) {
      const signed = await createReceiptEIP712(
        { resourceUrl, payer, network, transaction, metadata },
        chainId,
        signTypedData,
      );
      return {
        format: "eip712" as const,
        payload: signed.payload,
        signature: signed.signature,
      };
    },
  };
}
