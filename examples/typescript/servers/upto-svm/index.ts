import { config } from "dotenv";
import express from "express";
import { paymentMiddleware, setSettlementOverrides, x402ResourceServer } from "@x402/express";
import { UptoSvmScheme } from "@x402/svm/upto/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
config();

// Solana devnet (CAIP-2).
const SOLANA_DEVNET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";

const svmAddress = process.env.SVM_ADDRESS;
if (!svmAddress) {
  console.error("Missing required SVM_ADDRESS environment variable (base58 recipient)");
  process.exit(1);
}

// The facilitator must support the upto scheme on `solana:*` — i.e. run the
// `@x402/svm/upto/facilitator` UptoSvmScheme with a fee-payer key and a
// receiver-authorizer key. Self-facilitated servers can use the same key for
// both roles.
const facilitatorUrl = process.env.FACILITATOR_URL;
if (!facilitatorUrl) {
  console.error("Missing required FACILITATOR_URL environment variable");
  process.exit(1);
}
const facilitatorClient = new HTTPFacilitatorClient({ url: facilitatorUrl });

const app = express();

// "upto" authorizes up to a maximum but settles only the actual usage. On
// Solana the client opens a payment channel depositing the ceiling; the
// receiver authorizer settles the metered amount with a single voucher and the
// fee payer sponsors the transaction that refunds the remainder. Ideal for
// usage-based billing (LLM tokens, bytes served, compute).
const maxPrice = "$0.10"; // Maximum the client authorizes (10 cents)

app.use(
  paymentMiddleware(
    {
      "GET /api/generate": {
        accepts: {
          scheme: "upto",
          price: maxPrice,
          network: SOLANA_DEVNET,
          payTo: svmAddress,
        },
        description: "AI text generation — billed by token usage",
        mimeType: "application/json",
      },
    },
    new x402ResourceServer(facilitatorClient).register(SOLANA_DEVNET, new UptoSvmScheme()),
  ),
);

app.get("/api/generate", (req, res) => {
  // Simulate work that produces a variable cost. In production this might be
  // an LLM token count, bytes served, compute time, etc.
  const maxAmountAtomic = 100000; // 10 cents in 6-decimal USDC atomic units
  const actualUsage = Math.floor(Math.random() * (maxAmountAtomic + 1));

  // Tell the middleware to settle only what was actually used. The facilitator
  // The receiver authorizer signs a voucher for this amount (≤ the deposited
  // ceiling), and settlement refunds the rest.
  setSettlementOverrides(res, { amount: String(actualUsage) });

  res.json({
    result: "Here is your generated text...",
    usage: {
      authorizedMaxAtomic: String(maxAmountAtomic),
      actualChargedAtomic: String(actualUsage),
    },
  });
});

app.listen(4022, () => {
  console.log("Upto SVM server listening at http://localhost:4022");
  console.log("  GET /api/generate  — usage-based billing via the upto scheme on Solana");
});
