import { facilitator } from "@coinbase/x402";
import { Address } from "viem";
import { paymentMiddleware } from "x402-next";

const payTo = process.env.RESOURCE_WALLET_ADDRESS as Address;

// The CDP API key ID and secret are required to use the mainnet facilitator
if (!payTo || !process.env.CDP_API_KEY_ID || !process.env.CDP_API_KEY_SECRET) {
  console.error("Missing required environment variables");
  process.exit(1);
}

export const middleware = paymentMiddleware(
  payTo,
  {
    "/protected": {
      price: "$0.001",
      network: "base",
      config: {
        discoverable: false,
        description: "Access to protected content with exclusive music",
        outputSchema: {
          type: "text/html",
          description: "HTML page with embedded SoundCloud player featuring exclusive music content",
        },
      },
    },
  },
  {
    url: "https://facilitator.payai.network",
  },
  // {
  //   appName: "Mainnet x402 Demo",
  //   appLogo: "/x402-icon-blue.png",
  //   sessionTokenEndpoint: "/api/x402/session-token",
  // },
);

// Configure which paths the middleware should run on
export const config = {
  matcher: ["/protected/:path*"],
  runtime: "nodejs",
};
