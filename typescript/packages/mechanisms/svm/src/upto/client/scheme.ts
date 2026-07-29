import { fetchMint, TOKEN_2022_PROGRAM_ADDRESS } from "@solana-program/token-2022";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { type Address } from "@solana/kit";
import type { PaymentPayload, PaymentRequirements, SchemeNetworkClient } from "@x402/core/types";

import { buildOpenPaymentChannelTransaction, parseU64 } from "../../payment-channels/open";
import type { ClientSvmConfig, ClientSvmSigner } from "../../signer";
import { type UptoSvmPayloadV2 } from "../../types";
import { createRpcClient, resolveBlockhash } from "../../utils";
import { resolveUptoSvmPaymentChannelConfig } from "../shared";

/**
 * SVM client implementation for the `upto` payment scheme.
 *
 * Builds the channel `open` transaction whose `deposit` is the authorized ceiling,
 * with `extra.receiverAuthorizer` as authorized signer and `extra.feePayer` as
 * transaction fee payer, rent payer, and zero-share channel payee. The client
 * signs only the open; the fee payer broadcasts it and later submits the
 * settlement carrying the receiver authorizer's voucher for the metered amount.
 */
export class UptoSvmScheme implements SchemeNetworkClient {
  readonly scheme = "upto";

  /**
   * Creates a new upto SVM client.
   *
   * @param signer - The payer's SVM signer
   * @param config - Optional configuration with a custom RPC URL
   */
  constructor(
    private readonly signer: ClientSvmSigner,
    private readonly config?: ClientSvmConfig,
  ) {}

  /**
   * Creates the `upto` payment payload: a payer-signed channel open authorizing
   * up to `paymentRequirements.amount`.
   *
   * @param x402Version - The x402 protocol version
   * @param paymentRequirements - The payment requirements (amount = authorized maximum)
   * @returns The x402 version and the scheme-specific payload
   */
  async createPaymentPayload(
    x402Version: number,
    paymentRequirements: PaymentRequirements,
  ): Promise<Pick<PaymentPayload, "x402Version" | "payload">> {
    const channelConfig = resolveUptoSvmPaymentChannelConfig(paymentRequirements);

    const rpc = createRpcClient(paymentRequirements.network, this.config?.rpcUrl);

    // Resolve the token program: prefer the requirement's hint, else read the mint.
    let tokenProgram = paymentRequirements.extra?.tokenProgram as string | undefined;
    if (!tokenProgram) {
      const mint = await fetchMint(rpc, paymentRequirements.asset as Address);
      const programAddress = mint.programAddress.toString();
      if (
        programAddress !== TOKEN_PROGRAM_ADDRESS.toString() &&
        programAddress !== TOKEN_2022_PROGRAM_ADDRESS.toString()
      ) {
        throw new Error("Asset was not created by a known token program");
      }
      tokenProgram = programAddress;
    }

    const maxAmount = BigInt(paymentRequirements.amount);
    const latestBlockhash = await resolveBlockhash(rpc, paymentRequirements);
    const openSlot = resolveRecentSlot(paymentRequirements);

    const open = await buildOpenPaymentChannelTransaction({
      authorizedSigner: channelConfig.receiverAuthorizer,
      blockhash: {
        blockhash: latestBlockhash.blockhash,
        lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
      },
      deposit: maxAmount,
      feePayer: channelConfig.feePayer,
      gracePeriod: channelConfig.withdrawDelay,
      mint: paymentRequirements.asset,
      openSlot,
      payee: channelConfig.feePayer,
      payer: this.signer,
      recipients: channelConfig.splits,
      tokenProgram,
    });

    const now = Math.floor(Date.now() / 1000);
    const validAfter = (paymentRequirements.extra?.validAfter as number | undefined) ?? now;
    const expiresAt = now + paymentRequirements.maxTimeoutSeconds;

    const payload: UptoSvmPayloadV2 = {
      authorizedSigner: channelConfig.receiverAuthorizer,
      channelId: open.channelId,
      deposit: maxAmount.toString(),
      expiresAt,
      from: this.signer.address,
      maxAmount: maxAmount.toString(),
      nonce: open.salt.toString(),
      openSlot: open.openSlot.toString(),
      openTransaction: open.transaction,
      validAfter,
    };

    return { x402Version, payload };
  }
}

/**
 * Read the challenge-bound open slot (`extra.recentSlot`) from the requirements.
 *
 * The slot is a channel-PDA seed (`open_slot`) and the program only accepts
 * opens within 1500 slots of it, so it MUST come from the server's 402
 * challenge — the client never substitutes one fetched from its own RPC.
 * Accepts a base-10 string (canonical) or a safe number.
 *
 * @param requirements - The payment requirements (challenge) being paid
 * @returns The open slot as a u64 bigint
 */
function resolveRecentSlot(requirements: PaymentRequirements): bigint {
  const provided = requirements.extra?.recentSlot;
  if (provided === undefined || provided === null) {
    throw new Error(
      "upto SVM requires `extra.recentSlot` in the 402 challenge (server-fetched current slot); " +
        "the channel PDA is derived from it and the client must not use its own slot",
    );
  }
  return parseU64(provided as bigint | number | string, "extra.recentSlot");
}
