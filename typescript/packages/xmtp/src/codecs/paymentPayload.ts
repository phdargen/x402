import type { ContentCodec, EncodedContent } from "@xmtp/content-type-primitives";
import type { PaymentPayload } from "@x402/core/types";
import { PaymentPayloadContentType } from "../types";

/**
 * XMTP content codec for x402/payment-payload messages.
 *
 * Encodes PaymentPayload objects as JSON-encoded UTF-8 bytes for XMTP transport.
 * Clients send this content type to submit payment to a Resource Agent.
 */
export class PaymentPayloadCodec implements ContentCodec<PaymentPayload> {
  /** Content type identifier */
  contentType = PaymentPayloadContentType;

  /**
   * Encodes a PaymentPayload object into XMTP EncodedContent.
   *
   * @param content - The PaymentPayload object to encode
   * @returns Encoded content with JSON-encoded UTF-8 bytes
   */
  encode(content: PaymentPayload): EncodedContent {
    return {
      type: this.contentType,
      parameters: {},
      content: new TextEncoder().encode(JSON.stringify(content)),
    };
  }

  /**
   * Decodes XMTP EncodedContent back into a PaymentPayload object.
   *
   * @param content - The encoded content to decode
   * @returns The decoded PaymentPayload object
   */
  decode(content: EncodedContent): PaymentPayload {
    const json = new TextDecoder().decode(content.content);
    return JSON.parse(json) as PaymentPayload;
  }

  /**
   * Generates a human-readable fallback string for clients that don't support this content type.
   *
   * @param _ - The PaymentPayload object (unused, required by interface)
   * @returns Fallback text
   */
  fallback(_: PaymentPayload): string | undefined {
    return "x402 payment submitted. Use an x402-compatible client to view.";
  }

  /**
   * Whether this message type should trigger a push notification.
   *
   * @returns false - payment-payload messages should not push
   */
  shouldPush(): boolean {
    return false;
  }
}
