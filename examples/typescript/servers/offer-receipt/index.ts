/**
 * Express server example with offer-receipt extension
 *
 * This example demonstrates how to use the offer-receipt extension
 * to add cryptographically signed offers and receipts to x402 payment flows.
 *
 * Supports two signing modes:
 * - JWS (default): Uses jose library with ES256 algorithm
 * - EIP-712: Uses viem wallet client for Ethereum-native signing
 *
 * Set SIGNER_MODE=eip712 and PRIVATE_KEY to use EIP-712 signing.
 */

import { config } from "dotenv";
import express from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import {
  createOfferReceiptExtension,
  createJWSSigner,
  createEIP712Signer,
  declareOfferReceipt,
  offerValidationHook,
  type OfferReceiptSigner,
} from "@x402/extensions/offer-receipt";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import * as jose from "jose";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

config();

const evmAddress = process.env.EVM_ADDRESS as `0x${string}`;
if (!evmAddress) {
  console.error("Missing EVM_ADDRESS environment variable");
  process.exit(1);
}

const facilitatorUrl = process.env.FACILITATOR_URL;
if (!facilitatorUrl) {
  console.error("Missing FACILITATOR_URL environment variable");
  process.exit(1);
}

// Signer configuration
const signerMode = process.env.SIGNER_MODE || "jws"; // "jws" or "eip712"
const signingKeyPem = process.env.SIGNING_KEY_PEM;
const signingKeyKid = process.env.SIGNING_KEY_KID || "did:web:localhost:4022#key-1";
const privateKey = process.env.PRIVATE_KEY as `0x${string}` | undefined;

/**
 * Create a JWS signer using jose library
 */
async function createJWSOffer(): Promise<OfferReceiptSigner> {
  if (signingKeyPem) {
    // Use provided PEM key
    const key = await jose.importPKCS8(signingKeyPem, "ES256");
    return createJWSSigner(signingKeyKid, "ES256", async (payload: Uint8Array) => {
      const payloadObj = JSON.parse(new TextDecoder().decode(payload));
      return new jose.SignJWT(payloadObj)
        .setProtectedHeader({ alg: "ES256", kid: signingKeyKid })
        .sign(key);
    });
  }

  // Generate ephemeral key for demo
  console.warn("No SIGNING_KEY_PEM provided, generating ephemeral JWS key (not for production!)");
  const { privateKey: key } = await jose.generateKeyPair("ES256");
  return createJWSSigner(signingKeyKid, "ES256", async (payload: Uint8Array) => {
    const payloadObj = JSON.parse(new TextDecoder().decode(payload));
    return new jose.SignJWT(payloadObj)
      .setProtectedHeader({ alg: "ES256", kid: signingKeyKid })
      .sign(key);
  });
}

/**
 * Create an EIP-712 signer using viem wallet client
 */
function createEIP712Offer(): OfferReceiptSigner {
  if (!privateKey) {
    console.error("EIP-712 signer requires PRIVATE_KEY environment variable");
    process.exit(1);
  }

  const account = privateKeyToAccount(privateKey);
  const walletClient = createWalletClient({
    account,
    chain: baseSepolia,
    transport: http(),
  });

  const kid = `did:pkh:eip155:84532:${account.address}`;
  console.log(`Using EIP-712 signer with address: ${account.address}`);

  return createEIP712Signer(kid, baseSepolia.id, walletClient.signTypedData.bind(walletClient));
}

