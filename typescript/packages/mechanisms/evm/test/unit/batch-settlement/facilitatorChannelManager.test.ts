import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { MockedFunction } from "vitest";
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  type Hex,
  type Log,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  FacilitatorChannelManager,
  type FacilitatorRetention,
} from "../../../src/batch-settlement/facilitator/channelManager";
import type { FacilitatorChannel } from "../../../src/batch-settlement/facilitator/types";
import { InMemoryChannelStorage } from "../../../src/batch-settlement/storage/channel";
import { batchSettlementABI } from "../../../src/batch-settlement/abi";
import { BATCH_SETTLEMENT_ADDRESS } from "../../../src/batch-settlement/constants";
import { computeChannelId as computeChannelIdForNetwork } from "../../../src/batch-settlement/utils";
import type { AuthorizerSigner, ChannelConfig } from "../../../src/batch-settlement/types";
import type { FacilitatorContext } from "@x402/core/types";
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

type WriteCall = { functionName: string; args: readonly unknown[] };
type ContractClaimRow = { voucher: { channel: ChannelConfig }; totalClaimed: bigint };

/**
 * Returns the claim rows of a claim or `multicall([claim, refund])` write, in call order.
 *
 * @param write - Arguments of a `writeContract` call.
 * @returns Claim rows.
 */
function claimRowsOf(write: WriteCall): readonly ContractClaimRow[] {
  if (write.functionName === "claim" || write.functionName === "claimWithSignature") {
    return write.args[0] as readonly ContractClaimRow[];
  }
  if (write.functionName === "multicall") {
    return (write.args[0] as readonly Hex[]).flatMap(data => {
      const decoded = decodeFunctionData({ abi: batchSettlementABI, data });
      return decoded.functionName === "claim" || decoded.functionName === "claimWithSignature"
        ? (decoded.args[0] as readonly ContractClaimRow[])
        : [];
    });
  }
  return [];
}

function buildClaimedLog(channelId: `0x${string}`, newTotalClaimed: bigint): Log {
  return {
    address: BATCH_SETTLEMENT_ADDRESS,
    topics: encodeEventTopics({
      abi: batchSettlementABI,
      eventName: "Claimed",
      args: { channelId, sender: RECEIVER },
    }),
    data: encodeAbiParameters([{ type: "uint128" }, { type: "uint128" }], [1n, newTotalClaimed]),
    blockHash: null,
    blockNumber: null,
    logIndex: null,
    transactionHash: null,
    transactionIndex: null,
    removed: false,
  } as Log;
}

/**
 * Builds a receipt in which every claim row of the write emitted `Claimed`.
 *
 * @param write - Arguments of a `writeContract` call.
 * @param skip - Channel ids whose rows were a no-op and emitted nothing.
 * @returns Successful receipt with the `Claimed` logs.
 */
function claimedReceipt(write: WriteCall, skip: readonly `0x${string}`[] = []) {
  const skipped = new Set(skip.map(id => id.toLowerCase()));
  const logs = claimRowsOf(write)
    .map(row => ({
      channelId: computeChannelIdForNetwork(row.voucher.channel, NETWORK),
      totalClaimed: row.totalClaimed,
    }))
    .filter(({ channelId }) => !skipped.has(channelId.toLowerCase()))
    .map(({ channelId, totalClaimed }) => buildClaimedLog(channelId, totalClaimed));
  return { status: "success", logs };
}

/**
 * Builds a builder-code extension context that records the `m` metadata it is asked to encode.
 *
 * @param suffix - Suffix returned whenever metadata is present.
 * @returns Facilitator context and the recorded metadata per resolution.
 */
function metadataContext(suffix: `0x${string}` = "0x8021abcd") {
  const recorded: unknown[] = [];
  const context: FacilitatorContext = {
    getExtension: () => ({
      key: "builder-code",
      buildDataSuffix: (ctx: { metadata?: unknown }) => {
        recorded.push(ctx.metadata);
        return ctx.metadata ? suffix : undefined;
      },
    }),
  } as unknown as FacilitatorContext;
  return { context, recorded, suffix };
}

