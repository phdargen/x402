import { describe, it, expect, vi } from "vitest";
import {
  x402XMTPClient,
  createx402XMTPClient,
  wrapAgentWithPayment,
} from "../../src/client/x402XMTPClient";
import { createPaymentForXMTP } from "../../src/client/helpers";
import { PaymentRequiredContentType, SettlementResponseContentType } from "../../src/types";
import type { XMTPAgent, XMTPConversation, XMTPMessage } from "../../src/types";
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

/** Content type for mock messages. */
type MockContentType = {
  authorityId: string;
  typeId: string;
  versionMajor: number;
  versionMinor: number;
};

/**
 * Builds a mock XMTP message for tests.
 *
 * @param id - Message ID
 * @param contentType - Content type descriptor
 * @param content - Decoded message content
 * @param senderInboxId - Sender inbox ID (default: 'agent-inbox')
 * @returns A minimal XMTPMessage-shaped object
 */
function makeMessage(
  id: string,
  contentType: MockContentType,
  content: unknown,
  senderInboxId = "agent-inbox",
): XMTPMessage {
  return { id, contentType, content, senderInboxId, sentAt: new Date() };
}

/**
 * Creates a mock XMTP agent for tests.
 *
 * @returns A minimal XMTPAgent with vi.fn() for use/on and fixed address
 */
function createMockAgent(): XMTPAgent {
  return {
    use: vi.fn(),
    on: vi.fn(),
    address: "0xAgentAddress",
    client: {
      accountAddress: "client-inbox",
      conversations: { getMessageById: vi.fn() },
    },
  };
}

/**
 * Creates a mock x402 client for tests (createPaymentPayload, register, registerV1).
 *
 * @returns A minimal x402Client-shaped object with mocked methods
 */
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
});

