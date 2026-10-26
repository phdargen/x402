import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WalletError } from "../src";
import {
  capSpendControls,
  parseAllowAsset,
  parseConfig,
  parseRpcSpecs,
  redactUrl,
} from "../src/config";
import { fakeFamily, fakeRequirement, minimalWallet, paidServer, run, tempDir } from "./helpers";

/**
 * Writes a JSON config file.
 *
 * @param path - Destination
 * @param config - Contents
 * @returns The path
 */
function writeJson(path: string, config: unknown): string {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(config));
  return path;
}

describe("config resolution", () => {
  const home = tempDir();
  const homeFile = writeJson(join(home, ".config", "x402", "config.json"), { account: "home" });
  const envFile = writeJson(join(tempDir(), "env.json"), { account: "env" });
  const flagFile = writeJson(join(tempDir(), "flag.json"), { account: "flag" });

  it("prefers --config over X402_CONFIG over the home file", async () => {
    const env = { HOME: home, X402_CONFIG: envFile };
    const flag = await run(["config", "view", "--config", flagFile, "--json"], { env });
    expect(flag.json).toMatchObject({
      path: flagFile,
      source: "--config",
      config: { account: "flag" },
    });
    const fromEnv = await run(["config", "view", "--json"], { env });
    expect(fromEnv.json).toMatchObject({
      path: envFile,
      source: "X402_CONFIG",
      config: { account: "env" },
    });
    const fromHome = await run(["config", "view", "--json"], { env: { HOME: home } });
    expect(fromHome.json).toMatchObject({
      path: homeFile,
      source: "home",
      config: { account: "home" },
    });
  });

  it("ignores config files in the working directory", async () => {
    const cwd = tempDir();
    writeJson(join(cwd, "x402.config.json"), { account: "cwd" });
    writeJson(join(cwd, "config.json"), { account: "cwd" });
    writeJson(join(cwd, "x402.json"), { account: "cwd" });
    const previous = process.cwd();
    process.chdir(cwd);
    try {
      const result = await run(["config", "view", "--json"]);
      expect(result.json).toMatchObject({ source: "home", exists: false, config: {} });
    } finally {
      process.chdir(previous);
    }
  });

  it("fails when an explicit config file is missing", async () => {
    const result = await run(["config", "view", "--config", "/nope/x402.json"]);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("does not exist");
  });

  it("overrides runCli defaults field by field and concatenates wallets", async () => {
    const file = writeJson(join(tempDir(), "c.json"), { account: "file", wallet: "keychain" });
    const result = await run(["config", "view", "--config", file, "--json"], {
      defaults: { account: "defaults", families: ["evm"], wallets: [minimalWallet()] },
    });
    expect(result.json.config).toEqual({
      account: "file",
      wallet: "keychain",
      families: ["evm"],
      wallets: ["minimal"],
    });
  });

  it("validates JSON config", () => {
    expect(() => parseConfig({ spendControls: false }, "c.json")).toThrow("cannot be turned off");
    expect(() =>
      parseConfig({ spendControls: { maxAmountPerPayment: false } }, "c.json"),
    ).toThrow();
    expect(() => parseConfig({ wallets: [] }, "c.json")).toThrow('unknown field "wallets"');
    expect(parseConfig({ rpc: { "eip155:8453": "https://rpc" } }, "c.json")).toEqual({
      rpc: { "eip155:8453": "https://rpc" },
    });
  });

  it("validates networks and rpc keys", () => {
    expect(parseConfig({ networks: ["eip155:8453", "solana:*"] }, "c.json")).toEqual({
      networks: ["eip155:8453", "solana:*"],
    });
    expect(() => parseConfig({ networks: "eip155:8453" }, "c.json")).toThrow("must be a list");
    expect(() => parseConfig({ networks: ["base"] }, "c.json")).toThrow('networks entry "base"');
    expect(() => parseConfig({ rpc: { "eip155:*": "https://rpc" } }, "c.json")).toThrow(
      "patterns are not supported",
    );
    const error = (() => {
      try {
        parseConfig({ rpc: { "eip155:8453": "not a url/sekret" } }, "c.json");
      } catch (e) {
        return e as Error;
      }
    })();
    expect(error?.message).toContain('rpc["eip155:8453"] must be an http(s) URL');
    expect(error?.message).not.toContain("sekret");
  });

  it("validates networks and rpc in TS and MJS configs", async () => {
    const file = join(tempDir(), "x402.config.mjs");
    writeFileSync(file, "export default { rpc: { 'solana:*': 'https://rpc' } };\n");
    const result = await run(["config", "view", "--config", file]);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain(
      "must be a CAIP-2 network such as eip155:8453; patterns are not supported",
    );
  });

  it("redacts RPC URLs that could carry a key in config view", async () => {
    const file = writeJson(join(tempDir(), "c.json"), {
      rpc: {
        "eip155:8453": "https://base-mainnet.g.alchemy.com/v2/sekret",
        "eip155:84532": "https://sepolia.base.org",
        "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1": "https://devnet.helius-rpc.com/?api-key=sekret",
      },
    });
    const result = await run(["config", "view", "--config", file, "--json"]);
    expect(result.json.config.rpc).toEqual({
      "eip155:8453": "https://base-mainnet.g.alchemy.com/<redacted>",
      "eip155:84532": "https://sepolia.base.org",
      "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1": "https://devnet.helius-rpc.com/<redacted>",
    });
    expect(result.stdout).not.toContain("sekret");
  });

  it("refuses to rewrite non-JSON config files", async () => {
    const file = join(tempDir(), "x402.config.mjs");
    writeFileSync(file, "export default { account: 'mjs' };\n");
    const view = await run(["config", "view", "--config", file, "--json"]);
    expect(view.json.config).toEqual({ account: "mjs" });
    const result = await run(["account", "default", "work", "--config", file]);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain(`edit ${file} directly`);
  });
});

