import type { ContentTypeId } from "@xmtp/content-type-primitives";
import type {
  PaymentPayload,
  PaymentRequired,
  PaymentRequirements,
  SettleResponse,
} from "@x402/core/types";

// ============================================================================
// Content Type Identifiers
// ============================================================================

/** Content type descriptor (authority, type, major and minor version). */
type ContentTypeDescriptor = {
  authorityId: string;
  typeId: string;
  versionMajor: number;
  versionMinor: number;
};

/**
 * Returns true if two content type IDs are equal (authority, type, major and minor version).
 *
 * @param a - First content type descriptor
 * @param b - Second content type ID to compare
 * @returns True when both content types match
 */
function sameAsContentType(a: ContentTypeDescriptor, b: ContentTypeId): boolean {
  return (
    a.authorityId === b.authorityId &&
    a.typeId === b.typeId &&
    a.versionMajor === b.versionMajor &&
    a.versionMinor === b.versionMinor
  );
}

/**
 * XMTP content type ID for x402/payment-required messages
 */
export const PaymentRequiredContentType: ContentTypeId = {
  authorityId: "x402",
  typeId: "payment-required",
  versionMajor: 1,
  versionMinor: 0,
  sameAs: other => sameAsContentType(PaymentRequiredContentType, other),
};

/**
 * XMTP content type ID for x402/payment-payload messages
 */
export const PaymentPayloadContentType: ContentTypeId = {
  authorityId: "x402",
  typeId: "payment-payload",
  versionMajor: 1,
  versionMinor: 0,
  sameAs: other => sameAsContentType(PaymentPayloadContentType, other),
};

/**
 * XMTP content type ID for x402/settlement-response messages
 */
export const SettlementResponseContentType: ContentTypeId = {
  authorityId: "x402",
  typeId: "settlement-response",
  versionMajor: 1,
  versionMinor: 0,
  sameAs: other => sameAsContentType(SettlementResponseContentType, other),
};

// ============================================================================
// Server Types
// ============================================================================

/**
 * Handler that runs after payment verification succeeds.
 * Receives the original text message that triggered the payment flow.
 * Returns the service response to deliver to the client.
 */
export type PaidMessageHandler = (
  originalMessage: XMTPOriginalMessage,
  context: XMTPPaymentContext,
) => Promise<XMTPServiceResponse> | XMTPServiceResponse;

/**
 * Structured request body embedded in x402/payment-payload (POST-like requests)
 */
export interface XMTPRequestBody {
  body: unknown;
  contentType?: string; // defaults to "application/json"
}

/**
 * The original message recovered from the XMTP reply chain
 */
export interface XMTPOriginalMessage {
  /** The text content of the original message */
  content: string;
  /** The XMTP message ID */
  id: string;
  /** The sender's inbox ID */
  senderInboxId: string;
  /** Structured request body from the payment-payload `request` field, if present */
  request?: XMTPRequestBody;
}

/**
 * Context provided to the paid message handler and hooks
 */
export interface XMTPPaymentContext {
  /** The payment payload from the client */
  paymentPayload: PaymentPayload;
  /** The matched payment requirements */
  paymentRequirements: PaymentRequirements;
  /** The sender's address (resolved from XMTP identity) */
  senderAddress?: string;
}

/**
 * Service response to send after successful payment
 */
export interface XMTPServiceResponse {
  /** Text content to send as a regular XMTP message */
  text: string;
}

/**
 * Configuration for createPaymentWrapper
 */
export interface XMTPPaymentWrapperConfig {
  /** Payment requirements that must be satisfied */
  accepts: PaymentRequirements[];

  /** Handler that runs after payment verification, receives the original text message */
  handler: PaidMessageHandler;

  /** Optional resource metadata */
  resource?: {
    /** Custom URL for the resource (defaults to xmtp://{agentAddress}/{capability}) */
    url?: string;
    /** Human-readable description */
    description?: string;
    /** MIME type of the response */
    mimeType?: string;
  };

  /** Lifecycle hooks */
  hooks?: {
    /** Called after payment verification, before handler execution. Return false to abort. */
    onBeforeExecution?: XMTPBeforeExecutionHook;
    /** Called after handler execution, before settlement */
    onAfterExecution?: XMTPAfterExecutionHook;
    /** Called after successful settlement */
    onAfterSettlement?: XMTPAfterSettlementHook;
  };
}

/**
 * Result of createPaymentWrapper
 */
export interface XMTPPaymentWrapperResult {
  /** AgentMiddleware that intercepts x402/payment-payload messages */
  middleware: XMTPAgentMiddleware;
  /** Sends x402/payment-required as a reply to the current message */
  requestPayment: (ctx: XMTPMessageContext) => Promise<void>;
}

// ============================================================================
// Server Hook Types
// ============================================================================

/**
 * Context provided to server-side hooks
 */
