import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import {
  encodePaymentRequiredHeader,
  decodePaymentSignatureHeader,
  encodePaymentResponseHeader,
} from "@x402/core/http";
import type { PaymentPayload, SettleResponse } from "@x402/core/types";
import { BatchSettlementEvmScheme, FileSessionStorage } from "@x402/evm/batch-settlement/server";
import {
  isBatchSettlementDepositPayload,
  isBatchSettlementVoucherPayload,
  type BatchSettlementPaymentResponseExtra,
} from "@x402/evm";
import { config } from "dotenv";
import express from "express";
import { privateKeyToAccount } from "viem/accounts";
import OpenAI from "openai";
import {
  buildFinalPaymentResponse,
  colorizeGreen,
  colorizeRed,
  formatChannelId,
  getAcceptedRenewalState,
  getChannelIdFromPayload,
  getChunkChargeAmount,
  getNextMaxClaimableAmount,
  isTruthyEnvFlag,
  parseServerCliOptions,
  sseWrite,
  toVoucherPayload,
  waitForVoucher,
  type VoucherResolver,
} from "./utils";

config();

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const NETWORK = "eip155:84532" as const;
const PORT = Number(process.env.PORT ?? "4021");

const evmAddress = process.env.EVM_ADDRESS as `0x${string}`;
const receiverAuthorizerPrivateKey = process.env.EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY as
  | `0x${string}`
  | undefined;
const storageDir = process.env.STORAGE_DIR;
const withdrawDelay = Number(process.env.DEFERRED_WITHDRAW_DELAY_SECONDS ?? "900");

if (!evmAddress || !/^0x[0-9a-fA-F]{40}$/.test(evmAddress)) {
  console.error("Missing or invalid EVM_ADDRESS (checksummed 20-byte hex, 0x-prefixed)");
  process.exit(1);
}

const facilitatorUrl = process.env.FACILITATOR_URL;
if (!facilitatorUrl) {
  console.error("Missing required FACILITATOR_URL environment variable");
  process.exit(1);
}

const cliOptions = parseServerCliOptions(process.argv.slice(2));
const verbose = cliOptions.verbose || isTruthyEnvFlag(process.env.VERBOSE);

const CHUNK_SIZE = Number(process.env.CHUNK_SIZE ?? "100");
const PRICE_PER_CHUNK = process.env.PRICE_PER_CHUNK ?? "$0.001";

let chunkAmountAtomic = "";

if (!Number.isInteger(CHUNK_SIZE) || CHUNK_SIZE <= 0) {
  console.error("CHUNK_SIZE must be a positive integer");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// SDK wiring
// ---------------------------------------------------------------------------

const receiverAuthorizerSigner = receiverAuthorizerPrivateKey
  ? privateKeyToAccount(receiverAuthorizerPrivateKey)
  : undefined;

const facilitatorClient = new HTTPFacilitatorClient({ url: facilitatorUrl });

const batchedScheme = new BatchSettlementEvmScheme(evmAddress, {
  ...(receiverAuthorizerSigner ? { receiverAuthorizerSigner } : {}),
  withdrawDelay,
  ...(storageDir ? { storage: new FileSessionStorage({ directory: storageDir }) } : {}),
});

const resourceServer = new x402ResourceServer(facilitatorClient).register(NETWORK, batchedScheme);

// Payment requirements template
const paymentOptions = {
  scheme: "batch-settlement" as const,
  price: PRICE_PER_CHUNK,
  network: NETWORK,
  payTo: evmAddress,
};

// ---------------------------------------------------------------------------
// OpenAI (optional — falls back to simulated stream)
// ---------------------------------------------------------------------------

const openai = process.env.OPENAI_API_KEY ? new OpenAI() : null;

/**
 * Yields LLM tokens from OpenAI when configured, otherwise a simulated word stream.
 *
 * @param prompt - User prompt for the chat completion.
 * @returns Async generator of token strings.
 */
async function* tokenStream(prompt: string): AsyncGenerator<string> {
  if (openai) {
    const stream = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      stream: true,
    });
    for await (const chunk of stream) {
      const token = chunk.choices[0]?.delta?.content;
      if (token) yield token;
    }
    return;
  }

  // Simulated fallback: yield one word at a time with a small delay
  const words = "The quick brown fox jumps over the lazy dog. ".repeat(30).trim().split(" ");
  for (const word of words) {
    await new Promise(r => setTimeout(r, 20));
    yield word + " ";
  }
}

// ---------------------------------------------------------------------------
// Pending-voucher map for the side-channel endpoint
// ---------------------------------------------------------------------------

