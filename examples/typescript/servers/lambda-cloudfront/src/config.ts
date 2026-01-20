import type { RoutesConfig } from "@x402/lambda";

// Payment recipient addresses from environment
const evmAddress = process.env.EVM_ADDRESS as `0x${string}`;
const svmAddress = process.env.SVM_ADDRESS;

if (!evmAddress || !svmAddress) {
  console.warn("Missing EVM_ADDRESS or SVM_ADDRESS environment variables");
}

/**
 * Route configuration for payment-protected endpoints.
 * This CloudFront proxy protects all /api/* routes.
 */
export const routes: RoutesConfig = {
  "/api/*": {
    accepts: [
      {
        scheme: "exact",
        price: "$0.001",
        network: "eip155:84532", // Base Sepolia
        payTo: evmAddress || "0x0000000000000000000000000000000000000000",
      },
      {
        scheme: "exact",
        price: "$0.001",
        network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", // Solana Devnet
        payTo: svmAddress || "11111111111111111111111111111111",
      },
    ],
    description: "Protected API access",
  },
};

/**
 * CloudFront distribution domain.
 * Replace with your actual distribution domain.
 */
export const distributionDomain = process.env.CLOUDFRONT_DOMAIN || "d1234567890.cloudfront.net";

/**
 * Facilitator URL for payment processing.
 */
export const facilitatorUrl = process.env.FACILITATOR_URL || "https://facilitator.x402.org";
