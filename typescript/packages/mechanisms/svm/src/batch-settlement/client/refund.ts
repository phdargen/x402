/** Driving a payer-forced channel close over HTTP. */

import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  encodePaymentSignatureHeader,
} from "@x402/core/http";
import type { PaymentRequirements, SettleResponse } from "@x402/core/types";

import { BatchError } from "../errors";
import { BATCH_SETTLEMENT_SCHEME } from "../types";

/** Caller-facing options for a refund. */
export interface BatchRefundOptions {
  /** Fetch implementation; defaults to `globalThis.fetch`. */
  fetch?: typeof fetch | undefined;
  /** Requirements to refund against; probed from `url` when omitted. */
  requirements?: PaymentRequirements | undefined;
}

/** How a refund payload is built. */
export interface RefundPayloadOptions {
  /** Include a payer-signed `request_close` for a facilitator that cannot close cooperatively. */
  withTransaction?: boolean | undefined;
}

/** Builds the payer-signed close payload for a set of requirements. */
export type RefundPayloadBuilder = (
  x402Version: number,
  requirements: PaymentRequirements,
  options?: RefundPayloadOptions,
) => Promise<{ x402Version: number; payload: unknown }>;

/**
 * Probe a protected route for the requirements its channel was opened against.
 *
 * A refund needs the same `feePayer`, asset and `withdrawDelay` the channel was
 * derived from, and an unpaid `GET` is what advertises them. When the route
 * lists more than one `batch-settlement` accept, this selects the `solana:`
 * one.
 *
 * @param url - A protected route on the channel's server
 * @param fetchImpl - Fetch implementation to probe with
 * @returns The advertised Solana batch-settlement requirements and x402 version
 */
export async function probeBatchRequirements(
  url: string,
  fetchImpl: typeof fetch,
): Promise<{ x402Version: number; requirements: PaymentRequirements }> {
  const probe = await fetchImpl(url, { method: "GET" });
  if (probe.status !== 402) {
    throw new Error(`refund probe expected 402 from ${url}, got ${probe.status}`);
  }
  const header = probe.headers.get("PAYMENT-REQUIRED");
  if (!header) throw new Error("refund probe response has no PAYMENT-REQUIRED header");
  const paymentRequired = decodePaymentRequiredHeader(header);
  const requirements = paymentRequired.accepts.find(
    accept => accept.scheme === BATCH_SETTLEMENT_SCHEME && accept.network.startsWith("solana:"),
  );
  if (!requirements) throw new Error(`${url} does not offer ${BATCH_SETTLEMENT_SCHEME}`);
  return { requirements, x402Version: paymentRequired.x402Version };
}

/**
 * Close the channel backing `url` and refund its unused escrow.
 *
 * The response is either an immediate cooperative close, or the start of a
 * payer-forced close whose grace period must elapse before the unused deposit
 * is returned. The scheme has no partial refund — the program returns all
 * unused escrow or nothing — so this takes no amount.
 *
 * Unlike a paid request there is nothing to retry against a corrective 402: a
 * close carries no cumulative amount to resynchronize.
 *
 * @param build - Builds the payer-signed close payload
 * @param url - Any protected route on the channel to close
 * @param options - Fetch override, or requirements to skip the probe
 * @returns The settlement response describing the initiated close
 */
export async function refundBatchChannel(
  build: RefundPayloadBuilder,
  url: string,
  options?: BatchRefundOptions,
): Promise<SettleResponse> {
  const fetchImpl = options?.fetch ?? globalThis.fetch;
  if (!fetchImpl) {
    throw new Error("refund requires a fetch implementation (globalThis.fetch unavailable)");
  }
  const probed = options?.requirements
    ? { requirements: options.requirements, x402Version: 2 }
    : await probeBatchRequirements(url, fetchImpl);

  const send = async (withTransaction: boolean) => {
    const payload = await build(probed.x402Version, probed.requirements, { withTransaction });
    const response = await fetchImpl(url, {
      headers: {
        "PAYMENT-SIGNATURE": encodePaymentSignatureHeader({
          accepted: probed.requirements,
          payload: payload.payload as never,
          x402Version: payload.x402Version,
        }),
      },
      method: "GET",
    });
    const settledHeader = response.headers.get("PAYMENT-RESPONSE");
    const settled = settledHeader ? decodePaymentResponseHeader(settledHeader) : undefined;
    const requiredHeader =
      response.status === 402 ? response.headers.get("PAYMENT-REQUIRED") : null;
    const reason =
      settled?.errorReason ??
      (requiredHeader ? decodePaymentRequiredHeader(requiredHeader).error : undefined);
    return { reason, settled, status: response.status };
  };

  // Only a facilitator with no stored receiver binding needs the
  // payer-signed request_close; everyone else closes cooperatively.
  let result = await send(false);
  if (result.reason === BatchError.RECEIVER_BINDING_UNAVAILABLE) result = await send(true);
  if (result.settled) return result.settled;
  if (result.status === 402) {
    throw new Error(`refund refused: ${result.reason ?? "no reason given"}`);
  }
  throw new Error(`refund response has no PAYMENT-RESPONSE header (status ${result.status})`);
}