const pendingVouchers = new Map<string, VoucherResolver>();

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json());

/**
 * Logs a message when verbose mode is enabled.
 *
 * @param message - Text to print to stdout.
 */
function logVerbose(message: string): void {
  if (!verbose) return;
  console.log(message);
}

// ------ GET /llm/stream ---------------------------------------------------

app.get("/llm/stream", async (req, res) => {
  // Build requirements for this route
  const requirements = await resourceServer.buildPaymentRequirements(paymentOptions);

  // If no payment header → 402
  const paymentHeader = req.headers["payment-signature"];
  if (!paymentHeader || typeof paymentHeader !== "string") {
    logVerbose(`\n${colorizeRed("[payment-required]")} ${req.originalUrl}`);
    const paymentRequired = await resourceServer.createPaymentRequiredResponse(requirements, {
      url: "/llm/stream",
      description: "SSE LLM stream",
      mimeType: "text/event-stream",
    });
    res
      .status(402)
      .set("PAYMENT-REQUIRED", encodePaymentRequiredHeader(paymentRequired))
      .json(paymentRequired);
    return;
  }

  // Decode & match requirements
  let paymentPayload: PaymentPayload;
  try {
    paymentPayload = decodePaymentSignatureHeader(paymentHeader);
  } catch {
    res.status(400).json({ error: "Malformed PAYMENT-SIGNATURE header" });
    return;
  }
  const matched = resourceServer.findMatchingRequirements(requirements, paymentPayload);
  if (!matched) {
    res.status(402).json({ error: "No matching payment requirements" });
    return;
  }

  const requestChannelId = getChannelIdFromPayload(paymentPayload);
  const requestStartCharged =
    (await batchedScheme.getStorage().get(requestChannelId ?? ""))?.chargedCumulativeAmount ?? "0";

  // Verify payment.  On failure, return a proper PAYMENT-REQUIRED response so that
  // corrective schemes (e.g. batch-settlement stale cumulative amount) can resync
  // the client session via `extra` and retry.
  const verifyResult = await resourceServer.verifyPayment(paymentPayload, matched);
  if (!verifyResult.isValid) {
    const correctivePaymentRequired = await resourceServer.createPaymentRequiredResponse(
      [matched],
      { url: "/llm/stream", description: "SSE LLM stream", mimeType: "text/event-stream" },
      verifyResult.invalidReason ?? "Verification failed",
    );
    res
      .status(402)
      .set("PAYMENT-REQUIRED", encodePaymentRequiredHeader(correctivePaymentRequired))
      .json(correctivePaymentRequired);
    return;
  }

  // For deposits, settle on-chain immediately (also charges one chunk to session)
  // For vouchers, defer settlement until streaming
  const isDeposit = isBatchSettlementDepositPayload(paymentPayload.payload);
  let firstChunkSettled = false;
  let trailingSettleResponse: SettleResponse | null = null;

  logVerbose(
    `${colorizeGreen("[payment-accepted]")} channel=${formatChannelId(requestChannelId)} kind=${isDeposit ? "deposit" : "voucher"}`,
  );

  if (isDeposit) {
    const settleResult = await resourceServer.settlePayment(paymentPayload, matched);
    if (!settleResult.success) {
      res.status(402).json({ error: "Deposit settlement failed" });
      return;
    }
    trailingSettleResponse = settleResult;
    firstChunkSettled = true;
  }

  // Extract channelId and build a voucher-only payload for mid-stream settlements
  // The deposit payload can't be re-settled, so we convert to a voucher shape
  const voucherState = toVoucherPayload(paymentPayload, matched);
  let channelId = voucherState.channelId;
  let currentPayload = voucherState.payload;

  // Begin SSE.
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    Trailer: "PAYMENT-RESPONSE",
  });

  let chunkTokenCount = 0;
  let tokenIndex = 0;
  let currentRequirements = matched;

  const prompt = (req.query.prompt as string) || "Tell me a fun fact about payments.";

  try {
    for await (const token of tokenStream(prompt)) {
      // Send token to client.
      sseWrite(res, "data", { token, index: tokenIndex++ });
      chunkTokenCount++;

      // Wait until the current chunk is full
      if (chunkTokenCount < CHUNK_SIZE) continue;

      // --- Chunk complete: request voucher renewal ---

      let chargedCumulativeAmount: string;
      let balance: string;
      if (firstChunkSettled) {
        // The deposit settle already charged this chunk — just read the session state
        const session = await batchedScheme.getStorage().get(channelId);
        chargedCumulativeAmount = session?.chargedCumulativeAmount ?? chunkAmountAtomic;
        balance = session?.balance ?? "0";
        firstChunkSettled = false;
      } else {
        // Settle the current voucher-backed chunk at the configured chunk price
        const settleResult = await resourceServer.settlePayment(
          currentPayload,
          currentRequirements,
          undefined,
          undefined,
          { amount: chunkAmountAtomic },
        );
        trailingSettleResponse = settleResult;
        const extra = settleResult.extra as
          | Partial<BatchSettlementPaymentResponseExtra>
          | undefined;
        chargedCumulativeAmount = extra?.chargedCumulativeAmount ?? "0";
        balance = extra?.balance ?? "0";
      }

      // Ask client for a new voucher.
      const nextMaxClaimableAmount = getNextMaxClaimableAmount(
        chargedCumulativeAmount,
        chunkAmountAtomic,
      );
      const voucherEndpoint = `/x402/voucher/${encodeURIComponent(channelId)}`;
      logVerbose(
        `${colorizeRed("[voucher-requested]")} channel=${formatChannelId(channelId)} charged=${chargedCumulativeAmount} next=${nextMaxClaimableAmount}`,
      );
      sseWrite(res, "x402-voucher-needed", {
        channelId,
        chargedCumulativeAmount,
        balance,
        nextMaxClaimableAmount,
        voucherEndpoint,
      });

      // Wait for the client to POST a new voucher on the side-channel
      const newPayload = await waitForVoucher(pendingVouchers, channelId, 30_000);

      // Re-match requirements (same template, amount = chunk price)
      const newRequirements = resourceServer.findMatchingRequirements(requirements, newPayload);
      if (!newRequirements) {
        sseWrite(res, "x402-error", {
          code: "requirements_mismatch",
          message: "No match",
        });
        break;
      }

      // Verify the renewal payload
      const newVerify = await resourceServer.verifyPayment(newPayload, newRequirements);
      if (!newVerify.isValid) {
        sseWrite(res, "x402-error", {
          code: "voucher_invalid",
          message: newVerify.invalidReason ?? "Voucher verification failed",
        });
        break;
      }

      let acceptedChargedCumulativeAmount = chargedCumulativeAmount;
      let acceptedBalance =
        (newVerify.extra as Partial<BatchSettlementPaymentResponseExtra> | undefined)?.balance ??
        "0";

      if (isBatchSettlementDepositPayload(newPayload.payload)) {
        const renewalSettle = await resourceServer.settlePayment(newPayload, newRequirements);
        if (!renewalSettle.success) {
          sseWrite(res, "x402-error", {
            code: "deposit_settlement_failed",
            message: "Renewal deposit settlement failed",
          });
          break;
        }
        trailingSettleResponse = renewalSettle;

        const renewedVoucherState = toVoucherPayload(newPayload, newRequirements);
        channelId = renewedVoucherState.channelId;
        currentPayload = renewedVoucherState.payload;
        currentRequirements = newRequirements;
        firstChunkSettled = true;
        const renewalExtra = renewalSettle.extra as
          | Partial<BatchSettlementPaymentResponseExtra>
          | undefined;
        acceptedChargedCumulativeAmount =
          renewalExtra?.chargedCumulativeAmount ?? chargedCumulativeAmount;
        acceptedBalance = renewalExtra?.balance ?? acceptedBalance;
      } else {
        currentPayload = newPayload;
        currentRequirements = newRequirements;
      }

      const acceptedRenewal = getAcceptedRenewalState(
        newPayload,
        acceptedChargedCumulativeAmount,
        acceptedBalance,
      );

      sseWrite(res, "x402-voucher-accepted", {
        channelId,
        newChargedCumulativeAmount: acceptedRenewal.chargedCumulativeAmount,
        balance: acceptedRenewal.balance,
        signedMaxClaimable: acceptedRenewal.signedMaxClaimable,
        toppedUp: acceptedRenewal.toppedUp,
      });
      logVerbose(
        `${colorizeGreen("[voucher-accepted]")} channel=${formatChannelId(channelId)} signed=${acceptedRenewal.signedMaxClaimable}${acceptedRenewal.toppedUp ? " topped-up" : ""}`,
      );

      // Reset chunk tracking
      chunkTokenCount = 0;
    }

    // --- Stream complete: settle any started chunk ---
    if (chunkTokenCount > 0 && !firstChunkSettled) {
      const partialChunkAmount = getChunkChargeAmount(
        chunkTokenCount,
        CHUNK_SIZE,
        chunkAmountAtomic,
      );
      const finalSettle = await resourceServer.settlePayment(
        currentPayload,
        currentRequirements,
        undefined,
        undefined,
        { amount: partialChunkAmount },
      );
      const finalExtra = finalSettle.extra as
        | (Partial<BatchSettlementPaymentResponseExtra> & {
            signedMaxClaimable?: string;
          })
        | undefined;
      const chargedCumulativeAmount = finalExtra?.chargedCumulativeAmount ?? "0";
      const fallbackMaxClaimable = isBatchSettlementVoucherPayload(currentPayload.payload)
        ? currentPayload.payload.maxClaimableAmount
        : "0";
      const signedMaxClaimable = finalExtra?.signedMaxClaimable ?? fallbackMaxClaimable;
      trailingSettleResponse = finalSettle;

      sseWrite(res, "x402-settlement", {
        channelId,
        chargedCumulativeAmount,
        signedMaxClaimable,
      });
      logVerbose(
        `[settlement] channel=${formatChannelId(channelId)} charged=${chargedCumulativeAmount} signed=${signedMaxClaimable}`,
      );
    } else if (firstChunkSettled) {
      // Stream ended within the first (deposit-settled) chunk — report state without re-settling
      const session = await batchedScheme.getStorage().get(channelId);
      sseWrite(res, "x402-settlement", {
        channelId,
        chargedCumulativeAmount: session?.chargedCumulativeAmount ?? "0",
        signedMaxClaimable: session?.signedMaxClaimable ?? "0",
      });
      logVerbose(
        `[settlement] channel=${formatChannelId(channelId)} charged=${session?.chargedCumulativeAmount ?? "0"} signed=${session?.signedMaxClaimable ?? "0"}`,
      );
    }

    sseWrite(res, "done", {});
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal stream error";
    logVerbose(`[stream-error] channel=${formatChannelId(channelId)} message=${message}`);
    sseWrite(res, "x402-error", { code: "stream_error", message });
  } finally {
    pendingVouchers.delete(channelId);
    if (trailingSettleResponse) {
      const finalPaymentResponse = await buildFinalPaymentResponse(
        batchedScheme,
        trailingSettleResponse,
        channelId,
        requestStartCharged,
      );
      logVerbose(
        `[payment-response] channel=${formatChannelId(channelId)} amount=${finalPaymentResponse.amount ?? "0"}`,
      );
      res.addTrailers({
        "PAYMENT-RESPONSE": encodePaymentResponseHeader(finalPaymentResponse),
      });
    }
    res.end();
  }
});

