// @x402/xmtp - XMTP transport integration for x402 payment protocol
//
// This package provides XMTP-native payment handling for agents and clients.
// It enables pay-per-message interactions following the x402 protocol over XMTP transport.

// Codec exports (universal - work with any XMTP SDK)
export {
  PaymentRequiredCodec,
  PaymentPayloadCodec,
  SettlementResponseCodec,
  x402Codecs,
} from "./codecs";

// Client exports
export { createPaymentForXMTP } from "./client";
export { x402XMTPClient, wrapAgentWithPayment, createx402XMTPClient } from "./client";

// Server exports
export { createPaymentWrapper } from "./server";

// Type exports
export {
  PaymentRequiredContentType,
  PaymentPayloadContentType,
  SettlementResponseContentType,
} from "./types";
export type {
  // Server types
  PaidMessageHandler,
  XMTPOriginalMessage,
  XMTPPaymentContext,
  XMTPServiceResponse,
  XMTPPaymentWrapperConfig,
  XMTPPaymentWrapperResult,
  XMTPServerHookContext,
  XMTPBeforeExecutionHook,
  XMTPAfterExecutionContext,
  XMTPAfterExecutionHook,
  XMTPSettlementContext,
  XMTPAfterSettlementHook,
  // Client types
  x402XMTPClientOptions,
  XMTPPaymentRequestedContext,
  x402XMTPMessageResult,
  XMTPBeforePaymentHook,
  XMTPAfterPaymentHook,
  x402XMTPClientConfig,
  // XMTP SDK abstraction types
  XMTPMessage,
  XMTPConversation,
  XMTPMessageContext,
  XMTPAgentMiddleware,
  XMTPAgent,
} from "./types";

// Utility exports
export {
  isPaymentRequiredMessage,
  isPaymentPayloadMessage,
  isSettlementResponseMessage,
  isPaymentRequiredContent,
  isPaymentPayloadContent,
  isSettlementResponseContent,
  createResourceUrl,
} from "./utils";

// ============================================================================
// Convenience Re-exports from @x402/core
// ============================================================================

export { x402Client } from "@x402/core/client";
export type { x402ClientConfig } from "@x402/core/client";

export { x402ResourceServer } from "@x402/core/server";

export type {
  PaymentPayload,
  PaymentRequired,
  PaymentRequirements,
  SettleResponse,
  Network,
  SchemeNetworkClient,
  SchemeNetworkServer,
} from "@x402/core/types";