export interface XMTPServerHookContext {
  /** The payment payload from the client */
  paymentPayload: PaymentPayload;
  /** The matched payment requirements */
  paymentRequirements: PaymentRequirements;
  /** The original message that triggered the payment flow */
  originalMessage: XMTPOriginalMessage;
}

/**
 * Hook called before handler execution. Return false to abort.
 */
export type XMTPBeforeExecutionHook = (
  context: XMTPServerHookContext,
) => Promise<boolean | void> | boolean | void;

/**
 * Context for after-execution hooks
 */
export interface XMTPAfterExecutionContext extends XMTPServerHookContext {
  /** The handler result */
  result: XMTPServiceResponse;
}

/**
 * Hook called after handler execution, before settlement
 */
export type XMTPAfterExecutionHook = (context: XMTPAfterExecutionContext) => Promise<void> | void;

/**
 * Context for settlement hooks
 */
export interface XMTPSettlementContext extends XMTPServerHookContext {
  /** The settlement result */
  settlement: SettleResponse;
}

/**
 * Hook called after successful settlement
 */
export type XMTPAfterSettlementHook = (context: XMTPSettlementContext) => Promise<void> | void;

// ============================================================================
// Client Types
// ============================================================================

/**
 * Configuration for createPaymentClientMiddleware
 */
export interface XMTPPaymentClientConfig {
  /** Whether to automatically create and send payment when payment-required is received. @default true */
  autoPayment?: boolean;

  /** Hook called when payment is requested. Return true to proceed, false to abort. */
  onPaymentRequested?: (ctx: { paymentRequired: PaymentRequired }) => Promise<boolean> | boolean;

  /** Hook called before payment is created */
  onBeforePayment?: (ctx: { paymentRequired: PaymentRequired }) => Promise<void> | void;

  /** Hook called after settlement-response is received */
  onAfterPayment?: (ctx: { settlement: SettleResponse }) => Promise<void> | void;

  /** Return structured request data to embed in the payment-payload (POST-like). */
  getRequestBody?: (
    ctx: { paymentRequired: PaymentRequired },
  ) => Promise<XMTPRequestBody | undefined> | XMTPRequestBody | undefined;
}

/**
 * Result of createPaymentClientMiddleware
 */
export interface XMTPPaymentClientResult {
  middleware: XMTPAgentMiddleware;
}

// ============================================================================
// XMTP SDK Abstraction Types
// ============================================================================
// Minimal interfaces for the parts of @xmtp/agent-sdk we use.
// This avoids a hard dependency while providing type safety.

/**
 * Minimal XMTP message interface
 */
export interface XMTPMessage {
  /** Unique message identifier */
  id: string;
  /** Content type identifier */
  contentType: { authorityId: string; typeId: string; versionMajor: number; versionMinor: number };
  /** Decoded message content */
  content: unknown;
  /** Sender's inbox ID */
  senderInboxId: string;
  /** When the message was sent */
  sentAt: Date;
  /** Reference to parent message (for replies), when available */
  reference?: string;
}

/**
 * Minimal XMTP conversation interface
 */
export interface XMTPConversation {
  /** Send encoded content to the conversation */
  send: (content: unknown) => Promise<string>;
  /** Send a text message */
  sendText: (text: string) => Promise<string>;
  /** Send a reply to a specific message */
  sendReply: (params: {
    content: unknown;
    reference: string;
    referenceInboxId: string;
  }) => Promise<string>;
  /** Retrieve messages from the conversation */
  messages: (opts?: unknown) => Promise<XMTPMessage[]>;
}

/**
 * Minimal XMTP message context (from agent-sdk middleware/events)
 */
export interface XMTPMessageContext {
  /** The incoming message */
  message: XMTPMessage;
  /** The conversation the message belongs to */
  conversation: XMTPConversation;
  /** The XMTP client */
  client: {
    accountAddress: string;
    /** Optional: direct message lookup (agent-sdk provides this) */
    conversations?: { getMessageById: (id: string) => Promise<XMTPMessage | undefined> };
  };
  /** Send a text message to the conversation */
  sendText: (text: string) => Promise<void>;
  /** Send a text reply to the current message */
  sendTextReply: (text: string) => Promise<void>;
  /** Get the sender's Ethereum address */
  getSenderAddress: () => Promise<string>;
}

/**
 * XMTP AgentMiddleware type: receives context and a next function
 */
export type XMTPAgentMiddleware = (
  ctx: XMTPMessageContext,
  next: () => Promise<void>,
) => Promise<void>;

/**
 * Minimal XMTP Agent interface
 */
export interface XMTPAgent {
  /** Register middleware */
  use: (middleware: XMTPAgentMiddleware | XMTPAgentMiddleware[]) => void;
  /** Register an event handler */
  on: (event: string, handler: (ctx: XMTPMessageContext) => Promise<void> | void) => void;
  /** The agent's wallet address */
  address: string;
  /** The XMTP client */
  client: {
    accountAddress: string;
    conversations: { getMessageById: (id: string) => Promise<XMTPMessage | undefined> };
  };
}
