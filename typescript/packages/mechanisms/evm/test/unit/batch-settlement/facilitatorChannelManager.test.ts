import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { MockedFunction } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import {
  FacilitatorChannelManager,
  type FacilitatorRetention,
} from "../../../src/batch-settlement/facilitator/channelManager";
import type { FacilitatorChannel } from "../../../src/batch-settlement/facilitator/types";
import { InMemoryChannelStorage } from "../../../src/batch-settlement/storage/channel";
import { computeChannelId as computeChannelIdForNetwork } from "../../../src/batch-settlement/utils";
import type { AuthorizerSigner, ChannelConfig } from "../../../src/batch-settlement/types";
import type { FacilitatorEvmSigner } from "../../../src/signer";
import { multicall } from "../../../src/multicall";

vi.mock("../../../src/multicall", async importOriginal => {
  const actual = await importOriginal<typeof import("../../../src/multicall")>();
  return { ...actual, multicall: vi.fn() };
});

const mockedMulticall = multicall as unknown as MockedFunction<typeof multicall>;

const RECEIVER = "0x9876543210987654321098765432109876543210" as `0x${string}`;
const PAYER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as `0x${string}`;
const TOKEN = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as `0x${string}`;
const ZERO = "0x0000000000000000000000000000000000000000" as `0x${string}`;
const NETWORK = "eip155:84532";
const FACILITATOR_ADDRESS = "0xFAC11174700123456789012345678901234aBCDe" as `0x${string}`;

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

function buildChannel(overrides: Partial<FacilitatorChannel> = {}): FacilitatorChannel {
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
    network: NETWORK,
    chargeCount: 2,
    ...overrides,
  };
}

function buildSigner(overrides: Partial<FacilitatorEvmSigner> = {}): FacilitatorEvmSigner {
  return {
    getAddresses: () => [FACILITATOR_ADDRESS],
    readContract: vi.fn().mockResolvedValue(undefined),
    verifyTypedData: vi.fn().mockResolvedValue(true),
    writeContract: vi.fn().mockResolvedValue(("0x" + "ab".repeat(32)) as `0x${string}`),
    sendTransaction: vi.fn(),
    waitForTransactionReceipt: vi.fn().mockResolvedValue({ status: "success" }),
    getCode: vi.fn().mockResolvedValue("0x6080604052"),
    ...overrides,
  };
}

async function storeChannel(
  storage: InMemoryChannelStorage<FacilitatorChannel>,
  channel: FacilitatorChannel,
): Promise<void> {
  await storage.updateChannel(channel.channelId, () => channel);
}

function buildManager(opts?: {
  signer?: FacilitatorEvmSigner;
  authorizerSigner?: AuthorizerSigner;
  storage?: InMemoryChannelStorage<FacilitatorChannel>;
  retention?: FacilitatorRetention;
}): {
  manager: FacilitatorChannelManager;
  signer: FacilitatorEvmSigner;
  storage: InMemoryChannelStorage<FacilitatorChannel>;
  authorizer: AuthorizerSigner;
} {
  const storage = opts?.storage ?? new InMemoryChannelStorage<FacilitatorChannel>();
  const authorizer = opts?.authorizerSigner ?? buildAuthorizerSigner();
  const signer = opts?.signer ?? buildSigner();
  const manager = new FacilitatorChannelManager({
    storage,
    signer,
    authorizerSigner: authorizer,
    retention: opts?.retention,
  });
  return { manager, signer, storage, authorizer };
}

