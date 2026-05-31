import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { requireEnv } from "../../lib/env.js";
import {
  hasServerNetworkConfig,
  logServerNetworks,
  registerServerNetworks,
} from "../../lib/networks.js";

const facilitatorUrl = requireEnv("FACILITATOR_URL");

if (!hasServerNetworkConfig()) {
  console.error(
    "❌ At least one of AVM_ADDRESS, EVM_ADDRESS, SVM_ADDRESS, STELLAR_ADDRESS, or HEDERA_ACCOUNT_ID is required",
  );
  process.exit(1);
}

const facilitatorClient = new HTTPFacilitatorClient({ url: facilitatorUrl });
const server = new x402ResourceServer(facilitatorClient);
const { accepts, registered } = registerServerNetworks(server);

if (!registered || accepts.length === 0) {
  console.error("❌ No networks were registered from environment configuration");
  process.exit(1);
}

const app = new Hono();

app.use(
  paymentMiddleware(
    {
      "GET /weather": {
        accepts,
        description: "Weather data",
        mimeType: "application/json",
      },
    },
    server,
  ),
);

app.get("/weather", c => {
  return c.json({
    report: {
      weather: "sunny",
      temperature: 70,
    },
  });
});

const port = Number(process.env.PORT || 4021);
serve({
  fetch: app.fetch,
  port,
});

console.log(`Server listening at http://localhost:${port}`);
logServerNetworks();
console.log(`   Facilitator: ${facilitatorUrl}`);
console.log();
