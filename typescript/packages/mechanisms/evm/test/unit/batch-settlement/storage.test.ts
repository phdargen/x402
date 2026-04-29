import { describe, it, expect, beforeEach } from "vitest";
import { InMemoryChannelStorage, type Channel } from "../../../src/batch-settlement/server/storage";
import {
  InMemoryClientChannelStorage,
  type BatchSettlementClientContext,
} from "../../../src/batch-settlement/client/storage";
import type { ChannelConfig } from "../../../src/batch-settlement/types";

const CHANNEL_CONFIG: ChannelConfig = {
  payer: "0x1234567890123456789012345678901234567890",
  payerAuthorizer: "0x1234567890123456789012345678901234567890",
  receiver: "0x9876543210987654321098765432109876543210",
  receiverAuthorizer: "0x0000000000000000000000000000000000000000",
  token: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  withdrawDelay: 900,
  salt: "0x0000000000000000000000000000000000000000000000000000000000000000",
};

const CHANNEL_ID = "0xabc1230000000000000000000000000000000000000000000000000000000001";

const buildSession = (overrides: Partial<Channel> = {}): Channel => ({
  channelId: CHANNEL_ID,
  channelConfig: CHANNEL_CONFIG,
  payer: CHANNEL_CONFIG.payer,
  chargedCumulativeAmount: "0",
  signedMaxClaimable: "0",
  signature: "0x",
  balance: "10000000",
  totalClaimed: "0",
  withdrawRequestedAt: 0,
  refundNonce: 0,
  lastRequestTimestamp: 0,
  ...overrides,
});

describe("InMemoryChannelStorage", () => {
  let storage: InMemoryChannelStorage;

  beforeEach(() => {
    storage = new InMemoryChannelStorage();
  });

  describe("get/updateChannel", () => {
    it("returns undefined when no session exists", async () => {
      expect(await storage.get(CHANNEL_ID)).toBeUndefined();
    });

    it("stores and retrieves a session", async () => {
      const session = buildSession({ chargedCumulativeAmount: "1000" });
      await storage.updateChannel(CHANNEL_ID, () => session);
      expect(await storage.get(CHANNEL_ID)).toEqual(session);
    });

    it("treats channelId case-insensitively", async () => {
      const session = buildSession({ chargedCumulativeAmount: "500" });
      await storage.updateChannel(CHANNEL_ID.toUpperCase(), () => session);
      expect(await storage.get(CHANNEL_ID.toLowerCase())).toEqual(session);
    });

    it("overwrites a session on subsequent update", async () => {
      await storage.updateChannel(CHANNEL_ID, () => buildSession({ chargedCumulativeAmount: "1" }));
      await storage.updateChannel(CHANNEL_ID, () => buildSession({ chargedCumulativeAmount: "2" }));
      const got = await storage.get(CHANNEL_ID);
      expect(got?.chargedCumulativeAmount).toBe("2");
    });

    it("deletes a session", async () => {
      await storage.updateChannel(CHANNEL_ID, () => buildSession());
      await storage.updateChannel(CHANNEL_ID, () => undefined);
      expect(await storage.get(CHANNEL_ID)).toBeUndefined();
    });

    it("delete is a no-op when nothing is stored", async () => {
      await expect(storage.updateChannel(CHANNEL_ID, () => undefined)).resolves.toEqual({
        channel: undefined,
        status: "unchanged",
      });
    });
  });

  describe("list", () => {
    it("returns [] for an empty storage", async () => {
      expect(await storage.list()).toEqual([]);
    });

    it("returns all stored sessions", async () => {
      const id1 = "0x1111111111111111111111111111111111111111111111111111111111111111";
      const id2 = "0x2222222222222222222222222222222222222222222222222222222222222222";
      await storage.updateChannel(id1, () => buildSession({ channelId: id1 }));
      await storage.updateChannel(id2, () => buildSession({ channelId: id2 }));
      const all = await storage.list();
      expect(all).toHaveLength(2);
      expect(all.map(s => s.channelId).sort()).toEqual([id1, id2].sort());
    });
  });

  describe("updateChannel", () => {
    it("inserts a new session when none exists", async () => {
      const session = buildSession({ chargedCumulativeAmount: "100" });
      const result = await storage.updateChannel(CHANNEL_ID, () => session);
      expect(result).toEqual({ channel: session, status: "updated" });
      expect(await storage.get(CHANNEL_ID)).toEqual(session);
    });

    it("updates from the current stored value", async () => {
      await storage.updateChannel(CHANNEL_ID, () => buildSession({ chargedCumulativeAmount: "500" }));
      const updated = buildSession({ chargedCumulativeAmount: "750" });
      const result = await storage.updateChannel(CHANNEL_ID, current =>
        current?.chargedCumulativeAmount === "500" ? updated : current,
      );
      expect(result.status).toBe("updated");
      expect((await storage.get(CHANNEL_ID))?.chargedCumulativeAmount).toBe("750");
    });

    it("can leave the channel unchanged", async () => {
      await storage.updateChannel(CHANNEL_ID, () => buildSession({ chargedCumulativeAmount: "500" }));
      const updated = buildSession({ chargedCumulativeAmount: "750" });
      const result = await storage.updateChannel(CHANNEL_ID, current =>
        current?.chargedCumulativeAmount === "499" ? updated : current,
      );
      expect(result.status).toBe("unchanged");
      expect((await storage.get(CHANNEL_ID))?.chargedCumulativeAmount).toBe("500");
    });

    it("serializes concurrent updateChannel mutations", async () => {
      await storage.updateChannel(CHANNEL_ID, () => buildSession({ chargedCumulativeAmount: "0" }));
      const winner = buildSession({ chargedCumulativeAmount: "100" });
      const loser = buildSession({ chargedCumulativeAmount: "200" });

      const [a, b] = await Promise.all([
        storage.updateChannel(CHANNEL_ID, current =>
          current?.chargedCumulativeAmount === "0" ? winner : current,
        ),
        storage.updateChannel(CHANNEL_ID, current =>
          current?.chargedCumulativeAmount === "0" ? loser : current,
        ),
      ]);

      expect([a, b].filter(result => result.status === "updated")).toHaveLength(1);
      const final = await storage.get(CHANNEL_ID);
      expect(["100", "200"]).toContain(final?.chargedCumulativeAmount);
    });
  });
});

