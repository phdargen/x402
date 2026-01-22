import { config } from "dotenv";
import express from "express";
import { paymentMiddlewareFromHTTPServer, x402ResourceServer, x402HTTPResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import {
  declareSIWxExtension,
  createSIWxRequestHook,
  createSIWxSettleHook,
  InMemorySIWxStorage,
} from "@x402/extensions/sign-in-with-x";

config();

const evmAddress = process.env.EVM_ADDRESS as `0x${string}`;
if (!evmAddress) {
  console.error("Missing EVM_ADDRESS");
  process.exit(1);
}

const facilitatorUrl = process.env.FACILITATOR_URL;
if (!facilitatorUrl) {
  console.error("Missing FACILITATOR_URL");
  process.exit(1);
}

const PORT = 4021;
const HOST = `localhost:${PORT}`;
const NETWORK = "eip155:84532" as const;

// Create shared storage for tracking paid addresses
const storage = new InMemorySIWxStorage();

const facilitatorClient = new HTTPFacilitatorClient({ url: facilitatorUrl });

// Configure core resource server with scheme and settle hook
const resourceServer = new x402ResourceServer(facilitatorClient)
  .register(NETWORK, new ExactEvmScheme())
  .onAfterSettle(createSIWxSettleHook({ storage }))
// .onBeforeVerify(async context => {
//   console.log("Before verify hook", context);
//   // Abort verification by returning { abort: true, reason: string }
// })
// .onAfterVerify(async context => {
//   console.log("After verify hook", context);
// })
// .onVerifyFailure(async context => {
//   console.log("Verify failure hook", context);
//   // Return a result with Recovered=true to recover from the failure
//   // return { recovered: true, result: { isValid: true, invalidReason: "Recovered from failure" } };
// })
// .onBeforeSettle(async context => {
//   console.log("Before settle hook", context);
//   // Abort settlement by returning { abort: true, reason: string }
// })
// .onAfterSettle(async context => {
//   console.log("After settle hook", context);
// })
// .onSettleFailure(async context => {
//   console.log("Settle failure hook", context);
//   // Return a result with Recovered=true to recover from the failure
//   // return { recovered: true, result: { success: true, transaction: "0x123..." } };
// });

/**
 * Creates route config with SIWX extension.
 *
 * @param path - The route path
 * @returns Route configuration object
 */
function routeConfig(path: string) {
  return {
    accepts: [{ scheme: "exact", price: "$0.001", network: NETWORK, payTo: evmAddress }],
    description: `Protected resource: ${path}`,
    mimeType: "application/json",
    extensions: declareSIWxExtension({
      domain: HOST,
      resourceUri: `http://${HOST}${path}`,
      network: NETWORK,
    }),
  };
}

const routes = {
  "GET /weather": routeConfig("/weather"),
  "GET /joke": routeConfig("/joke"),
};

// Create HTTP server with routes and add onRequest hook for SIWX
const httpServer = new x402HTTPResourceServer(resourceServer, routes)
  .onRequest(async (context, routeConfig) => {
    console.log("SIWX request hook", context, routeConfig);
  })
  .onRequest(createSIWxRequestHook({ storage, domain: HOST }));

const app = express();

// Single payment middleware - SIWX is handled via onRequest hook
app.use(paymentMiddlewareFromHTTPServer(httpServer));

app.get("/weather", (req, res) => res.json({ weather: "sunny", temperature: 72 }));
app.get("/joke", (req, res) =>
  res.json({ joke: "Why do programmers prefer dark mode? Because light attracts bugs." }),
);

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  console.log(`Routes: GET /weather, GET /joke`);

  // For testing: pre-seed a payment if TEST_ADDRESS is set
  const testAddress = process.env.TEST_ADDRESS;
  if (testAddress) {
    storage.recordPayment("/weather", testAddress);
    console.log(`Test mode: Pre-seeded payment for ${testAddress} on /weather`);
  }
});
