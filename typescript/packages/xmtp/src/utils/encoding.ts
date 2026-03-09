import type { PaymentPayload, PaymentRequired, SettleResponse } from "@x402/core/types";
import {
  PaymentRequiredContentType,
  PaymentPayloadContentType,
  SettlementResponseContentType,
} from "../types";
import type { XMTPMessage } from "../types";

// ============================================================================
// Type Guards
// ============================================================================

/**
 * Type guard for checking if a value is a non-null object.
 *
 * @param value - The value to check
 * @returns True if value is a non-null object
 */
export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Content type descriptor for matching (authority, type, major version). */
type ContentTypeDescriptorMajor = {
  authorityId: string;
  typeId: string;
  versionMajor: number;
};

/** Reply-wrapped content (xmtp.org/reply wraps the actual payload). */
type ReplyContent = {
  content: unknown;
  contentType: ContentTypeDescriptorMajor;
  reference?: string;
  referenceInboxId?: string;
};

/**
 * Checks if two content type IDs match (same authority, type, and major version).
 *
 * @param a - First content type
 * @param b - Second content type
 * @returns True if the content types match
 */
function contentTypeMatches(a: ContentTypeDescriptorMajor, b: ContentTypeDescriptorMajor): boolean {
  return (
    a.authorityId === b.authorityId && a.typeId === b.typeId && a.versionMajor === b.versionMajor
  );
}

/**
 * Returns true if the message is an xmtp.org/reply (reply wrapper).
 */
function isReplyMessage(message: XMTPMessage): boolean {
  return (
    message.contentType?.authorityId === "xmtp.org" &&
    message.contentType?.typeId === "reply"
  );
}

/**
 * Extracts inner content from a reply-wrapped message, or the message itself if not a reply.
 */
function getInnerContent(message: XMTPMessage): { content: unknown; contentType: ContentTypeDescriptorMajor } | null {
  if (isReplyMessage(message) && isObject(message.content)) {
    const reply = message.content as ReplyContent;
    if (reply.contentType) {
      return { content: reply.content, contentType: reply.contentType };
    }
  }
  return { content: message.content, contentType: message.contentType };
}

/**
 * Type guard for x402/payment-required XMTP messages.
 * Handles both direct x402/payment-required and reply-wrapped (xmtp.org/reply) messages.
 *
 * @param message - The XMTP message to check
 * @returns True if the message is a payment-required message
 */
export function isPaymentRequiredMessage(
  message: XMTPMessage,
): message is XMTPMessage & { content: PaymentRequired } {
  const inner = getInnerContent(message);
  if (!inner) return false;
  return contentTypeMatches(inner.contentType, PaymentRequiredContentType);
}

/**
 * Extracts PaymentRequired content from a message (direct or reply-wrapped).
 */
export function getPaymentRequiredContent(message: XMTPMessage): PaymentRequired | null {
  if (!isPaymentRequiredMessage(message)) return null;
  const inner = getInnerContent(message);
  return inner && isPaymentRequiredContent(inner.content) ? (inner.content as PaymentRequired) : null;
}

/**
 * Extracts SettleResponse content from a message (direct or reply-wrapped).
 */
export function getSettlementResponseContent(message: XMTPMessage): SettleResponse | null {
  if (!isSettlementResponseMessage(message)) return null;
  const inner = getInnerContent(message);
  return inner && isSettlementResponseContent(inner.content) ? (inner.content as SettleResponse) : null;
}

/**
 * Extracts PaymentPayload content from a message (direct or reply-wrapped).
 */
export function getPaymentPayloadContent(message: XMTPMessage): PaymentPayload | null {
  if (!isPaymentPayloadMessage(message)) return null;
  const inner = getInnerContent(message);
  return inner && isPaymentPayloadContent(inner.content) ? (inner.content as PaymentPayload) : null;
}

/**
 * Type guard for x402/payment-payload XMTP messages.
 * Handles both direct and reply-wrapped messages.
 *
 * @param message - The XMTP message to check
 * @returns True if the message is a payment-payload message
 */
export function isPaymentPayloadMessage(
  message: XMTPMessage,
): message is XMTPMessage & { content: PaymentPayload } {
  const inner = getInnerContent(message);
  if (!inner) return false;
  return contentTypeMatches(inner.contentType, PaymentPayloadContentType);
}

/**
 * Type guard for x402/settlement-response XMTP messages.
 * Handles both direct and reply-wrapped messages.
 *
 * @param message - The XMTP message to check
 * @returns True if the message is a settlement-response message
 */
export function isSettlementResponseMessage(
  message: XMTPMessage,
): message is XMTPMessage & { content: SettleResponse } {
  const inner = getInnerContent(message);
  if (!inner) return false;
  return contentTypeMatches(inner.contentType, SettlementResponseContentType);
}

// ============================================================================
// Content Guards (for decoded content)
// ============================================================================

/**
 * Type guard for PaymentRequired content structure.
 *
 * @param content - The decoded content to check
 * @returns True if the content is a PaymentRequired structure
 */
export function isPaymentRequiredContent(content: unknown): content is PaymentRequired {
  if (!isObject(content)) {
    return false;
  }
  return (
    "x402Version" in content &&
    "accepts" in content &&
    Array.isArray((content as { accepts: unknown }).accepts)
  );
}

/**
 * Type guard for PaymentPayload content structure.
 *
 * @param content - The decoded content to check
 * @returns True if the content is a PaymentPayload structure
 */
export function isPaymentPayloadContent(content: unknown): content is PaymentPayload {
  if (!isObject(content)) {
    return false;
  }
  return "x402Version" in content && "payload" in content;
}

/**
 * Type guard for SettleResponse content structure.
 *
 * @param content - The decoded content to check
 * @returns True if the content is a SettleResponse structure
 */
export function isSettlementResponseContent(content: unknown): content is SettleResponse {
  if (!isObject(content)) {
    return false;
  }
  return "success" in content;
}

// ============================================================================
// URL Helpers
// ============================================================================

/**
 * Creates an XMTP resource URL in the format `xmtp://{address}/{capability}`.
 *
 * @param agentAddress - The agent's wallet address
 * @param capability - The capability or service name
 * @returns The formatted resource URL
 */
export function createResourceUrl(agentAddress: string, capability: string): string {
  return `xmtp://${agentAddress}/${capability}`;
}