describe("x402XMTPClient", () => {
  describe("sendWithPayment", () => {
    it("should return free response when no payment required", async () => {
      const agent = createMockAgent();
      const paymentClient = createMockPaymentClient();
      const client = new x402XMTPClient(agent, paymentClient);

      let messageCount = 0;
      const conversation: XMTPConversation = {
        sendText: vi.fn().mockResolvedValue("sent-id"),
        send: vi.fn().mockResolvedValue("sent-id"),
        sendReply: vi.fn().mockResolvedValue("sent-id"),
        messages: vi.fn().mockImplementation(async () => {
          messageCount++;
          if (messageCount <= 1) return [];
          return [
            makeMessage(
              "resp-1",
              { authorityId: "text", typeId: "text", versionMajor: 1, versionMinor: 0 },
              "Free response",
              "agent-inbox",
            ),
          ];
        }),
      };

      const result = await client.sendWithPayment(conversation, "hello");
      expect(result.paymentMade).toBe(false);
      expect(result.content).toBe("Free response");
    });

    it("should throw when payment required but autoPayment is disabled", async () => {
      const agent = createMockAgent();
      const paymentClient = createMockPaymentClient();
      const client = new x402XMTPClient(agent, paymentClient, { autoPayment: false });

      let messageCount = 0;
      const conversation: XMTPConversation = {
        sendText: vi.fn().mockResolvedValue("sent-id"),
        send: vi.fn().mockResolvedValue("sent-id"),
        sendReply: vi.fn().mockResolvedValue("sent-id"),
        messages: vi.fn().mockImplementation(async () => {
          messageCount++;
          if (messageCount <= 1) return [];
          return [
            makeMessage("resp-1", PaymentRequiredContentType, mockPaymentRequired, "agent-inbox"),
          ];
        }),
      };

      await expect(client.sendWithPayment(conversation, "hello")).rejects.toThrow(
        "autoPayment is disabled",
      );
    });

    it("should throw when payment request is denied", async () => {
      const agent = createMockAgent();
      const paymentClient = createMockPaymentClient();
      const client = new x402XMTPClient(agent, paymentClient, {
        autoPayment: true,
        onPaymentRequested: () => false,
      });

      let messageCount = 0;
      const conversation: XMTPConversation = {
        sendText: vi.fn().mockResolvedValue("sent-id"),
        send: vi.fn().mockResolvedValue("sent-id"),
        sendReply: vi.fn().mockResolvedValue("sent-id"),
        messages: vi.fn().mockImplementation(async () => {
          messageCount++;
          if (messageCount <= 1) return [];
          return [
            makeMessage("resp-1", PaymentRequiredContentType, mockPaymentRequired, "agent-inbox"),
          ];
        }),
      };

      await expect(client.sendWithPayment(conversation, "hello")).rejects.toThrow(
        "Payment request denied",
      );
    });

    it("should handle full payment flow", async () => {
      const agent = createMockAgent();
      const paymentClient = createMockPaymentClient();
      const client = new x402XMTPClient(agent, paymentClient, { timeoutMs: 5000 });

      let phase = 0;
      const conversation: XMTPConversation = {
        sendText: vi.fn().mockResolvedValue("sent-id"),
        send: vi.fn().mockResolvedValue("sent-id"),
        sendReply: vi.fn().mockResolvedValue("sent-id"),
        messages: vi.fn().mockImplementation(async () => {
          phase++;
          if (phase <= 1) return [];
          if (phase <= 2) {
            return [
              makeMessage("pr-1", PaymentRequiredContentType, mockPaymentRequired, "agent-inbox"),
            ];
          }
          if (phase <= 4) return [];
          return [
            makeMessage("pr-1", PaymentRequiredContentType, mockPaymentRequired, "agent-inbox"),
            makeMessage(
              "settle-1",
              SettlementResponseContentType,
              mockSettleResponse,
              "agent-inbox",
            ),
            makeMessage(
              "service-1",
              { authorityId: "text", typeId: "text", versionMajor: 1, versionMinor: 0 },
              "Analysis result",
              "agent-inbox",
            ),
          ];
        }),
      };

      const result = await client.sendWithPayment(conversation, "analyze AAPL");
      expect(result.paymentMade).toBe(true);
      expect(result.content).toBe("Analysis result");
      expect(result.paymentResponse).toEqual(mockSettleResponse);
    });
  });

  describe("hooks", () => {
    it("should call onBeforePayment hook", async () => {
      const agent = createMockAgent();
      const paymentClient = createMockPaymentClient();
      const beforeHook = vi.fn();
      const client = new x402XMTPClient(agent, paymentClient, { timeoutMs: 5000 });
      client.onBeforePayment(beforeHook);

      let phase = 0;
      const conversation: XMTPConversation = {
        sendText: vi.fn().mockResolvedValue("sent-id"),
        send: vi.fn().mockResolvedValue("sent-id"),
        sendReply: vi.fn().mockResolvedValue("sent-id"),
        messages: vi.fn().mockImplementation(async () => {
          phase++;
          if (phase <= 1) return [];
          if (phase <= 2) {
            return [
              makeMessage("pr-1", PaymentRequiredContentType, mockPaymentRequired, "agent-inbox"),
            ];
          }
          if (phase <= 4) return [];
          return [
            makeMessage("pr-1", PaymentRequiredContentType, mockPaymentRequired, "agent-inbox"),
            makeMessage(
              "settle-1",
              SettlementResponseContentType,
              mockSettleResponse,
              "agent-inbox",
            ),
            makeMessage(
              "service-1",
              { authorityId: "text", typeId: "text", versionMajor: 1, versionMinor: 0 },
              "result",
              "agent-inbox",
            ),
          ];
        }),
      };

      await client.sendWithPayment(conversation, "test");
      expect(beforeHook).toHaveBeenCalled();
    });

    it("should call onAfterPayment hook", async () => {
      const agent = createMockAgent();
      const paymentClient = createMockPaymentClient();
      const afterHook = vi.fn();
      const client = new x402XMTPClient(agent, paymentClient, { timeoutMs: 5000 });
      client.onAfterPayment(afterHook);

      let phase = 0;
      const conversation: XMTPConversation = {
        sendText: vi.fn().mockResolvedValue("sent-id"),
        send: vi.fn().mockResolvedValue("sent-id"),
        sendReply: vi.fn().mockResolvedValue("sent-id"),
        messages: vi.fn().mockImplementation(async () => {
          phase++;
          if (phase <= 1) return [];
          if (phase <= 2) {
            return [
              makeMessage("pr-1", PaymentRequiredContentType, mockPaymentRequired, "agent-inbox"),
            ];
          }
          if (phase <= 4) return [];
          return [
            makeMessage("pr-1", PaymentRequiredContentType, mockPaymentRequired, "agent-inbox"),
            makeMessage(
              "settle-1",
              SettlementResponseContentType,
              mockSettleResponse,
              "agent-inbox",
            ),
            makeMessage(
              "service-1",
              { authorityId: "text", typeId: "text", versionMajor: 1, versionMinor: 0 },
              "result",
              "agent-inbox",
            ),
          ];
        }),
      };

      await client.sendWithPayment(conversation, "test");
      expect(afterHook).toHaveBeenCalled();
      expect(afterHook.mock.calls[0][0].settlement).toEqual(mockSettleResponse);
    });
  });
});

describe("wrapAgentWithPayment", () => {
  it("should create an x402XMTPClient", () => {
    const agent = createMockAgent();
    const paymentClient = createMockPaymentClient();
    const client = wrapAgentWithPayment(agent, paymentClient);
    expect(client).toBeInstanceOf(x402XMTPClient);
  });
});

describe("createx402XMTPClient", () => {
  it("should create an x402XMTPClient from config", () => {
    const agent = createMockAgent();
    const mockSchemeClient = {
      createPaymentPayload: vi.fn(),
    } as unknown as import("@x402/core/types").SchemeNetworkClient;
    const client = createx402XMTPClient({
      agent,
      schemes: [{ network: "eip155:84532", client: mockSchemeClient }],
      autoPayment: true,
    });
    expect(client).toBeInstanceOf(x402XMTPClient);
  });
});
