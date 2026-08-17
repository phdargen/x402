import { config } from "dotenv";
import { x402Client, x402HTTPClient } from "@x402/fetch";
import { toClientCardanoSigner } from "@x402/cardano";
import { ExactCardanoScheme } from "@x402/cardano/exact/client";

config();

const cardanoMnemonic = process.env.CARDANO_MNEMONIC;
const cardanoNetwork = process.env.CARDANO_NETWORK ?? "cardano:preprod";
const blockfrostBaseUrl = process.env.BLOCKFROST_PREPROD_URL;
const blockfrostProjectId = process.env.BLOCKFROST_PROJECT_ID;
const baseURL = process.env.RESOURCE_SERVER_URL ?? "http://localhost:4021";
const endpointPath = process.env.ENDPOINT_PATH ?? "/weather";
const url = `${baseURL}${endpointPath}`;
const raceCount = Number(process.env.RACE_COUNT ?? "10");

if (!cardanoMnemonic) {
  console.error("CARDANO_MNEMONIC is required");
  process.exit(1);
}

if (!blockfrostBaseUrl || !blockfrostProjectId) {
  console.error("BLOCKFROST_PREPROD_URL and BLOCKFROST_PROJECT_ID are required");
  process.exit(1);
}

if (!Number.isFinite(raceCount) || raceCount <= 0) {
  console.error("RACE_COUNT must be a positive number");
  process.exit(1);
}

/**
 * Runs the Cardano race-condition demo: one payment, many parallel requests.
 * Demonstrates whether the server accepts the same payment multiple times.
 */
async function main(): Promise<void> {
  const cardanoSigner = toClientCardanoSigner({
    mnemonic: cardanoMnemonic,
    network: cardanoNetwork,
    provider: { blockfrost: { baseUrl: blockfrostBaseUrl, projectId: blockfrostProjectId } },
  });
  console.log("Cardano Race Condition Vulnerability Demo");
  console.log("=========================================");
  console.log(`Server: ${url}`);
  console.log(`Payer: ${cardanoSigner.getAddress()}`);
  console.log(`Network: ${cardanoNetwork}`);
  console.log(`Race count: ${raceCount}`);
  console.log("");

  const client = new x402Client().register("cardano:*", new ExactCardanoScheme(cardanoSigner));
  const httpClient = new x402HTTPClient(client);

  console.log("Getting 402 response...");
  const initialResponse = await fetch(url);

  if (initialResponse.status !== 402) {
    throw new Error(`Expected 402, got ${initialResponse.status}. Is the server running?`);
  }
  console.log("Got 402 Payment Required");

  console.log("Parsing payment requirements...");
  let body: unknown;
  try {
    body = await initialResponse.json();
  } catch {
    throw new Error("Failed to parse 402 response body as JSON");
  }

  const paymentRequired = httpClient.getPaymentRequiredResponse(
    name => initialResponse.headers.get(name),
    body,
  );

  const cardanoOption = paymentRequired.accepts.find(
    a => a.network.startsWith("cardano") && a.scheme === "exact",
  );

  if (!cardanoOption) {
    throw new Error("No Cardano exact payment option found in 402 response");
  }

  console.log(`Found Cardano exact option on network: ${cardanoOption.network}`);
  console.log(`  Pay to: ${cardanoOption.payTo}`);
  console.log(`  Amount: ${cardanoOption.amount}`);
  console.log(`  Asset:  ${cardanoOption.asset}`);
  console.log("");

  console.log("Building and signing payment transaction once...");
  const paymentPayload = await client.createPaymentPayload(paymentRequired);
  const paymentHeaders = httpClient.encodePaymentSignatureHeader(paymentPayload);

  console.log(`Firing ${raceCount} parallel requests with the same payment header...`);
  const startTime = Date.now();

  const results = await Promise.all(
    Array.from({ length: raceCount }, async (_, i) => {
      const response = await fetch(url, { headers: paymentHeaders });
      let responseBody: unknown;
      try {
        responseBody = await response.json();
      } catch {
        responseBody = await response.text();
      }
      let paymentResponse: unknown;
      try {
        paymentResponse = httpClient.getPaymentSettleResponse(name => response.headers.get(name));
      } catch {
        paymentResponse = null;
      }
      return { index: i, status: response.status, body: responseBody, paymentResponse };
    }),
  );

  const elapsed = Date.now() - startTime;

  console.log("Results:");
  console.log("--------");

  const succeeded = results.filter(r => r.status === 200);
  const failed = results.filter(r => r.status !== 200);

  for (const r of results) {
    const paymentStr = r.paymentResponse ? ` | payment: ${JSON.stringify(r.paymentResponse)}` : "";
    console.log(`  Request ${r.index}: HTTP ${r.status} - ${JSON.stringify(r.body)}${paymentStr}`);
  }

  console.log("");
  console.log(`Time: ${elapsed}ms`);
  console.log("");

  if (succeeded.length > 1) {
    console.log(
      `VULNERABLE: ${succeeded.length}/${raceCount} requests succeeded with the same payment.`,
    );
    console.log("The server accepted the same transaction multiple times.");
  } else if (succeeded.length === 1) {
    console.log(
      `PROTECTED: Only 1/${raceCount} requests succeeded. ${failed.length} were correctly rejected.`,
    );
  } else {
    console.log(
      `All ${raceCount} requests failed (status codes: ${results.map(r => r.status).join(", ")}).`,
    );
    console.log("Check that the server is running and accepting payments.");
  }
}

main().catch(error => {
  console.error(error?.message ?? error);
  process.exit(1);
});
