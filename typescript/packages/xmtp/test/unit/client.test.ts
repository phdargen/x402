import { describe, it, expect, vi } from "vitest";
import { createPaymentClientMiddleware } from "../../src/client/paymentClientMiddleware";
import { createPaymentForXMTP } from "../../src/client/helpers";
import { PaymentRequiredContentType, SettlementResponseContentType } from "../../src/types";
import type { XMTPMessageContext, XMTPMessage } from "../../src/types";
import type { PaymentRequired, SettleResponse } from "@x402/core/types";

const mockPaymentRequired: PaymentRequired = {
  x402Version: 2,
  resource: { url: "xmtp://0xAgent/service" },
  accepts: [
    {
      scheme: "exact",
      network: "eip155:84532",
      amount: "10000",
      asset: "0xToken",
      payTo: "0xPayee",
      maxTimeoutSeconds: 60,
      extra: { name: "USDC" },
    },
  ],
};

const mockSettleResponse: SettleResponse = {
  success: true,
  transaction: "0xtx123",
  network: "eip155:84532",
  payer: "0xPayer",
};

type MockContentType = {
  authorityId: string;
  typeId: string;
  versionMajor: number;
  versionMinor: number;
};

function makeMessage(
  id: string,
  contentType: MockContentType,
  content: unknown,
  senderInboxId = "agent-inbox",
): XMTPMessage {
  return { id, contentType, content, senderInboxId, sentAt: new Date() };
}

function createMockPaymentClient() {
  return {
    createPaymentPayload: vi.fn().mockResolvedValue({
      x402Version: 2,
      accepted: mockPaymentRequired.accepts[0],
      payload: { signature: "0xsig" },
    }),
    register: vi.fn().mockReturnThis(),
    registerV1: vi.fn().mockReturnThis(),
  } as unknown as import("@x402/core/client").x402Client;
}

function createMockContext(message: XMTPMessage): XMTPMessageContext {
  return {
    message,
    conversation: {
      sendText: vi.fn().mockResolvedValue(undefined),
      sendReply: vi.fn().mockResolvedValue("reply-id"),
      send: vi.fn().mockResolvedValue("sent-id"),
      messages: vi.fn().mockResolvedValue([]),
    } as unknown as XMTPMessageContext["conversation"],
    client: { accountAddress: "client-inbox" },
    sendText: vi.fn().mockResolvedValue(undefined),
    sendTextReply: vi.fn().mockResolvedValue(undefined),
    getSenderAddress: vi.fn().mockResolvedValue("0xSender"),
  };
}

describe("createPaymentForXMTP", () => {
  it("should delegate to x402Client.createPaymentPayload", async () => {
    const paymentClient = createMockPaymentClient();
    const result = await createPaymentForXMTP(
      paymentClient as unknown as import("@x402/core/client").x402Client,
      mockPaymentRequired,
    );
    expect(paymentClient.createPaymentPayload).toHaveBeenCalledWith(mockPaymentRequired);
    expect(result).toBeDefined();
    expect(result.x402Version).toBe(2);
  });

  it("should merge request into payload when provided", async () => {
    const paymentClient = createMockPaymentClient();
    const request = { body: { city: "SF" }, contentType: "application/json" as const };
    const result = await createPaymentForXMTP(
      paymentClient as unknown as import("@x402/core/client").x402Client,
      mockPaymentRequired,
      request,
    );
    expect(result).toHaveProperty("request", request);
    expect(result.x402Version).toBe(2);
  });
});

