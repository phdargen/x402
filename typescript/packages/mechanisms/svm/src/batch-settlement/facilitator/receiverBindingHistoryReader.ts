import type { Network } from "@x402/core/types";

import {
  channelHistoryReads,
  type PaymentChannelFacilitatorSigner,
} from "../../payment-channels/signer";
import type { FacilitatorSvmSigner } from "../../signer";

/** One signature touching a channel account, newest-first as returned by RPC. */
export interface BatchReceiverBindingHistorySignature {
  signature: string;
  /** RPC error for a failed transaction, or null when it succeeded. */
  err: unknown;
}

/**
 * Read path that reconstructs a channel's receiver-authorizer binding from
 * its open transaction.
 *
 * History depth cannot be checked statically. The RPC behind the
 * {@link PaymentChannelFacilitatorSigner} must retain the open transaction
 * for the life of the channel. A pruned history returns null from
 * `getTransaction` and fails closed as an unavailable binding.
 */
export interface BatchReceiverBindingHistoryReader {
  getSignaturesForAddress(
    network: Network,
    address: string,
    options?: { before?: string; limit?: number },
  ): Promise<BatchReceiverBindingHistorySignature[]>;
  /** Confirmed transaction bytes, or null when the signature is unknown. */
  getTransaction(network: Network, signature: string): Promise<string | null>;
}

/** Payment-channel signer that can read confirmed transaction history. */
type ChannelHistorySigner = {
  getSignaturesForAddress: NonNullable<PaymentChannelFacilitatorSigner["getSignaturesForAddress"]>;
  getTransaction: NonNullable<PaymentChannelFacilitatorSigner["getTransaction"]>;
};

/**
 * History reader backed by {@link channelHistoryReads}.
 *
 * @param rpcUrlByNetwork - Optional full-history RPC URL per CAIP-2 network
 * @returns A reader that loads confirmed transaction wire bytes
 */
export function createReceiverBindingHistoryReader(
  rpcUrlByNetwork: Partial<Record<string, string>> = {},
): BatchReceiverBindingHistoryReader {
  return historyReaderFromChannelHistory(channelHistoryReads(rpcUrlByNetwork));
}

/**
 * Adapt history reads to the history-reader interface.
 *
 * @param history - Signature paging and base64 transaction reads
 * @returns A reader that loads confirmed transaction wire bytes
 */
function historyReaderFromChannelHistory(
  history: ChannelHistorySigner,
): BatchReceiverBindingHistoryReader {
  return {
    async getSignaturesForAddress(network, account, options) {
      const page = await history.getSignaturesForAddress(account, network, options);
      return page.map(item => ({
        err: item.err,
        signature: item.signature,
      }));
    },
    getTransaction(network, signature) {
      return history.getTransaction(signature, network);
    },
  };
}

/**
 * Adapt a signer's history reads to {@link BatchReceiverBindingHistoryReader}.
 *
 * `BatchSvmScheme` does not call this. Pass the result as
 * `receiverBindingHistoryReader` only when that signer is the history source
 * the facilitator intends to use.
 *
 * @param signer - Facilitator signer, possibly a {@link PaymentChannelFacilitatorSigner}
 * @returns A history reader, or undefined when the signer has no history reads
 */
export function receiverBindingHistoryReaderFromSigner(
  signer: FacilitatorSvmSigner,
): BatchReceiverBindingHistoryReader | undefined {
  const candidate = signer as Partial<
    Pick<PaymentChannelFacilitatorSigner, "getSignaturesForAddress" | "getTransaction">
  >;
  if (
    typeof candidate.getSignaturesForAddress !== "function" ||
    typeof candidate.getTransaction !== "function"
  ) {
    return undefined;
  }
  return historyReaderFromChannelHistory({
    getSignaturesForAddress: candidate.getSignaturesForAddress.bind(signer),
    getTransaction: candidate.getTransaction.bind(signer),
  });
}
