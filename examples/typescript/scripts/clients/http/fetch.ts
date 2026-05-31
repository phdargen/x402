import { x402Client, wrapFetchWithPayment, x402HTTPClient } from "@x402/fetch";
import { hasClientNetworkConfig, registerClientNetworks } from "../../lib/networks.js";
import { resourceUrl } from "../../lib/env.js";

/**
 * Example demonstrating how to use @x402/fetch to make requests to x402-protected endpoints.
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

  const fetchWithPayment = wrapFetchWithPayment(fetch, client);

  console.log(`Making request to: ${url}\n`);
  const response = await fetchWithPayment(url, { method: "GET" });
  const contentType = response.headers.get("content-type") ?? "";
  const body = contentType.includes("application/json")
    ? await response.json()
    : await response.text();
  console.log("Response body:", body);

  const paymentResponse = new x402HTTPClient(client).getPaymentSettleResponse(name =>
    response.headers.get(name),
  );
  console.log("\nPayment response:", JSON.stringify(paymentResponse, null, 2));
}

main().catch(error => {
  console.error(error?.response?.data?.error ?? error);
  process.exit(1);
});
