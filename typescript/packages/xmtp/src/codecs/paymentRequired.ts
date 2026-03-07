import type { ContentCodec, EncodedContent } from "@xmtp/content-type-primitives";
import type { PaymentRequired } from "@x402/core/types";
import { PaymentRequiredContentType } from "../types";

/**
 * XMTP content codec for x402/payment-required messages.
 *
 * Encodes PaymentRequired objects as JSON-encoded UTF-8 bytes for XMTP transport.
 * Resource Agents send this content type to indicate that payment is required.
 */
export class PaymentRequiredCodec implements ContentCodec<PaymentRequired> {
  /** Content type identifier */
  contentType = PaymentRequiredContentType;

  /**
   * Encodes a PaymentRequired object into XMTP EncodedContent.
   *
   * @param content - The PaymentRequired object to encode
   * @returns Encoded content with JSON-encoded UTF-8 bytes
   */
  encode(content: PaymentRequired): EncodedContent {
    return {
      type: this.contentType,
      parameters: {},
      content: new TextEncoder().encode(JSON.stringify(content)),
    };
  }

  /**
   * Decodes XMTP EncodedContent back into a PaymentRequired object.
   *
   * @param content - The encoded content to decode
   * @returns The decoded PaymentRequired object
   */
  decode(content: EncodedContent): PaymentRequired {
    const json = new TextDecoder().decode(content.content);
    return JSON.parse(json) as PaymentRequired;
  }

  /**
   * Generates a human-readable fallback string for clients that don't support this content type.
   *
   * @param content - The PaymentRequired object
   * @returns Fallback text describing the payment requirement
   */
  fallback(content: PaymentRequired): string | undefined {
    const first = content.accepts?.[0];
    if (!first) {
      return "Payment required. Use an x402-compatible client to pay.";
    }
    const assetName = (first.extra as Record<string, unknown>)?.name || first.asset;
    return `Payment required: ${first.amount} ${assetName} on ${first.network}. Use an x402-compatible client to pay.`;
  }

  /**
   * Whether this message type should trigger a push notification.
   *
   * @returns true - payment-required messages should push
   */
  shouldPush(): boolean {
    return true;
  }
}
