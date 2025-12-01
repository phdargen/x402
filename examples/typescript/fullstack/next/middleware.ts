import { paymentMiddleware } from "@x402/next";
import { x402ResourceServer, HTTPFacilitatorClient } from "@x402/core/server";
import { registerExactEvmScheme } from "@x402/evm/exact/server";
import { createPaywall } from "@x402/paywall";
import { evmPaywall } from "@x402/paywall/evm";

const facilitatorUrl = process.env.FACILITATOR_URL;
const evmPayeeAddress = process.env.EVM_PAYEE_ADDRESS as `0x${string}`;
const network = process.env.NETWORK || "eip155:84532";

// if (!facilitatorUrl) {
//   console.error("❌ FACILITATOR_URL environment variable is required");
//   process.exit(1);
// }

// if (!evmPayeeAddress) {
//   console.error("❌ EVM_PAYEE_ADDRESS environment variable is required");
//   process.exit(1);
// }

// Create HTTP facilitator client
const facilitatorClient = new HTTPFacilitatorClient({ url: facilitatorUrl });

// Create x402 resource server
const server = new x402ResourceServer(facilitatorClient);

// Register EVM scheme
registerExactEvmScheme(server);

// Build paywall using v2 builder pattern
const paywall = createPaywall()
  .withNetwork(evmPaywall)
  .withConfig({
    appName: process.env.APP_NAME || "Next x402 Demo",
    appLogo: process.env.APP_LOGO || "/x402-icon-blue.png",
    cdpClientKey: process.env.CDP_CLIENT_KEY,
    testnet: true,
  })
  .build();

console.log(`Using remote facilitator at: ${facilitatorUrl}`);

// Export middleware with v2 API
export const middleware = paymentMiddleware(
  {
    "/protected": {
      accepts: {
        payTo: evmPayeeAddress,
        scheme: "exact",
        price: "$0.01",
        network: network as `${string}:${string}`,
      },
      description: "Access to protected content",
    },
  },
  server,
  undefined, // paywallConfig (using custom paywall instead)
  paywall, // custom paywall provider
);

// Configure which paths the middleware should run on
export const config = {
  matcher: ["/protected/:path*"],
  runtime: "nodejs", 
};

