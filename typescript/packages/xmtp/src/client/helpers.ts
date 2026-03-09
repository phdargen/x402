/**
 * SDK-agnostic client helper functions for x402 over XMTP.
 *
 * These pure functions work with any XMTP SDK (browser, node, agent, react-native).
 * They depend only on @x402/core types and the codecs from this package.
 */

import type { PaymentPayload, PaymentRequired } from "@x402/core/types";
import { x402Client } from "@x402/core/client";
import type { XMTPRequestBody } from "../types";

/**
 * Creates a PaymentPayload from a PaymentRequired response using the x402 client.
 *
 * This is the core SDK-agnostic function that any XMTP client can use to create
 * a payment after receiving a payment-required message.
 *
 * @param paymentClient - The x402 client with registered payment schemes
 * @param paymentRequired - The PaymentRequired message from the resource agent
 * @param request - Optional structured request body to embed in the payload (POST-like)
 * @returns The payment payload ready to be sent via PaymentPayloadCodec.encode()
 *
 * @example
 * ```typescript
 * import { createPaymentForXMTP, PaymentPayloadCodec } from "@x402/xmtp";
 * import { x402Client } from "@x402/core/client";
 *
 * const paymentClient = new x402Client().register("eip155:84532", new ExactEvmScheme(signer));
 * const paymentPayload = await createPaymentForXMTP(paymentClient, paymentRequired);
 *
 * const codec = new PaymentPayloadCodec();
 * await conversation.send(codec.encode(paymentPayload));
 * ```
 */
export async function createPaymentForXMTP(
  paymentClient: x402Client,
  paymentRequired: PaymentRequired,
  request?: XMTPRequestBody,
): Promise<PaymentPayload> {
  const payload = await paymentClient.createPaymentPayload(paymentRequired);
  if (request) {
    return { ...payload, request } as PaymentPayload;
  }
  return payload;
}
