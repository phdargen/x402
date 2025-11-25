import { Address } from "viem";
import { paymentMiddleware, Network, Resource } from "x402-next";
import { facilitator } from "@coinbase/x402";

const useCdpFacilitator = process.env.USE_CDP_FACILITATOR === 'true';
const payTo = process.env.EVM_ADDRESS as Address;
const network = process.env.EVM_NETWORK as Network;

// Configure facilitator
const facilitatorConfig = useCdpFacilitator
  ? facilitator
  : undefined;

export const middleware = paymentMiddleware(
  payTo,
  {
    "/api/protected": {
      price: "$0.001",
      network,
      config: {
        description: "Protected API endpoint",
      },
    },
    "/api/weather": {
      price: "$0.001",
      network,
      config: {
        description: "Weather API endpoint - normal response",
      },
    },
    "/api/streaming-weather": {
      price: "$0.001",
      network,
      config: {
        description: "Weather API endpoint - streaming test",
      },
    },
  },
  facilitatorConfig,
  {
    appName: "Next x402 E2E Test",
    appLogo: "/x402-icon-blue.png",
  },
);

// Configure which paths the middleware should run on
export const config = {
  matcher: ["/api/protected", "/api/weather", "/api/streaming-weather"],
  runtime: 'nodejs', // TEMPORARY: Only needed until Edge runtime support is added
};

