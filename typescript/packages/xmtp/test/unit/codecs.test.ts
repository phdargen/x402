import { describe, it, expect } from "vitest";
import { PaymentRequiredCodec } from "../../src/codecs/paymentRequired";
import { PaymentPayloadCodec } from "../../src/codecs/paymentPayload";
import { SettlementResponseCodec } from "../../src/codecs/settlementResponse";
import { x402Codecs } from "../../src/codecs";
import type { PaymentRequired, PaymentPayload, SettleResponse } from "@x402/core/types";

const mockPaymentRequired: PaymentRequired = {
  x402Version: 2,
  error: "Payment required for this service",
  resource: {
    url: "xmtp://0xAgentAddress/premium-query",
    description: "Premium AI analysis",
    mimeType: "text/plain",
  },
  accepts: [
    {
      scheme: "exact",
      network: "eip155:84532",
      amount: "10000",
      asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
      maxTimeoutSeconds: 60,
      extra: { name: "USDC", version: "2" },
    },
  ],
};

const mockPaymentPayload: PaymentPayload = {
  x402Version: 2,
  resource: {
    url: "xmtp://0xAgentAddress/premium-query",
    description: "Premium AI analysis",
    mimeType: "text/plain",
  },
  accepted: {
    scheme: "exact",
    network: "eip155:84532",
    amount: "10000",
    asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
    maxTimeoutSeconds: 60,
    extra: { name: "USDC", version: "2" },
  },
  payload: {
    signature: "0xabc123",
    authorization: {
      from: "0x857b06519E91e3A54538791bDbb0E22373e36b66",
      to: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
      value: "10000",
      validAfter: "1740672089",
      validBefore: "1740672154",
      nonce: "0xdef456",
    },
  },
};

const mockSettleResponseSuccess: SettleResponse = {
  success: true,
  transaction: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
  network: "eip155:84532",
  payer: "0x857b06519E91e3A54538791bDbb0E22373e36b66",
};

const mockSettleResponseFailure: SettleResponse = {
  success: false,
  errorReason: "insufficient_funds",
  payer: "0x857b06519E91e3A54538791bDbb0E22373e36b66",
  transaction: "",
  network: "eip155:84532",
};

describe("PaymentRequiredCodec", () => {
  const codec = new PaymentRequiredCodec();

  it("should have correct content type", () => {
    expect(codec.contentType.authorityId).toBe("x402");
    expect(codec.contentType.typeId).toBe("payment-required");
    expect(codec.contentType.versionMajor).toBe(1);
    expect(codec.contentType.versionMinor).toBe(0);
  });

  it("should encode and decode round-trip", () => {
    const encoded = codec.encode(mockPaymentRequired);
    const decoded = codec.decode(encoded);
    expect(decoded).toEqual(mockPaymentRequired);
  });

  it("should encode to UTF-8 bytes", () => {
    const encoded = codec.encode(mockPaymentRequired);
    expect(encoded.type).toEqual(codec.contentType);
    expect(encoded.content).toBeInstanceOf(Uint8Array);
    const json = new TextDecoder().decode(encoded.content);
    expect(JSON.parse(json)).toEqual(mockPaymentRequired);
  });

  it("should generate fallback text with asset info", () => {
    const fallback = codec.fallback(mockPaymentRequired);
    expect(fallback).toContain("Payment required:");
    expect(fallback).toContain("10000");
    expect(fallback).toContain("USDC");
    expect(fallback).toContain("eip155:84532");
  });

  it("should generate fallback text without accepts", () => {
    const empty: PaymentRequired = { x402Version: 2, resource: { url: "" }, accepts: [] };
    const fallback = codec.fallback(empty);
    expect(fallback).toContain("Payment required");
  });

  it("should push", () => {
    expect(codec.shouldPush()).toBe(true);
  });
});

describe("PaymentPayloadCodec", () => {
  const codec = new PaymentPayloadCodec();

  it("should have correct content type", () => {
    expect(codec.contentType.authorityId).toBe("x402");
    expect(codec.contentType.typeId).toBe("payment-payload");
    expect(codec.contentType.versionMajor).toBe(1);
    expect(codec.contentType.versionMinor).toBe(0);
  });

  it("should encode and decode round-trip", () => {
    const encoded = codec.encode(mockPaymentPayload);
    const decoded = codec.decode(encoded);
    expect(decoded).toEqual(mockPaymentPayload);
  });

  it("should encode to UTF-8 bytes", () => {
    const encoded = codec.encode(mockPaymentPayload);
    expect(encoded.content).toBeInstanceOf(Uint8Array);
  });

  it("should generate fallback text", () => {
    const fallback = codec.fallback(mockPaymentPayload);
    expect(fallback).toContain("x402 payment submitted");
  });

  it("should not push", () => {
    expect(codec.shouldPush()).toBe(false);
  });
});

describe("SettlementResponseCodec", () => {
  const codec = new SettlementResponseCodec();

  it("should have correct content type", () => {
    expect(codec.contentType.authorityId).toBe("x402");
    expect(codec.contentType.typeId).toBe("settlement-response");
    expect(codec.contentType.versionMajor).toBe(1);
    expect(codec.contentType.versionMinor).toBe(0);
  });

  it("should encode and decode round-trip for success", () => {
    const encoded = codec.encode(mockSettleResponseSuccess);
    const decoded = codec.decode(encoded);
    expect(decoded).toEqual(mockSettleResponseSuccess);
  });

  it("should encode and decode round-trip for failure", () => {
    const encoded = codec.encode(mockSettleResponseFailure);
    const decoded = codec.decode(encoded);
    expect(decoded).toEqual(mockSettleResponseFailure);
  });

  it("should generate success fallback text", () => {
    const fallback = codec.fallback(mockSettleResponseSuccess);
    expect(fallback).toContain("Payment settled");
    expect(fallback).toContain(mockSettleResponseSuccess.transaction);
  });

  it("should generate failure fallback text", () => {
    const fallback = codec.fallback(mockSettleResponseFailure);
    expect(fallback).toContain("Payment failed");
    expect(fallback).toContain("insufficient_funds");
  });

  it("should push", () => {
    expect(codec.shouldPush()).toBe(true);
  });
});

describe("x402Codecs", () => {
  it("should export all three codecs", () => {
    expect(x402Codecs).toHaveLength(3);
    expect(x402Codecs[0]).toBeInstanceOf(PaymentRequiredCodec);
    expect(x402Codecs[1]).toBeInstanceOf(PaymentPayloadCodec);
    expect(x402Codecs[2]).toBeInstanceOf(SettlementResponseCodec);
  });
});
