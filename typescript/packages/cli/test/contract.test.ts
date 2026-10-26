import { describe, expect, it } from "vitest";
import { createClient } from "../src";
import { fakeFamily, fakeRequirement, minimalWallet, paidServer, run } from "./helpers";

describe("extension contract: a wallet with only id and getSigner", () => {
  it("builds a client that pays through createClient", async () => {
    const client = await createClient({ wallet: minimalWallet(), families: [fakeFamily()] });
    const payload = await client.createPaymentPayload({
      x402Version: 2,
      resource: { url: "https://example.com" },
      accepts: [fakeRequirement()],
    });
    expect(payload.payload).toEqual({ from: "addr-default-key" });
  });

  it("supports pay --dry-run through runCli", async () => {
    const { fetch, requests } = paidServer([fakeRequirement()]);
    const result = await run(["pay", "https://example.com/paid", "--dry-run", "--json"], {
      defaults: { wallet: minimalWallet(), families: [fakeFamily()] },
      fetch,
    });
    expect(result.code).toBe(0);
    expect(result.json).toMatchObject({
      dryRun: true,
      network: "fake:1",
      amount: "10000",
      formatted: "0.01 TOK",
      payTo: "merchant",
    });
    expect(requests).toHaveLength(1);
  });

  it("pays, writing the body to stdout and the receipt to stderr", async () => {
    const { fetch, requests } = paidServer([fakeRequirement()]);
    const result = await run(["pay", "https://example.com/paid"], {
      defaults: { wallet: minimalWallet(), families: [fakeFamily()] },
      fetch,
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("paid content\n");
    expect(result.stderr).toContain("Paid 0.01 TOK on Fake. Transaction: 0xtx");
    expect(requests).toHaveLength(2);
  });

  it("supports balance through runCli", async () => {
    const result = await run(["balance", "--json"], {
      defaults: { wallet: minimalWallet(), families: [fakeFamily()] },
    });
    expect(result.code).toBe(0);
    expect(result.json).toEqual({
      account: "default",
      wallet: "minimal",
      balances: [
        {
          family: "fake",
          address: "addr-default-key",
          network: "fake:1",
          asset: "TOK",
          symbol: "TOK",
          amount: "1.5",
          networkName: "Fake",
          testnet: false,
        },
      ],
    });
  });

  it("reports account create as unsupported", async () => {
    const result = await run(["account", "create", "--family", "fake"], {
      defaults: { wallet: minimalWallet(), families: [fakeFamily()] },
    });
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("The minimal wallet does not support account create.");
    expect(result.stdout).toContain("x402 account create --family fake --wallet keychain");
  });

  it("selects a wallet from config.wallets with --wallet", async () => {
    const result = await run(["account", "view", "--wallet", "minimal", "--json"], {
      defaults: { wallets: [minimalWallet()], families: [fakeFamily()] },
    });
    expect(result.json).toMatchObject({
      wallet: "minimal",
      addresses: [{ address: "addr-default-key" }],
    });
  });

  it("lists registered wallets for an unknown --wallet", async () => {
    const result = await run(["account", "view", "--wallet", "nope"], {
      defaults: { families: [fakeFamily()] },
    });
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("Registered wallets: local, keychain");
  });
});
