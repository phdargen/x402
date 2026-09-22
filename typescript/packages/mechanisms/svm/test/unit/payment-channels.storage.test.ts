import { describe, expect, it } from "vitest";

import { SOLANA_DEVNET_CAIP2, TOKEN_PROGRAM_ADDRESS } from "../../src/constants";
import { USDC_DEVNET_ADDRESS, USDC_MAINNET_ADDRESS } from "../../src/defaultAssets";
import {
  InMemoryPaymentChannelStorage,
  type PaymentChannelRecord,
} from "../../src/payment-channels/storage";

function record(overrides: Partial<PaymentChannelRecord> = {}): PaymentChannelRecord {
  return {
    channelId: "chan-a",
    expiresAt: 0,
    firstSeenAt: 10,
    lastActivityAt: 10,
    network: SOLANA_DEVNET_CAIP2,
    payTo: USDC_MAINNET_ADDRESS,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
    ...overrides,
  };
}

describe("payment-channel facilitator storage", () => {
  it("keeps the receiver authorizer bound at first deposit for the channel lifetime", async () => {
    const storage = new InMemoryPaymentChannelStorage();
    await storage.upsert(record({ receiverAuthorizer: USDC_DEVNET_ADDRESS }));
    // A later claim or distribute upsert carries no key.
    await storage.upsert(record({ lastActivityAt: 20 }));
    expect(await storage.get("chan-a")).toMatchObject({
      lastActivityAt: 20,
      receiverAuthorizer: USDC_DEVNET_ADDRESS,
    });
    // A different key later never replaces the binding.
    await storage.upsert(record({ lastActivityAt: 30, receiverAuthorizer: USDC_MAINNET_ADDRESS }));
    expect((await storage.get("chan-a"))?.receiverAuthorizer).toBe(USDC_DEVNET_ADDRESS);
  });

  it("records a binding that arrives after an unbound first upsert, and none when never given", async () => {
    const storage = new InMemoryPaymentChannelStorage();
    await storage.upsert(record());
    expect((await storage.get("chan-a"))?.receiverAuthorizer).toBeUndefined();
    await storage.upsert(record({ receiverAuthorizer: USDC_DEVNET_ADDRESS }));
    expect((await storage.get("chan-a"))?.receiverAuthorizer).toBe(USDC_DEVNET_ADDRESS);
    expect(Object.keys((await storage.get("chan-a"))!)).toContain("receiverAuthorizer");
  });
});