describe("FacilitatorChannelManager — claim()", () => {
  it("returns no results when there are no claimable vouchers", async () => {
    const { manager, signer } = buildManager();
    const results = await manager.claim();
    expect(results).toEqual([]);
    expect(signer.writeContract).not.toHaveBeenCalled();
  });

  it("claims, applies totals, and subtracts attested chargeCount", async () => {
    const { manager, storage, authorizer } = buildManager();
    const config = buildChannelConfig();
    config.receiverAuthorizer = authorizer.address;
    const channel = buildChannel({
      channelConfig: config,
      channelId: computeChannelId(config),
      chargedCumulativeAmount: "5000",
      signedMaxClaimable: "5000",
      chargeCount: 3,
    });
    await storeChannel(storage, channel);

    const results = await manager.claim();
    expect(results).toHaveLength(1);
    expect(results[0].vouchers).toBe(1);

    const updated = await storage.get(channel.channelId);
    expect(updated?.totalClaimed).toBe("5000");
    expect(updated?.chargeCount).toBe(0);
  });

  it("batches claims according to maxClaimsPerBatch", async () => {
    const { manager, storage, authorizer, signer } = buildManager();
    for (const suffix of ["01", "02"]) {
      const config = buildChannelConfig(suffix);
      config.receiverAuthorizer = authorizer.address;
      await storeChannel(
        storage,
        buildChannel({
          channelConfig: config,
          channelId: computeChannelId(config),
          chargedCumulativeAmount: "5000",
          signedMaxClaimable: "5000",
        }),
      );
    }

    const results = await manager.claim({ maxClaimsPerBatch: 1 });
    expect(results).toHaveLength(2);
    expect(signer.writeContract).toHaveBeenCalledTimes(2);
  });

  it("skips channels that are not idle when idleSecs is set", async () => {
    const { manager, storage, authorizer } = buildManager();
    const config = buildChannelConfig();
    config.receiverAuthorizer = authorizer.address;
    const channel = buildChannel({
      channelConfig: config,
      channelId: computeChannelId(config),
      chargedCumulativeAmount: "5000",
      lastRequestTimestamp: Date.now(),
    });
    await storeChannel(storage, channel);

    const results = await manager.claim({ idleSecs: 120 });
    expect(results).toEqual([]);
  });

  it("does not update the store when claim simulation fails", async () => {
    const signer = buildSigner({
      readContract: vi.fn().mockRejectedValue(new Error("execution reverted: NothingToClaim")),
    });
    const { manager, storage, authorizer } = buildManager({ signer });
    const config = buildChannelConfig();
    config.receiverAuthorizer = authorizer.address;
    const channel = buildChannel({
      channelConfig: config,
      channelId: computeChannelId(config),
      chargedCumulativeAmount: "5000",
      chargeCount: 3,
    });
    await storeChannel(storage, channel);

    await expect(manager.claim()).rejects.toThrow(/Claim failed/);
    const stored = await storage.get(channel.channelId);
    expect(stored?.totalClaimed).toBe("0");
    expect(stored?.chargeCount).toBe(3);
    expect(signer.writeContract).not.toHaveBeenCalled();
  });
});

describe("FacilitatorChannelManager — settle()", () => {
  it("throws when onchain settle simulation fails for a claimed receiver pair", async () => {
    const signer = buildSigner({
      readContract: vi.fn().mockImplementation(args => {
        if (args.functionName === "receivers") {
          return Promise.resolve([5000n, 0n]);
        }
        if (args.functionName === "settle") {
          return Promise.reject(new Error("execution reverted"));
        }
        return Promise.resolve(undefined);
      }),
    });
    const { manager, storage, authorizer } = buildManager({ signer });
    const config = buildChannelConfig();
    config.receiverAuthorizer = authorizer.address;
    await storeChannel(
      storage,
      buildChannel({
        channelConfig: config,
        channelId: computeChannelId(config),
        totalClaimed: "5000",
        chargedCumulativeAmount: "5000",
      }),
    );

    await expect(manager.settle()).rejects.toThrow(/Settle failed/);
  });

  it("claims vouchers on each network independently", async () => {
    const { manager, storage, authorizer } = buildManager();
    for (const [suffix, network] of [
      ["01", "eip155:84532"],
      ["02", "eip155:1"],
    ] as const) {
      const config = buildChannelConfig(suffix);
      config.receiverAuthorizer = authorizer.address;
      await storeChannel(
        storage,
        buildChannel({
          channelConfig: config,
          channelId: computeChannelIdForNetwork(config, network),
          network,
          chargedCumulativeAmount: "5000",
          signedMaxClaimable: "5000",
        }),
      );
    }

    const results = await manager.claim();
    expect(results).toHaveLength(2);
    expect(new Set(results.map(r => r.network))).toEqual(new Set(["eip155:84532", "eip155:1"]));
  });

  it("returns an empty settle list from claimAndSettle when nothing is claimable", async () => {
    const { manager } = buildManager();
    const { claims, settle } = await manager.claimAndSettle();
    expect(claims).toEqual([]);
    expect(settle).toEqual([]);
  });

  it("does not throw when onchain receivers are already settled but store rows still have totalClaimed", async () => {
    const signer = buildSigner({
      readContract: vi.fn().mockImplementation(args => {
        if (args.functionName === "receivers") {
          return Promise.resolve([5000n, 5000n]);
        }
        return Promise.resolve(undefined);
      }),
    });
    const { manager, storage } = buildManager({ signer });
    const channel = buildChannel({ totalClaimed: "5000" });
    await storeChannel(storage, channel);

    await expect(manager.settle()).resolves.toEqual([]);
    expect(signer.writeContract).not.toHaveBeenCalled();
  });
});

