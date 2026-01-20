import { createCloudFrontProxy, x402ResourceServer } from "@x402/lambda";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { ExactSvmScheme } from "@x402/svm/exact/server";
import { routes, distributionDomain, facilitatorUrl } from "./config";

// Create facilitator client
const facilitatorClient = new HTTPFacilitatorClient({ url: facilitatorUrl });

// Create and configure the x402 resource server
const server = new x402ResourceServer(facilitatorClient)
  .register("eip155:84532", new ExactEvmScheme())
  .register("solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", new ExactSvmScheme());

// Create the CloudFront proxy handlers
export const { verify, settle } = createCloudFrontProxy(
  routes,
  server,
  distributionDomain,
  {
    paywallConfig: {
      appName: "CloudFront x402 Example",
      testnet: true,
    },
  },
);
