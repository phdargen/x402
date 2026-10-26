import { x402Client } from "@x402/core/client";
import { getBase58Encoder } from "@solana/kit";
import {
  DEFAULT_ASSETS as SVM_DEFAULT_ASSETS,
  SOLANA_DEVNET_CAIP2,
  SOLANA_MAINNET_CAIP2,
} from "@x402/svm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WalletError } from "../src";
import { evm } from "../src/families/evm";
import { svm } from "../src/families/svm";
import { loadFamily } from "../src/families";
import { BASE_USDC, TEST_EVM_ADDRESS, TEST_EVM_KEY } from "./helpers";

/**
 * Builds the error Node throws for a missing package.
 *
 * @param name - Package name
 * @returns The error
 */
function moduleNotFound(name: string): Error {
  return Object.assign(new Error(`Cannot find package '${name}' imported from /x/dist/evm.js`), {
    code: "ERR_MODULE_NOT_FOUND",
  });
}

describe("loadFamily", () => {
  it("loads the built-in families", async () => {
    expect((await loadFamily("evm")).id).toBe("evm");
    expect((await loadFamily("svm")).id).toBe("svm");
  });

  it("fails on an unknown id and lists the known ids", async () => {
    await expect(loadFamily("aptos")).rejects.toThrow(
      'Unknown family "aptos". Known families: evm, svm.',
    );
  });

  it("prints the install command when a peer is missing", async () => {
    const table = {
      evm: { load: () => Promise.reject(moduleNotFound("viem")), install: "@x402/evm viem" },
    };
    const error = await loadFamily("evm", table).catch(e => e);
    expect(error).toBeInstanceOf(WalletError);
    expect(error.message).toBe("EVM support is not installed.");
    expect(error.hint).toBe("npm i @x402/evm viem");
  });

  it("rethrows unrelated module errors", async () => {
    const table = {
      evm: { load: () => Promise.reject(moduleNotFound("other")), install: "@x402/evm viem" },
    };
    await expect(loadFamily("evm", table)).rejects.toThrow("Cannot find package 'other'");
  });
});

