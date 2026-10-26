import { afterEach, describe, expect, it, vi } from "vitest";
import { evm } from "../src/families/evm";
import { svm } from "../src/families/svm";
import { BASE_USDC, run, TEST_EVM_ADDRESS, TEST_EVM_KEY } from "./helpers";

interface RpcCall {
  url: string;
  method: string;
  params: unknown[];
}

/**
 * Stubs fetch with a JSON-RPC responder.
 *
 * @param respond - Returns the `result` for a call, or throws to return an RPC error
 * @returns Recorded calls
 */
function stubRpc(respond: (call: RpcCall) => unknown): RpcCall[] {
  const calls: RpcCall[] = [];
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const body = (await request.json()) as { id: number; method: string; params: unknown[] };
    const call = { url: request.url, method: body.method, params: body.params };
    calls.push(call);
    try {
      return Response.json({ jsonrpc: "2.0", id: body.id, result: respond(call) });
    } catch (error) {
      return Response.json({
        jsonrpc: "2.0",
        id: body.id,
        error: { code: -32000, message: String(error) },
      });
    }
  });
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("evm balances", () => {
  it("reads balanceOf for default assets through the configured RPC", async () => {
    const calls = stubRpc(() => `0x${1_250_000n.toString(16).padStart(64, "0")}`);
    const balances = await evm().balances(TEST_EVM_ADDRESS, { "eip155:8453": "https://base.rpc" }, [
      "eip155:8453",
    ]);
    expect(balances).toEqual([
      { network: "eip155:8453", asset: BASE_USDC, symbol: "USDC", amount: "1.25" },
    ]);
    expect(calls[0]).toMatchObject({ url: "https://base.rpc/", method: "eth_call" });
  });

  it("reports per-asset errors instead of failing", async () => {
    stubRpc(() => {
      throw new Error("boom");
    });
    const [balance] = await evm().balances(TEST_EVM_ADDRESS, {}, ["eip155:8453"]);
    expect(balance.amount).toBe("");
    expect(balance.error).toBeTruthy();
  });

  it("defaults to Base mainnet and Base Sepolia", async () => {
    stubRpc(() => `0x${"0".repeat(64)}`);
    const balances = await evm().balances(TEST_EVM_ADDRESS, {});
    expect(balances.map(b => b.network)).toEqual(["eip155:8453", "eip155:84532"]);
  });
});

describe("svm balances", () => {
  const owner = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

  it("sums token accounts for each default asset", async () => {
    const calls = stubRpc(() => ({
      context: { slot: 1 },
      value: [1_500_000, 500_000].map(amount => ({
        pubkey: owner,
        account: {
          data: {
            parsed: { info: { tokenAmount: { amount: String(amount) } } },
            program: "spl-token",
            space: 165,
          },
          executable: false,
          lamports: 1,
          owner,
          rentEpoch: 0,
          space: 165,
        },
      })),
    }));
    const balances = await svm().balances(owner, {}, ["solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"]);
    expect(balances.map(b => [b.symbol, b.amount])).toEqual([
      ["USDC", "2"],
      ["USDG", "2"],
      ["PYUSD", "2"],
    ]);
    expect(calls[0]).toMatchObject({
      url: "https://api.devnet.solana.com/",
      method: "getTokenAccountsByOwner",
    });
  });

  it("skips non-Solana networks", async () => {
    expect(await svm().balances(owner, {}, ["eip155:8453"])).toEqual([]);
  });
});

describe("x402 balance RPC resolution", () => {
  const argv = ["balance", "--family", "evm", "--network", "eip155:84532", "--json"];
  const defaults = { rpc: { "eip155:84532": "https://config.rpc" } } as const;

  it("prefers --rpc over X402_RPC over config.rpc, per network", async () => {
    const calls = stubRpc(() => `0x${"0".repeat(64)}`);
    const env = {
      X402_EVM_PRIVATE_KEY: TEST_EVM_KEY,
      X402_RPC: "eip155:8453=https://unused.rpc, eip155:84532=https://env.rpc",
    };
    await run([...argv, "--rpc", "eip155:84532=https://flag.rpc"], { env, defaults });
    await run(argv, { env, defaults });
    const fromConfig = await run(argv, { env: { X402_EVM_PRIVATE_KEY: TEST_EVM_KEY }, defaults });
    expect(calls.map(call => call.url)).toEqual([
      "https://flag.rpc/",
      "https://env.rpc/",
      "https://config.rpc/",
    ]);
    expect(fromConfig.json.balances[0]).toMatchObject({
      network: "eip155:84532",
      networkName: "Base Sepolia",
      testnet: true,
      amount: "0",
    });
  });

  it("fails on a malformed X402_RPC without echoing it", async () => {
    stubRpc(() => `0x${"0".repeat(64)}`);
    const result = await run(argv, {
      env: { X402_EVM_PRIVATE_KEY: TEST_EVM_KEY, X402_RPC: "https://rpc.example/v2/sekret" },
    });
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("Invalid X402_RPC entry");
    expect(result.stdout).not.toContain("sekret");
  });
});
