import { HTTPFacilitatorClient, type RoutesConfig } from "@x402/core/server";
import { BatchSettlementEvmScheme } from "@x402/evm/batch-settlement/server";
import {
  createVoucherGatewayServerExtension,
  declareVoucherGatewayExtension,
  VOUCHER_GATEWAY,
} from "@x402/evm/batch-settlement/gateway/server";
import {
  paymentMiddlewareFromHTTPServer,
  setSettlementOverrides,
  x402HTTPResourceServer,
  x402ResourceServer,
} from "@x402/express";
import { config } from "dotenv";
import express from "express";
import { encodePacked, keccak256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";

config();

const NETWORK = "eip155:84532" as const;

const evmAddress = process.env.EVM_ADDRESS as `0x${string}`;
const receiverAuthorizerPrivateKey = process.env.EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY as
  | `0x${string}`
  | undefined;
const serverCount = Number(process.env.M_SERVERS ?? "4");

const facilitatorUrl = process.env.FACILITATOR_URL;
if (!facilitatorUrl) {
  console.error("Missing required FACILITATOR_URL environment variable");
  process.exit(1);
}

if (!evmAddress || !/^0x[0-9a-fA-F]{40}$/.test(evmAddress)) {
  console.error("Missing or invalid EVM_ADDRESS (checksummed 20-byte hex, 0x-prefixed)");
  process.exit(1);
}

if (!receiverAuthorizerPrivateKey) {
  console.error(
    "EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY is required in gateway mode (signs GatewayClaimAuthorization)",
  );
  process.exit(1);
}
if (!Number.isSafeInteger(serverCount) || serverCount < 1) {
  console.error("M_SERVERS must be a positive integer");
  process.exit(1);
}

const receiverAuthorizerSigner = privateKeyToAccount(receiverAuthorizerPrivateKey);
const facilitatorClient = new HTTPFacilitatorClient({ url: facilitatorUrl });
const serverAddresses = Array.from({ length: serverCount }, (_, index) =>
  privateKeyToAccount(
    keccak256(
      encodePacked(
        ["bytes32", "string", "uint256"],
        [receiverAuthorizerPrivateKey, "x402 gateway example server", BigInt(index)],
      ),
    ),
  ),
).map(account => account.address);

const batchedScheme = new BatchSettlementEvmScheme(evmAddress, {
  receiverAuthorizerSigner,
});

const resourceServer = new x402ResourceServer(facilitatorClient)
  .register(NETWORK, batchedScheme)
  .registerExtension(createVoucherGatewayServerExtension());

const maxPrice = "$0.01";

const weatherRoute = {
  accepts: {
    scheme: "batch-settlement",
    price: maxPrice,
    network: NETWORK,
    payTo: evmAddress,
  },
  description: "Weather data (voucher-gateway)",
  mimeType: "application/json",
  extensions: {
    [VOUCHER_GATEWAY]: declareVoucherGatewayExtension(),
  },
} as const;

const routes: RoutesConfig = {
  "GET /weather": weatherRoute,
};
for (let index = 0; index < serverCount; index++) {
  routes[`GET /server/${index + 1}/weather`] = {
    accepts: {
      scheme: "batch-settlement",
      price: maxPrice,
      network: NETWORK,
      payTo: serverAddresses[index],
    },
    description: `Weather data from simulated server ${index + 1} (voucher-gateway)`,
    mimeType: "application/json",
    extensions: {
      [VOUCHER_GATEWAY]: declareVoucherGatewayExtension(),
    },
  };
}

const httpServer = new x402HTTPResourceServer(resourceServer, routes);

/**
 * Sends a paid weather payload and applies a random usage-based charge override.
 *
 * @param res - Express response used for settlement overrides and body.
 * @param extras - Optional fields merged into the JSON body.
 */
function sendWeather(
  res: Parameters<typeof setSettlementOverrides>[0],
  extras?: Record<string, unknown>,
): void {
  const chargedPercent = 1 + Math.floor(Math.random() * 100);
  setSettlementOverrides(res, { amount: `${chargedPercent}%` });
  res.send({
    ...extras,
    report: {
      weather: "sunny",
      temperature: 70,
    },
  });
}

/**
 * Initializes facilitator capability checks and starts the gateway server.
 */
async function main() {
  await httpServer.initialize();

  const app = express();
  app.use(paymentMiddlewareFromHTTPServer(httpServer, undefined, undefined, false));

  app.get("/weather", (_req, res) => {
    sendWeather(res);
  });

  for (let index = 0; index < serverCount; index++) {
    const serverNumber = index + 1;
    app.get(`/server/${serverNumber}/weather`, (_req, res) => {
      sendWeather(res, { server: serverNumber });
    });
  }

  app.listen(4021, () => {
    console.log("Batch-settlement gateway server listening at http://localhost:4021");
    console.log(`  GET /weather -> ${evmAddress}`);
    for (let index = 0; index < serverCount; index++) {
      console.log(`  GET /server/${index + 1}/weather -> ${serverAddresses[index]}`);
    }
    console.log(`  Receiver authorizer: ${receiverAuthorizerSigner.address}`);
  });
}

main().catch(err => {
  console.error("Startup failed:", err);
  process.exit(1);
});
