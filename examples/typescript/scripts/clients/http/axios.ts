import { x402Client, wrapAxiosWithPayment, x402HTTPClient } from "@x402/axios";
import axios from "axios";
import { hasClientNetworkConfig, registerClientNetworks } from "../../lib/networks.js";
import { resourceUrl } from "../../lib/env.js";

/**
 * Example demonstrating how to use @x402/axios to make requests to x402-protected endpoints.
 *
 * Registers payment schemes for every network configured in the environment.
 * See scripts/.env.example for optional network keys.
 */
async function main(): Promise<void> {
  if (!hasClientNetworkConfig()) {
    console.error(
      "❌ At least one of AVM_PRIVATE_KEY, EVM_PRIVATE_KEY, SVM_PRIVATE_KEY, STELLAR_PRIVATE_KEY, or HEDERA_ACCOUNT_ID + HEDERA_PRIVATE_KEY is required",
    );
    process.exit(1);
  }

  const url = resourceUrl();
  const client = new x402Client();

  if (!(await registerClientNetworks(client))) {
    console.error("❌ No networks were registered from environment configuration");
    process.exit(1);
  }

  const api = wrapAxiosWithPayment(axios.create(), client);

  console.log(`Making request to: ${url}\n`);
  const response = await api.get(url);
  const body = response.data;
  console.log("Response body:", body);

  const paymentResponse = new x402HTTPClient(client).getPaymentSettleResponse(
    name => response.headers[name.toLowerCase()],
  );
  console.log("\nPayment response:", JSON.stringify(paymentResponse, null, 2));
}

main().catch(error => {
  console.error(error?.response?.data?.error ?? error);
  process.exit(1);
});