describe("FacilitatorChannelManager — refund()", () => {
  beforeEach(() => {
    mockedMulticall.mockReset();
    mockedMulticall.mockResolvedValue([
      { status: "success", result: [10000n, 0n] },
      { status: "success", result: [0n, 0n] },
      { status: "success", result: 0n },
    ]);
  });

  it("refunds only the requested channel ids", async () => {
    const { manager, storage, authorizer } = buildManager();
    const configA = buildChannelConfig("01");
    const configB = buildChannelConfig("02");
    configA.receiverAuthorizer = authorizer.address;
    configB.receiverAuthorizer = authorizer.address;
    const channelA = buildChannel({
      channelConfig: configA,
      channelId: computeChannelId(configA),
    });
    const channelB = buildChannel({
      channelConfig: configB,
      channelId: computeChannelId(configB),
    });
    await storeChannel(storage, channelA);
    await storeChannel(storage, channelB);

    const results = await manager.refund([channelA.channelId]);
    expect(results).toHaveLength(1);
    expect(results[0].channel).toBe(channelA.channelId);
  });

  it("skips channels with a live admission lock", async () => {
    const { manager, storage, signer, authorizer } = buildManager();
    const config = buildChannelConfig();
    config.receiverAuthorizer = authorizer.address;
    const channel = buildChannel({
      channelConfig: config,
      channelId: computeChannelId(config),
    });
    await storeChannel(storage, channel);
    await storage.acquire(channel.channelId, "pending", 60_000);

    const results = await manager.refund();
    expect(results).toEqual([]);
    expect(signer.writeContract).not.toHaveBeenCalled();
    expect(await storage.get(channel.channelId)).toBeDefined();
  });

  it("claims outstanding then refunds remaining escrow", async () => {
    const { manager, storage, authorizer } = buildManager();
    const config = buildChannelConfig();
    config.receiverAuthorizer = authorizer.address;
    const channel = buildChannel({
      channelConfig: config,
      channelId: computeChannelId(config),
      chargedCumulativeAmount: "3000",
      signedMaxClaimable: "3000",
      totalClaimed: "0",
      chargeCount: 2,
    });
    await storeChannel(storage, channel);

    const results = await manager.refund();
    expect(results).toHaveLength(1);
    expect(results[0].channel).toBe(channel.channelId);

    const stored = await storage.get(channel.channelId);
    expect(stored).toBeUndefined();
  });

  it("refundIdleChannels ignores channels whose escrow balance is already zero", async () => {
    const { manager, storage, signer, authorizer } = buildManager();
    const config = buildChannelConfig();
    config.receiverAuthorizer = authorizer.address;
    const channel = buildChannel({
      channelConfig: config,
      channelId: computeChannelId(config),
      balance: "0",
      chargedCumulativeAmount: "0",
      totalClaimed: "0",
      lastRequestTimestamp: Date.now() - 120_000,
    });
    await storeChannel(storage, channel);

    const results = await manager.refundIdleChannels({ idleSecs: 60 });
    expect(results).toEqual([]);
    expect(signer.writeContract).not.toHaveBeenCalled();
  });

  it("keeps closed channel rows when retention is forever", async () => {
    const { manager, storage, authorizer } = buildManager({ retention: "forever" });
    const config = buildChannelConfig();
    config.receiverAuthorizer = authorizer.address;
    const channel = buildChannel({
      channelConfig: config,
      channelId: computeChannelId(config),
      chargedCumulativeAmount: "3000",
      signedMaxClaimable: "3000",
      totalClaimed: "0",
      chargeCount: 0,
    });
    await storeChannel(storage, channel);

    await manager.refund();
    expect(await storage.get(channel.channelId)).toBeDefined();
  });

  it("claims outstanding value without refunding when escrow is fully earmarked", async () => {
    const { manager, storage, authorizer, signer } = buildManager();
    const config = buildChannelConfig();
    config.receiverAuthorizer = authorizer.address;
    const channel = buildChannel({
      channelConfig: config,
      channelId: computeChannelId(config),
      chargedCumulativeAmount: "5000",
      signedMaxClaimable: "5000",
      balance: "5000",
      totalClaimed: "0",
      chargeCount: 2,
    });
    await storeChannel(storage, channel);

    const results = await manager.refund();
    expect(results).toHaveLength(1);
    expect(signer.writeContract).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: "claimWithSignature" }),
    );
    expect(signer.writeContract).not.toHaveBeenCalledWith(
      expect.objectContaining({ functionName: "refundWithSignature" }),
    );
    expect(await storage.get(channel.channelId)).toBeUndefined();
  });

  it("does not idle-refund channels whose escrow balance is zero", async () => {
    const { manager, storage, authorizer } = buildManager();
    const config = buildChannelConfig();
    config.receiverAuthorizer = authorizer.address;
    await storeChannel(
      storage,
      buildChannel({
        channelConfig: config,
        channelId: computeChannelId(config),
        balance: "0",
        lastRequestTimestamp: Date.now() - 120_000,
      }),
    );

    expect(await manager.refundIdleChannels({ idleSecs: 60 })).toEqual([]);
  });

  it("keeps a fully closed channel row when retention is forever", async () => {
    mockedMulticall.mockResolvedValue([
      { status: "success", result: [5000n, 5000n] },
      { status: "success", result: [0n, 0n] },
      { status: "success", result: 1n },
    ]);
    const { manager, storage, authorizer } = buildManager({ retention: "forever" });
    const config = buildChannelConfig();
    config.receiverAuthorizer = authorizer.address;
    const channel = buildChannel({
      channelConfig: config,
      channelId: computeChannelId(config),
      chargedCumulativeAmount: "5000",
      signedMaxClaimable: "5000",
      balance: "5000",
      totalClaimed: "5000",
      chargeCount: 0,
    });
    await storeChannel(storage, channel);

    await manager.refund([channel.channelId]);

    expect(await storage.get(channel.channelId)).toBeDefined();
  });

  it("refundIdleChannels only refunds channels idle long enough", async () => {
    const { manager, storage, authorizer } = buildManager();
    const idleConfig = buildChannelConfig("01");
    idleConfig.receiverAuthorizer = authorizer.address;
    const freshConfig = buildChannelConfig("02");
    freshConfig.receiverAuthorizer = authorizer.address;
    const idle = buildChannel({
      channelConfig: idleConfig,
      channelId: computeChannelId(idleConfig),
      lastRequestTimestamp: Date.now() - 120_000,
    });
    const fresh = buildChannel({
      channelConfig: freshConfig,
      channelId: computeChannelId(freshConfig),
      lastRequestTimestamp: Date.now(),
    });
    await storeChannel(storage, idle);
    await storeChannel(storage, fresh);

    const results = await manager.refundIdleChannels({ idleSecs: 60 });
    expect(results).toEqual([
      expect.objectContaining({ channel: idle.channelId, transaction: expect.any(String) }),
    ]);
    expect(await storage.get(fresh.channelId)).toBeDefined();
  });
});

