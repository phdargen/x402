import { x402Client, wrapFetchWithPayment, x402HTTPClient } from "@x402/fetch";
import { config } from "dotenv";

config();

export const baseURL = process.env.RESOURCE_SERVER_URL || "http://localhost:4021";
export const endpointPath = process.env.ENDPOINT_PATH || "/weather";
export const url = `${baseURL}${endpointPath}`;
export const raceCount = Number(process.env.RACE_COUNT ?? "4");

if (!Number.isFinite(raceCount) || raceCount <= 0) {
  console.error("RACE_COUNT must be a positive number");
  process.exit(1);
}

type RaceRequestResult = {
  index: number;
  status: number;
  paymentStatus: string | undefined;
  body: unknown;
  header: unknown;
};

/**
 * Fires parallel requests with the same payment header to test replay protection.
 *
 * @param client
 * @param httpClient
 * @param options
 * @param options.label
 * @param options.networkPrefix
 * @param options.payerAddress
 * @param options.channelSalt
 * @param options.raceCount
 */
export async function runRace(
  client: x402Client,
  httpClient: x402HTTPClient,
  options: {
    label: string;
    networkPrefix: "eip155" | "solana";
    payerAddress: string;
    channelSalt: string;
    raceCount: number;
  },
): Promise<void> {
  const { label, networkPrefix, payerAddress, channelSalt, raceCount: count } = options;

  console.log(`${label} Race Condition Demo`);
  console.log("=".repeat(label.length + 24));
  console.log(`Server: ${url}`);
  console.log(`Payer: ${payerAddress}`);
  console.log(`Channel salt: ${channelSalt}`);
  console.log(`Race count: ${count}`);
  console.log("");

  console.log("Getting 402 response...");
  const initialResponse = await fetch(url);

  if (initialResponse.status !== 402) {
    throw new Error(`Expected 402, got ${initialResponse.status}. Is the batched server running?`);
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

  const batchedOptions = paymentRequired.accepts.filter(
    a => a.network.startsWith(networkPrefix) && a.scheme === "batch-settlement",
  );

  if (batchedOptions.length === 0) {
    throw new Error(`No ${label} batched payment option found in 402 response`);
  }

  console.log(
    `Found ${batchedOptions.length} ${label} batched option(s) on network: ${batchedOptions[0].network}`,
  );
  for (const option of batchedOptions) {
    const voucherSigner = option.extra?.voucherSigner ?? "client";
    const operator =
      typeof option.extra?.operator === "string" ? option.extra.operator : undefined;
    console.log(`  Accept (${voucherSigner}-signed):`);
    console.log(`    Pay to: ${option.payTo}`);
    console.log(`    Amount: ${option.amount}`);
    console.log(`    Asset:  ${option.asset}`);
    if (operator) {
      console.log(`    Operator: ${operator}`);
    }
  }
  console.log("");

  if (networkPrefix === "solana") {
    // On-chain discovery only restores the settled watermark, not vouchers the
    // server has already accepted. One sequential paid request resynchronizes
    // local cumulative state before we reuse a single payload in parallel.
    console.log("Synchronizing SVM channel state with one paid request...");
    const fetchWithPayment = wrapFetchWithPayment(fetch, httpClient);
    const syncResponse = await fetchWithPayment(url, { method: "GET" });
    const syncResult = await httpClient.processResponse(syncResponse);
    if (syncResult.status !== 200) {
      throw new Error(
        `SVM sync request failed with HTTP ${syncResult.status}. ` +
          "Try a fresh SVM_CHANNEL_SALT or refund the channel.",
      );
    }
    console.log("Channel state synchronized.");
    console.log("");
  }

  console.log("Building batched payment payload once...");
  // Keep every accept the server offered so core can apply payment policies and
  // the batch client can fall back from an untrusted server-signed accept to
  // the same route's client-signed accept.
  const paymentPayload = await client.createPaymentPayload(paymentRequired);
  const chosenSigner = paymentPayload.accepted?.extra?.voucherSigner ?? "client";
  console.log(`Selected ${chosenSigner}-signed batch-settlement accept for the race.`);
  const paymentHeaders = httpClient.encodePaymentSignatureHeader(paymentPayload);

  console.log(`Firing ${count} parallel requests with the same payment header...`);
  const startTime = Date.now();

  const results = await Promise.all(
    Array.from({ length: count }, async (_, i) => {
      const response = await fetch(url, { headers: paymentHeaders });
      const getHeader = (name: string) => response.headers.get(name);
      let responseBody: unknown;
      try {
        responseBody = await response.json();
      } catch {
        responseBody = await response.text();
      }
      const parsed = httpClient.parsePaymentResult({
        status: response.status,
        getHeader,
        body: responseBody,
      });
      return {
        index: i,
        status: parsed.status,
        paymentStatus: parsed.paymentStatus,
        body: parsed.body,
        header: parsed.header,
      } satisfies RaceRequestResult;
    }),
  );

  const elapsed = Date.now() - startTime;

  console.log("Results:");
  console.log("--------");

  const succeeded = results.filter(r => r.status === 200);
  const failed = results.filter(r => r.status !== 200);

  for (const r of results) {
    const header = r.header;
    const errorCode =
      header && typeof header === "object" && "error" in header && header.error
        ? header.error
        : header && typeof header === "object" && "errorReason" in header && header.errorReason
          ? header.errorReason
          : undefined;
    const detailParts: string[] = [];
    if (errorCode) {
      detailParts.push(`error: ${errorCode}`);
    }
    if (r.body !== undefined && r.body !== null && JSON.stringify(r.body) !== "{}") {
      detailParts.push(`body: ${JSON.stringify(r.body)}`);
    }
    const paymentStr =
      header && typeof header === "object" && ("success" in header || "accepts" in header)
        ? ` | payment: ${JSON.stringify(header)}`
        : "";
    const detail = detailParts.length > 0 ? detailParts.join(" | ") : "{}";
    console.log(`  Request ${r.index}: HTTP ${r.status} - ${detail}${paymentStr}`);
  }

  console.log("");
  console.log(`Time: ${elapsed}ms`);
  console.log("");

  if (succeeded.length > 1) {
    console.log(
      `VULNERABLE: ${succeeded.length}/${count} requests succeeded with the same payment.`,
    );
    console.log("The server accepted the same batched payment multiple times.");
  } else if (succeeded.length === 1) {
    console.log(
      `PROTECTED: Only 1/${count} requests succeeded. ${failed.length} were correctly rejected.`,
    );
  } else {
    console.log(
      `All ${count} requests failed (status codes: ${results.map(r => r.status).join(", ")}).`,
    );
    console.log("Check that the server is running and accepting batched payments.");
  }
}
