import { describe, it, expect, vi } from "vitest";
import { createPaymentWrapper } from "../../src/server/paymentWrapper";
import type { PaymentRequirements, PaymentPayload, SettleResponse } from "@x402/core/types";
import type { XMTPMessageContext, XMTPMessage, XMTPConversation } from "../../src/types";
import { PaymentPayloadContentType } from "../../src/types";

const mockRequirements: PaymentRequirements = {
  scheme: "exact",
  network: "eip155:84532",
  amount: "10000",
  asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
  maxTimeoutSeconds: 60,
  extra: { name: "USDC", version: "2" },
};

const mockPaymentPayload: PaymentPayload = {
  x402Version: 2,
  accepted: mockRequirements,
  payload: {
    signature: "0xabc",
    authorization: { from: "0xPayer", to: "0xPayee", value: "10000" },
  },
};

const mockSettleResponse: SettleResponse = {
  success: true,
  transaction: "0xtx123",
  network: "eip155:84532",
  payer: "0xPayer",
};

/**
 * Creates a mock x402 resource server for tests.
 *
 * @param overrides - Optional overrides for default mock behavior
 * @returns A minimal x402ResourceServer-shaped object with vi.fn() mocks
 */
function createMockResourceServer(overrides: Record<string, unknown> = {}) {
  return {
    findMatchingRequirements: vi.fn().mockReturnValue(mockRequirements),
    verifyPayment: vi.fn().mockResolvedValue({ isValid: true }),
    settlePayment: vi.fn().mockResolvedValue(mockSettleResponse),
    createPaymentRequiredResponse: vi.fn().mockResolvedValue({
      x402Version: 2,
      error: "Payment required",
      resource: { url: "xmtp://agent/service" },
      accepts: [mockRequirements],
    }),
    ...overrides,
  } as unknown as import("@x402/core/server").x402ResourceServer;
}

/**
 * Creates a mock XMTP conversation with send/sendText/sendReply/messages and sentMessages array.
 *
 * @returns A minimal XMTPConversation with vi.fn() mocks and sentMessages tracking
 */
function createMockConversation(): XMTPConversation & { sentMessages: unknown[] } {
  const sentMessages: unknown[] = [];
  return {
    sentMessages,
    send: vi.fn().mockImplementation(async (content: unknown) => {
      sentMessages.push(content);
      return "msg-sent";
    }),
    sendText: vi.fn().mockImplementation(async (text: string) => {
      sentMessages.push({ type: "text", text });
      return "msg-sent";
    }),
    sendReply: vi.fn().mockImplementation(async (params: unknown) => {
      sentMessages.push(params);
      return "msg-sent";
    }),
    messages: vi.fn().mockResolvedValue([]),
  };
}

/**
 * Creates a mock XMTP message context for middleware tests.
 *
 * @param message - Partial message to merge into the default mock message
 * @param conversation - Optional conversation; created via createMockConversation if omitted
 * @returns A minimal XMTPMessageContext
 */
function createMockContext(
  message: Partial<XMTPMessage>,
  conversation?: ReturnType<typeof createMockConversation>,
): XMTPMessageContext {
  const conv = conversation || createMockConversation();
  return {
    message: {
      id: "msg-1",
      contentType: { authorityId: "text", typeId: "text", versionMajor: 1, versionMinor: 0 },
      content: "",
      senderInboxId: "sender-inbox",
      sentAt: new Date(),
      ...message,
    },
    conversation: conv,
    client: { accountAddress: "0xAgent" },
    sendText: vi.fn().mockImplementation(async (text: string) => {
      await conv.sendText(text);
    }),
    sendTextReply: vi.fn(),
    getSenderAddress: vi.fn().mockResolvedValue("0xSenderAddress"),
  };
}

