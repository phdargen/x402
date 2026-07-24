import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { paymentMiddleware, setSettlementOverrides } from "@x402/hono";
import { x402ResourceServer } from "@x402/core/server";
import {
  loadServerConfig,
  createFacilitatorClients,
  configureResourceServer,
  buildPaymentRoutes,
  E2E_GET_ROUTES,
  ROUTE_PATHS,
  getUnconfiguredResponseForPath,
  buildHealthResponse,
  buildCloseResponse,
  formatStartupBanner,
} from "@x402/e2e-server-shared";

const cfg = loadServerConfig();
const { PORT, facilitatorUrl } = cfg;

const app = new Hono();
const facilitatorClients = createFacilitatorClients(facilitatorUrl);
const x402Server = new x402ResourceServer(facilitatorClients);
configureResourceServer(x402Server, cfg);

console.log(
  `Facilitator account: ${facilitatorUrl ? facilitatorUrl.substring(0, 10) + "..." : "not configured"}`,
);
console.log(`Using remote facilitator at: ${facilitatorUrl}`);

app.use("*", async (c, next) => {
  const path = c.req.path;
  const err = getUnconfiguredResponseForPath(path, cfg);
  if (err) {
    return c.json(err, 501);
  }
  await next();
});

app.use("*", paymentMiddleware(buildPaymentRoutes(cfg), x402Server));

for (const route of E2E_GET_ROUTES) {
  app.get(route.path, c => {
    if (route.settlementOverride) {
      setSettlementOverrides(c, route.settlementOverride);
    }
    return c.json(route.response());
  });
}

app.get(ROUTE_PATHS.HEALTH, c => c.json(buildHealthResponse(cfg)));

app.post(ROUTE_PATHS.CLOSE, c => {
  console.log("Received shutdown request");
  setTimeout(() => process.exit(0), 100);
  return c.json(buildCloseResponse());
});

serve({ fetch: app.fetch, port: parseInt(PORT) });

console.log(
  formatStartupBanner(cfg, {
    title: "x402 Hono E2E Test Server",
    address: `http://localhost:${PORT}`,
  }),
);
