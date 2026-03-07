import { describe, it, expect } from "vitest";
import {
  isObject,
  isPaymentRequiredMessage,
  isPaymentPayloadMessage,
  isSettlementResponseMessage,
  isPaymentRequiredContent,
  isPaymentPayloadContent,
  isSettlementResponseContent,
  createResourceUrl,
} from "../../src/utils/encoding";
import type { XMTPMessage } from "../../src/types";

/**
 * Builds a minimal XMTP message for encoding tests.
 *
 * @param authorityId - Content type authority ID
 * @param typeId - Content type ID
 * @param content - Decoded content
 * @returns A minimal XMTPMessage-shaped object
 */
function makeMessage(authorityId: string, typeId: string, content: unknown): XMTPMessage {
  return {
    id: "msg-1",
    contentType: { authorityId, typeId, versionMajor: 1, versionMinor: 0 },
    content,
    senderInboxId: "inbox-1",
    sentAt: new Date(),
  };
}

describe("isObject", () => {
  it("should return true for plain objects", () => {
    expect(isObject({})).toBe(true);
    expect(isObject({ key: "value" })).toBe(true);
  });

  it("should return false for null", () => {
    expect(isObject(null)).toBe(false);
  });

  it("should return false for primitives", () => {
    expect(isObject(undefined)).toBe(false);
    expect(isObject(42)).toBe(false);
    expect(isObject("string")).toBe(false);
    expect(isObject(true)).toBe(false);
  });
});

describe("isPaymentRequiredMessage", () => {
  it("should return true for payment-required content type", () => {
    const msg = makeMessage("x402", "payment-required", {});
    expect(isPaymentRequiredMessage(msg)).toBe(true);
  });

  it("should return false for other content types", () => {
    const msg = makeMessage("x402", "payment-payload", {});
    expect(isPaymentRequiredMessage(msg)).toBe(false);
  });

  it("should return false for different authority", () => {
    const msg = makeMessage("other", "payment-required", {});
    expect(isPaymentRequiredMessage(msg)).toBe(false);
  });
});

describe("isPaymentPayloadMessage", () => {
  it("should return true for payment-payload content type", () => {
    const msg = makeMessage("x402", "payment-payload", {});
    expect(isPaymentPayloadMessage(msg)).toBe(true);
  });

  it("should return false for other content types", () => {
    const msg = makeMessage("x402", "settlement-response", {});
    expect(isPaymentPayloadMessage(msg)).toBe(false);
  });
});

describe("isSettlementResponseMessage", () => {
  it("should return true for settlement-response content type", () => {
    const msg = makeMessage("x402", "settlement-response", {});
    expect(isSettlementResponseMessage(msg)).toBe(true);
  });

  it("should return false for other content types", () => {
    const msg = makeMessage("x402", "payment-required", {});
    expect(isSettlementResponseMessage(msg)).toBe(false);
  });
});

describe("isPaymentRequiredContent", () => {
  it("should return true for valid PaymentRequired structure", () => {
    expect(
      isPaymentRequiredContent({
        x402Version: 2,
        accepts: [{ scheme: "exact", network: "eip155:84532" }],
        resource: { url: "test" },
      }),
    ).toBe(true);
  });

  it("should return false for missing accepts", () => {
    expect(isPaymentRequiredContent({ x402Version: 2 })).toBe(false);
  });

  it("should return false for non-array accepts", () => {
    expect(isPaymentRequiredContent({ x402Version: 2, accepts: "not-array" })).toBe(false);
  });

  it("should return false for non-objects", () => {
    expect(isPaymentRequiredContent(null)).toBe(false);
    expect(isPaymentRequiredContent("string")).toBe(false);
    expect(isPaymentRequiredContent(42)).toBe(false);
  });
});

describe("isPaymentPayloadContent", () => {
  it("should return true for valid PaymentPayload structure", () => {
    expect(
      isPaymentPayloadContent({
        x402Version: 2,
        payload: { signature: "0x123" },
      }),
    ).toBe(true);
  });

  it("should return false for missing payload", () => {
    expect(isPaymentPayloadContent({ x402Version: 2 })).toBe(false);
  });

  it("should return false for non-objects", () => {
    expect(isPaymentPayloadContent(null)).toBe(false);
  });
});

describe("isSettlementResponseContent", () => {
  it("should return true for success response", () => {
    expect(
      isSettlementResponseContent({
        success: true,
        transaction: "0x123",
        network: "eip155:84532",
      }),
    ).toBe(true);
  });

  it("should return true for failure response", () => {
    expect(
      isSettlementResponseContent({
        success: false,
        errorReason: "insufficient_funds",
      }),
    ).toBe(true);
  });

  it("should return false for missing success field", () => {
    expect(isSettlementResponseContent({ transaction: "0x123" })).toBe(false);
  });

  it("should return false for non-objects", () => {
    expect(isSettlementResponseContent(null)).toBe(false);
  });
});

describe("createResourceUrl", () => {
  it("should create xmtp:// URL", () => {
    const url = createResourceUrl("0xAgent123", "premium-query");
    expect(url).toBe("xmtp://0xAgent123/premium-query");
  });

  it("should handle arbitrary capability names", () => {
    const url = createResourceUrl("0xABC", "my-service/v2");
    expect(url).toBe("xmtp://0xABC/my-service/v2");
  });
});
