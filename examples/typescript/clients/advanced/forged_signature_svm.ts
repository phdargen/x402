import { config } from "dotenv";
import { x402Client, x402HTTPClient } from "@x402/fetch";
import type { PaymentPayload } from "@x402/core/types";
import { decodeTransactionFromPayload } from "@x402/svm";
import { registerExactSvmScheme } from "@x402/svm/exact/client";
import {
  createKeyPairSignerFromBytes,
  getAddressEncoder,
  getBase64EncodedWireTransaction,
  getCompiledTransactionMessageDecoder,
  verifySignature,
  type Address,
  type Transaction,
} from "@solana/kit";
import { base58 } from "@scure/base";

config();

const svmPrivateKey = process.env.SVM_PRIVATE_KEY;
const baseURL = process.env.RESOURCE_SERVER_URL ?? "http://localhost:4021";
const endpointPath = process.env.ENDPOINT_PATH ?? "/weather";
const url = `${baseURL}${endpointPath}`;

const INVALID_SIGNATURE = "invalid_exact_svm_payload_signature_invalid";

if (!svmPrivateKey) {
  console.error("SVM_PRIVATE_KEY is required");
  process.exit(1);
}

const addressEncoder = getAddressEncoder();
const compiledMessageDecoder = getCompiledTransactionMessageDecoder();

/**
 * JSON.stringify that serializes bigint as a decimal string.
 *
 * @param value - Value to serialize.
 * @returns JSON string.
 */
function jsonStringify(value: unknown): string {
  return JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? v.toString() : v));
}

/**
 * Encodes bytes as a hex string for signature dumps.
 *
 * @param data - Bytes to encode.
 * @returns Hex encoding of `data`.
 */
function hex(data: Uint8Array): string {
  return Buffer.from(data).toString("hex");
}

/**
 * Replaces every non-fee-payer required signature with all-zero bytes.
 *
 * @param transaction - Legitimately signed wire transaction
 * @returns Wire transaction with forged client signatures
 */
function forgeClientSignatures(transaction: Transaction): Transaction {
  const compiled = compiledMessageDecoder.decode(transaction.messageBytes);
  const forgedSignatures: Record<string, Uint8Array> = { ...transaction.signatures };

  for (let i = 1; i < compiled.header.numSignerAccounts; i++) {
    const address = compiled.staticAccounts[i]?.toString();
    if (!address) {
      continue;
    }
    forgedSignatures[address] = new Uint8Array(64);
  }

  return { messageBytes: transaction.messageBytes, signatures: forgedSignatures as never };
}

/**
 * Mirrors facilitator local verification: account 0 must be feePayer; indices
 * 1..numSigners-1 must carry valid Ed25519 signatures over messageBytes.
 *
 * @param transaction - Decoded transaction
 * @param expectedFeePayer - Fee payer from payment requirements
 * @returns Whether every required client signature verifies locally
 */
async function verifyClientSignaturesLocally(
  transaction: Transaction,
  expectedFeePayer: string,
): Promise<boolean> {
  const compiled = compiledMessageDecoder.decode(transaction.messageBytes);
  const feePayerAccount = compiled.staticAccounts[0]?.toString();
  if (!feePayerAccount || feePayerAccount !== expectedFeePayer) {
    return false;
  }

  const checks: Promise<boolean>[] = [];
  for (let i = 1; i < compiled.header.numSignerAccounts; i++) {
    const address = compiled.staticAccounts[i]?.toString();
    if (!address) {
      return false;
    }

    const signature = transaction.signatures[address as Address];
    if (!signature || signature.length !== 64) {
      return false;
    }

    checks.push(
      (async () => {
        try {
          const publicKeyBytes = addressEncoder.encode(address as Address);
          const publicKey = await crypto.subtle.importKey("raw", publicKeyBytes, "Ed25519", false, [
            "verify",
          ]);
          return verifySignature(publicKey, signature, transaction.messageBytes);
        } catch {
          return false;
        }
      })(),
    );
  }

  const results = await Promise.all(checks);
  return results.every(Boolean);
}

/**
 * Demonstrates that facilitator verify rejects forged client signatures via local
 * Ed25519 checks before simulating with RPC sigVerify off.
 */