async function main() {
  // Create the signer based on mode
  let signer: OfferReceiptSigner;

  if (signerMode === "eip712") {
    console.log("Using EIP-712 signing mode");
    signer = createEIP712Offer();
  } else {
    console.log("Using JWS signing mode");
    signer = await createJWSOffer();
  }

  console.log(`Signer kid: ${signer.kid}, format: ${signer.format}`);

  // Create facilitator client and resource server
  const facilitatorClient = new HTTPFacilitatorClient({ url: facilitatorUrl });
  const resourceServer = new x402ResourceServer(facilitatorClient)
    .register("eip155:84532", new ExactEvmScheme())
    .onBeforeVerify(async context => {
      console.log("Before verify hook", context);
      // Abort verification by returning { abort: true, reason: string }
    })
    .onAfterVerify(async context => {
      console.log("After verify hook", context);
    })
    .onVerifyFailure(async context => {
      console.log("Verify failure hook", context);
      // Return a result with Recovered=true to recover from the failure
      // return { recovered: true, result: { isValid: true, invalidReason: "Recovered from failure" } };
    })
    .onBeforeSettle(async context => {
      console.log("Before settle hook", context);
      // Abort settlement by returning { abort: true, reason: string }
    })
    .onAfterSettle(async context => {
      console.log("After settle hook", context);
    })
    .onSettleFailure(async context => {
      console.log("Settle failure hook", context);
      // Return a result with Recovered=true to recover from the failure
      // return { recovered: true, result: { success: true, transaction: "0x123..." } };
    })
    // Register the offer-receipt extension
    .registerExtension(createOfferReceiptExtension(signer))
    // Enable server-side offer validation (validates acceptIndex match and validUntil expiration)
    .onBeforeVerify(offerValidationHook);

  const app = express();

  // Apply payment middleware with offer-receipt enabled on routes
  app.use(
    paymentMiddleware(
      {
        "GET /weather": {
          accepts: {
            scheme: "exact",
            price: "$0.001",
            network: "eip155:84532",
            payTo: evmAddress,
          },
          description: "Weather data with signed offer/receipt",
          mimeType: "application/json",
          // Enable offer-receipt extension for this route
          extensions: {
            ...declareOfferReceipt({ validitySeconds: 60 }),
            ...declareDiscoveryExtension({
              input: { city: "San Francisco" },
              inputSchema: {
                properties: {
                  city: { type: "string", description: "City name to get weather for" },
                },
                required: ["city"],
              },
              output: {
                example: {
                  report: {
                    weather: "sunny",
                    temperature: 72,
                    humidity: 45,
                    timestamp: "2024-01-15T12:00:00Z",
                  },
                },
              },
            }),
          },
        },
        "GET /premium-data": {
          accepts: {
            scheme: "exact",
            price: "$0.01",
            network: "eip155:84532",
            payTo: evmAddress,
          },
          description: "Premium data endpoint with signed offer/receipt and ToS",
          mimeType: "application/json",
          extensions: {
            // Include custom metadata in offers and receipts
            ...declareOfferReceipt({
              metadata: {
                tos: "https://example.com/terms-of-service",
                version: "1.0",
                provider: "Example Corp",
              },
            }),
            ...declareDiscoveryExtension({
              output: {
                example: {
                  premium: true,
                  data: {
                    insights: ["Market trend is bullish", "Volume increasing 15%"],
                    confidence: 0.89,
                    generatedAt: "2024-01-15T12:00:00Z",
                  },
                },
              },
            }),
          },
        },
        // Route with offer-receipt but without txHash in receipt (privacy mode)
        "GET /private-data": {
          accepts: {
            scheme: "exact",
            price: "$0.005",
            network: "eip155:84532",
            payTo: evmAddress,
          },
          description: "Private data endpoint - receipt without transaction hash",
          mimeType: "application/json",
          extensions: {
            ...declareOfferReceipt({ includeTxHash: false }),
            ...declareDiscoveryExtension({
              output: {
                example: {
                  private: true,
                  data: {
                    sensitiveInfo: "This receipt has no transaction hash for privacy",
                    generatedAt: "2024-01-15T12:00:00Z",
                  },
                },
              },
            }),
          },
        },
        // Route without offer-receipt (shows it's opt-in per route)
        "GET /basic": {
          accepts: {
            scheme: "exact",
            price: "$0.0001",
            network: "eip155:84532",
            payTo: evmAddress,
          },
          description: "Basic endpoint without offer/receipt",
          mimeType: "application/json",
          // No offer-receipt extension, but still has bazaar discovery
          extensions: {
            ...declareDiscoveryExtension({
              output: {
                example: {
                  message: "Basic response without offer-receipt",
                  timestamp: "2024-01-15T12:00:00Z",
                },
              },
            }),
          },
        },
      },
      resourceServer,
    ),
  );

  // Route handlers
  app.get("/weather", (_req: express.Request, res: express.Response) => {
    res.json({
      report: {
        weather: "sunny",
        temperature: 72,
        humidity: 45,
        timestamp: new Date().toISOString(),
      },
    });
  });

  app.get("/premium-data", (_req: express.Request, res: express.Response) => {
    res.json({
      premium: true,
      data: {
        insights: ["Market trend is bullish", "Volume increasing 15%"],
        confidence: 0.89,
        generatedAt: new Date().toISOString(),
      },
    });
  });

  app.get("/basic", (_req: express.Request, res: express.Response) => {
    res.json({
      message: "Basic response without offer-receipt",
      timestamp: new Date().toISOString(),
    });
  });

  app.get("/private-data", (_req: express.Request, res: express.Response) => {
    res.json({
      private: true,
      data: {
        sensitiveInfo: "This receipt has no transaction hash for privacy",
        generatedAt: new Date().toISOString(),
      },
    });
  });

  const port = process.env.PORT || 4022;
  app.listen(port, () => {
    console.log(`Server listening at http://localhost:${port}`);
    console.log("\nAvailable endpoints:");
    console.log("  GET /weather      - $0.001  (with offer-receipt)");
    console.log("  GET /premium-data - $0.01   (with offer-receipt + ToS metadata)");
    console.log("  GET /private-data - $0.005  (with offer-receipt, no txHash in receipt)");
    console.log("  GET /basic        - $0.0001 (without offer-receipt)");
  });
}

main().catch(console.error);
