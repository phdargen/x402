import { describe, it, expect, beforeEach, vi } from "vitest";
import { getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { BatchSettlementEvmScheme } from "../../../src/batch-settlement/facilitator/scheme";
import { BatchSettlementVoucherStoreManager } from "../../../src/batch-settlement/facilitator/voucherStore";
import { InMemoryChannelStorage, type Channel } from "../../../src/batch-settlement/storage";
import { computeChannelId as computeChannelIdForNetwork } from "../../../src/batch-settlement/utils";
import type { AuthorizerSigner, ChannelConfig } from "../../../src/batch-settlement/types";
import type { FacilitatorEvmSigner } from "../../../src/signer";

const PAYER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as `0x${string}`;
const RECEIVER = "0x9876543210987654321098765432109876543210" as `0x${string}`;
const OTHER_RECEIVER = "0x1234567890123456789012345678901234567890" as `0x${string}`;
const ASSET = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as `0x${string}`;
const OTHER_ASSET = "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85" as `0x${string}`;
const FACILITATOR_ADDRESS = "0xFAC11174700123456789012345678901234aBCDe" as `0x${string}`;
const NETWORK = "eip155:84532";

/** Claim rows submitted onchain, in `claimWithSignature` argument order. */
type ClaimArg = { voucher: { channel: { salt: string }; maxClaimableAmount: bigint } };

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

const authorizer = buildAuthorizerSigner();

function buildSigner(overrides: Partial<FacilitatorEvmSigner> = {}): FacilitatorEvmSigner {
  return {
    getAddresses: () => [FACILITATOR_ADDRESS],
    readContract: vi.fn().mockImplementation(args => {
      if (args.functionName === "receivers") return Promise.resolve([2500n, 0n]);
      return Promise.resolve(undefined);
    }),
    verifyTypedData: vi.fn().mockResolvedValue(true),
    writeContract: vi.fn().mockResolvedValue("0xtxhash" as `0x${string}`),
    sendTransaction: vi.fn(),
    waitForTransactionReceipt: vi.fn().mockResolvedValue({ status: "success", logs: [] }),
    getCode: vi.fn().mockResolvedValue("0x"),
    ...overrides,
  };
}

function buildChannelConfig(overrides: Partial<ChannelConfig> = {}): ChannelConfig {
  return {
    payer: PAYER,
    payerAuthorizer: PAYER,
    receiver: RECEIVER,
    receiverAuthorizer: authorizer.address,
    token: ASSET,
    withdrawDelay: 900,
    salt: "0x0000000000000000000000000000000000000000000000000000000000000000",
    ...overrides,
  };
}

/**
 * Writes a channel with an outstanding claimable amount into the store.
 *
 * @param storage - Store backing the manager.
 * @param overrides - Channel-config and row overrides.
 * @param overrides.config - Channel configuration to store.
 * @param overrides.charged - Committed watermark.
 * @param overrides.totalClaimed - Amount already claimed onchain.
 * @param overrides.withdrawRequestedAt - Withdraw request timestamp in seconds.
 * @param overrides.pendingExpiresAt - Reservation expiry in milliseconds.
 * @returns The stored channel id.
 */
async function storeClaimable(
  storage: InMemoryChannelStorage,
  overrides: {
    config?: ChannelConfig;
    charged?: string;
    totalClaimed?: string;
    withdrawRequestedAt?: number;
    pendingExpiresAt?: number;
  } = {},
): Promise<`0x${string}`> {
  const config = overrides.config ?? buildChannelConfig();
  const channelId = computeChannelIdForNetwork(config, NETWORK);
  const charged = overrides.charged ?? "1000";
  const channel: Channel = {
    channelId,
    channelConfig: config,
    chargedCumulativeAmount: charged,
    signedMaxClaimable: charged,
    signature: "0xabcd",
    balance: "10000",
    totalClaimed: overrides.totalClaimed ?? "0",
    withdrawRequestedAt: overrides.withdrawRequestedAt ?? 0,
    refundNonce: 0,
    lastRequestTimestamp: Date.now() - 60_000,
    ...(overrides.pendingExpiresAt !== undefined
      ? {
          pendingRequest: {
            pendingId: "0xabcd",
            signedMaxClaimable: charged,
            verifiedAmount: "1000",
            expiresAt: overrides.pendingExpiresAt,
          },
        }
      : {}),
  };
  await storage.updateChannel(channelId, () => channel);
  return channelId;
}

function buildManager(
  storage: InMemoryChannelStorage,
  signer: FacilitatorEvmSigner,
  options?: { urgencyRatio?: number },
): BatchSettlementVoucherStoreManager {
  const scheme = new BatchSettlementEvmScheme(signer, authorizer, {
    voucherStore: { storage, withdrawDelay: 900 },
  });
  return scheme.createVoucherStoreManager(NETWORK, options);
}

/**
 * Extracts the claim batches submitted onchain.
 *
 * @param signer - Facilitator signer mock.
 * @returns One entry per `claimWithSignature` transaction.
 */
function claimBatches(signer: FacilitatorEvmSigner): ClaimArg[][] {
  return (signer.writeContract as ReturnType<typeof vi.fn>).mock.calls
    .filter(([arg]) => arg?.functionName === "claimWithSignature")
    .map(([arg]) => arg.args[0] as ClaimArg[]);
}

/**
 * Extracts the `(receiver, token)` pairs settled onchain.
 *
 * @param signer - Facilitator signer mock.
 * @returns One entry per `settle` transaction.
 */
function settleTargets(signer: FacilitatorEvmSigner): Array<[string, string]> {
  return (signer.writeContract as ReturnType<typeof vi.fn>).mock.calls
    .filter(([arg]) => arg?.functionName === "settle")
    .map(([arg]) => [arg.args[0] as string, arg.args[1] as string]);
}

let storage: InMemoryChannelStorage;
let signer: FacilitatorEvmSigner;

beforeEach(() => {
  storage = new InMemoryChannelStorage();
  signer = buildSigner();
});

describe("BatchSettlementVoucherStoreManager — construction", () => {
  it("requires a configured voucher store", () => {
    const scheme = new BatchSettlementEvmScheme(buildSigner(), authorizer);
    expect(() => scheme.createVoucherStoreManager(NETWORK)).toThrow(/voucherStore/);
  });

  it("is created from a scheme that runs a voucher store", () => {
    expect(buildManager(storage, signer)).toBeInstanceOf(BatchSettlementVoucherStoreManager);
  });
});

describe("BatchSettlementVoucherStoreManager — claim", () => {
  it("claims nothing when no channel is ahead of its onchain accounting", async () => {
    await storeClaimable(storage, { charged: "1000", totalClaimed: "1000" });
    const results = await buildManager(storage, signer).claim();

    expect(results).toEqual([]);
    expect(signer.writeContract).not.toHaveBeenCalled();
  });

  it("splits claim rows into batches of maxClaimsPerBatch", async () => {
    for (let i = 0; i < 3; i++) {
      await storeClaimable(storage, {
        config: buildChannelConfig({ salt: `0x${String(i).padStart(64, "0")}` }),
      });
    }

    const results = await buildManager(storage, signer).claim({ maxClaimsPerBatch: 2 });

    expect(results.map(r => r.vouchers)).toEqual([2, 1]);
    expect(claimBatches(signer).map(batch => batch.length)).toEqual([2, 1]);
  });

  it("mirrors the claimed total so the next pass skips the channel", async () => {
    const channelId = await storeClaimable(storage, { charged: "1000" });
    const manager = buildManager(storage, signer);

    await manager.claim();
    expect((await storage.get(channelId))?.totalClaimed).toBe("1000");

    (signer.writeContract as ReturnType<typeof vi.fn>).mockClear();
    expect(await manager.claim()).toEqual([]);
    expect(signer.writeContract).not.toHaveBeenCalled();
  });

  it("claims channels whose withdrawal is close to finalizing first", async () => {
    const calmSalt = `0x${"0".repeat(63)}1`;
    const urgentSalt = `0x${"0".repeat(63)}2`;
    await storeClaimable(storage, { config: buildChannelConfig({ salt: calmSalt }) });
    await storeClaimable(storage, {
      config: buildChannelConfig({ salt: urgentSalt }),
      // Requested 800s ago against a 900s delay: past the 50% urgency threshold.
      withdrawRequestedAt: Math.floor(Date.now() / 1000) - 800,
    });

    await buildManager(storage, signer).claim();

    expect(claimBatches(signer)[0].map(row => row.voucher.channel.salt)).toEqual([
      urgentSalt,
      calmSalt,
    ]);
  });

  it("skips channels whose charge is still being decided", async () => {
    await storeClaimable(storage, { pendingExpiresAt: Date.now() + 60_000 });
    const results = await buildManager(storage, signer).claim();

    expect(results).toEqual([]);
    expect(signer.writeContract).not.toHaveBeenCalled();
  });

  it("claims a channel again once its reservation has expired", async () => {
    await storeClaimable(storage, { pendingExpiresAt: Date.now() - 1 });
    const results = await buildManager(storage, signer).claim();

    expect(results.map(r => r.vouchers)).toEqual([1]);
  });

  it("skips channels authorized by another key", async () => {
    await storeClaimable(storage, {
      config: buildChannelConfig({
        receiverAuthorizer: "0x1111111111111111111111111111111111111111",
      }),
    });

    expect(await buildManager(storage, signer).claim()).toEqual([]);
  });

  it("respects the idle filter", async () => {
    const config = buildChannelConfig();
    const channelId = await storeClaimable(storage, { config });
    await storage.updateChannel(channelId, current => ({
      ...current!,
      lastRequestTimestamp: Date.now(),
    }));

    expect(await buildManager(storage, signer).claim({ idleSecs: 60 })).toEqual([]);
    expect((await buildManager(storage, signer).claim()).length).toBe(1);
  });

  it("surfaces a failed claim transaction", async () => {
    await storeClaimable(storage);
    const failing = buildSigner({
      waitForTransactionReceipt: vi.fn().mockResolvedValue({ status: "reverted" }),
    });

    await expect(buildManager(storage, failing).claim()).rejects.toThrow(/Claim failed/);
  });
});

describe("BatchSettlementVoucherStoreManager — settle", () => {
  it("settles each receiver and token pair the store holds", async () => {
    await storeClaimable(storage, { config: buildChannelConfig() });
    await storeClaimable(storage, {
      config: buildChannelConfig({ receiver: OTHER_RECEIVER }),
    });
    await storeClaimable(storage, { config: buildChannelConfig({ token: OTHER_ASSET }) });

    const results = await buildManager(storage, signer).settle();

    expect(results).toHaveLength(3);
    expect(settleTargets(signer)).toEqual(
      expect.arrayContaining([
        [getAddress(RECEIVER), getAddress(ASSET)],
        [getAddress(OTHER_RECEIVER), getAddress(ASSET)],
        [getAddress(RECEIVER), getAddress(OTHER_ASSET)],
      ]),
    );
  });

  it("groups channels that share a receiver and token into one settlement", async () => {
    await storeClaimable(storage, {
      config: buildChannelConfig({ salt: `0x${"0".repeat(63)}1` }),
    });
    await storeClaimable(storage, {
      config: buildChannelConfig({ salt: `0x${"0".repeat(63)}2` }),
    });

    const results = await buildManager(storage, signer).settle();

    expect(results).toHaveLength(1);
    expect(settleTargets(signer)).toEqual([[getAddress(RECEIVER), getAddress(ASSET)]]);
  });

  it("settles only the requested pair when one is given", async () => {
    await storeClaimable(storage);
    await storeClaimable(storage, { config: buildChannelConfig({ receiver: OTHER_RECEIVER }) });

    const results = await buildManager(storage, signer).settle({
      receiver: OTHER_RECEIVER,
      token: ASSET,
    });

    expect(results).toHaveLength(1);
    expect(settleTargets(signer)).toEqual([[getAddress(OTHER_RECEIVER), getAddress(ASSET)]]);
  });

  it("skips pairs with nothing to settle", async () => {
    await storeClaimable(storage);
    const idle = buildSigner({
      readContract: vi.fn().mockImplementation(args => {
        if (args.functionName === "receivers") return Promise.resolve([2500n, 2500n]);
        return Promise.resolve(undefined);
      }),
    });

    expect(await buildManager(storage, idle).settle()).toEqual([]);
    expect(idle.writeContract).not.toHaveBeenCalled();
  });

  it("claims then settles in one pass", async () => {
    await storeClaimable(storage);
    const manager = buildManager(storage, signer);

    const { claims, settles } = await manager.claimAndSettle();

    expect(claims.map(c => c.vouchers)).toEqual([1]);
    expect(settles).toHaveLength(1);
  });

  it("does not settle when there was nothing to claim", async () => {
    await storeClaimable(storage, { charged: "1000", totalClaimed: "1000" });

    const { claims, settles } = await buildManager(storage, signer).claimAndSettle();

    expect(claims).toEqual([]);
    expect(settles).toEqual([]);
    expect(signer.writeContract).not.toHaveBeenCalled();
  });
});

describe("BatchSettlementVoucherStoreManager — schedule", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("runs claims on the configured interval and stops cleanly", async () => {
    await storeClaimable(storage);
    const manager = buildManager(storage, signer);
    const onClaim = vi.fn();

    manager.start({ claimIntervalSecs: 10, onClaim });
    await vi.advanceTimersByTimeAsync(10_000);

    expect(onClaim).toHaveBeenCalledTimes(1);
    expect(onClaim.mock.calls[0][0]).toMatchObject({ vouchers: 1 });

    manager.stop();
    (signer.writeContract as ReturnType<typeof vi.fn>).mockClear();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(signer.writeContract).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  it("settles only after a claim has run", async () => {
    await storeClaimable(storage);
    const manager = buildManager(storage, signer);
    const onSettle = vi.fn();

    manager.start({ settleIntervalSecs: 10, onSettle });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onSettle).not.toHaveBeenCalled();

    manager.stop();
    manager.start({ claimIntervalSecs: 5, settleIntervalSecs: 10, onSettle });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onSettle).toHaveBeenCalledTimes(1);

    manager.stop();
    vi.useRealTimers();
  });

  it("reports scheduled failures through onError", async () => {
    await storeClaimable(storage);
    const failing = buildSigner({
      waitForTransactionReceipt: vi.fn().mockResolvedValue({ status: "reverted" }),
    });
    const manager = buildManager(storage, failing);
    const onError = vi.fn();

    manager.start({ claimIntervalSecs: 10, onError });
    await vi.advanceTimersByTimeAsync(10_000);

    expect(onError).toHaveBeenCalledTimes(1);
    manager.stop();
    vi.useRealTimers();
  });
});
