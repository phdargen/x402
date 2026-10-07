import { describe, it, expect } from "vitest";
import { claimKey } from "../../../src/batch-settlement/attestation";
import { afterClaim } from "../../../src/batch-settlement/facilitator/channelManager";
import { InMemoryChannelStorage } from "../../../src/batch-settlement/storage/channel";
import type { FacilitatorChannel } from "../../../src/batch-settlement/facilitator/types";
import { computeChannelId } from "../../../src/batch-settlement/utils";
import type { ChannelConfig } from "../../../src/batch-settlement/types";

const NETWORK = "eip155:84532";

function buildConfig(saltSuffix = "00"): ChannelConfig {
  const salt = `0x${"00".repeat(31)}${saltSuffix.padStart(2, "0")}` as `0x${string}`;
  return {
    payer: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    payerAuthorizer: "0x0000000000000000000000000000000000000000",
    receiver: "0x9876543210987654321098765432109876543210",
    receiverAuthorizer: "0x1111111111111111111111111111111111111111",
    token: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    withdrawDelay: 900,
    salt,
  };
}

const TOTAL = "5000";

function attestedMap(...channels: FacilitatorChannel[]): Map<string, number> {
  return new Map(
    channels.map(channel => [claimKey(channel.channelId, TOTAL), channel.chargeCount]),
  );
}

function claimedIds(...channels: FacilitatorChannel[]): Set<string> {
  return new Set(channels.map(channel => claimKey(channel.channelId, TOTAL)));
}

function buildChannel(overrides: Partial<FacilitatorChannel> = {}): FacilitatorChannel {
  const channelConfig = overrides.channelConfig ?? buildConfig();
  const channelId = overrides.channelId ?? computeChannelId(channelConfig, NETWORK);
  return {
    channelId,
    channelConfig,
    chargedCumulativeAmount: "5000",
    signedMaxClaimable: "5000",
    signature: "0xdeadbeef",
    balance: "5000",
    totalClaimed: "0",
    withdrawRequestedAt: 0,
    refundNonce: 0,
    lastRequestTimestamp: Date.now(),
    network: NETWORK,
    chargeCount: 3,
    ...overrides,
  };
}