describe("InMemoryClientChannelStorage", () => {
  let storage: InMemoryClientChannelStorage;

  beforeEach(() => {
    storage = new InMemoryClientChannelStorage();
  });

  it("returns undefined when no context exists", async () => {
    expect(await storage.get(CHANNEL_ID)).toBeUndefined();
  });

  it("stores and retrieves a context", async () => {
    const ctx: BatchSettlementClientContext = {
      chargedCumulativeAmount: "1000",
      balance: "10000000",
      totalClaimed: "0",
      depositAmount: "10000000",
      signedMaxClaimable: "1000",
      signature: "0xdeadbeef",
    };
    await storage.set(CHANNEL_ID, ctx);
    expect(await storage.get(CHANNEL_ID)).toEqual(ctx);
  });

  it("overwrites a context on subsequent set", async () => {
    await storage.set(CHANNEL_ID, { chargedCumulativeAmount: "1" });
    await storage.set(CHANNEL_ID, { chargedCumulativeAmount: "2" });
    const got = await storage.get(CHANNEL_ID);
    expect(got?.chargedCumulativeAmount).toBe("2");
  });

  it("deletes a context", async () => {
    await storage.set(CHANNEL_ID, { chargedCumulativeAmount: "5" });
    await storage.delete(CHANNEL_ID);
    expect(await storage.get(CHANNEL_ID)).toBeUndefined();
  });

  it("delete is a no-op when nothing is stored", async () => {
    await expect(storage.delete(CHANNEL_ID)).resolves.toBeUndefined();
  });

  it("uses keys verbatim (no normalization)", async () => {
    await storage.set(CHANNEL_ID.toUpperCase(), { chargedCumulativeAmount: "1" });
    expect(await storage.get(CHANNEL_ID.toLowerCase())).toBeUndefined();
    expect(await storage.get(CHANNEL_ID.toUpperCase())).toEqual({ chargedCumulativeAmount: "1" });
  });
});
