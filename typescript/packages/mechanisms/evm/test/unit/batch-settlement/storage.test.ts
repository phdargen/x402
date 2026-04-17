import { describe, it, expect, beforeEach } from "vitest";
import {
  InMemorySessionStorage,
  type ChannelSession,
} from "../../../src/batch-settlement/server/storage";
import {
  InMemoryClientSessionStorage,
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

const buildSession = (overrides: Partial<ChannelSession> = {}): ChannelSession => ({
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

describe("InMemorySessionStorage", () => {
  let storage: InMemorySessionStorage;

  beforeEach(() => {
    storage = new InMemorySessionStorage();
  });

  describe("get/set/delete", () => {
    it("returns undefined when no session exists", async () => {
      expect(await storage.get(CHANNEL_ID)).toBeUndefined();
    });

    it("stores and retrieves a session", async () => {
      const session = buildSession({ chargedCumulativeAmount: "1000" });
      await storage.set(CHANNEL_ID, session);
      expect(await storage.get(CHANNEL_ID)).toEqual(session);
    });

    it("treats channelId case-insensitively", async () => {
      const session = buildSession({ chargedCumulativeAmount: "500" });
      await storage.set(CHANNEL_ID.toUpperCase(), session);
      expect(await storage.get(CHANNEL_ID.toLowerCase())).toEqual(session);
    });

    it("overwrites a session on subsequent set", async () => {
      await storage.set(CHANNEL_ID, buildSession({ chargedCumulativeAmount: "1" }));
      await storage.set(CHANNEL_ID, buildSession({ chargedCumulativeAmount: "2" }));
      const got = await storage.get(CHANNEL_ID);
      expect(got?.chargedCumulativeAmount).toBe("2");
    });

    it("deletes a session", async () => {
      await storage.set(CHANNEL_ID, buildSession());
      await storage.delete(CHANNEL_ID);
      expect(await storage.get(CHANNEL_ID)).toBeUndefined();
    });

    it("delete is a no-op when nothing is stored", async () => {
      await expect(storage.delete(CHANNEL_ID)).resolves.toBeUndefined();
    });
  });

  describe("list", () => {
    it("returns [] for an empty storage", async () => {
      expect(await storage.list()).toEqual([]);
    });

    it("returns all stored sessions", async () => {
      const id1 = "0x1111111111111111111111111111111111111111111111111111111111111111";
      const id2 = "0x2222222222222222222222222222222222222222222222222222222222222222";
      await storage.set(id1, buildSession({ channelId: id1 }));
      await storage.set(id2, buildSession({ channelId: id2 }));
      const all = await storage.list();
      expect(all).toHaveLength(2);
      expect(all.map(s => s.channelId).sort()).toEqual([id1, id2].sort());
    });
  });

  describe("compareAndSet", () => {
    it("inserts a new session when none exists (regardless of expectedCharged)", async () => {
      const session = buildSession({ chargedCumulativeAmount: "100" });
      const ok = await storage.compareAndSet(CHANNEL_ID, "anything", session);
      expect(ok).toBe(true);
      expect(await storage.get(CHANNEL_ID)).toEqual(session);
    });

    it("succeeds when expectedCharged matches the stored value", async () => {
      await storage.set(CHANNEL_ID, buildSession({ chargedCumulativeAmount: "500" }));
      const updated = buildSession({ chargedCumulativeAmount: "750" });
      const ok = await storage.compareAndSet(CHANNEL_ID, "500", updated);
      expect(ok).toBe(true);
      expect((await storage.get(CHANNEL_ID))?.chargedCumulativeAmount).toBe("750");
    });

    it("fails (and does not write) when expectedCharged is stale", async () => {
      await storage.set(CHANNEL_ID, buildSession({ chargedCumulativeAmount: "500" }));
      const updated = buildSession({ chargedCumulativeAmount: "750" });
      const ok = await storage.compareAndSet(CHANNEL_ID, "499", updated);
      expect(ok).toBe(false);
      expect((await storage.get(CHANNEL_ID))?.chargedCumulativeAmount).toBe("500");
    });

    it("only the first concurrent compareAndSet wins", async () => {
      await storage.set(CHANNEL_ID, buildSession({ chargedCumulativeAmount: "0" }));
      const winner = buildSession({ chargedCumulativeAmount: "100" });
      const loser = buildSession({ chargedCumulativeAmount: "200" });

      const [a, b] = await Promise.all([
        storage.compareAndSet(CHANNEL_ID, "0", winner),
        storage.compareAndSet(CHANNEL_ID, "0", loser),
      ]);

      expect([a, b].filter(Boolean)).toHaveLength(1);
      const final = await storage.get(CHANNEL_ID);
      expect(["100", "200"]).toContain(final?.chargedCumulativeAmount);
    });
  });
});

describe("InMemoryClientSessionStorage", () => {
  let storage: InMemoryClientSessionStorage;

  beforeEach(() => {
    storage = new InMemoryClientSessionStorage();
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
