import type { Address } from "@solana/kit";

import type { FacilitatorSigningCapabilities, FacilitatorSvmSigner } from "../signer";
import { fetchMaybeChannel } from "./generated/accounts/channel";

/**
 * {@link FacilitatorSvmSigner} narrowed to the optional caps payment-channel
 * facilitator work requires: reading a channel, a slot, and a blockhash, and
 * resolving a kit signer. Exact-only signers omit these methods, so they stay
 * optional on the base type. `upto` and batch settlement both use this set.
 */
export type PaymentChannelFacilitatorSigner = FacilitatorSvmSigner & {
  getAccountInfo: NonNullable<FacilitatorSvmSigner["getAccountInfo"]>;
  getLatestBlockhash: NonNullable<FacilitatorSvmSigner["getLatestBlockhash"]>;
  getSlot: NonNullable<FacilitatorSvmSigner["getSlot"]>;
  getSigner(feePayer: Address): FacilitatorSigningCapabilities;
};

const PAYMENT_CHANNEL_FACILITATOR_METHODS = [
  "getSigner",
  "getAccountInfo",
  "getLatestBlockhash",
  "getSlot",
] as const satisfies readonly (keyof PaymentChannelFacilitatorSigner)[];

/**
 * Assert a facilitator signer exposes every optional cap payment-channel
 * facilitator work needs.
 *
 * @param signer - Facilitator signer to validate
 * @param label - Component name for error messages
 * @throws Error when a required capability is missing
 */
export function assertPaymentChannelFacilitatorSigner(
  signer: FacilitatorSvmSigner,
  label: string,
): asserts signer is PaymentChannelFacilitatorSigner {
  for (const method of PAYMENT_CHANNEL_FACILITATOR_METHODS) {
    if (typeof signer[method] !== "function") {
      throw new Error(`${label} requires ${method} on the signer.`);
    }
  }
}

/**
 * Kit-compatible RPC adapter so generated account fetch helpers read through
 * the facilitator signer.
 *
 * @param signer - Payment-channel facilitator signer
 * @param network - CAIP-2 network identifier
 * @returns Minimal RPC surface for {@link fetchMaybeChannel}
 */
export function accountFetchRpc(
  signer: PaymentChannelFacilitatorSigner,
  network: string,
): Parameters<typeof fetchMaybeChannel>[0] {
  return {
    getAccountInfo: (
      accountAddress: Address,
      config?: { commitment?: string; encoding?: string },
    ) => ({
      send: async () => ({
        context: { slot: 0n },
        value: await signer.getAccountInfo(accountAddress.toString(), network, {
          commitment: config?.commitment,
          encoding: config?.encoding,
        }),
      }),
    }),
  } as Parameters<typeof fetchMaybeChannel>[0];
}