describe("writing config", () => {
  it("config init writes a starter file and refuses to overwrite it", async () => {
    const file = join(tempDir(), "nested", "x402.json");
    const first = await run(["config", "init", "--family", "evm", "--config", file, "--json"]);
    expect(first.code).toBe(0);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      families: ["evm"],
      spendControls: { maxAmountPerPayment: "$1" },
    });
    const second = await run(["config", "init", "--config", file]);
    expect(second.code).toBe(1);
    expect(second.stdout).toContain("x402 config init --force");
  });

  it("account default writes config.account", async () => {
    const file = join(tempDir(), "x402.json");
    await run(["account", "default", "work", "--config", file]);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ account: "work" });
    const invalid = await run(["account", "default", "Bad_Name", "--config", file]);
    expect(invalid.stdout).toContain("Invalid account name");
  });

  it("policy set --dry-run writes nothing", async () => {
    const file = join(tempDir(), "x402.json");
    const result = await run([
      "policy",
      "set",
      "--max-amount",
      "$0.50",
      "--dry-run",
      "--config",
      file,
      "--json",
    ]);
    expect(result.json).toMatchObject({
      written: false,
      spendControls: { maxAmountPerPayment: "$0.50" },
    });
    expect(existsSync(file)).toBe(false);
  });

  it("policy set writes spend controls", async () => {
    const file = writeJson(join(tempDir(), "x402.json"), { account: "work" });
    const asset = "eip155:8453/0xabc/2000000";
    await run(["policy", "set", "--max-amount", "$0.50", "--allow-asset", asset, "--config", file]);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      account: "work",
      spendControls: {
        maxAmountPerPayment: "$0.50",
        allowedAssets: [{ network: "eip155:8453", asset: "0xabc", maxAmountPerPayment: "2000000" }],
      },
    });
  });

  it("policy set --network writes networks without touching spend controls", async () => {
    const file = writeJson(join(tempDir(), "x402.json"), { account: "work" });
    const result = await run([
      "policy",
      "set",
      "--network",
      "eip155:8453",
      "--network",
      "solana:*",
      "--config",
      file,
      "--json",
    ]);
    expect(result.json).toEqual({
      path: file,
      written: true,
      networks: ["eip155:8453", "solana:*"],
    });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      account: "work",
      networks: ["eip155:8453", "solana:*"],
    });
    const invalid = await run(["policy", "set", "--network", "base", "--config", file]);
    expect(invalid.code).toBe(1);
    expect(invalid.stdout).toContain("Invalid --network: networks entry");
    expect(invalid.stdout).toContain("x402 policy set --network eip155:8453");
  });

  it("policy set rejects bad input with an example", async () => {
    expect((await run(["policy", "set"])).stdout).toContain("x402 policy set --max-amount '$0.50'");
    expect((await run(["policy", "set", "--max-amount", "5 USDT"])).stdout).toContain(
      "Invalid amount",
    );
    expect(() => parseAllowAsset("eip155:8453")).toThrow("Invalid --allow-asset");
  });
});

