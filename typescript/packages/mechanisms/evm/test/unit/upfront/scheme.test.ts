import { describe, it, expect, beforeEach, vi } from "vitest";
import { UpfrontEvmScheme as UpfrontClient } from "../../../src/upfront/client/scheme";
import { UpfrontEvmScheme as UpfrontServer } from "../../../src/upfront/server/scheme";
import { UpfrontEvmScheme as UpfrontFacilitator } from "../../../src/upfront/facilitator/scheme";
import type { ClientEvmSigner, FacilitatorEvmSigner } from "../../../src/signer";
import { PaymentRequirements } from "@x402/core/types";

describe("UpfrontEvmScheme", () => {
  describe("client", () => {
    let client: UpfrontClient;
    let mockSigner: ClientEvmSigner;

    beforeEach(() => {
      mockSigner = {
        address: "0x1234567890123456789012345678901234567890",
        signTypedData: vi.fn().mockResolvedValue("0xsig"),
      };
      client = new UpfrontClient(mockSigner);
    });

    it("delegates EIP-3009 payload creation to exact", async () => {
      expect(client.scheme).toBe("upfront");
      const requirements: PaymentRequirements = {
        scheme: "upfront",
        network: "eip155:84532",
        amount: "1000000",
        asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        payTo: "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0",
        maxTimeoutSeconds: 300,
        extra: { name: "USDC", version: "2" },
      };
      const result = await client.createPaymentPayload(2, requirements);
      expect(result.payload).toHaveProperty("signature");
      expect(result.payload).toHaveProperty("authorization");
    });
  });

  describe("server", () => {
    it("declares preExecute settlement timing", () => {
      const server = new UpfrontServer();
      expect(server.scheme).toBe("upfront");
      expect(server.settlementTiming).toBe("preExecute");
    });
  });

  describe("facilitator", () => {
    it("uses scheme upfront and shares exact caip family", () => {
      const mockFacilitatorSigner: FacilitatorEvmSigner = {
        getAddresses: vi.fn().mockReturnValue(["0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0"]),
        readContract: vi.fn(),
        verifyTypedData: vi.fn(),
        writeContract: vi.fn(),
        sendTransaction: vi.fn(),
        waitForTransactionReceipt: vi.fn(),
        getCode: vi.fn(),
      };
      const facilitator = new UpfrontFacilitator(mockFacilitatorSigner);
      expect(facilitator.scheme).toBe("upfront");
      expect(facilitator.caipFamily).toBe("eip155:*");
    });
  });
});
