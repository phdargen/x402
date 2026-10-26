import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Network } from "@x402/core/types";
import { describe, expect, it } from "vitest";
import { createClient, NetworkNotAllowedError } from "../src";
import { networkPolicy } from "../src/networks";
import {
  fakeFamily,
  fakeRequirement,
  fakeRequirementV1,
  minimalWallet,
  paidServer,
  paidServerV1,
  run,
  tempDir,
} from "./helpers";

/**
 * Runs the network policy over requirements on the given networks.
 *
 * @param offered - Networks the server lists, in order
 * @param networks - Configured networks
 * @returns The networks the policy keeps, in order
 */
function keep(offered: Network[], networks?: Network[]): Network[] {
  const requirements = offered.map(network => fakeRequirement({ network }));
  return networkPolicy([fakeFamily()], networks)(2, requirements).map(r => r.network);
}

/**
 * Writes a JSON config file.
 *
 * @param config - Contents
 * @returns The path
 */
function configFile(config: unknown): string {
  const path = join(tempDir(), "x402.json");
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(config));
  return path;
}

describe("network policy", () => {
  it("drops known testnets by default and keeps the server's order", () => {
    expect(keep(["fake:2", "fake:9", "fake:1"])).toEqual(["fake:9", "fake:1"]);
  });

  it("orders by position in networks, keeping the server's order within one entry", () => {
    expect(keep(["fake:1", "fake:3", "fake:2"], ["fake:2", "fake:*"])).toEqual([
      "fake:2",
      "fake:1",
      "fake:3",
    ]);
  });

  it("allows only listed networks, testnets included", () => {
    expect(keep(["fake:1", "fake:2"], ["fake:2"])).toEqual(["fake:2"]);
  });

  it("applies networks to x402 v1 requirements through their CAIP-2 id", () => {
    expect(keep(["fake-testnet" as Network], ["fake:2"])).toEqual(["fake-testnet"]);
    expect(() => keep(["fake-testnet" as Network])).toThrow(NetworkNotAllowedError);
  });

  it("explains a rejection and lists the offered networks as CAIP-2 ids", () => {
    const error = (() => {
      try {
        keep(["fake:2", "fake-testnet" as Network]);
      } catch (e) {
        return e as NetworkNotAllowedError;
      }
    })();
    expect(error?.message).toBe(
      "Skipped testnet payment options: Fake Testnet (fake:2, testnet). Testnets are off unless listed in networks.",
    );
    expect(error?.offered).toEqual(["fake:2"]);
    expect(() => keep(["fake:1"], ["fake:2"])).toThrow(
      "No payment option is on an allowed network. Offered: Fake (fake:1). Allowed: fake:2.",
    );
  });
});

describe("createClient", () => {
  it("pays the mainnet option when the server lists a testnet first", async () => {
    const client = await createClient({ wallet: minimalWallet(), families: [fakeFamily()] });
    let selected: string | undefined;
    client.onBeforePaymentCreation(async ({ selectedRequirements }) => {
      selected = selectedRequirements.network;
    });
    await client.createPaymentPayload({
      x402Version: 2,
      resource: { url: "https://example.com" },
      accepts: [fakeRequirement({ network: "fake:2" }), fakeRequirement({ network: "fake:1" })],
    });
    expect(selected).toBe("fake:1");
  });

  it.each([
    [{ networks: [] }, "at least one network"],
    [{ networks: ["fake"] }, 'networks entry "fake"'],
    [{ rpc: { "solana:*": "https://key@rpc.example/secret" } }, "patterns are not supported"],
    [{ rpc: { "eip155:8453": "ftp://rpc.example/secret" } }, "must be an http(s) URL"],
  ])("rejects invalid options %j", async (options, message) => {
    const error = await createClient({
      wallet: minimalWallet(),
      families: [fakeFamily()],
      ...(options as object),
    }).then(
      () => undefined,
      (e: Error) => e,
    );
    expect(error?.message).toContain(message);
    expect(error?.message).not.toContain("secret");
  });
});

