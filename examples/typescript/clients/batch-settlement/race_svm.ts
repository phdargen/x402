import { base58 } from "@scure/base";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { x402Client, x402HTTPClient } from "@x402/fetch";
import { BatchSvmScheme } from "@x402/svm/batch-settlement/client";

import { raceCount, runRace } from "./raceCommon";

const svmPrivateKey = process.env.SVM_PRIVATE_KEY?.trim();
const svmRpcUrl = process.env.SVM_RPC_URL?.trim() || undefined;
const channelSalt = process.env.SVM_CHANNEL_SALT?.trim() || "0";
const depositMultiplier = Number(process.env.DEPOSIT_MULTIPLIER ?? "5");
const svmServerSignedOperators = (process.env.SVM_SERVER_SIGNED_OPERATORS ?? "")
  .split(",")
  .map(key => key.trim())
  .filter(Boolean);
const svmServerSignedMaxDeposit = process.env.SVM_SERVER_SIGNED_MAX_DEPOSIT?.trim() || "$0.05";

if (!svmPrivateKey) {
  console.error("SVM_PRIVATE_KEY is required");
  process.exit(1);
}

/**
 * Solana batched race-condition demo: one payment payload, many parallel requests.
 */
async function main(svmPrivateKey: string): Promise<void> {
  const svmSigner = await createKeyPairSignerFromBytes(base58.decode(svmPrivateKey));
  const scheme = new BatchSvmScheme(svmSigner, {
    depositPolicy: { depositMultiplier },
    salt: channelSalt,
    ...(svmRpcUrl ? { rpcUrl: svmRpcUrl } : {}),
    ...(svmServerSignedOperators.length > 0
      ? {
          serverSignedChannelsPolicy: {
            allowedOperators: svmServerSignedOperators,
            maxDeposit: svmServerSignedMaxDeposit,
          },
        }
      : {}),
  });

  const client = new x402Client();
  client.register("solana:*", scheme);
  // Prefer trusted server-signed metered accepts; without trust the policy drops
  // them and the client pays with its own vouchers (same as index.ts).
  client.registerPolicy(scheme.paymentPolicy);

  console.log(
    "SVM server-signed channels:",
    svmServerSignedOperators.length > 0
      ? `trusted operators ${svmServerSignedOperators.join(", ")} up to ${svmServerSignedMaxDeposit} per channel`
      : "refused (client-signed vouchers only)",
  );
  console.log("");

  const httpClient = new x402HTTPClient(client);

  await runRace(client, httpClient, {
    label: "SVM",
    networkPrefix: "solana",
    payerAddress: svmSigner.address,
    channelSalt,
    raceCount,
  });
}

void main(svmPrivateKey).catch(error => {
  console.error(error?.message ?? error);
  process.exit(1);
});