describe("--rpc and X402_RPC", () => {
  it("parses <network>=<url> entries", () => {
    expect(
      parseRpcSpecs(["eip155:8453=https://a.rpc/x?k=1", "eip155:84532=http://b.rpc"], "--rpc"),
    ).toEqual({ "eip155:8453": "https://a.rpc/x?k=1", "eip155:84532": "http://b.rpc" });
  });

  it.each(["https://rpc.example/v2/sekret", "eip155:*=https://rpc/sekret", "eip155:8453=sekret"])(
    "rejects %s without echoing it",
    spec => {
      const error = (() => {
        try {
          parseRpcSpecs([spec], "--rpc");
        } catch (e) {
          return e as WalletError;
        }
      })();
      expect(error).toBeInstanceOf(WalletError);
      expect(error?.message).toContain("Invalid --rpc entry");
      expect(error?.message).not.toContain("sekret");
      expect(error?.hint).toContain("--rpc eip155:8453=");
    },
  );

  it("redacts everything after the origin when a URL could carry a key", () => {
    expect(redactUrl("https://rpc.example")).toBe("https://rpc.example");
    expect(redactUrl("https://user:pw@rpc.example")).toBe("https://rpc.example/<redacted>");
    expect(redactUrl("nonsense")).toBe("<redacted>");
  });
});

describe("--max-amount", () => {
  it("lowers the cap but never raises it", () => {
    expect(capSpendControls({ maxAmountPerPayment: "$1" }, "$5")).toEqual({
      maxAmountPerPayment: "$1",
    });
    expect(capSpendControls({}, "$5")).toEqual({});
    expect(capSpendControls({ maxAmountPerPayment: "$1" }, "$0.10")).toEqual({
      maxAmountPerPayment: "$0.10",
    });
    expect(capSpendControls({}, 0.5)).toEqual({ maxAmountPerPayment: 0.5 });
  });

  it("stays capped at a $1 policy when pay passes --max-amount '$5'", async () => {
    const file = writeJson(join(tempDir(), "x402.json"), {
      spendControls: { maxAmountPerPayment: "$1" },
    });
    const { fetch, requests } = paidServer([fakeRequirement({ amount: "2000000" })]);
    const result = await run(
      ["pay", "https://example.com/paid", "--max-amount", "$5", "--config", file],
      {
        defaults: { wallet: minimalWallet(), families: [fakeFamily()] },
        fetch,
      },
    );
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("rejected by spendControls.maxAmountPerPayment");
    expect(requests).toHaveLength(1);
  });

  it("applies a lower --max-amount", async () => {
    const { fetch } = paidServer([fakeRequirement({ amount: "10000" })]);
    const result = await run(["pay", "https://example.com/paid", "--max-amount", "$0.001"], {
      defaults: { wallet: minimalWallet(), families: [fakeFamily()] },
      fetch,
    });
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("rejected by spendControls.maxAmountPerPayment");
  });

  it("refuses spend controls turned off in a TS config or runCli defaults", async () => {
    const result = await run(["config", "view"], {
      defaults: { spendControls: { maxAmountPerPayment: false } as never },
    });
    expect(result.stdout).toContain("cannot be turned off");
  });
});
