import { x402Facilitator } from "@x402/core/facilitator";
import {
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import express from "express";
import { hasFacilitatorNetworkConfig, registerFacilitatorNetworks } from "../../lib/networks.js";

const PORT = process.env.PORT || "4022";

if (!hasFacilitatorNetworkConfig()) {
  console.error(
    "❌ At least one of AVM_PRIVATE_KEY, EVM_PRIVATE_KEY, SVM_PRIVATE_KEY, STELLAR_PRIVATE_KEY, or HEDERA_ACCOUNT_ID + HEDERA_PRIVATE_KEY is required",
  );
  process.exit(1);
}

const facilitator = new x402Facilitator()
  .onBeforeVerify(async context => {
    console.log("Before verify", context);
  })
  .onAfterVerify(async context => {
    console.log("After verify", context);
  })
  .onVerifyFailure(async context => {
    console.log("Verify failure", context);
  })
  .onBeforeSettle(async context => {
    console.log("Before settle", context);
  })
  .onAfterSettle(async context => {
    console.log("After settle", context);
  })
  .onSettleFailure(async context => {
    console.log("Settle failure", context);
  });

const registered = await registerFacilitatorNetworks(facilitator);
if (!registered) {
  console.error("❌ No networks were registered from environment configuration");
  process.exit(1);
}

const app = express();
app.use(express.json());

/**
 * POST /verify
 * Verify a payment against requirements
 */
app.post("/verify", async (req, res) => {
  try {
    const { paymentPayload, paymentRequirements } = req.body as {
      paymentPayload: PaymentPayload;
      paymentRequirements: PaymentRequirements;
    };

    if (!paymentPayload || !paymentRequirements) {
      return res.status(400).json({
        error: "Missing paymentPayload or paymentRequirements",
      });
    }

    const response: VerifyResponse = await facilitator.verify(paymentPayload, paymentRequirements);

    res.json(response);
  } catch (error) {
    console.error("Verify error:", error);
    res.status(500).json({
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

/**
 * POST /settle
 * Settle a payment on-chain
 */
app.post("/settle", async (req, res) => {
  try {
    const { paymentPayload, paymentRequirements } = req.body;

    if (!paymentPayload || !paymentRequirements) {
      return res.status(400).json({
        error: "Missing paymentPayload or paymentRequirements",
      });
    }

    const response: SettleResponse = await facilitator.settle(
      paymentPayload as PaymentPayload,
      paymentRequirements as PaymentRequirements,
    );

    res.json(response);
  } catch (error) {
    console.error("Settle error:", error);

    if (error instanceof Error && error.message.includes("Settlement aborted:")) {
      return res.json({
        success: false,
        errorReason: error.message.replace("Settlement aborted: ", ""),
        network: req.body?.paymentPayload?.network || "unknown",
      } as SettleResponse);
    }

    res.status(500).json({
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

/**
 * GET /supported
 * Get supported payment kinds and extensions
 */
app.get("/supported", async (req, res) => {
  try {
    const response = facilitator.getSupported();
    res.json(response);
  } catch (error) {
    console.error("Supported error:", error);
    res.status(500).json({
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

app.listen(parseInt(PORT), () => {
  console.log(`🚀 Facilitator listening on http://localhost:${PORT}`);
  console.log();
});