// ------ POST /x402/voucher/:channelId  (side-channel) --------------------

app.post("/x402/voucher/:channelId", (req, res) => {
  const { channelId } = req.params;
  const resolver = pendingVouchers.get(channelId);
  if (!resolver) {
    res.status(404).json({ error: "No pending voucher request for this channel" });
    return;
  }

  const paymentHeader = req.headers["payment-signature"];
  if (!paymentHeader || typeof paymentHeader !== "string") {
    res.status(400).json({ error: "Missing PAYMENT-SIGNATURE header" });
    return;
  }

  try {
    const payload = decodePaymentSignatureHeader(paymentHeader);
    resolver.resolve(payload);
    res.json({ ok: true });
  } catch {
    res.status(400).json({ error: "Malformed PAYMENT-SIGNATURE header" });
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

/**
 * Parses chunk pricing, initializes the resource server, and listens on `PORT`.
 *
 * @returns Resolves when the HTTP server has started listening.
 */
async function start(): Promise<void> {
  const [assetAmount] = await Promise.all([
    batchedScheme.parsePrice(PRICE_PER_CHUNK, NETWORK),
    resourceServer.initialize(),
  ]);
  chunkAmountAtomic = assetAmount.amount;

  app.listen(PORT, () => {
    console.log(`Batched-streaming server listening at http://localhost:${PORT}`);
    console.log(`  GET  /llm/stream          — SSE endpoint`);
    console.log(`  POST /x402/voucher/:id    — voucher renewal side-channel`);
    console.log(`  Chunk size: ${CHUNK_SIZE} tokens`);
    console.log(`  Chunk price: ${PRICE_PER_CHUNK}`);
    if (openai) {
      console.log("  OpenAI: enabled");
    } else {
      console.log("  OpenAI: disabled (simulated stream)");
    }
    if (receiverAuthorizerSigner) {
      console.log(`  Receiver authorizer: local signer ${receiverAuthorizerSigner.address}`);
    } else {
      console.log("  Receiver authorizer: facilitator", "\n");
    }
  });
}

start().catch(error => {
  console.error("Failed to initialize batched-streaming server:", error);
  process.exit(1);
});
