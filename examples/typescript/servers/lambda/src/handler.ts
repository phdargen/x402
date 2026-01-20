import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { withPayment, x402ResourceServer, PaymentContext } from "@x402/lambda";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { ExactSvmScheme } from "@x402/svm/exact/server";

// Configuration from environment
const evmAddress = process.env.EVM_ADDRESS as `0x${string}`;
const svmAddress = process.env.SVM_ADDRESS;
const facilitatorUrl = process.env.FACILITATOR_URL || "https://facilitator.x402.org";

// Create facilitator client
const facilitatorClient = new HTTPFacilitatorClient({ url: facilitatorUrl });

// Create and configure the x402 resource server
const server = new x402ResourceServer(facilitatorClient)
  .register("eip155:84532", new ExactEvmScheme())
  .register("solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", new ExactSvmScheme());

// Route configuration
const routes = {
  "GET /weather": {
    accepts: [
      {
        scheme: "exact" as const,
        price: "$0.001",
        network: "eip155:84532" as const,
        payTo: evmAddress || ("0x0000000000000000000000000000000000000000" as `0x${string}`),
      },
      {
        scheme: "exact" as const,
        price: "$0.001",
        network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" as const,
        payTo: svmAddress || "11111111111111111111111111111111",
      },
    ],
    description: "Weather data",
    mimeType: "application/json",
  },
  "GET /premium/*": {
    accepts: [
      {
        scheme: "exact" as const,
        price: "$0.01",
        network: "eip155:84532" as const,
        payTo: evmAddress || ("0x0000000000000000000000000000000000000000" as `0x${string}`),
      },
    ],
    description: "Premium content",
    mimeType: "application/json",
  },
};

// Business logic handler
const businessLogic = async (event: APIGatewayProxyEventV2, paymentContext: PaymentContext) => {
  const path = event.requestContext.http.path;

  // Weather endpoint
  if (path === "/weather") {
    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        report: {
          weather: "sunny",
          temperature: 72,
          humidity: 45,
          wind: "5 mph NW",
        },
        payment: {
          payer: paymentContext.payer,
          network: paymentContext.requirements.network,
        },
      }),
    };
  }

  // Premium content endpoints
  if (path.startsWith("/premium/")) {
    const contentId = path.replace("/premium/", "");
    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        content: {
          id: contentId,
          title: `Premium Article: ${contentId}`,
          body: "This is premium content that was unlocked with payment.",
          author: "x402 Team",
        },
        payment: {
          payer: paymentContext.payer,
          network: paymentContext.requirements.network,
        },
      }),
    };
  }

  // Not found
  return {
    statusCode: 404,
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ error: "Not found" }),
  };
};

// Export the wrapped handler
export const handler = withPayment(routes, server, businessLogic, {
  paywallConfig: {
    appName: "Lambda x402 Example",
    testnet: true,
  },
});
