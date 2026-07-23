import { randomInt } from "node:crypto";
import { toClientEvmSigner } from "@x402/evm";
import { BatchSettlementEvmScheme } from "@x402/evm/batch-settlement/client";
import { FileClientChannelStorage } from "@x402/evm/batch-settlement/client/file-storage";
import { x402Client, wrapFetchWithPayment, x402HTTPClient } from "@x402/fetch";
import { config } from "dotenv";
import { createPublicClient, encodePacked, http, keccak256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

config();

const evmPrivateKey = process.env.EVM_PRIVATE_KEY?.trim() as `0x${string}` | undefined;
if (!evmPrivateKey) {
  console.error("EVM_PRIVATE_KEY environment variable is required");
  process.exit(1);
}

const voucherSignerPrivateKey = process.env.EVM_VOUCHER_SIGNER_PRIVATE_KEY?.trim() as
  | `0x${string}`
  | undefined;
const resourceServerUrl = process.env.RESOURCE_SERVER_URL ?? "http://localhost:4021";
const facilitatorUrl = process.env.FACILITATOR_URL ?? "http://localhost:4022";
const storageDir = process.env.STORAGE_DIR?.trim();
const baseSalt = (process.env.CHANNEL_SALT ??
  "0x0000000000000000000000000000000000000000000000000000000000000000") as `0x${string}`;

/**
 * Reads a positive integer from the environment.
 *
 * @param name - Environment variable name.
 * @param fallback - Value used when the variable is unset.
 * @returns The validated positive integer.
 */
function positiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

/**
 * Truncates long strings for readable failure logs.
 *
 * @param value - Value to stringify.
 * @param maxLength - Maximum characters retained.
 * @returns Truncated string representation.
 */
function truncate(value: unknown, maxLength = 400): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) return "";
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}…`;
}

/**
 * Summarizes a settle failure without dumping full RPC request bodies.
 *
 * @param result - Parsed HTTP payment response.
 * @returns Compact failure summary.
 */
function summarizeFailure(result: {
  status: number;
  paymentStatus: string;
  header: unknown;
  body: unknown;
}): string {
  const header =
    result.header && typeof result.header === "object"
      ? (result.header as Record<string, unknown>)
      : undefined;
  return JSON.stringify(
    {
      status: result.status,
      paymentStatus: result.paymentStatus,
      errorReason: header?.errorReason,
      errorMessage: truncate(header?.errorMessage),
      payer: header?.payer,
      network: header?.network,
      body: result.body,
    },
    null,
    2,
  );
}

/**
 * Runs tasks with a fixed concurrency limit.
 *
 * @param items - Items to process.
 * @param concurrency - Maximum in-flight tasks.
 * @param worker - Per-item async worker.
 * @returns Worker results in input order.
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function runWorker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await worker(items[index], index);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => runWorker());
  await Promise.all(workers);
  return results;
}

const clientCount = positiveInteger("N_CLIENTS", 3);
const serverCount = positiveInteger("M_SERVERS", 4);
const paymentsPerClient = positiveInteger("N_PAYMENTS", 5);
const depositMultiplier = positiveInteger("DEPOSIT_MULTIPLIER", paymentsPerClient + 2);
// Default 1: concurrent first deposits against public RPCs often hit rate limits.
const clientConcurrency = positiveInteger("CLIENT_CONCURRENCY", 1);

if (!/^0x[0-9a-fA-F]{64}$/.test(baseSalt)) {
  throw new Error("CHANNEL_SALT must be a 32-byte 0x-prefixed hex value");
}

const payerAccount = privateKeyToAccount(evmPrivateKey);
const publicClient = createPublicClient({
  chain: baseSepolia,
  transport: http(process.env.EVM_RPC_URL),
});
const signer = toClientEvmSigner(payerAccount, publicClient);
const voucherSigner = voucherSignerPrivateKey
  ? toClientEvmSigner(privateKeyToAccount(voucherSignerPrivateKey))
  : undefined;

/**
 * Runs one logical client over a salt-isolated shared gateway channel.
 *
 * @param clientIndex - Zero-based logical client index.
 * @returns Number of successful payments.
 */
async function runClient(clientIndex: number): Promise<number> {
  const salt = keccak256(encodePacked(["bytes32", "uint256"], [baseSalt, BigInt(clientIndex)]));
  const scheme = new BatchSettlementEvmScheme(signer, {
    salt,
    depositPolicy: { depositMultiplier },
    ...(voucherSigner ? { voucherSigner } : {}),
    ...(storageDir
      ? {
          storage: new FileClientChannelStorage({
            directory: `${storageDir}/client-${clientIndex + 1}`,
          }),
        }
      : {}),
  });
  const client = new x402Client().register("eip155:*", scheme);
  const fetchWithPayment = wrapFetchWithPayment(fetch, client);
  const httpClient = new x402HTTPClient(client);
  let successfulPayments = 0;

  for (let paymentIndex = 0; paymentIndex < paymentsPerClient; paymentIndex++) {
    const serverIndex = randomInt(serverCount) + 1;
    const url = `${resourceServerUrl}/server/${serverIndex}/weather`;
    const response = await fetchWithPayment(url, { method: "GET" });
    const result = await httpClient.processResponse(response);
    if (result.paymentStatus !== "settled") {
      throw new Error(
        `Client ${clientIndex + 1} payment ${paymentIndex + 1} to server ${serverIndex} did not settle:\n${summarizeFailure(result)}`,
      );
    }
    successfulPayments++;
    console.log(
      `Client ${clientIndex + 1}: payment ${paymentIndex + 1}/${paymentsPerClient} -> server ${serverIndex}`,
    );
  }

  return successfulPayments;
}

/**
 * Runs all logical clients, then asks the facilitator to redeem accumulated state once.
 */
async function main(): Promise<void> {
  console.log(
    `Running ${clientCount} clients x ${paymentsPerClient} payments against ${serverCount} servers`,
  );
  console.log(`Client concurrency: ${clientConcurrency}`);
  console.log(`Payer: ${signer.address}`);
  console.log(`Voucher signer: ${voucherSigner?.address ?? signer.address}`);

  const successfulPayments = (
    await mapWithConcurrency(
      Array.from({ length: clientCount }, (_, index) => index),
      clientConcurrency,
      clientIndex => runClient(clientIndex),
    )
  ).reduce((total, count) => total + count, 0);

  console.log(`Completed ${successfulPayments} payments; requesting one accumulated distribution`);
  const response = await fetch(`${facilitatorUrl}/distribute`, { method: "POST" });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Distribution failed (${response.status}): ${body}`);
  }
  console.log(`Distribution result: ${body}`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