async function main(): Promise<void> {
  const clientSigner = await createKeyPairSignerFromBytes(base58.decode(svmPrivateKey!));

  console.log("SVM exact: forged client signature rejection (sigVerify:false sim)");
  console.log("=".repeat(78));
  console.log(`Server: ${url}`);
  console.log(`Client: ${clientSigner.address}`);
  console.log("");

  const client = new x402Client();
  registerExactSvmScheme(client, { signer: clientSigner });
  const httpClient = new x402HTTPClient(client);

  console.log("Step 0 — fetch 402 payment requirements...");
  const initialResponse = await fetch(url);
  if (initialResponse.status !== 402) {
    throw new Error(`Expected 402, got ${initialResponse.status}. Is the server running?`);
  }

  let body: unknown;
  try {
    body = await initialResponse.json();
  } catch {
    throw new Error("Failed to parse 402 response body as JSON");
  }

  const paymentRequired = httpClient.getPaymentRequiredResponse(
    name => initialResponse.headers.get(name),
    body,
  );

  const requirements = paymentRequired.accepts.find(
    a => a.network.startsWith("solana") && a.scheme === "exact",
  );
  if (!requirements) {
    throw new Error("No Solana exact payment option found in 402 response");
  }

  const feePayer = requirements.extra?.feePayer as Address | undefined;
  if (!feePayer) {
    throw new Error("feePayer missing from payment requirements extra");
  }

  console.log("Fixtures");
  console.log(`  network              = ${requirements.network}`);
  console.log(`  payTo                = ${requirements.payTo}`);
  console.log(`  amount               = ${requirements.amount}`);
  console.log(`  facilitator feePayer = ${feePayer}`);
  console.log(`  client authority     = ${clientSigner.address}`);
  console.log("");

  console.log("Step 1 — build and sign a legitimate payment with the x402 client...");
  const legitPayload = await client.createPaymentPayload(paymentRequired);
  const legitTx = decodeTransactionFromPayload(legitPayload.payload as { transaction: string });
  const compiled = compiledMessageDecoder.decode(legitTx.messageBytes);

  const requiredSigners = compiled.staticAccounts
    .slice(0, compiled.header.numSignerAccounts)
    .map((account, index) => ({
      index,
      address: account.toString(),
      role: index === 0 ? "fee payer (unsigned until settle)" : "client signer",
    }));

  console.log("  required signers:");
  for (const signer of requiredSigners) {
    const sig = legitTx.signatures[signer.address as Address];
    console.log(
      `    [${signer.index}] ${signer.address} (${signer.role})${
        sig ? ` sig=${hex(sig).slice(0, 16)}...` : " sig=(missing)"
      }`,
    );
  }
  console.log("");

  const legitLocalOk = await verifyClientSignaturesLocally(legitTx, feePayer);
  console.log(
    `Step 2 — local Ed25519 check on legitimate payment: ${legitLocalOk ? "PASS" : "FAIL"}`,
  );
  console.log("");

  console.log("Step 3 — forge every client signature (all-zero 64-byte placeholders)...");
  const forgedTx = forgeClientSignatures(legitTx);
  const forgedWire = getBase64EncodedWireTransaction(forgedTx);

  for (const signer of requiredSigners.filter(s => s.index > 0)) {
    const sig = forgedTx.signatures[signer.address as Address]!;
    console.log(`  forged [${signer.index}] ${signer.address} sig=${hex(sig)}`);
  }
  console.log("");

  const forgedLocalOk = await verifyClientSignaturesLocally(forgedTx, feePayer);
  console.log(
    `Step 4 — local Ed25519 check on forged payment: ${forgedLocalOk ? "PASS" : "FAIL (expected)"}`,
  );
  console.log("  -> facilitator verify runs this locally, then simulates with sigVerify:false");
  console.log("     (RPC would accept zeroed signatures if we skipped the local check)");
  console.log("");

  const forgedPayload: PaymentPayload = {
    x402Version: paymentRequired.x402Version,
    payload: { transaction: forgedWire },
    resource: paymentRequired.resource,
    accepted: requirements,
    ...(paymentRequired.extensions ? { extensions: paymentRequired.extensions } : {}),
  };

  const paymentHeaders = httpClient.encodePaymentSignatureHeader(forgedPayload);

  console.log("Step 5 — submit forged payment to resource server...");
  const paidResponse = await fetch(url, { headers: paymentHeaders });

  let responseBody: unknown;
  try {
    responseBody = await paidResponse.json();
  } catch {
    responseBody = await paidResponse.text();
  }

  let paymentResponse: unknown;
  try {
    paymentResponse = httpClient.getPaymentSettleResponse(name => paidResponse.headers.get(name));
  } catch {
    paymentResponse = null;
  }

  console.log(`  HTTP status: ${paidResponse.status}`);
  console.log(`  body:        ${jsonStringify(responseBody)}`);
  if (paymentResponse) {
    console.log(`  settlement:  ${jsonStringify(paymentResponse)}`);
  }
  console.log("");

  const bodyText = jsonStringify(responseBody);
  const mentionsInvalidSignature =
    bodyText.includes(INVALID_SIGNATURE) ||
    (paymentResponse != null && jsonStringify(paymentResponse).includes(INVALID_SIGNATURE));

  const settlementSuccess =
    paidResponse.status === 200 &&
    paymentResponse != null &&
    typeof paymentResponse === "object" &&
    "success" in paymentResponse &&
    (paymentResponse as { success?: boolean }).success === true;

  console.log("=".repeat(78));
  if (settlementSuccess) {
    console.log("VERDICT: VULNERABLE — server accepted a payment with forged client signatures");
    console.log(
      "Local Ed25519 verification is missing or RPC sigVerify:true simulation still passes.",
    );
  } else if (paidResponse.status !== 200 || mentionsInvalidSignature) {
    console.log("VERDICT: PROTECTED — server rejected the forged payment");
    if (mentionsInvalidSignature) {
      console.log(`Rejected with ${INVALID_SIGNATURE} (local verify before sigVerify:false sim).`);
    } else {
      console.log(
        "Payment was rejected before settlement (check body/settlement for invalidReason).",
      );
    }
  } else {
    console.log(
      "VERDICT: INCONCLUSIVE — request failed but invalidReason not surfaced in response",
    );
  }
  console.log("=".repeat(78));
}

main().catch(error => {
  console.error(error?.message ?? error);
  process.exit(1);
});