describe("pay --network", () => {
  const defaults = { wallet: minimalWallet(), families: [fakeFamily()] };
  const both = [fakeRequirement({ network: "fake:1" }), fakeRequirement({ network: "fake:2" })];

  it("selects a testnet for one request", async () => {
    const { fetch } = paidServer(both);
    const result = await run(
      ["pay", "https://example.com/paid", "--network", "fake:2", "--dry-run", "--json"],
      { defaults, fetch },
    );
    expect(result.json).toMatchObject({
      dryRun: true,
      network: "fake:2",
      networkName: "Fake Testnet",
      testnet: true,
    });
  });

  it("labels testnets in the confirmation prompt", async () => {
    const questions: string[] = [];
    const { fetch } = paidServer([fakeRequirement({ network: "fake:2" })]);
    await run(["pay", "https://example.com/paid", "--network", "fake:2"], {
      defaults,
      fetch,
      isTTY: true,
      confirm: async question => (questions.push(question), false),
    });
    expect(questions).toEqual(["Pay 0.01 TOK to merchant on Fake Testnet (testnet)? [y/N] "]);
  });

  it("suggests --network when the server only accepts testnets", async () => {
    const { fetch, requests } = paidServer([fakeRequirement({ network: "fake:2" })]);
    const result = await run(["pay", "https://example.com/paid?q=1&r=2"], { defaults, fetch });
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("Skipped testnet payment options: Fake Testnet");
    expect(result.stdout).toContain("x402 pay 'https://example.com/paid?q=1&r=2' --network fake:2");
    expect(requests).toHaveLength(1);
  });

  it("suggests policy set when config.networks excludes every offer", async () => {
    const file = configFile({ networks: ["fake:1"] });
    const { fetch } = paidServer([fakeRequirement({ network: "fake:2" })]);
    const result = await run(["pay", "https://example.com/paid", "--config", file], {
      defaults,
      fetch,
    });
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("Allowed: fake:1.");
    expect(result.stdout).toContain("x402 policy set --network fake:1 --network fake:2");
  });

  it("can narrow config.networks but never widen it", async () => {
    const file = configFile({ networks: ["fake:1", "fake:3"] });
    const { fetch } = paidServer(both);
    const narrowed = await run(
      ["pay", "https://example.com/paid", "--network", "fake:1", "--config", file, "--dry-run"],
      { defaults, fetch },
    );
    expect(narrowed.code).toBe(0);
    const widened = await run(
      ["pay", "https://example.com/paid", "--network", "fake:2", "--config", file],
      { defaults, fetch },
    );
    expect(widened.code).toBe(1);
    expect(widened.stdout).toContain("--network can only narrow them");
    expect(widened.stdout).toContain(
      "x402 policy set --network fake:1 --network fake:3 --network fake:2",
    );
  });

  it("pays an x402 v1 server and reports CAIP-2 networks", async () => {
    const { fetch, requests } = paidServerV1([fakeRequirementV1()]);
    const result = await run(["pay", "https://example.com/paid", "--network", "fake:2", "--json"], {
      defaults,
      fetch,
    });
    expect(result.json).toMatchObject({
      status: 200,
      quote: { network: "fake:2", networkName: "Fake Testnet", formatted: "0.01 TOK" },
      receipt: { success: true, network: "fake:2" },
      body: "paid content",
    });
    expect(requests[1].headers.has("X-PAYMENT")).toBe(true);
  });

  it("suggests a CAIP-2 --network for an x402 v1 server", async () => {
    const { fetch } = paidServerV1([fakeRequirementV1()]);
    const result = await run(["pay", "https://example.com/paid"], { defaults, fetch });
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("x402 pay https://example.com/paid --network fake:2");
    expect(result.stdout).not.toContain("fake-testnet");
  });

  it("rejects patterns and malformed ids", async () => {
    for (const value of ["fake:*", "base"]) {
      const result = await run(["pay", "https://example.com/paid", "--network", value], {
        defaults,
      });
      expect(result.code).toBe(1);
      expect(result.stdout).toContain(`Invalid --network \\"${value}\\"`);
    }
  });
});
