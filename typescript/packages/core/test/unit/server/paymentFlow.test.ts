import { describe, it, expect, vi, afterEach } from "vitest";
import {
  x402ResourceServer,
  SettleContext,
  SettlePhase,
  PAYMENT_FLOWS,
  DEFAULT_PAYMENT_FLOW,
} from "../../../src/server";
import { x402HTTPResourceServer } from "../../../src/http/x402HTTPResourceServer";
import {
  MockFacilitatorClient,
  MockSchemeNetworkServer,
  buildSupportedResponse,
  buildVerifyResponse,
  buildSettleResponse,
  buildPaymentPayload,
  buildPaymentRequirements,
} from "../../mocks";
import { Network, PaymentFlowName } from "../../../src/types";
import type { HTTPAdapter } from "../../../src/http/x402HTTPResourceServer";
import { encodePaymentSignatureHeader } from "../../../src/http";

/**
 *
 */
class MockHTTPAdapter implements HTTPAdapter {
  private headers: Record<string, string> = {};

  /**
   *
   * @param headers
   */
  constructor(headers: Record<string, string> = {}) {
    this.headers = headers;
  }

  /**
   *
   * @param name
   */
  getHeader(name: string): string | undefined {
    return this.headers[name.toLowerCase()];
  }

  /**
   *
   */
  getMethod(): string {
    return "GET";
  }

  /**
   *
   */
  getPath(): string {
    return "/api/test";
  }

  /**
   *
   */
  getUrl(): string {
    return "https://example.com/api/test";
  }

  /**
   *
   */
  getAcceptHeader(): string {
    return "application/json";
  }

  /**
   *
   */
  getUserAgent(): string {
    return "TestClient/1.0";
  }
}

/**
 *
 * @param flow
 */
function schemeWithFlow(flow: PaymentFlowName): MockSchemeNetworkServer {
  return Object.assign(
    new MockSchemeNetworkServer("exact", {
      amount: "1000000",
      asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      extra: {},
    }),
    {
      getPaymentFlow: () => flow,
    },
  );
}

