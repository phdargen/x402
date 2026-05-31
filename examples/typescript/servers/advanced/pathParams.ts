/**
 * Example demonstrating path parameters with x402 bazaar discovery.
 *
 * This example shows how to use URI templates like /weather/{city}
 * for endpoints with dynamic path segments.
 *
 * Run with: pnpm dev:path-params
 */
import { config } from "dotenv";
import express from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
config();

const evmAddress = process.env.EVM_ADDRESS as `0x${string}`;
if (!evmAddress) {
  console.error("Missing required environment variables");
  process.exit(1);
}

const facilitatorUrl = process.env.FACILITATOR_URL;
if (!facilitatorUrl) {
  console.error("❌ FACILITATOR_URL environment variable is required");
  process.exit(1);
}
const facilitatorClient = new HTTPFacilitatorClient({ url: facilitatorUrl });

const app = express();

// Weather data for different cities
const weatherData: Record<string, { weather: string; temperature: number; humidity: number }> = {
  "new-york": { weather: "cloudy", temperature: 55, humidity: 65 },
  tokyo: { weather: "sunny", temperature: 72, humidity: 45 },
  london: { weather: "rainy", temperature: 50, humidity: 80 },
  sydney: { weather: "clear", temperature: 78, humidity: 55 },
};

app.use(
  paymentMiddleware(
    {
      // Path parameter route - matches /weather/new-york, /weather/tokyo, etc.
      // Note: Use [param] syntax for x402 middleware (not Express :param syntax)
      "GET /weather/[city]": {
        accepts: {
          scheme: "exact",
          price: "$0.001",
          network: "eip155:84532",
          payTo: evmAddress,
        },
        // URI template syntax for discovery - curly braces indicate path parameter
        resource: "https://api.example.com/weather/{city}",
        description: "Get weather data for a specific city",
        mimeType: "application/json",
        extensions: {
          ...declareDiscoveryExtension({
            // Path parameters with example values
            pathParams: { city: "new-york" },
            pathParamsSchema: {
              properties: {
                city: {
                  type: "string",
                  description: "City slug (e.g., 'new-york', 'tokyo', 'london')",
                },
              },
              required: ["city"],
            },
            output: {
              example: {
                city: "new-york",
                weather: "cloudy",
                temperature: 55,
                humidity: 65,
              },
            },
          }),
        },
      },
    },
    new x402ResourceServer(facilitatorClient).register("eip155:84532", new ExactEvmScheme()),
  ),
);

// Handler for /weather/:city
app.get("/weather/:city", (req, res) => {
  const city = req.params.city.toLowerCase();
  const data = weatherData[city];

  if (!data) {
    res.status(404).json({
      error: "City not found",
      availableCities: Object.keys(weatherData),
    });
    return;
  }

  res.json({
    city,
    weather: data.weather,
    temperature: data.temperature,
    humidity: data.humidity,
  });
});

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

const PORT = 4021;
app.listen(PORT, () => {
  console.log(`Path params example server listening at http://localhost:${PORT}`);
  console.log(`\nAvailable endpoints:`);
  console.log(`  GET /weather/new-york`);
  console.log(`  GET /weather/tokyo`);
  console.log(`  GET /weather/london`);
  console.log(`  GET /weather/sydney`);
});
