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
 * Type guard for x402/payment-required XMTP messages.
 *
 * @param message - The XMTP message to check
 * @returns True if the message is a payment-required message
 */
export function isPaymentRequiredMessage(
  message: XMTPMessage,
): message is XMTPMessage & { content: PaymentRequired } {
  return contentTypeMatches(message.contentType, PaymentRequiredContentType);
}

/**
 * Type guard for x402/payment-payload XMTP messages.
 *
 * @param message - The XMTP message to check
 * @returns True if the message is a payment-payload message
 */
export function isPaymentPayloadMessage(
  message: XMTPMessage,
): message is XMTPMessage & { content: PaymentPayload } {
  return contentTypeMatches(message.contentType, PaymentPayloadContentType);
}

/**
 * Type guard for x402/settlement-response XMTP messages.
 *
 * @param message - The XMTP message to check
 * @returns True if the message is a settlement-response message
 */
export function isSettlementResponseMessage(
  message: XMTPMessage,
): message is XMTPMessage & { content: SettleResponse } {
  return contentTypeMatches(message.contentType, SettlementResponseContentType);
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
