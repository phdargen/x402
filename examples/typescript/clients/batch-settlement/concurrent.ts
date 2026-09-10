import { toClientEvmSigner, type ClientEvmSigner } from "@x402/evm";
import { BatchSettlementEvmScheme } from "@x402/evm/batch-settlement/client";
import { FileClientChannelStorage } from "@x402/evm/batch-settlement/client/file-storage";
import { x402Client, wrapFetchWithPayment, x402HTTPClient } from "@x402/fetch";
import { config } from "dotenv";
import { createPublicClient, http } from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

config();

const evmPrivateKeyRaw = process.env.EVM_PRIVATE_KEY?.trim();
if (!evmPrivateKeyRaw) {
  console.error("EVM_PRIVATE_KEY environment variable is required");
  process.exit(1);
}
const evmPrivateKey = evmPrivateKeyRaw as `0x${string}`;
const evmVoucherSignerPrivateKey = process.env.EVM_VOUCHER_SIGNER_PRIVATE_KEY?.trim() || undefined;
const baseURL = process.env.RESOURCE_SERVER_URL || "http://localhost:4021";
const endpointPath = process.env.ENDPOINT_PATH || "/weather";
const url = `${baseURL}${endpointPath}`;
const storageDir = process.env.STORAGE_DIR;
const channelSaltBase = (process.env.CHANNEL_SALT ??
  "0x0000000000000000000000000000000000000000000000000000000000000000") as `0x${string}`;
const numberOfRequests = Number(process.env.NUMBER_OF_REQUESTS ?? "3");
const numberOfChannels = Number(process.env.NUMBER_OF_CHANNELS ?? "3");
const refundAfterRequests = process.env.REFUND_AFTER_REQUESTS === "true";
const refundAmount = process.env.REFUND_AMOUNT;
const depositMultiplier = Number(process.env.DEPOSIT_MULTIPLIER ?? "5");

type ClientContext = {
  signer: ClientEvmSigner;
  voucherSigner: ClientEvmSigner | undefined;
};

/**
 * Builds a batch-settlement scheme for one channel index (optional isolated file storage).
 *
 * @param ctx - Shared signer configuration.
 * @param channelSalt - Channel index (`CHANNEL_SALT + slot`).
 * @param channelIndex - Used to partition file storage when `STORAGE_DIR` is set.
 * @returns Configured batch-settlement scheme.
 */
function createBatchedScheme(
  ctx: ClientContext,
  channelSalt: bigint,
  channelIndex: number,
): BatchSettlementEvmScheme {
  const channelStorageDir = storageDir
    ? `${storageDir.replace(/\/$/, "")}/channel-${channelIndex}`
    : undefined;

  return new BatchSettlementEvmScheme(ctx.signer, {
    depositPolicy: {
      depositMultiplier,
    },
    salt: channelSalt,
    ...(ctx.voucherSigner ? { voucherSigner: ctx.voucherSigner } : {}),
    ...(channelStorageDir
      ? { storage: new FileClientChannelStorage({ directory: channelStorageDir }) }
      : {}),
  });
}

/**
 * Runs sequential paid requests on a single payment channel.
 *
 * @param options - Channel label, scheme, and request count.
 * @param options.label - Log prefix for this channel.
 * @param options.channelSalt - Salt used for this channel id.
 * @param options.batchedScheme - Scheme instance for this channel.
 * @param options.requestCount - Number of sequential paid requests to send.
 * @returns Resolves after all configured requests (and optional refund) complete.
 */
async function runChannelPayments(options: {
  label: string;
  channelSalt: bigint;
  batchedScheme: BatchSettlementEvmScheme;
  requestCount: number;
}): Promise<void> {
  const { label, channelSalt, batchedScheme, requestCount } = options;

  const client = new x402Client();
  client.register("eip155:*", batchedScheme);
  client.setSpendControls({
    maxAmountPerPayment: "$1",
  });

  const fetchWithPayment = wrapFetchWithPayment(fetch, client);
  const httpClient = new x402HTTPClient(client);

  console.log(`${label} — channel salt: ${channelSalt}`);

  for (let i = 0; i < requestCount; i++) {
    const requestT0 = performance.now();

    const response = await fetchWithPayment(url, { method: "GET" });
    const result = await httpClient.processResponse(response);

    if (result.paymentStatus === "settled") {
      console.log(`${label} — Request ${i + 1} — RESPONSE`);
      console.log(result.body);
      console.log(JSON.stringify(result.header, null, 2));
    } else {
      console.log(`${label} — Request ${i + 1} — no settlement`);
      console.log(JSON.stringify(result, null, 2));
    }
    console.log(
      `${label} — Request ${i + 1} — completed in ${((performance.now() - requestT0) / 1000).toFixed(3)}s\n`,
    );
  }

  if (refundAfterRequests) {
    console.log(
      refundAmount
        ? `${label} — REQUESTING PARTIAL REFUND of ${refundAmount} base units`
        : `${label} — REQUESTING FULL REFUND of remaining channel balance`,
    );
    const refundT0 = performance.now();
    const settle = await batchedScheme.refund(url, {
      ...(refundAmount ? { amount: refundAmount } : {}),
    });
    console.log(JSON.stringify(settle, null, 2));
    console.log(
      `${label} — Refund completed in ${((performance.now() - refundT0) / 1000).toFixed(3)}s`,
    );
  }
}

/**
 * Multi-channel demo: parallel channels with incremented salts; each runs multiple payments.
 *
 * @returns Resolves when every channel finishes its payment sequence.
 */
async function main(): Promise<void> {
  if (!Number.isFinite(numberOfRequests) || numberOfRequests <= 0) {
    console.error("NUMBER_OF_REQUESTS must be a positive number");
    process.exit(1);
  }
  if (!Number.isFinite(numberOfChannels) || numberOfChannels <= 0) {
    console.error("NUMBER_OF_CHANNELS must be a positive number");
    process.exit(1);
  }

  const account = privateKeyToAccount(evmPrivateKey);
  const publicClient = createPublicClient({
    chain: baseSepolia,
    transport: http(),
  });
  const signer = toClientEvmSigner(account, publicClient);

  const voucherSigner = evmVoucherSignerPrivateKey
    ? toClientEvmSigner(privateKeyToAccount(evmVoucherSignerPrivateKey as `0x${string}`))
    : undefined;

  const ctx: ClientContext = { signer, voucherSigner };

  console.log(`Base URL: ${baseURL}, endpoint: ${endpointPath}`);
  console.log("payer (same EOA, distinct channels via salt):", signer.address);
  console.log("payerAuthorizer:", voucherSigner?.address ?? signer.address);
  console.log(
    `Channels: ${numberOfChannels} (salts ${channelSaltBase} + 0..${numberOfChannels - 1})`,
  );
  console.log(`Payments per channel: ${numberOfRequests}\n`);

  await Promise.all(
    Array.from({ length: numberOfChannels }, async (_, channelIndex) => {
      const salt = BigInt(channelSaltBase) + BigInt(channelIndex);
      const batchedScheme = createBatchedScheme(ctx, salt, channelIndex);
      const label = `Channel ${channelIndex + 1}/${numberOfChannels}`;

      await runChannelPayments({
        label,
        channelSalt: salt,
        batchedScheme,
        requestCount: numberOfRequests,
      });
    }),
  );
}

main().catch(error => {
  console.error(error?.response?.data?.error ?? error);
  process.exit(1);
});
