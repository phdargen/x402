import type { ContentCodec, EncodedContent } from "@xmtp/content-type-primitives";
import type { SettleResponse } from "@x402/core/types";
import { SettlementResponseContentType } from "../types";

/**
 * XMTP content codec for x402/settlement-response messages.
 *
 * Encodes SettleResponse objects as JSON-encoded UTF-8 bytes for XMTP transport.
 * Resource Agents send this content type to communicate payment settlement results.
 */
export class SettlementResponseCodec implements ContentCodec<SettleResponse> {
  /** Content type identifier */
  contentType = SettlementResponseContentType;

  /**
   * Encodes a SettleResponse object into XMTP EncodedContent.
   *
   * @param content - The SettleResponse object to encode
   * @returns Encoded content with JSON-encoded UTF-8 bytes
   */
  encode(content: SettleResponse): EncodedContent {
    return {
      type: this.contentType,
      parameters: {},
      content: new TextEncoder().encode(JSON.stringify(content)),
    };
  }

  /**
   * Decodes XMTP EncodedContent back into a SettleResponse object.
   *
   * @param content - The encoded content to decode
   * @returns The decoded SettleResponse object
   */
  decode(content: EncodedContent): SettleResponse {
    const json = new TextDecoder().decode(content.content);
    return JSON.parse(json) as SettleResponse;
  }

  /**
   * Generates a human-readable fallback string for clients that don't support this content type.
   *
   * @param content - The SettleResponse object
   * @returns Fallback text describing the settlement result
   */
  fallback(content: SettleResponse): string | undefined {
    if (content.success) {
      return `Payment settled. Tx: ${content.transaction}`;
    }
    return `Payment failed: ${content.errorReason || "unknown error"}`;
  }

  /**
   * Whether this message type should trigger a push notification.
   *
   * @returns true - settlement-response messages should push
   */
  shouldPush(): boolean {
    return true;
  }
}