function buildSigner(overrides: Partial<FacilitatorEvmSigner> = {}): FacilitatorEvmSigner {
  const writeContract =
    overrides.writeContract ??
    (vi.fn().mockResolvedValue(("0x" + "ab".repeat(32)) as `0x${string}`) as ReturnType<
      typeof vi.fn
    >);
  const lastWrite = (): WriteCall | undefined =>
    (writeContract as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0];
  return {
    getAddresses: () => [FACILITATOR_ADDRESS],
    readContract: vi.fn().mockResolvedValue(undefined),
    verifyTypedData: vi.fn().mockResolvedValue(true),
    writeContract,
    sendTransaction: vi.fn(),
    waitForTransactionReceipt: vi.fn().mockImplementation(async () => {
      const write = lastWrite();
      return write ? claimedReceipt(write) : { status: "success" };
    }),
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
  context?: FacilitatorContext;
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
    context: opts?.context,
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
    const { context, recorded, suffix } = metadataContext();
    const { manager, storage, authorizer, signer } = buildManager({ context });
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

    const write = (signer.writeContract as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      dataSuffix?: `0x${string}`;
    };
    expect(write.dataSuffix).toBe(suffix);
    expect(recorded).toEqual([{ x402ChargeCounts: [3n] }]);
  });

  it("sends no suffix when no builder-code extension is registered", async () => {
    const { manager, storage, authorizer, signer } = buildManager();
    const config = buildChannelConfig();
    config.receiverAuthorizer = authorizer.address;
    const channel = buildChannel({
      channelConfig: config,
      channelId: computeChannelId(config),
      chargedCumulativeAmount: "5000",
      signedMaxClaimable: "5000",
      chargeCount: 1,
    });
    await storeChannel(storage, channel);

    await manager.claim();
    const write = (signer.writeContract as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      dataSuffix?: `0x${string}`;
    };
    expect(write.dataSuffix).toBeUndefined();
    expect((await storage.get(channel.channelId))?.chargeCount).toBe(0);
  });

  it("carries one count per row in a single suffix next to builder-code", async () => {
    const { context, recorded, suffix } = metadataContext("0x8021beef");
    const { manager, storage, authorizer, signer } = buildManager({ context });
    const counts = [1, 5];
    for (const [index, chargeCount] of counts.entries()) {
      const config = buildChannelConfig(`0${index + 1}`);
      config.receiverAuthorizer = authorizer.address;
      await storeChannel(
        storage,
        buildChannel({
          channelConfig: config,
          channelId: computeChannelId(config),
          chargedCumulativeAmount: "5000",
          signedMaxClaimable: "5000",
          chargeCount,
        }),
      );
    }

    await manager.claim();
    const write = (signer.writeContract as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      dataSuffix?: `0x${string}`;
    };
    expect(write.dataSuffix).toBe(suffix);
    const [metadata] = recorded as [{ x402ChargeCounts: bigint[] }];
    expect([...metadata.x402ChargeCounts].sort()).toEqual([1n, 5n]);
  });

  it("subtracts only rows that emitted Claimed and keeps no-op counts pending", async () => {
    const storage = new InMemoryChannelStorage<FacilitatorChannel>();
    const authorizer = buildAuthorizerSigner();
    const channels: FacilitatorChannel[] = [];
    for (const [index, chargeCount] of [4, 2, 7].entries()) {
      const config = buildChannelConfig(`0${index + 1}`);
      config.receiverAuthorizer = authorizer.address;
      const channel = buildChannel({
        channelConfig: config,
        channelId: computeChannelId(config),
        chargedCumulativeAmount: "5000",
        signedMaxClaimable: "5000",
        chargeCount,
      });
      channels.push(channel);
      await storeChannel(storage, channel);
    }
    // The second channel's row turned into a no-op onchain: it emits no `Claimed`.
    const noOp = channels[1].channelId;
    const writeContract = vi.fn().mockResolvedValue(("0x" + "ab".repeat(32)) as `0x${string}`);
    const signer = buildSigner({
      writeContract,
      waitForTransactionReceipt: vi
        .fn()
        .mockImplementation(async () => claimedReceipt(writeContract.mock.calls[0][0], [noOp])),
    });
    const { manager } = buildManager({ signer, authorizerSigner: authorizer, storage });

    await manager.claim();

    const counts = await Promise.all(
      channels.map(async channel => (await storage.get(channel.channelId))?.chargeCount),
    );
    expect(counts).toEqual([0, 2, 0]);
  });

  it("subtracts nothing when the claim emitted no Claimed events", async () => {
    const storage = new InMemoryChannelStorage<FacilitatorChannel>();
    const authorizer = buildAuthorizerSigner();
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
    const signer = buildSigner({
      waitForTransactionReceipt: vi.fn().mockResolvedValue({ status: "success", logs: [] }),
    });
    const { manager } = buildManager({ signer, authorizerSigner: authorizer, storage });

    await manager.claim();

    const stored = await storage.get(channel.channelId);
    expect(stored?.totalClaimed).toBe("5000");
    expect(stored?.chargeCount).toBe(3);
  });

  it("preserves in-flight chargeCount increments across the encoded snapshot", async () => {
    const storage = new InMemoryChannelStorage<FacilitatorChannel>();
    const config = buildChannelConfig();
    const authorizer = buildAuthorizerSigner();
    config.receiverAuthorizer = authorizer.address;
    const channel = buildChannel({
      channelConfig: config,
      channelId: computeChannelId(config),
      chargedCumulativeAmount: "5000",
      signedMaxClaimable: "5000",
      chargeCount: 3,
    });
    await storeChannel(storage, channel);
    const signer = buildSigner({
      writeContract: vi.fn().mockImplementation(async () => {
        await storage.updateChannel(channel.channelId, current =>
          current ? { ...current, chargeCount: current.chargeCount + 2 } : current,
        );
        return ("0x" + "ab".repeat(32)) as `0x${string}`;
      }),
    });
    const { context, recorded } = metadataContext();
    const { manager } = buildManager({ signer, authorizerSigner: authorizer, storage, context });

    await manager.claim();

    expect((await storage.get(channel.channelId))?.chargeCount).toBe(2);
    expect(recorded).toEqual([{ x402ChargeCounts: [3n] }]);
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

  it("uses storage.query when implemented instead of listing every row", async () => {
    const inner = new InMemoryChannelStorage<FacilitatorChannel>();
    const authorizer = buildAuthorizerSigner();
    const skippedConfig = buildChannelConfig("01");
    skippedConfig.receiverAuthorizer = authorizer.address;
    const selectedConfig = buildChannelConfig("02");
    selectedConfig.receiverAuthorizer = authorizer.address;
    const skipped = buildChannel({
      channelConfig: skippedConfig,
      channelId: computeChannelId(skippedConfig),
      chargedCumulativeAmount: "5000",
      signedMaxClaimable: "5000",
    });
    const selected = buildChannel({
      channelConfig: selectedConfig,
      channelId: computeChannelId(selectedConfig),
      chargedCumulativeAmount: "5000",
      signedMaxClaimable: "5000",
    });
    await storeChannel(inner, skipped);
    await storeChannel(inner, selected);
    const query = vi.fn(async () => ({ items: [selected] }));
    const storage = Object.assign(inner, { query });
    const { manager, signer } = buildManager({ storage, authorizerSigner: authorizer });

    const results = await manager.claim();

    expect(query).toHaveBeenCalledWith({ kind: "claimable" }, undefined);
    expect(results).toHaveLength(1);
    expect(signer.writeContract).toHaveBeenCalledTimes(1);
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

  it("appends builder-code on a scheduled settle when context is provided", async () => {
    const builderSuffix = "0x8021abcd" as `0x${string}`;
    const signer = buildSigner({
      readContract: vi.fn().mockImplementation(args => {
        if (args.functionName === "receivers") {
          return Promise.resolve([5000n, 0n]);
        }
        return Promise.resolve(undefined);
      }),
    });
    const { manager, storage, authorizer } = buildManager({
      signer,
      context: {
        getExtension: () => ({
          key: "builder-code",
          buildDataSuffix: () => builderSuffix,
        }),
      },
    });
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

    const results = await manager.settle();
    expect(results).toHaveLength(1);
    expect(signer.writeContract).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: "settle", dataSuffix: builderSuffix }),
    );
  });

  it("uses storage.settleQuery when implemented instead of scanning claimed rows", async () => {
    const inner = new InMemoryChannelStorage<FacilitatorChannel>();
    await storeChannel(inner, buildChannel({ totalClaimed: "5000" }));
    const settleQuery = vi.fn(async () => ({ items: [] }));
    const storage = Object.assign(inner, { settleQuery });
    const { manager, signer } = buildManager({ storage });

    await expect(manager.settle()).resolves.toEqual([]);
    expect(settleQuery).toHaveBeenCalledWith({}, undefined);
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

  it("refunds remaining-escrow channels", async () => {
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

    const results = await manager.refund();
    expect(results.map(result => result.channel).sort()).toEqual(
      [channelA.channelId, channelB.channelId].sort(),
    );
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
    expect(stored).toBeDefined();
    expect(stored?.totalClaimed).toBe("3000");
    expect(stored?.chargeCount).toBe(0);
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
    const { context, recorded, suffix } = metadataContext();
    const { manager, storage, authorizer, signer } = buildManager({ context });
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
    const stored = await storage.get(channel.channelId);
    expect(stored).toBeDefined();
    expect(stored?.totalClaimed).toBe("5000");
    expect(stored?.chargeCount).toBe(0);
    const write = (signer.writeContract as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      dataSuffix?: `0x${string}`;
    };
    expect(write.dataSuffix).toBe(suffix);
    expect(recorded).toEqual([{ x402ChargeCounts: [2n] }]);
  });

  it("carries charge counts in m on the outer suffix of a refund multicall", async () => {
    mockedMulticall.mockResolvedValue([
      { status: "success", result: [10000n, 0n] },
      { status: "success", result: [0n, 0n] },
      { status: "success", result: 0n },
    ]);
    const { context, recorded, suffix } = metadataContext();
    const { manager, storage, authorizer, signer } = buildManager({ context });
    const config = buildChannelConfig();
    config.receiverAuthorizer = authorizer.address;
    const channel = buildChannel({
      channelConfig: config,
      channelId: computeChannelId(config),
      chargedCumulativeAmount: "3000",
      signedMaxClaimable: "3000",
      balance: "10000",
      totalClaimed: "0",
      chargeCount: 4,
    });
    await storeChannel(storage, channel);

    const results = await manager.refund();
    expect(results).toHaveLength(1);
    const write = (signer.writeContract as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      functionName: string;
      args: readonly unknown[];
      dataSuffix?: `0x${string}`;
    };
    expect(write.functionName).toBe("multicall");
    expect(write.dataSuffix).toBe(suffix);
    expect(recorded).toEqual([{ x402ChargeCounts: [4n] }]);

    // The inner claim leg is bare: re-encoding the decoded call reproduces it exactly.
    const claimCalldata = (write.args[0] as `0x${string}`[])[0];
    const decoded = decodeFunctionData({ abi: batchSettlementABI, data: claimCalldata });
    expect(decoded.functionName).toBe("claimWithSignature");
    expect(
      encodeFunctionData({
        abi: batchSettlementABI,
        functionName: "claimWithSignature",
        args: decoded.args as never,
      }),
    ).toBe(claimCalldata);
    expect((await storage.get(channel.channelId))?.chargeCount).toBe(0);
  });

  it("keeps the count pending when the bundled claim emitted no Claimed event", async () => {
    mockedMulticall.mockResolvedValue([
      { status: "success", result: [10000n, 0n] },
      { status: "success", result: [0n, 0n] },
      { status: "success", result: 0n },
    ]);
    const signer = buildSigner({
      waitForTransactionReceipt: vi.fn().mockResolvedValue({ status: "success", logs: [] }),
    });
    const { manager, storage, authorizer } = buildManager({ signer });
    const config = buildChannelConfig();
    config.receiverAuthorizer = authorizer.address;
    const channel = buildChannel({
      channelConfig: config,
      channelId: computeChannelId(config),
      chargedCumulativeAmount: "3000",
      signedMaxClaimable: "3000",
      balance: "10000",
      totalClaimed: "0",
      chargeCount: 4,
    });
    await storeChannel(storage, channel);

    await manager.refund();
    const write = (signer.writeContract as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      functionName: string;
    };
    expect(write.functionName).toBe("multicall");
    expect((await storage.get(channel.channelId))?.chargeCount).toBe(4);
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

    await manager.refund();

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