describe("createPaymentWrapper", () => {
  it("should throw if accepts is empty", () => {
    const resourceServer = createMockResourceServer();
    expect(() =>
      createPaymentWrapper(resourceServer, {
        accepts: [],
        handler: async () => ({ text: "result" }),
      }),
    ).toThrow("accepts must have at least one payment requirement");
  });

  it("should return middleware and requestPayment", () => {
    const resourceServer = createMockResourceServer();
    const result = createPaymentWrapper(resourceServer, {
      accepts: [mockRequirements],
      handler: async () => ({ text: "result" }),
    });

    expect(result.middleware).toBeTypeOf("function");
    expect(result.requestPayment).toBeTypeOf("function");
  });

  describe("middleware", () => {
    it("should pass through non-payment messages", async () => {
      const resourceServer = createMockResourceServer();
      const { middleware } = createPaymentWrapper(resourceServer, {
        accepts: [mockRequirements],
        handler: async () => ({ text: "result" }),
      });

      const ctx = createMockContext({
        contentType: { authorityId: "text", typeId: "text", versionMajor: 1, versionMinor: 0 },
      });
      const next = vi.fn();
      await middleware(ctx, next);
      expect(next).toHaveBeenCalled();
    });

    it("should intercept payment-payload messages", async () => {
      const resourceServer = createMockResourceServer();
      const handler = vi.fn().mockResolvedValue({ text: "Premium analysis result" });
      const { middleware } = createPaymentWrapper(resourceServer, {
        accepts: [mockRequirements],
        handler,
      });

      const conversation = createMockConversation();
      const ctx = createMockContext(
        {
          contentType: PaymentPayloadContentType,
          content: mockPaymentPayload,
        },
        conversation,
      );
      const next = vi.fn();

      await middleware(ctx, next);

      expect(next).not.toHaveBeenCalled();
      expect(resourceServer.verifyPayment).toHaveBeenCalledWith(
        mockPaymentPayload,
        mockRequirements,
      );
      expect(handler).toHaveBeenCalled();
      expect(resourceServer.settlePayment).toHaveBeenCalled();

      expect(conversation.sendReply).toHaveBeenCalled();
      expect(conversation.sendText).toHaveBeenCalledWith("Premium analysis result");
    });

    it("should extract request from payment-payload and attach to originalMessage", async () => {
      const resourceServer = createMockResourceServer();
      const requestBody = { body: { city: "Tokyo" }, contentType: "application/json" as const };
      const payloadWithRequest = { ...mockPaymentPayload, request: requestBody };
      const handler = vi.fn().mockResolvedValue({ text: "result" });
      const { middleware } = createPaymentWrapper(resourceServer, {
        accepts: [mockRequirements],
        handler,
      });

      const originalMsg = {
        id: "original-id",
        contentType: { authorityId: "text", typeId: "text", versionMajor: 1, versionMinor: 0 },
        content: "/weather",
        senderInboxId: "sender-inbox",
        sentAt: new Date(),
      };
      const paymentRequiredMsg = {
        id: "pr-id",
        contentType: PaymentPayloadContentType,
        content: { x402Version: 2, resource: {}, accepts: [mockRequirements] },
        senderInboxId: "agent-inbox",
        sentAt: new Date(),
        reference: "original-id",
      };
      const paymentPayloadMsg = {
        id: "payload-id",
        contentType: PaymentPayloadContentType,
        content: payloadWithRequest,
        senderInboxId: "client-inbox",
        sentAt: new Date(),
        reference: "pr-id",
      };

      const conversation = createMockConversation();
      (conversation.messages as ReturnType<typeof vi.fn>).mockResolvedValue([
        originalMsg,
        paymentRequiredMsg,
        paymentPayloadMsg,
      ]);

      const ctx = createMockContext(
        {
          id: "payload-id",
          contentType: PaymentPayloadContentType,
          content: payloadWithRequest,
          senderInboxId: "client-inbox",
          reference: "pr-id",
        },
        conversation,
      );

      await middleware(ctx, vi.fn());

      expect(handler).toHaveBeenCalled();
      const handlerArg = handler.mock.calls[0][0] as { request?: typeof requestBody };
      expect(handlerArg.request).toEqual(requestBody);
    });

    it("should send settlement failure for invalid payment", async () => {
      const resourceServer = createMockResourceServer({
        verifyPayment: vi.fn().mockResolvedValue({
          isValid: false,
          invalidReason: "expired_authorization",
        }),
      });
      const handler = vi.fn();
      const { middleware } = createPaymentWrapper(resourceServer, {
        accepts: [mockRequirements],
        handler,
      });

      const conversation = createMockConversation();
      const ctx = createMockContext(
        {
          contentType: PaymentPayloadContentType,
          content: mockPaymentPayload,
        },
        conversation,
      );

      await middleware(ctx, vi.fn());
      expect(handler).not.toHaveBeenCalled();
      expect(conversation.sendReply).toHaveBeenCalled();
    });

    it("should call onBeforeExecution hook", async () => {
      const resourceServer = createMockResourceServer();
      const onBeforeExecution = vi.fn().mockResolvedValue(true);
      const handler = vi.fn().mockResolvedValue({ text: "result" });
      const { middleware } = createPaymentWrapper(resourceServer, {
        accepts: [mockRequirements],
        handler,
        hooks: { onBeforeExecution },
      });

      const ctx = createMockContext({
        contentType: PaymentPayloadContentType,
        content: mockPaymentPayload,
      });

      await middleware(ctx, vi.fn());
      expect(onBeforeExecution).toHaveBeenCalled();
      expect(handler).toHaveBeenCalled();
    });

    it("should abort if onBeforeExecution returns false", async () => {
      const resourceServer = createMockResourceServer();
      const onBeforeExecution = vi.fn().mockResolvedValue(false);
      const handler = vi.fn();
      const { middleware } = createPaymentWrapper(resourceServer, {
        accepts: [mockRequirements],
        handler,
        hooks: { onBeforeExecution },
      });

      const conversation = createMockConversation();
      const ctx = createMockContext(
        {
          contentType: PaymentPayloadContentType,
          content: mockPaymentPayload,
        },
        conversation,
      );

      await middleware(ctx, vi.fn());
      expect(handler).not.toHaveBeenCalled();
      expect(conversation.sendReply).toHaveBeenCalled();
    });

    it("should call onAfterSettlement hook", async () => {
      const resourceServer = createMockResourceServer();
      const onAfterSettlement = vi.fn();
      const { middleware } = createPaymentWrapper(resourceServer, {
        accepts: [mockRequirements],
        handler: async () => ({ text: "result" }),
        hooks: { onAfterSettlement },
      });

      const ctx = createMockContext({
        contentType: PaymentPayloadContentType,
        content: mockPaymentPayload,
      });

      await middleware(ctx, vi.fn());
      expect(onAfterSettlement).toHaveBeenCalled();
      expect(onAfterSettlement.mock.calls[0][0].settlement).toEqual(mockSettleResponse);
    });
  });

  describe("requestPayment", () => {
    it("should send payment-required as reply", async () => {
      const resourceServer = createMockResourceServer();
      const { requestPayment } = createPaymentWrapper(resourceServer, {
        accepts: [mockRequirements],
        handler: async () => ({ text: "result" }),
      });

      const conversation = createMockConversation();
      const ctx = createMockContext(
        {
          id: "original-msg-id",
          senderInboxId: "sender-inbox",
          content: "analyze AAPL",
        },
        conversation,
      );

      await requestPayment(ctx);

      expect(resourceServer.createPaymentRequiredResponse).toHaveBeenCalled();
      expect(conversation.sendReply).toHaveBeenCalledWith(
        expect.objectContaining({
          reference: "original-msg-id",
          referenceInboxId: "sender-inbox",
        }),
      );
    });
  });
});
