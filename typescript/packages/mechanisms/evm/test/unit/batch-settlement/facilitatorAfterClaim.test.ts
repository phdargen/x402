import { describe, it, expect } from "vitest";
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
    );

    expect((await storage.get(channel.channelId))?.totalClaimed).toBe("5000");
    expect((await storage.get(channel.channelId))?.chargeCount).toBe(0);
  });

  it("deletes a closed channel row after claim when retention is until-closed", async () => {
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
      "until-closed",
    );

    expect(await storage.get(channel.channelId)).toBeUndefined();
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
    );

    expect(await storage.get(channel.channelId)).toBeUndefined();
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
    );

    expect(await storage.get(channel.channelId)).toBeDefined();
  });

  it("still deletes a closed row when lock inspection fails (treated as unlocked)", async () => {
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
    );

    expect(await storage.get(channel.channelId)).toBeUndefined();
  });
});