describe("createPaymentClientMiddleware", () => {
  it("should return { middleware } matching XMTPAgentMiddleware signature", () => {
    const paymentClient = createMockPaymentClient();
    const result = createPaymentClientMiddleware(paymentClient);
    expect(result).toHaveProperty("middleware");
    expect(typeof result.middleware).toBe("function");
  });

  it("should pass through non-x402 messages (call next)", async () => {
    const paymentClient = createMockPaymentClient();
    const { middleware } = createPaymentClientMiddleware(paymentClient);
    const ctx = createMockContext(
      makeMessage("m1", { authorityId: "text", typeId: "text", versionMajor: 1, versionMinor: 0 }, "hello"),
    );
    const next = vi.fn().mockResolvedValue(undefined);

    await middleware(ctx, next);

    expect(next).toHaveBeenCalled();
  });

  it("should intercept payment-required, create payment, send reply, not call next", async () => {
    const paymentClient = createMockPaymentClient();
    const { middleware } = createPaymentClientMiddleware(paymentClient);
    const ctx = createMockContext(
      makeMessage("pr-1", PaymentRequiredContentType, mockPaymentRequired, "agent-inbox"),
    );
    const next = vi.fn();

    await middleware(ctx, next);

    expect(next).not.toHaveBeenCalled();
    expect(paymentClient.createPaymentPayload).toHaveBeenCalledWith(mockPaymentRequired);
    expect(ctx.conversation.sendReply).toHaveBeenCalled();
  });

  it("should intercept settlement-response, run onAfterPayment, then call next", async () => {
    const paymentClient = createMockPaymentClient();
    const onAfterPayment = vi.fn().mockResolvedValue(undefined);
    const { middleware } = createPaymentClientMiddleware(paymentClient, { onAfterPayment });
    const ctx = createMockContext(
      makeMessage("settle-1", SettlementResponseContentType, mockSettleResponse, "agent-inbox"),
    );
    const next = vi.fn().mockResolvedValue(undefined);

    await middleware(ctx, next);

    expect(onAfterPayment).toHaveBeenCalledWith({ settlement: mockSettleResponse });
    expect(next).toHaveBeenCalled();
  });

  it("should skip payment when onPaymentRequested returns false", async () => {
    const paymentClient = createMockPaymentClient();
    const { middleware } = createPaymentClientMiddleware(paymentClient, {
      onPaymentRequested: () => false,
    });
    const ctx = createMockContext(
      makeMessage("pr-1", PaymentRequiredContentType, mockPaymentRequired, "agent-inbox"),
    );
    const next = vi.fn();

    await middleware(ctx, next);

    expect(next).not.toHaveBeenCalled();
    expect(paymentClient.createPaymentPayload).not.toHaveBeenCalled();
    expect(ctx.conversation.sendReply).not.toHaveBeenCalled();
  });

  it("should skip payment when autoPayment is false", async () => {
    const paymentClient = createMockPaymentClient();
    const { middleware } = createPaymentClientMiddleware(paymentClient, { autoPayment: false });
    const ctx = createMockContext(
      makeMessage("pr-1", PaymentRequiredContentType, mockPaymentRequired, "agent-inbox"),
    );
    const next = vi.fn();

    await middleware(ctx, next);

    expect(next).not.toHaveBeenCalled();
    expect(paymentClient.createPaymentPayload).not.toHaveBeenCalled();
  });

  it("should include request in payment-payload when getRequestBody returns data", async () => {
    const paymentClient = createMockPaymentClient();
    const requestBody = { body: { city: "Tokyo" }, contentType: "application/json" as const };
    const { middleware } = createPaymentClientMiddleware(paymentClient, {
      getRequestBody: () => requestBody,
    });
    const ctx = createMockContext(
      makeMessage("pr-1", PaymentRequiredContentType, mockPaymentRequired, "agent-inbox"),
    );
    const next = vi.fn();

    await middleware(ctx, next);

    expect(paymentClient.createPaymentPayload).toHaveBeenCalledWith(mockPaymentRequired);
    const sendReplyCall = (ctx.conversation.sendReply as ReturnType<typeof vi.fn>).mock.calls[0];
    const encodedContent = sendReplyCall[0].content as { content: Uint8Array };
    expect(encodedContent).toBeDefined();
    const decoded = JSON.parse(new TextDecoder().decode(encodedContent.content));
    expect(decoded.request).toEqual(requestBody);
  });

  it("should not include request when getRequestBody is absent", async () => {
    const paymentClient = createMockPaymentClient();
    const { middleware } = createPaymentClientMiddleware(paymentClient);
    const ctx = createMockContext(
      makeMessage("pr-1", PaymentRequiredContentType, mockPaymentRequired, "agent-inbox"),
    );
    const next = vi.fn();

    await middleware(ctx, next);

    const sendReplyCall = (ctx.conversation.sendReply as ReturnType<typeof vi.fn>).mock.calls[0];
    const encodedContent = sendReplyCall[0].content as { content: Uint8Array };
    const decoded = JSON.parse(new TextDecoder().decode(encodedContent.content));
    expect(decoded.request).toBeUndefined();
  });

  it("should call onBeforePayment before creating payment", async () => {
    const paymentClient = createMockPaymentClient();
    const onBeforePayment = vi.fn().mockResolvedValue(undefined);
    const { middleware } = createPaymentClientMiddleware(paymentClient, { onBeforePayment });
    const ctx = createMockContext(
      makeMessage("pr-1", PaymentRequiredContentType, mockPaymentRequired, "agent-inbox"),
    );
    const next = vi.fn();

    await middleware(ctx, next);

    expect(onBeforePayment).toHaveBeenCalledWith({ paymentRequired: mockPaymentRequired });
    expect(paymentClient.createPaymentPayload).toHaveBeenCalled();
  });
});
