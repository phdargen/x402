import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { MockedFunction } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import {
  BatchSettlementChannelManager,
  type ClaimResult,
  type SettleResult,
  type RefundResult,
} from "../../../src/batch-settlement/server/channelManager";
import { BatchSettlementEvmScheme } from "../../../src/batch-settlement/server/scheme";
import { InMemoryChannelStorage, type Channel } from "../../../src/batch-settlement/server/storage";
import { computeChannelId as computeChannelIdForNetwork } from "../../../src/batch-settlement/utils";
import type { ChannelConfig, AuthorizerSigner } from "../../../src/batch-settlement/types";
import type { FacilitatorClient } from "@x402/core/server";
import type {
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  VerifyResponse,
  SupportedResponse,
} from "@x402/core/types";

const RECEIVER = "0x9876543210987654321098765432109876543210" as `0x${string}`;
const PAYER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as `0x${string}`;
const TOKEN = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as `0x${string}`;
const ZERO = "0x0000000000000000000000000000000000000000" as `0x${string}`;
const NETWORK = "eip155:84532";

function computeChannelId(config: ChannelConfig): `0x${string}` {
  return computeChannelIdForNetwork(config, NETWORK);
}

function buildAuthorizerSigner(): AuthorizerSigner {
  const account = privateKeyToAccount(
    "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  );
  return {
    address: account.address,
    signTypedData: msg =>
      account.signTypedData({
        domain: msg.domain,
        types: msg.types,
        primaryType: msg.primaryType,
        message: msg.message,
      } as Parameters<typeof account.signTypedData>[0]),
  };
}

function buildChannelConfig(saltSuffix = "00"): ChannelConfig {
  const salt = `0x${"00".repeat(31)}${saltSuffix.padStart(2, "0")}` as `0x${string}`;
  return {
    payer: PAYER,
    payerAuthorizer: ZERO,
    receiver: RECEIVER,
    receiverAuthorizer: ZERO,
    token: TOKEN,
    withdrawDelay: 900,
    salt,
  };
}

function buildSession(overrides: Partial<Channel> = {}): Channel {
  const config = overrides.channelConfig ?? buildChannelConfig();
  const channelId = overrides.channelId ?? computeChannelId(config);
  return {
    channelId,
    channelConfig: config,
    chargedCumulativeAmount: "1000",
    signedMaxClaimable: "1000",
    signature: "0xdeadbeef",
    balance: "10000",
    totalClaimed: "0",
    withdrawRequestedAt: 0,
    refundNonce: 0,
    lastRequestTimestamp: Date.now(),
    ...overrides,
  };
}

async function storeChannel(storage: InMemoryChannelStorage, channel: Channel): Promise<void> {
  await storage.updateChannel(channel.channelId, () => channel);
}

type FakeFacilitator = FacilitatorClient & {
  verify: MockedFunction<FacilitatorClient["verify"]>;
  settle: MockedFunction<FacilitatorClient["settle"]>;
  getSupported: MockedFunction<FacilitatorClient["getSupported"]>;
};

function buildFacilitator(
  settleImpl: (
    payload: PaymentPayload,
    reqs: PaymentRequirements,
  ) => Promise<SettleResponse> = async (_, reqs) => ({
    success: true,
    transaction: "0xtx",
    network: reqs.network,
  }),
): FakeFacilitator {
  return {
    verify: vi.fn<FacilitatorClient["verify"]>(
      async () =>
        ({
          isValid: true,
        }) as VerifyResponse,
    ),
    settle: vi.fn<FacilitatorClient["settle"]>(settleImpl),
    getSupported: vi.fn<FacilitatorClient["getSupported"]>(
      async () =>
        ({
          kinds: [],
        }) as unknown as SupportedResponse,
    ),
  };
}

function buildManager(opts?: {
  authorizerSigner?: AuthorizerSigner;
  facilitator?: FakeFacilitator;
  storage?: InMemoryChannelStorage;
}): {
  manager: BatchSettlementChannelManager;
  scheme: BatchSettlementEvmScheme;
  facilitator: FakeFacilitator;
  storage: InMemoryChannelStorage;
} {
  const storage = opts?.storage ?? new InMemoryChannelStorage();
  const scheme = new BatchSettlementEvmScheme(RECEIVER, {
    storage,
    receiverAuthorizerSigner: opts?.authorizerSigner,
  });
  const facilitator = opts?.facilitator ?? buildFacilitator();
  const manager = new BatchSettlementChannelManager({
    scheme,
    facilitator,
    receiver: RECEIVER,
    token: TOKEN,
    network: NETWORK,
  });
  return { manager, scheme, facilitator, storage };
}

describe("BatchSettlementChannelManager — claim()", () => {
  it("returns no results when there are no claimable vouchers", async () => {
    const { manager, facilitator } = buildManager();
    const results = await manager.claim();
    expect(results).toEqual([]);
    expect(facilitator.settle).not.toHaveBeenCalled();
  });

  it("submits a single claim batch when claimable vouchers exist", async () => {
    const { manager, storage, facilitator } = buildManager();
    const session = buildSession({ chargedCumulativeAmount: "5000", totalClaimed: "0" });
    await storeChannel(storage, session);

    const results = await manager.claim();
    expect(results).toHaveLength(1);
    expect(results[0].vouchers).toBe(1);
    expect(results[0].transaction).toBe("0xtx");

    expect(facilitator.settle).toHaveBeenCalledTimes(1);
    const [paymentPayload] = facilitator.settle.mock.calls[0];
    const payload = paymentPayload.payload as Record<string, unknown>;
    expect(payload.type).toBe("claim");
    expect(payload.claims).toHaveLength(1);
  });

  it("splits claims across multiple batches respecting maxClaimsPerBatch", async () => {
    const { manager, storage, facilitator } = buildManager();
    for (let i = 0; i < 5; i++) {
      const config = buildChannelConfig(i.toString(16));
      await storeChannel(
        storage,
        buildSession({
          channelConfig: config,
          channelId: computeChannelId(config),
          chargedCumulativeAmount: String(1000 * (i + 1)),
          totalClaimed: "0",
        }),
      );
    }

    const results = await manager.claim({ maxClaimsPerBatch: 2 });
    expect(results).toHaveLength(3);
    expect(results.map(r => r.vouchers)).toEqual([2, 2, 1]);
    expect(facilitator.settle).toHaveBeenCalledTimes(3);
  });

  it("skips sessions that are not idle long enough when idleSecs is set", async () => {
    const { manager, storage, facilitator } = buildManager();
    const fresh = buildSession({
      chargedCumulativeAmount: "5000",
      lastRequestTimestamp: Date.now(),
    });
    await storeChannel(storage, fresh);

    const results = await manager.claim({ idleSecs: 60 });
    expect(results).toEqual([]);
    expect(facilitator.settle).not.toHaveBeenCalled();
  });

  it("updates session.totalClaimed after a successful claim", async () => {
    const { manager, storage } = buildManager();
    const session = buildSession({ chargedCumulativeAmount: "5000", totalClaimed: "0" });
    await storeChannel(storage, session);

    await manager.claim();

    const updated = await storage.get(session.channelId);
    expect(updated?.totalClaimed).toBe("5000");
  });

  it("includes a claim authorizer signature when an authorizer signer is configured", async () => {
    const authorizer = buildAuthorizerSigner();
    const config = buildChannelConfig();
    const channelId = computeChannelId({ ...config, receiverAuthorizer: authorizer.address });
    const { manager, storage, facilitator } = buildManager({ authorizerSigner: authorizer });
    await storeChannel(
      storage,
      buildSession({
        channelId,
        channelConfig: { ...config, receiverAuthorizer: authorizer.address },
        chargedCumulativeAmount: "5000",
      }),
    );

    await manager.claim();

    const [paymentPayload] = facilitator.settle.mock.calls[0];
    const payload = paymentPayload.payload as Record<string, unknown>;
    expect(payload.claimAuthorizerSignature).toMatch(/^0x[0-9a-f]+$/i);
  });

  it("propagates a facilitator failure as a thrown error and leaves session intact", async () => {
    const facilitator = buildFacilitator(async () => ({
      success: false,
      errorReason: "boom",
      errorMessage: "Claim reverted",
      transaction: "",
      network: NETWORK,
    }));
    const { manager, storage } = buildManager({ facilitator });
    const session = buildSession({ chargedCumulativeAmount: "5000" });
    await storeChannel(storage, session);

    await expect(manager.claim()).rejects.toThrow(/Claim failed/);

    const stored = await storage.get(session.channelId);
    expect(stored?.totalClaimed).toBe("0");
  });
});

describe("BatchSettlementChannelManager — settle()", () => {
  it('calls the facilitator with a type="settle" payload', async () => {
    const { manager, facilitator } = buildManager();
    const result = await manager.settle();

    expect(result.transaction).toBe("0xtx");
    const [paymentPayload, reqs] = facilitator.settle.mock.calls[0];
    expect((paymentPayload.payload as Record<string, unknown>).type).toBe("settle");
    expect((paymentPayload.payload as Record<string, unknown>).receiver).toBe(RECEIVER);
    expect((paymentPayload.payload as Record<string, unknown>).token).toBe(TOKEN);
    expect(reqs.network).toBe(NETWORK);
  });

  it("throws when the facilitator reports a failure", async () => {
    const facilitator = buildFacilitator(async () => ({
      success: false,
      errorReason: "boom",
      errorMessage: "settle reverted",
      transaction: "",
      network: NETWORK,
    }));
    const { manager } = buildManager({ facilitator });
    await expect(manager.settle()).rejects.toThrow(/Settle failed/);
  });
});

describe("BatchSettlementChannelManager — claimAndSettle()", () => {
  it("returns only the empty claims when no claimable vouchers exist", async () => {
    const { manager, facilitator } = buildManager();
    const result = await manager.claimAndSettle();
    expect(result.claims).toEqual([]);
    expect(result.settle).toBeUndefined();
    expect(facilitator.settle).not.toHaveBeenCalled();
  });

  it("runs both claim and settle when there are claimable vouchers", async () => {
    const { manager, storage, facilitator } = buildManager();
    const session = buildSession({ chargedCumulativeAmount: "5000" });
    await storeChannel(storage, session);

    const result = await manager.claimAndSettle();
    expect(result.claims).toHaveLength(1);
    expect(result.settle?.transaction).toBe("0xtx");
    expect(facilitator.settle).toHaveBeenCalledTimes(2);
  });
});

describe("BatchSettlementChannelManager — refund()", () => {
  it("returns no channels when storage is empty", async () => {
    const { manager, facilitator } = buildManager();
    const result = await manager.refund();
    expect(result.channels).toEqual([]);
    expect(result.transaction).toBe("");
    expect(facilitator.settle).not.toHaveBeenCalled();
  });

  it("filters by provided channel ids (case-insensitive)", async () => {
    const { manager, storage, facilitator } = buildManager();
    const session = buildSession({ chargedCumulativeAmount: "1000", balance: "10000" });
    await storeChannel(storage, session);

    const idUpper = session.channelId.toUpperCase().replace("0X", "0x");
    const result = await manager.refund([idUpper]);

    expect(result.channels).toEqual([session.channelId]);
    expect(facilitator.settle).toHaveBeenCalledTimes(1);
    const [paymentPayload] = facilitator.settle.mock.calls[0];
    const payload = paymentPayload.payload as Record<string, unknown>;
    expect(payload.type).toBe("refund");
    expect(payload.amount).toBe("9000");
    expect(payload.chargedCumulativeAmount).toBeUndefined();
  });

  it("includes outstanding voucher claims and deletes session on success", async () => {
    const { manager, storage } = buildManager();
    const session = buildSession({
      chargedCumulativeAmount: "3000",
      totalClaimed: "1000",
      balance: "10000",
    });
    await storeChannel(storage, session);

    await manager.refund();

    const stored = await storage.get(session.channelId);
    expect(stored).toBeUndefined();
  });

  it("throws when facilitator reports failure", async () => {
    const facilitator = buildFacilitator(async () => ({
      success: false,
      errorReason: "boom",
      errorMessage: "refund reverted",
      transaction: "",
      network: NETWORK,
    }));
    const { manager, storage } = buildManager({ facilitator });
    const session = buildSession({ chargedCumulativeAmount: "1000", balance: "10000" });
    await storeChannel(storage, session);

    await expect(manager.refund()).rejects.toThrow(/Refund failed/);

    const stored = await storage.get(session.channelId);
    expect(stored).toBeDefined();
  });
});

describe("BatchSettlementChannelManager — start()/stop() loop", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("schedules a periodic tick when started and clears it on stop", async () => {
    const { manager } = buildManager();
    const setIntervalSpy = vi.spyOn(global, "setInterval");
    const clearIntervalSpy = vi.spyOn(global, "clearInterval");

    manager.start({ tickSecs: 1 });
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);

    await manager.stop();
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
  });

  it("is a no-op to call start twice (single timer)", () => {
    const { manager } = buildManager();
    const setIntervalSpy = vi.spyOn(global, "setInterval");

    manager.start({ tickSecs: 1 });
    manager.start({ tickSecs: 1 });
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
  });

  it("flushes pending claims and settles on stop({ flush: true })", async () => {
    const { manager, storage, facilitator } = buildManager();
    const session = buildSession({ chargedCumulativeAmount: "5000" });
    await storeChannel(storage, session);

    manager.start({ tickSecs: 60 });
    await manager.stop({ flush: true });

    expect(facilitator.settle).toHaveBeenCalledTimes(2);
  });

  it("invokes onRefund callback when refundOnShutdown produces channels", async () => {
    const { manager, storage } = buildManager();
    const session = buildSession({ chargedCumulativeAmount: "1000", balance: "10000" });
    await storeChannel(storage, session);

    const onRefund = vi.fn<(r: RefundResult) => void>();
    manager.start({ tickSecs: 60, refundOnShutdown: true, onRefund });
    await manager.stop({ flush: true });

    expect(onRefund).toHaveBeenCalledTimes(1);
    expect(onRefund.mock.calls[0][0].channels).toContain(session.channelId);
  });

  it("forwards refund-on-shutdown errors to onError callback", async () => {
    const facilitator = buildFacilitator(async payload => {
      const action = (payload.payload as Record<string, unknown>).type;
      if (action === "refund") {
        return {
          success: false,
          errorReason: "boom",
          errorMessage: "refund reverted",
          transaction: "",
          network: NETWORK,
        };
      }
      return { success: true, transaction: "0xtx", network: NETWORK };
    });
    const { manager, storage } = buildManager({ facilitator });
    const session = buildSession({ chargedCumulativeAmount: "1000", balance: "10000" });
    await storeChannel(storage, session);

    const onError = vi.fn<(e: unknown) => void>();
    manager.start({ tickSecs: 60, refundOnShutdown: true, onError });
    await manager.stop({ flush: true });

    expect(onError).toHaveBeenCalled();
  });
});