describe("afterClaim", () => {
  it("subtracts the attested chargeCount that existed before the claim", async () => {
    const storage = new InMemoryChannelStorage<FacilitatorChannel>();
    const channel = buildChannel({ balance: "10000" });
    await storage.updateChannel(channel.channelId, () => channel);

    await afterClaim(
      storage,
      storage,
      [
        {
          voucher: { channel: channel.channelConfig, maxClaimableAmount: "5000" },
          signature: "0xdeadbeef",
          totalClaimed: "5000",
        },
      ],
      NETWORK,
      attestedMap(channel),
      claimedIds(channel),
      undefined,
    );

    expect((await storage.get(channel.channelId))?.totalClaimed).toBe("5000");
    expect((await storage.get(channel.channelId))?.chargeCount).toBe(0);
  });

  it("preserves in-flight increments when subtracting the encoded snapshot", async () => {
    const storage = new InMemoryChannelStorage<FacilitatorChannel>();
    const channel = buildChannel({ balance: "10000", chargeCount: 3 });
    await storage.updateChannel(channel.channelId, () => channel);
    await storage.updateChannel(channel.channelId, current =>
      current ? { ...current, chargeCount: 5 } : current,
    );

    await afterClaim(
      storage,
      storage,
      [
        {
          voucher: { channel: channel.channelConfig, maxClaimableAmount: "5000" },
          signature: "0xdeadbeef",
          totalClaimed: "5000",
        },
      ],
      NETWORK,
      attestedMap(channel),
      claimedIds(channel),
      undefined,
    );

    expect((await storage.get(channel.channelId))?.chargeCount).toBe(2);
  });

  it("keeps a closed channel row after claim when retention is when-unused", async () => {
    const storage = new InMemoryChannelStorage<FacilitatorChannel>();
    const channel = buildChannel({ chargeCount: 0 });
    await storage.updateChannel(channel.channelId, () => channel);

    await afterClaim(
      storage,
      storage,
      [
        {
          voucher: { channel: channel.channelConfig, maxClaimableAmount: "5000" },
          signature: "0xdeadbeef",
          totalClaimed: "5000",
        },
      ],
      NETWORK,
      attestedMap(channel),
      claimedIds(channel),
      undefined,
      "when-unused",
    );

    const stored = await storage.get(channel.channelId);
    expect(stored).toBeDefined();
    expect(stored?.totalClaimed).toBe("5000");
    expect(stored?.chargeCount).toBe(0);
  });

  it("keeps a closed channel row when retention is forever", async () => {
    const storage = new InMemoryChannelStorage<FacilitatorChannel>();
    const channel = buildChannel({ chargeCount: 0 });
    await storage.updateChannel(channel.channelId, () => channel);

    await afterClaim(
      storage,
      storage,
      [
        {
          voucher: { channel: channel.channelConfig, maxClaimableAmount: "5000" },
          signature: "0xdeadbeef",
          totalClaimed: "5000",
        },
      ],
      NETWORK,
      attestedMap(channel),
      claimedIds(channel),
      undefined,
      "forever",
    );

    expect(await storage.get(channel.channelId)).toBeDefined();
  });

  it("ignores claims whose channel rows disappeared before attestation", async () => {
    const storage = new InMemoryChannelStorage<FacilitatorChannel>();
    const channel = buildChannel({ balance: "10000" });

    await afterClaim(
      storage,
      storage,
      [
        {
          voucher: { channel: channel.channelConfig, maxClaimableAmount: "5000" },
          signature: "0xdeadbeef",
          totalClaimed: "5000",
        },
      ],
      NETWORK,
      new Map([[claimKey(channel.channelId, TOTAL), 3]]),
      claimedIds(channel),
      undefined,
    );

    expect(await storage.get(channel.channelId)).toBeUndefined();
  });

  it("keeps the count pending for a row that did not emit Claimed", async () => {
    const storage = new InMemoryChannelStorage<FacilitatorChannel>();
    const claimedChannel = buildChannel({ balance: "10000", chargeCount: 4 });
    const noOpChannel = buildChannel({
      channelConfig: buildConfig("01"),
      balance: "10000",
      chargeCount: 2,
    });
    await storage.updateChannel(claimedChannel.channelId, () => claimedChannel);
    await storage.updateChannel(noOpChannel.channelId, () => noOpChannel);

    await afterClaim(
      storage,
      storage,
      [claimedChannel, noOpChannel].map(channel => ({
        voucher: { channel: channel.channelConfig, maxClaimableAmount: "5000" },
        signature: "0xdeadbeef" as const,
        totalClaimed: "5000",
      })),
      NETWORK,
      attestedMap(claimedChannel, noOpChannel),
      claimedIds(claimedChannel),
      undefined,
    );

    expect((await storage.get(claimedChannel.channelId))?.chargeCount).toBe(0);
    expect((await storage.get(noOpChannel.channelId))?.chargeCount).toBe(2);
  });

  it("subtracts nothing when the receipt has no Claimed events", async () => {
    const storage = new InMemoryChannelStorage<FacilitatorChannel>();
    const channel = buildChannel({ balance: "10000", chargeCount: 3 });
    await storage.updateChannel(channel.channelId, () => channel);

    await afterClaim(
      storage,
      storage,
      [
        {
          voucher: { channel: channel.channelConfig, maxClaimableAmount: "5000" },
          signature: "0xdeadbeef",
          totalClaimed: "5000",
        },
      ],
      NETWORK,
      attestedMap(channel),
      new Set(),
      undefined,
    );

    expect((await storage.get(channel.channelId))?.chargeCount).toBe(3);
  });

  it("does not delete a closed row while an admission lock is held", async () => {
    const storage = new InMemoryChannelStorage<FacilitatorChannel>();
    const channel = buildChannel({ chargeCount: 0 });
    await storage.updateChannel(channel.channelId, () => channel);
    await storage.acquire(channel.channelId, "pending-settle", 60_000);

    await afterClaim(
      storage,
      storage,
      [
        {
          voucher: { channel: channel.channelConfig, maxClaimableAmount: "5000" },
          signature: "0xdeadbeef",
          totalClaimed: "5000",
        },
      ],
      NETWORK,
      attestedMap(channel),
      claimedIds(channel),
      undefined,
    );

    expect(await storage.get(channel.channelId)).toBeDefined();
  });

  it("keeps a closed row after claim when lock inspection fails (treated as unlocked)", async () => {
    const storage = new InMemoryChannelStorage<FacilitatorChannel>();
    const lockStorage = {
      acquire: storage.acquire.bind(storage),
      release: storage.release.bind(storage),
      isHeld: async () => {
        throw new Error("lock store unavailable");
      },
    };
    const channel = buildChannel({ chargeCount: 0 });
    await storage.updateChannel(channel.channelId, () => channel);

    await afterClaim(
      storage,
      lockStorage,
      [
        {
          voucher: { channel: channel.channelConfig, maxClaimableAmount: "5000" },
          signature: "0xdeadbeef",
          totalClaimed: "5000",
        },
      ],
      NETWORK,
      attestedMap(channel),
      claimedIds(channel),
      undefined,
    );

    expect(await storage.get(channel.channelId)).toBeDefined();
  });

  it("subtracts the largest applied snapshot once when a channel repeats", async () => {
    const storage = new InMemoryChannelStorage<FacilitatorChannel>();
    const channel = buildChannel({ balance: "10000", chargeCount: 6 });
    await storage.updateChannel(channel.channelId, () => channel);
    const row = (totalClaimed: string) => ({
      voucher: { channel: channel.channelConfig, maxClaimableAmount: "8000" },
      signature: "0xdeadbeef" as const,
      totalClaimed,
    });

    // Two views of one counter (3, then 4 after a charge): attested 4, not 3 + 4.
    await afterClaim(
      storage,
      storage,
      [row("5000"), row("8000")],
      NETWORK,
      new Map([
        [claimKey(channel.channelId, "5000"), 3],
        [claimKey(channel.channelId, "8000"), 4],
      ]),
      new Set([claimKey(channel.channelId, "5000"), claimKey(channel.channelId, "8000")]),
      undefined,
    );
    expect((await storage.get(channel.channelId))?.chargeCount).toBe(2);
  });
});
