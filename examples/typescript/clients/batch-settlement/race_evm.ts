import { toClientEvmSigner } from "@x402/evm";
import { BatchSettlementEvmScheme } from "@x402/evm/batch-settlement/client";
import { FileClientChannelStorage } from "@x402/evm/batch-settlement/client/file-storage";
import { x402Client, x402HTTPClient } from "@x402/fetch";
import { createPublicClient, http } from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

import { raceCount, runRace } from "./raceCommon";

const evmPrivateKeyRaw = process.env.EVM_PRIVATE_KEY?.trim();
const evmVoucherSignerPrivateKey = process.env.EVM_VOUCHER_SIGNER_PRIVATE_KEY?.trim() || undefined;
const storageDir = process.env.STORAGE_DIR;
const channelSalt = (process.env.CHANNEL_SALT ??
  "0x0000000000000000000000000000000000000000000000000000000000000000") as `0x${string}`;
const depositMultiplier = Number(process.env.DEPOSIT_MULTIPLIER ?? "5");

if (!evmPrivateKeyRaw) {
  console.error("EVM_PRIVATE_KEY is required");
  process.exit(1);
}

/**
 * EVM batched race-condition demo: one payment payload, many parallel requests.
 */
async function main(): Promise<void> {
  const evmPrivateKey = evmPrivateKeyRaw as `0x${string}`;
  const account = privateKeyToAccount(evmPrivateKey);
  const publicClient = createPublicClient({
    chain: baseSepolia,
    transport: http(),
  });
  const signer = toClientEvmSigner(account, publicClient);

  const voucherSigner = evmVoucherSignerPrivateKey
    ? toClientEvmSigner(privateKeyToAccount(evmVoucherSignerPrivateKey as `0x${string}`))
    : undefined;

  const client = new x402Client();
  client.register(
    "eip155:*",
    new BatchSettlementEvmScheme(signer, {
      depositPolicy: {
        depositMultiplier,
      },
      salt: channelSalt,
      ...(voucherSigner ? { voucherSigner } : {}),
      ...(storageDir ? { storage: new FileClientChannelStorage({ directory: storageDir }) } : {}),
    }),
  );

  const httpClient = new x402HTTPClient(client);

  await runRace(client, httpClient, {
    label: "EVM",
    networkPrefix: "eip155",
    payerAddress: account.address,
    channelSalt,
    raceCount,
  });
}

main().catch(error => {
  console.error(error?.message ?? error);
  process.exit(1);
});