describe("BatchSettlementChannelManager — auto-loop tick policies", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("triggers a claim without settling in the same tick", async () => {
    const { manager, storage, facilitator } = buildManager();
    const session = buildSession({ chargedCumulativeAmount: "5000" });
    await storeChannel(storage, session);

    const onClaim = vi.fn<(r: ClaimResult) => void>();
    const onSettle = vi.fn<(r: SettleResult) => void>();
    manager.start({
      tickSecs: 1,
      claimIntervalSecs: 1,
      settleIntervalSecs: 1,
      onClaim,
      onSettle,
    });

    await vi.advanceTimersByTimeAsync(1100);
    await vi.runAllTicks();

    await manager.stop();
    expect(onClaim).toHaveBeenCalled();
    expect(onSettle).not.toHaveBeenCalled();
    const settleTypes = facilitator.settle.mock.calls.map(
      ([p]) => (p.payload as Record<string, unknown>).type,
    );
    expect(settleTypes).toEqual(["claim"]);
  });

  it("triggers a settle once settleIntervalSecs elapses after a claim", async () => {
    const { manager, storage, facilitator } = buildManager();
    const session = buildSession({ chargedCumulativeAmount: "5000" });
    await storeChannel(storage, session);

    const onSettle = vi.fn<(r: SettleResult) => void>();
    manager.start({
      tickSecs: 1,
      claimIntervalSecs: 1,
      settleIntervalSecs: 1,
      onSettle,
    });

    await vi.advanceTimersByTimeAsync(2200);
    await vi.runAllTicks();

    await manager.stop();
    expect(onSettle).toHaveBeenCalled();
    const settleTypes = facilitator.settle.mock.calls.map(
      ([p]) => (p.payload as Record<string, unknown>).type,
    );
    expect(settleTypes).toContain("settle");
  });

  it("invokes onError when a tick step throws", async () => {
    const facilitator = buildFacilitator(async () => {
      throw new Error("network down");
    });
    const { manager, storage } = buildManager({ facilitator });
    const session = buildSession({ chargedCumulativeAmount: "5000" });
    await storeChannel(storage, session);

    const onError = vi.fn<(e: unknown) => void>();
    manager.start({ tickSecs: 1, claimIntervalSecs: 1, onError });

    await vi.advanceTimersByTimeAsync(1100);
    await vi.runAllTicks();

    await manager.stop();
    expect(onError).toHaveBeenCalled();
  });
});
