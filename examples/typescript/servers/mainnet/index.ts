import { config } from "dotenv";
import express from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { ExactSvmScheme } from "@x402/svm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { facilitator } from "@coinbase/x402";
config();

const evmAddress = process.env.EVM_ADDRESS as `0x${string}`;
const svmAddress = process.env.SVM_ADDRESS;
if (!evmAddress || !svmAddress) {
  console.error("Missing required environment variables");
  process.exit(1);
}

const facilitatorUrl = process.env.FACILITATOR_URL;
if (!facilitatorUrl) {
  console.error("❌ FACILITATOR_URL environment variable is required");
  process.exit(1);
}

const facilitatorClient = new HTTPFacilitatorClient({ url: facilitatorUrl });
// const facilitatorClient = new HTTPFacilitatorClient(facilitator);

// async function main() {
//   // Call the /supported endpoint
//   const supported = await facilitatorClient.getSupported().catch(error => {
//     console.error("Error getting supported:", error);
//     process.exit(1);
//   });
//   console.dir(supported, { depth: null });
// }

// main();

const resourceServer = new x402ResourceServer(facilitatorClient)
  .register("eip155:8453", new ExactEvmScheme())
  .register("solana:*", new ExactSvmScheme())
  .onBeforeVerify(async context => {
    console.log("Before verify hook", context);
    // Abort verification by returning { abort: true, reason: string }
  })
  .onAfterVerify(async context => {
    console.log("After verify hook", context);
  })
  .onVerifyFailure(async context => {
    console.log("Verify failure hook", context);
    // Return a result with Recovered=true to recover from the failure
    // return { recovered: true, result: { isValid: true, invalidReason: "Recovered from failure" } };
  })
  .onBeforeSettle(async context => {
    console.log("Before settle hook", context);
    // Abort settlement by returning { abort: true, reason: string }
  })
  .onAfterSettle(async context => {
    console.log("After settle hook", context);
  })
  .onSettleFailure(async context => {
    console.log("Settle failure hook", context);
    // Return a result with Recovered=true to recover from the failure
    // return { recovered: true, result: { success: true, transaction: "0x123..." } };
  });

const app = express();

app.use(
  paymentMiddleware(
    {
      "GET /weather": {
        accepts: [
          // {
          //   scheme: "exact",
          //   price: "$0.001",
          //   network: "eip155:8453",
          //   payTo: evmAddress,
          // },
          {
            scheme: "exact",
            price: "$0.001",
            network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
            payTo: svmAddress,
            maxTimeoutSeconds: 300,
          },
        ],
        description: "Weather data",
        mimeType: "application/json",
      },
    },
    resourceServer
  ),
);

app.get("/weather", (req, res) => {
  res.send({
    report: {
      weather: "sunny",
      temperature: 70,
    },
  });
});

app.listen(4021, () => {
  console.log(`Server listening at http://localhost:${4021}`);
});
