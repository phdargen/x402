import { describe, it, expect } from "vitest";
import {
  DelegatedAuthIdentityConflictError,
  InMemoryDelegatedAuthStore,
} from "../../../src/batch-settlement/storage/delegatedAuth";

const NETWORK = "eip155:84532";
const CHANNEL_ID = "0xabc1230000000000000000000000000000000000000000000000000000000001";

describe("InMemoryDelegatedAuthStore", () => {
  it("binds a caller identity to a channel and returns a copy on get", async () => {
    const store = new InMemoryDelegatedAuthStore();
    await store.bind({ channelId: CHANNEL_ID, network: NETWORK, callerIdentity: "tenant-a" });
    const row = await store.get(CHANNEL_ID, NETWORK);
    expect(row).toEqual({ channelId: CHANNEL_ID, network: NETWORK, callerIdentity: "tenant-a" });
    row!.callerIdentity = "mutated";
    expect((await store.get(CHANNEL_ID, NETWORK))?.callerIdentity).toBe("tenant-a");
  });

  it("treats a repeat bind with the same identity as idempotent", async () => {
    const store = new InMemoryDelegatedAuthStore();
    await store.bind({ channelId: CHANNEL_ID, network: NETWORK, callerIdentity: "tenant-a" });
    await expect(
      store.bind({ channelId: CHANNEL_ID, network: NETWORK, callerIdentity: "tenant-a" }),
    ).resolves.toBeUndefined();
  });

  it("rejects a second identity for the same channel", async () => {
    const store = new InMemoryDelegatedAuthStore();
    await store.bind({ channelId: CHANNEL_ID, network: NETWORK, callerIdentity: "tenant-a" });
    await expect(
      store.bind({ channelId: CHANNEL_ID, network: NETWORK, callerIdentity: "tenant-b" }),
    ).rejects.toBeInstanceOf(DelegatedAuthIdentityConflictError);
  });

  it("delete removes the binding so a new identity can bind", async () => {
    const store = new InMemoryDelegatedAuthStore();
    await store.bind({ channelId: CHANNEL_ID, network: NETWORK, callerIdentity: "tenant-a" });
    await store.delete(CHANNEL_ID, NETWORK);
    expect(await store.get(CHANNEL_ID, NETWORK)).toBeUndefined();
    await store.bind({ channelId: CHANNEL_ID, network: NETWORK, callerIdentity: "tenant-b" });
    expect((await store.get(CHANNEL_ID, NETWORK))?.callerIdentity).toBe("tenant-b");
  });
});