describe("FacilitatorChannelManager — start()/stop() loop", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not invoke onError on settle interval when pendingSettle is false", async () => {
    const signer = buildSigner({
      readContract: vi.fn().mockImplementation(args => {
        if (args.functionName === "receivers") {
          return Promise.resolve([5000n, 5000n]);
        }
        return Promise.resolve(undefined);
      }),
    });
    const { manager, storage } = buildManager({ signer });
    await storeChannel(
      storage,
      buildChannel({
        totalClaimed: "5000",
        chargedCumulativeAmount: "5000",
      }),
    );

    const onError = vi.fn();
    const onSettle = vi.fn();
    manager.start({ settleIntervalSecs: 1, onSettle, onError });

    await vi.advanceTimersByTimeAsync(3500);
    await vi.runAllTicks();
    await manager.stop();

    expect(onSettle).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(signer.readContract).not.toHaveBeenCalled();
  });

  it("schedules configured auto job timers and clears them on stop", async () => {
    const { manager } = buildManager();
    const setIntervalSpy = vi.spyOn(global, "setInterval");
    const clearIntervalSpy = vi.spyOn(global, "clearInterval");

    manager.start({ claimIntervalSecs: 1, settleIntervalSecs: 2, refundIntervalSecs: 3 });
    expect(setIntervalSpy).toHaveBeenCalledTimes(3);

    await manager.stop();
    expect(clearIntervalSpy).toHaveBeenCalledTimes(3);
  });

  it("runs claim then settle then refund in priority order", async () => {
    mockedMulticall.mockResolvedValue([
      { status: "success", result: [10000n, 0n] },
      { status: "success", result: [0n, 0n] },
      { status: "success", result: 0n },
    ]);
    const signer = buildSigner({
      readContract: vi.fn().mockImplementation(args => {
        if (args.functionName === "receivers") return Promise.resolve([5000n, 0n]);
        return Promise.resolve(undefined);
      }),
    });
    const { manager, storage, authorizer } = buildManager({ signer });
    const config = buildChannelConfig();
    config.receiverAuthorizer = authorizer.address;
    await storeChannel(
      storage,
      buildChannel({
        channelConfig: config,
        channelId: computeChannelId(config),
        chargedCumulativeAmount: "5000",
        signedMaxClaimable: "5000",
        lastRequestTimestamp: Date.now() - 120_000,
      }),
    );

    const onClaim = vi.fn();
    const onSettle = vi.fn();
    const onRefund = vi.fn();
    manager.start({
      claimIntervalSecs: 1,
      settleIntervalSecs: 1,
      refundIntervalSecs: 1,
      refundIdleSecs: 60,
      onClaim,
      onSettle,
      onRefund,
    });

    await vi.advanceTimersByTimeAsync(1100);
    await vi.runAllTicks();
    await manager.stop();

    expect(onClaim).toHaveBeenCalled();
    expect(onSettle).toHaveBeenCalled();
    expect(onRefund).toHaveBeenCalled();
  });

  it("runs the generic refund auto job when refundIdleSecs is not configured", async () => {
    mockedMulticall.mockResolvedValue([
      { status: "success", result: [10000n, 0n] },
      { status: "success", result: [0n, 0n] },
      { status: "success", result: 0n },
    ]);
    const { manager, storage, authorizer } = buildManager();
    const config = buildChannelConfig();
    config.receiverAuthorizer = authorizer.address;
    await storeChannel(
      storage,
      buildChannel({
        channelConfig: config,
        channelId: computeChannelId(config),
        chargedCumulativeAmount: "3000",
        signedMaxClaimable: "3000",
        totalClaimed: "3000",
        balance: "10000",
        chargeCount: 0,
      }),
    );

    const onRefund = vi.fn();
    manager.start({ refundIntervalSecs: 1, onRefund });
    await vi.advanceTimersByTimeAsync(1100);
    await vi.runAllTicks();
    await manager.stop();

    expect(onRefund).toHaveBeenCalled();
  });

  it("does not enqueue auto jobs after stop", async () => {
    const { manager } = buildManager();
    const onClaim = vi.fn();
    manager.start({ claimIntervalSecs: 1, onClaim });
    await manager.stop();
    await vi.advanceTimersByTimeAsync(5000);
    await vi.runAllTicks();
    expect(onClaim).not.toHaveBeenCalled();
  });

  it("invokes onError when an auto refund job fails", async () => {
    mockedMulticall.mockRejectedValue(new Error("execution reverted: RefundFailed"));
    const { manager, storage, authorizer } = buildManager();
    const config = buildChannelConfig();
    config.receiverAuthorizer = authorizer.address;
    await storeChannel(
      storage,
      buildChannel({
        channelConfig: config,
        channelId: computeChannelId(config),
        lastRequestTimestamp: Date.now() - 120_000,
      }),
    );

    const onError = vi.fn();
    manager.start({ refundIntervalSecs: 1, refundIdleSecs: 60, onError });
    await vi.advanceTimersByTimeAsync(1100);
    await vi.runAllTicks();
    await manager.stop();

    expect(onError).toHaveBeenCalled();
  });

  it("invokes onError when an auto settle job fails after a claim batch", async () => {
    const signer = buildSigner({
      readContract: vi.fn().mockImplementation(args => {
        if (args.functionName === "receivers") {
          return Promise.resolve([5000n, 0n]);
        }
        if (args.functionName === "settle") {
          return Promise.reject(new Error("execution reverted"));
        }
        return Promise.resolve(undefined);
      }),
    });
    const { manager, storage, authorizer } = buildManager({ signer });
    const config = buildChannelConfig();
    config.receiverAuthorizer = authorizer.address;
    await storeChannel(
      storage,
      buildChannel({
        channelConfig: config,
        channelId: computeChannelId(config),
        chargedCumulativeAmount: "5000",
        signedMaxClaimable: "5000",
      }),
    );

    const onError = vi.fn();
    manager.start({ claimIntervalSecs: 1, settleIntervalSecs: 1, onError });
    await vi.advanceTimersByTimeAsync(2500);
    await vi.runAllTicks();
    await manager.stop();

    expect(onError).toHaveBeenCalled();
  });

  it("invokes onError when an auto claim job fails", async () => {
    const signer = buildSigner({
      readContract: vi.fn().mockRejectedValue(new Error("execution reverted: NothingToClaim")),
    });
    const { manager, storage, authorizer } = buildManager({ signer });
    const config = buildChannelConfig();
    config.receiverAuthorizer = authorizer.address;
    await storeChannel(
      storage,
      buildChannel({
        channelConfig: config,
        channelId: computeChannelId(config),
        chargedCumulativeAmount: "5000",
        signedMaxClaimable: "5000",
      }),
    );

    const onError = vi.fn();
    manager.start({ claimIntervalSecs: 1, onError });
    await vi.advanceTimersByTimeAsync(1100);
    await vi.runAllTicks();
    await manager.stop();

    expect(onError).toHaveBeenCalled();
  });

  it("does not start twice when start is called while already running", async () => {
    const { manager } = buildManager();
    const setIntervalSpy = vi.spyOn(global, "setInterval");
    manager.start({ claimIntervalSecs: 5 });
    manager.start({ claimIntervalSecs: 5 });
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    await manager.stop();
  });

  it("flushes a pending claim batch when stop is called with flush", async () => {
    const signer = buildSigner({
      readContract: vi.fn().mockImplementation(args => {
        if (args.functionName === "receivers") {
          return Promise.resolve([5000n, 0n]);
        }
        if (args.functionName === "settle") {
          return Promise.resolve(undefined);
        }
        return Promise.resolve(undefined);
      }),
    });
    const { manager, storage, authorizer } = buildManager({ signer });
    const config = buildChannelConfig();
    config.receiverAuthorizer = authorizer.address;
    await storeChannel(
      storage,
      buildChannel({
        channelConfig: config,
        channelId: computeChannelId(config),
        chargedCumulativeAmount: "5000",
        signedMaxClaimable: "5000",
      }),
    );

    manager.start({ claimIntervalSecs: 60 });
    await manager.stop({ flush: true });

    const updated = await storage.get(computeChannelId(config));
    expect(updated?.totalClaimed).toBe("5000");
  });
});
