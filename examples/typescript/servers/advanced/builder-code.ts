/**
 * Example: Server with Builder Code (ERC-8021) Extension
 *
 * Demonstrates how to declare per-network builder codes for on-chain attribution.
 * Builder codes are appended to settlement transaction calldata as an ERC-8021 suffix,
 * allowing offchain indexers to attribute transactions to the originating application.
 *
 * Required environment variables:
 * - EVM_ADDRESS: The payee wallet address
 * - FACILITATOR_URL: URL of the facilitator service
 */

import { config } from "dotenv";
import express from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { declareBuilderCodeExtension } from "@x402/extensions";
config();

const evmAddress = process.env.EVM_ADDRESS as `0x${string}`;
if (!evmAddress) {
  console.error("Missing EVM_ADDRESS environment variable");
  process.exit(1);
}

const facilitatorUrl = process.env.FACILITATOR_URL;
if (!facilitatorUrl) {
  console.error("Missing FACILITATOR_URL environment variable");
  process.exit(1);
}
const facilitatorClient = new HTTPFacilitatorClient({ url: facilitatorUrl });

const app = express();

app.use(
  paymentMiddleware(
    {
      "GET /weather": {
        accepts: {
          scheme: "exact",
          price: "$0.001",
          network: "eip155:84532",
          payTo: evmAddress,
        },
        description: "Weather data with on-chain attribution",
        mimeType: "application/json",
        extensions: {
          // Declare builder codes for on-chain attribution.
          // During settlement the facilitator appends these codes (along with
          // its own) as an ERC-8021 calldata suffix.
          ...declareBuilderCodeExtension({
            "eip155:84532": "weather-api",
          }),
        },
      },
    },
    new x402ResourceServer(facilitatorClient).register("eip155:84532", new ExactEvmScheme()),
  ),
);

app.get("/weather", (req, res) => {
  const city = (req.query.city as string) || "San Francisco";

  const weatherData: Record<string, { weather: string; temperature: number }> = {
    "San Francisco": { weather: "foggy", temperature: 60 },
    "New York": { weather: "cloudy", temperature: 55 },
  };

  const data = weatherData[city] || { weather: "sunny", temperature: 70 };

  res.send({
    city,
    weather: data.weather,
    temperature: data.temperature,
  });
});

app.listen(4021, () => {
  console.log("Server with Builder Code extension listening at http://localhost:4021");
});