describe("evm family", () => {
  it("derives the address of a known key", async () => {
    expect((await evm().keys.toSigner(TEST_EVM_KEY)).address).toBe(TEST_EVM_ADDRESS);
  });

  it("round-trips a generated key", async () => {
    const key = await evm().keys.generate();
    expect(key).toMatch(/^0x[0-9a-f]{64}$/);
    expect((await evm().keys.toSigner(key)).address).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it("rejects malformed keys without echoing them", async () => {
    const error = await evm()
      .keys.toSigner("0xsecretvalue")
      .catch(e => e);
    expect(error.message).not.toContain("secretvalue");
  });

  it("provides exact and upto on eip155:*, and exact for x402 v1 servers", async () => {
    const family = evm();
    const client = x402Client.fromConfig({
      schemes: family.schemes(await family.keys.toSigner(TEST_EVM_KEY), {}),
    });
    let selected: string | undefined;
    client.onBeforePaymentCreation(async ({ selectedRequirements }) => {
      selected = selectedRequirements.scheme;
      return { abort: true, reason: "stop" };
    });
    for (const scheme of ["exact", "upto"]) {
      await expect(
        client.createPaymentPayload({
          x402Version: 2,
          resource: { url: "https://example.com" },
          accepts: [
            {
              scheme,
              network: "eip155:8453",
              asset: BASE_USDC,
              amount: "10000",
              payTo: TEST_EVM_ADDRESS,
              maxTimeoutSeconds: 60,
              extra: { name: "USD Coin", version: "2" },
            },
          ],
        }),
      ).rejects.toThrow("stop");
      expect(selected).toBe(scheme);
    }
    selected = undefined;
    await expect(
      client.createPaymentPayload({
        x402Version: 1,
        accepts: [
          {
            scheme: "exact",
            network: "base",
            maxAmountRequired: "10000",
            resource: "https://example.com",
            description: "",
            mimeType: "",
            payTo: TEST_EVM_ADDRESS,
            maxTimeoutSeconds: 60,
            asset: BASE_USDC,
            extra: { name: "USD Coin", version: "2" },
          },
        ],
      } as never),
    ).rejects.toThrow("stop");
    expect(selected).toBe("exact");
  });

  it("converts x402 v1 network names to CAIP-2", () => {
    const { fromV1Network } = evm();
    expect(fromV1Network!("base-sepolia")).toBe("eip155:84532");
    expect(fromV1Network!("eip155:84532")).toBeUndefined();
    expect(fromV1Network!("constructor")).toBeUndefined();
  });

  it("formats known assets", () => {
    expect(evm().formatAmount!("10000", BASE_USDC, "eip155:8453")).toBe("0.01 USDC");
    expect(evm().formatAmount!("10000", "0xunknown", "eip155:8453")).toBeUndefined();
  });

  it("describes networks from viem", () => {
    const { describeNetwork } = evm();
    expect(describeNetwork!("eip155:8453")).toEqual({ name: "Base", testnet: false });
    expect(describeNetwork!("eip155:84532")).toEqual({ name: "Base Sepolia", testnet: true });
    expect(describeNetwork!("eip155:4242424242424")).toBeUndefined();
    expect(describeNetwork!("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp")).toBeUndefined();
  });
});

describe("svm family", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("describes Solana clusters", () => {
    const { describeNetwork } = svm();
    expect(describeNetwork!(SOLANA_MAINNET_CAIP2)).toEqual({ name: "Solana", testnet: false });
    expect(describeNetwork!(SOLANA_DEVNET_CAIP2)).toEqual({ name: "Solana Devnet", testnet: true });
    expect(describeNetwork!("eip155:8453")).toBeUndefined();
  });

  it("converts x402 v1 network names to CAIP-2", () => {
    const { fromV1Network } = svm();
    expect(fromV1Network!("solana-devnet")).toBe(SOLANA_DEVNET_CAIP2);
    expect(fromV1Network!(SOLANA_DEVNET_CAIP2)).toBeUndefined();
    expect(fromV1Network!("constructor")).toBeUndefined();
  });

  it("pays through the RPC configured for the CAIP-2 id, on v2 and v1", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      urls.push(new Request(input, init).url);
      return Response.json({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "stop" } });
    });
    const family = svm();
    const signer = await family.keys.toSigner(await family.keys.generate());
    const client = x402Client.fromConfig({
      schemes: family.schemes(signer, {
        [SOLANA_DEVNET_CAIP2]: "https://devnet.example-rpc.com",
      }),
    });
    const [{ asset }] = SVM_DEFAULT_ASSETS[SOLANA_DEVNET_CAIP2]!;
    const base = {
      scheme: "exact",
      asset,
      payTo: signer.address,
      maxTimeoutSeconds: 60,
      extra: { feePayer: signer.address },
    };
    await expect(
      client.createPaymentPayload({
        x402Version: 2,
        resource: { url: "https://example.com" },
        accepts: [{ ...base, network: SOLANA_DEVNET_CAIP2, amount: "10000" }],
      }),
    ).rejects.toThrow();
    const v2Calls = urls.length;
    expect(v2Calls).toBeGreaterThan(0);
    await expect(
      client.createPaymentPayload({
        x402Version: 1,
        accepts: [
          {
            ...base,
            network: "solana-devnet",
            maxAmountRequired: "10000",
            resource: "https://example.com",
            description: "",
            mimeType: "",
          },
        ],
      } as never),
    ).rejects.toThrow();
    expect(urls.length).toBeGreaterThan(v2Calls);
    expect(new Set(urls)).toEqual(new Set(["https://devnet.example-rpc.com/"]));
  });

  it("round-trips a generated base58 64-byte key", async () => {
    const family = svm();
    const secret = await family.keys.generate();
    const bytes = getBase58Encoder().encode(secret);
    expect(bytes).toHaveLength(64);
    const signer = await family.keys.toSigner(secret);
    expect(signer.address).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
  });

  it("rejects keys that are not 64 bytes", async () => {
    await expect(svm().keys.toSigner("abc")).rejects.toThrow("64 bytes");
  });
});
