import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";
import type {
  Network,
  PaymentRequirements,
  PaymentRequirementsV1,
  SchemeNetworkClient,
} from "@x402/core/types";
import {
  runCli,
  type Config,
  type NetworkFamily,
  type NetworkInfo,
  type RunOptions,
  type Wallet,
} from "../src";

export const TEST_EVM_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
export const TEST_EVM_ADDRESS = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
export const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
  /** stdout parsed as JSON, when it is JSON. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json: any;
}

/**
 * Creates an empty temporary directory.
 *
 * @returns Its path
 */
export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "x402-cli-"));
}

/**
 * Runs the CLI in-process with captured IO and an isolated HOME.
 *
 * @param argv - Arguments
 * @param options - Defaults and IO overrides
 * @returns Captured output and exit code
 */
export async function run(
  argv: string[],
  options: Omit<RunOptions, "argv" | "stdout" | "stderr" | "exit"> & { defaults?: Config } = {},
): Promise<RunResult> {
  let stdout = "";
  let stderr = "";
  let code = 0;
  const { defaults = {}, ...rest } = options;
  await runCli(defaults, {
    isTTY: false,
    ...rest,
    env: { HOME: tempDir(), ...rest.env },
    argv,
    stdout: text => void (stdout += text),
    stderr: text => void (stderr += text),
    exit: exitCode => void (code = exitCode),
  });
  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch {
    json = undefined;
  }
  return { stdout, stderr, code, json };
}

const FAKE_V1_NETWORK = "fake-testnet" as Network;

const FAKE_NETWORKS: Record<string, NetworkInfo> = {
  "fake:1": { name: "Fake", testnet: false },
  "fake:2": { name: "Fake Testnet", testnet: true },
};

/**
 * A family on `fake:*` that needs no chain. Its scheme treats `TOK` as a 6-decimal default asset.
 * It knows `fake:1` (mainnet) and `fake:2` (testnet), which x402 v1 servers call `fake-testnet`.
 *
 * @returns The fake family
 */
export function fakeFamily(): NetworkFamily {
  return {
    id: "fake",
    network: "fake:*",
    keys: {
      generate: async () => "fakesecret",
      toSigner: async secret => ({ address: `addr-${secret}` }),
    },
    schemes: signer => {
      const client: SchemeNetworkClient = {
        scheme: "exact",
        findDefaultAsset: asset =>
          asset === "TOK" ? { asset, decimals: 6, symbol: "TOK" } : undefined,
        createPaymentPayload: async x402Version => ({
          x402Version,
          payload: { from: signer.address },
        }),
      };
      return [
        { network: "fake:*", client },
        { x402Version: 1, network: FAKE_V1_NETWORK, client },
      ];
    },
    fromV1Network: name => (name === FAKE_V1_NETWORK ? "fake:2" : undefined),
    balances: async (address, _rpc, networks) =>
      (networks ?? ["fake:1"]).map(network => ({
        network,
        asset: "TOK",
        symbol: "TOK",
        amount: "1.5",
      })),
    formatAmount: (amount, asset) => (asset === "TOK" ? `${Number(amount) / 1e6} TOK` : undefined),
    describeNetwork: network =>
      Object.hasOwn(FAKE_NETWORKS, network) ? FAKE_NETWORKS[network] : undefined,
  };
}

/**
 * A wallet with only the required members.
 *
 * @returns The minimal wallet
 */
export function minimalWallet(): Wallet {
  return {
    id: "minimal",
    getSigner: async (name, family) => family.keys.toSigner(`${name}-key`),
  };
}

/**
 * A requirement for the fake family.
 *
 * @param overrides - Fields to override
 * @returns Payment requirements
 */
export function fakeRequirement(overrides: Partial<PaymentRequirements> = {}): PaymentRequirements {
  return {
    scheme: "exact",
    network: "fake:1",
    asset: "TOK",
    amount: "10000",
    payTo: "merchant",
    maxTimeoutSeconds: 60,
    extra: {},
    ...overrides,
  };
}

/**
 * A 402 response advertising `accepts`.
 *
 * @param url - Resource URL
 * @param accepts - Requirements
 * @returns The response
 */
export function paymentRequired(url: string, accepts: PaymentRequirements[]): Response {
  const header = encodePaymentRequiredHeader({ x402Version: 2, resource: { url }, accepts });
  return new Response("{}", {
    status: 402,
    headers: { "PAYMENT-REQUIRED": header, "Content-Type": "application/json" },
  });
}

/**
 * A fetch that answers 402 until it sees a payment, then 200 with a receipt.
 *
 * @param accepts - Requirements to advertise
 * @returns The fetch and the requests it received
 */
export function paidServer(accepts: PaymentRequirements[]) {
  const requests: Request[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push(request);
    if (!request.headers.has("PAYMENT-SIGNATURE")) return paymentRequired(request.url, accepts);
    const receipt = encodePaymentResponseHeader({
      success: true,
      transaction: "0xtx",
      network: accepts[0].network,
      payer: "payer",
    });
    return new Response("paid content", { status: 200, headers: { "PAYMENT-RESPONSE": receipt } });
  };
  return { fetch: fetch as typeof globalThis.fetch, requests };
}

/**
 * An x402 v1 requirement for the fake family, on `fake-testnet`.
 *
 * @returns Payment requirements
 */
export function fakeRequirementV1(): PaymentRequirementsV1 {
  return {
    scheme: "exact",
    network: FAKE_V1_NETWORK,
    maxAmountRequired: "10000",
    resource: "https://example.com/paid",
    description: "",
    mimeType: "",
    outputSchema: {},
    payTo: "merchant",
    maxTimeoutSeconds: 60,
    asset: "TOK",
    extra: {},
  };
}

/**
 * Like {@link paidServer}, for an x402 v1 server: requirements in the 402 body, payment in
 * `X-PAYMENT`, receipt in `X-PAYMENT-RESPONSE`.
 *
 * @param accepts - Requirements to advertise
 * @returns The fetch and the requests it received
 */
export function paidServerV1(accepts: PaymentRequirementsV1[]) {
  const requests: Request[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push(request);
    if (!request.headers.has("X-PAYMENT")) {
      return Response.json({ x402Version: 1, accepts }, { status: 402 });
    }
    const receipt = encodePaymentResponseHeader({
      success: true,
      transaction: "0xtx",
      network: accepts[0].network,
      payer: "payer",
    });
    return new Response("paid content", {
      status: 200,
      headers: { "X-PAYMENT-RESPONSE": receipt },
    });
  };
  return { fetch: fetch as typeof globalThis.fetch, requests };
}