describe("payment flows", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("vocabulary", () => {
    it("defaults to authorization", () => {
      expect(DEFAULT_PAYMENT_FLOW).toBe("authorization");
      expect(PAYMENT_FLOWS.authorization).toEqual({
        verifyBeforeHandler: true,
        settleBeforeHandler: false,
        settleAfterHandler: true,
      });
    });

    it("getPaymentFlow returns authorization when scheme omits the hook", async () => {
      const mockClient = new MockFacilitatorClient(
        buildSupportedResponse({
          kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" as Network }],
        }),
      );
      const server = new x402ResourceServer(mockClient);
      server.register("eip155:8453" as Network, new MockSchemeNetworkServer("exact"));
      await server.initialize();

      expect(
        server.getPaymentFlow(
          buildPaymentPayload(),
          buildPaymentRequirements({ scheme: "exact", network: "eip155:8453" as Network }),
        ),
      ).toBe("authorization");
    });
  });

  describe("settlePayment phase", () => {
    it("passes phase on SettleContext to beforeSettle hooks", async () => {
      const mockClient = new MockFacilitatorClient(
        buildSupportedResponse({
          kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" as Network }],
        }),
        undefined,
        buildSettleResponse({ success: true }),
      );
      const server = new x402ResourceServer(mockClient);
      server.register("eip155:8453" as Network, new MockSchemeNetworkServer("exact"));
      await server.initialize();

      const phases: SettlePhase[] = [];
      server.onBeforeSettle(async (ctx: SettleContext) => {
        phases.push(ctx.phase);
      });

      await server.settlePayment(
        buildPaymentPayload({
          accepted: buildPaymentRequirements({
            scheme: "exact",
            network: "eip155:8453" as Network,
          }),
        }),
        buildPaymentRequirements({ scheme: "exact", network: "eip155:8453" as Network }),
        undefined,
        undefined,
        undefined,
        "before-handler",
      );

      expect(phases).toEqual(["before-handler"]);
    });

    it("allows the same enrichment keys on a second settle via settle-local payload copy", async () => {
      const mockClient = new MockFacilitatorClient(
        buildSupportedResponse({
          kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" as Network }],
        }),
        undefined,
        buildSettleResponse({ success: true }),
      );
      const server = new x402ResourceServer(mockClient);
      let enrichCalls = 0;
      server.register(
        "eip155:8453" as Network,
        Object.assign(new MockSchemeNetworkServer("exact"), {
          enrichSettlementPayload: async (ctx: SettleContext) => {
            enrichCalls += 1;
            return { settlePhase: ctx.phase === "before-handler" ? "deposit" : "charge" };
          },
        }),
      );
      await server.initialize();

      const payload = buildPaymentPayload({
        accepted: buildPaymentRequirements({
          scheme: "exact",
          network: "eip155:8453" as Network,
        }),
        payload: { signature: "sig" },
      });
      const requirements = buildPaymentRequirements({
        scheme: "exact",
        network: "eip155:8453" as Network,
      });

      await server.settlePayment(
        payload,
        requirements,
        undefined,
        undefined,
        undefined,
        "before-handler",
      );
      await server.settlePayment(
        payload,
        requirements,
        undefined,
        undefined,
        undefined,
        "after-handler",
      );

      expect(enrichCalls).toBe(2);
      expect(mockClient.settleCalls).toHaveLength(2);
      expect(mockClient.settleCalls[0].payload.payload).toEqual({
        signature: "sig",
        settlePhase: "deposit",
      });
      expect(mockClient.settleCalls[1].payload.payload).toEqual({
        signature: "sig",
        settlePhase: "charge",
      });
      expect(payload.payload).toEqual({ signature: "sig" });
    });
  });

  describe("cancellation dispatcher settledPhases", () => {
    it("exposes completed settle phases on cancel", async () => {
      const mockClient = new MockFacilitatorClient(
        buildSupportedResponse({
          kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" as Network }],
        }),
        undefined,
        buildSettleResponse({ success: true, transaction: "0xdeposit" }),
      );
      const server = new x402ResourceServer(mockClient);
      server.register("eip155:8453" as Network, schemeWithFlow("escrow"));
      await server.initialize();

      const requirements = buildPaymentRequirements({
        scheme: "exact",
        network: "eip155:8453" as Network,
      });
      const payload = buildPaymentPayload({ accepted: requirements });
      const handle = server.createPaymentCancellationDispatcher(
        payload,
        requirements,
        undefined,
        undefined,
        ["before-handler"],
      );

      let settledPhases: readonly SettlePhase[] | undefined;
      server.onVerifiedPaymentCanceled(async ctx => {
        settledPhases = ctx.settledPhases;
        expect(ctx.phase).toBe("cancel");
      });

      await handle.cancel({ reason: "handler_failed", responseStatus: 500 });
      expect(settledPhases).toEqual(["before-handler"]);
    });
  });

  describe("HTTP orchestration", () => {
    let ResourceServer: x402ResourceServer;
    let mockFacilitator: MockFacilitatorClient;

    /**
     *
     * @param flow
     */
    async function setup(flow: PaymentFlowName) {
      mockFacilitator = new MockFacilitatorClient(
        buildSupportedResponse({
          kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" as Network }],
        }),
        buildVerifyResponse({ isValid: true }),
        buildSettleResponse({ success: true, transaction: "0xtx" }),
      );
      ResourceServer = new x402ResourceServer(mockFacilitator);
      ResourceServer.register("eip155:8453" as Network, schemeWithFlow(flow));
      await ResourceServer.initialize();
      return new x402HTTPResourceServer(ResourceServer, {
        "/api/test": {
          accepts: {
            scheme: "exact",
            payTo: "0xabc",
            price: "$1.00",
            network: "eip155:8453" as Network,
          },
        },
      });
    }

    /**
     *
     * @param httpServer
     */
    async function verifiedRequest(httpServer: x402HTTPResourceServer) {
      const requirements = buildPaymentRequirements({
        scheme: "exact",
        network: "eip155:8453" as Network,
        payTo: "0xabc",
        amount: "1000000",
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      });
      const payload = buildPaymentPayload({
        accepted: requirements,
      });
      const adapter = new MockHTTPAdapter({
        "payment-signature": encodePaymentSignatureHeader(payload),
      });
      return httpServer.processHTTPRequest({
        adapter,
        path: "/api/test",
        method: "GET",
      });
    }

    it("authorization: verifies before handler and settles after with phase after-handler", async () => {
      const httpServer = await setup("authorization");
      const phases: SettlePhase[] = [];
      ResourceServer.onBeforeSettle(async ctx => {
        phases.push(ctx.phase);
      });

      const result = await verifiedRequest(httpServer);
      expect(result.type).toBe("payment-verified");
      expect(mockFacilitator.verifyCalls).toHaveLength(1);
      expect(mockFacilitator.settleCalls).toHaveLength(0);

      if (result.type !== "payment-verified") return;
      const settle = await httpServer.processSettlement(
        result.paymentPayload,
        result.paymentRequirements,
        result.declaredExtensions,
        undefined,
        undefined,
        result.beforeHandlerSettlement,
      );
      expect(settle.success).toBe(true);
      expect(mockFacilitator.settleCalls).toHaveLength(1);
      expect(phases).toEqual(["after-handler"]);
    });

    it("upfront: settles before handler and echoes after without a second settle", async () => {
      const httpServer = await setup("upfront");
      const phases: SettlePhase[] = [];
      ResourceServer.onBeforeSettle(async ctx => {
        phases.push(ctx.phase);
      });

      const result = await verifiedRequest(httpServer);
      expect(result.type).toBe("payment-verified");
      expect(mockFacilitator.verifyCalls).toHaveLength(0);
      expect(mockFacilitator.settleCalls).toHaveLength(1);
      expect(phases).toEqual(["before-handler"]);

      if (result.type !== "payment-verified") return;
      expect(result.beforeHandlerSettlement?.phase).toBe("before-handler");
      const settle = await httpServer.processSettlement(
        result.paymentPayload,
        result.paymentRequirements,
        result.declaredExtensions,
        undefined,
        undefined,
        result.beforeHandlerSettlement,
      );
      expect(settle.success).toBe(true);
      if (settle.success) {
        expect(settle.headers["PAYMENT-RESPONSE"]).toBeDefined();
        expect(settle.transaction).toBe("0xtx");
      }
      expect(mockFacilitator.settleCalls).toHaveLength(1);
      expect(phases).toEqual(["before-handler"]);
    });

    it("escrow: settles before and after handler with distinct phases", async () => {
      const httpServer = await setup("escrow");
      const phases: SettlePhase[] = [];
      ResourceServer.onBeforeSettle(async ctx => {
        phases.push(ctx.phase);
      });

      const result = await verifiedRequest(httpServer);
      expect(result.type).toBe("payment-verified");
      expect(mockFacilitator.verifyCalls).toHaveLength(0);
      expect(mockFacilitator.settleCalls).toHaveLength(1);

      if (result.type !== "payment-verified") return;
      expect(result.beforeHandlerSettlement?.phase).toBe("before-handler");
      const settle = await httpServer.processSettlement(
        result.paymentPayload,
        result.paymentRequirements,
        result.declaredExtensions,
        undefined,
        undefined,
        result.beforeHandlerSettlement,
      );
      expect(settle.success).toBe(true);
      expect(mockFacilitator.settleCalls).toHaveLength(2);
      expect(phases).toEqual(["before-handler", "after-handler"]);
    });

    it("validation: verifies before handler and returns success with no PAYMENT-RESPONSE", async () => {
      const httpServer = await setup("validation");
      const phases: SettlePhase[] = [];
      ResourceServer.onBeforeSettle(async ctx => {
        phases.push(ctx.phase);
      });

      const result = await verifiedRequest(httpServer);
      expect(result.type).toBe("payment-verified");
      expect(mockFacilitator.verifyCalls).toHaveLength(1);
      expect(mockFacilitator.settleCalls).toHaveLength(0);

      if (result.type !== "payment-verified") return;
      const settle = await httpServer.processSettlement(
        result.paymentPayload,
        result.paymentRequirements,
        result.declaredExtensions,
        undefined,
        undefined,
        result.beforeHandlerSettlement,
      );
      expect(settle.success).toBe(true);
      if (settle.success) {
        expect(settle.headers).toEqual({});
      }
      expect(mockFacilitator.settleCalls).toHaveLength(0);
      expect(phases).toEqual([]);
    });

    it("warns once when settleBeforeHandler flow is settled without beforeHandlerSettlement", async () => {
      const httpServer = await setup("upfront");
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

      const result = await verifiedRequest(httpServer);
      expect(result.type).toBe("payment-verified");
      if (result.type !== "payment-verified") return;

      // Drop beforeHandlerSettlement: adapters that have not been updated yet.
      const settle1 = await httpServer.processSettlement(
        result.paymentPayload,
        result.paymentRequirements,
      );
      const settle2 = await httpServer.processSettlement(
        result.paymentPayload,
        result.paymentRequirements,
      );

      expect(settle1.success).toBe(true);
      expect(settle2.success).toBe(true);
      if (settle1.success) {
        expect(settle1.headers).toEqual({});
      }
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toContain("without beforeHandlerSettlement");
    });
  });
});
