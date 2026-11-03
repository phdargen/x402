import type { DynamicPayTo, DynamicPrice } from "@x402/core/http";
import { HTTPFacilitatorClient } from "@x402/core/server";
import type { AssetAmount, Network } from "@x402/core/types";
import { BatchSettlementEvmScheme } from "@x402/evm/batch-settlement/server";
import {
  paymentMiddlewareFromHTTPServer,
  setSettlementOverrides,
  x402HTTPResourceServer,
  x402ResourceServer,
} from "@x402/express";
import { config } from "dotenv";
import express from "express";
import { keccak256, toHex } from "viem";
import { privateKeyToAddress } from "viem/accounts";

config();

/**
 * Facilitator-managed batch-settlement stress server.
 *
 * Serves `GET /stress/:receiver/:token`, where `receiver` is an index into a seed-derived
 * receiver set (receivers never need keys) and `token` is `usdc` or `cbbtc`. Every paid request
 * is charged a random 1-100% of the route maximum, which exercises dynamic pricing.
 *
 * `GET /stress/config` publishes the receivers and tokens for the load generator and
 * `GET /stress/stats` exposes server-side verify/settle failure reasons.
 */

const EVM_NETWORK = "eip155:84532" as Network;
const PORT = Number(process.env.STRESS_PORT ?? "4022");
const SEED = process.env.STRESS_SEED?.trim() || "x402-stress-default-seed";
const RECEIVER_COUNT = Number(process.env.STRESS_RECEIVERS ?? "80");
// Max price per request in token atomic units. 100 = 0.0001 USDC or 0.000001 cbBTC.
const MAX_AMOUNT_ATOMIC = process.env.STRESS_MAX_AMOUNT_ATOMIC?.trim() || "100";
const facilitatorUrl = process.env.FACILITATOR_URL?.trim() || "http://localhost:8003/v2/x402";
const MAX_REASON_LENGTH = 160;

if (!Number.isInteger(RECEIVER_COUNT) || RECEIVER_COUNT <= 0) {
  console.error("STRESS_RECEIVERS must be a positive integer");
  process.exit(1);
}
if (!/^[1-9]\d*$/.test(MAX_AMOUNT_ATOMIC)) {
  console.error("STRESS_MAX_AMOUNT_ATOMIC must be a positive integer atomic amount");
  process.exit(1);
}

type StressToken = {
  key: "usdc" | "cbbtc";
  symbol: string;
  asset: `0x${string}`;
  name: string;
  version: string;
  decimals: number;
};

const TOKENS: Record<StressToken["key"], StressToken> = {
  usdc: {
    key: "usdc",
    symbol: "USDC",
    asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    name: "USDC",
    version: "2",
    decimals: 6,
  },
  cbbtc: {
    key: "cbbtc",
    symbol: "cbBTC",
    asset: "0xcbB7C0006F23900c38EB856149F799620fcb8A4a",
    name: "Coinbase Wrapped BTC",
    version: "1",
    decimals: 8,
  },
};

/**
 * Derives the receiver address for an index from the seed. Receivers need no keys: they only
 * accumulate settled funds.
 *
 * @param index - Receiver index.
 * @returns The derived receiver address.
 */
function deriveReceiver(index: number): `0x${string}` {
  return privateKeyToAddress(keccak256(toHex(`${SEED}:receiver:${index}`)));
}

const receivers = Array.from({ length: RECEIVER_COUNT }, (_, index) => deriveReceiver(index));

const stats = {
  startedAt: new Date().toISOString(),
  paidRequests: 0,
  refundRequests: 0,
  chargedAtomic: { usdc: 0n, cbbtc: 0n } as Record<StressToken["key"], bigint>,
  verifyFailures: {} as Record<string, number>,
  settleFailures: {} as Record<string, number>,
  refundFailures: {} as Record<string, number>,
};

/**
 * Counts one failure reason in a bucket. The reason is truncated so the bucket count stays
 * bounded even if an upstream error embeds variable data.
 *
 * @param bucket - Counter map to update.
 * @param reason - Failure reason text.
 */
function countReason(bucket: Record<string, number>, reason: string): void {
  const key = reason.slice(0, MAX_REASON_LENGTH);
  bucket[key] = (bucket[key] ?? 0) + 1;
}

/**
 * Returns whether a payment payload is a cooperative batch-settlement refund.
 *
 * @param payload - x402 payment payload value.
 * @returns Whether the payload declares the refund type.
 */
function isRefundPayload(payload: unknown): boolean {
  return (
    typeof payload === "object" &&
    payload !== null &&
    "type" in payload &&
    (payload as { type?: unknown }).type === "refund"
  );
}

/**
 * Parses `/stress/:receiver/:token` from a request path.
 *
 * @param path - Request path.
 * @returns The resolved receiver index and token.
 */
function parseStressPath(path: string): { receiverIndex: number; token: StressToken } {
  const segments = path.split("?")[0].split("/").filter(Boolean);
  const receiverIndex = Number(segments[1]);
  const token = TOKENS[segments[2] as StressToken["key"]];
  if (
    segments[0] !== "stress" ||
    !Number.isInteger(receiverIndex) ||
    receiverIndex < 0 ||
    receiverIndex >= RECEIVER_COUNT ||
    !token
  ) {
    throw new Error(`invalid stress path: ${path}`);
  }
  return { receiverIndex, token };
}

const payTo: DynamicPayTo = context => receivers[parseStressPath(context.path).receiverIndex];

const price: DynamicPrice = (context): AssetAmount => {
  const { token } = parseStressPath(context.path);
  return {
    asset: token.asset,
    amount: MAX_AMOUNT_ATOMIC,
    extra:
      token.key === "cbbtc"
        ? { assetTransferMethod: "permit2" }
        : { name: token.name, version: token.version },
  };
};

/**
 * Starts the stress server.
 */
async function main(): Promise<void> {
  const facilitatorClient = new HTTPFacilitatorClient({ url: facilitatorUrl });
  const resourceServer = new x402ResourceServer(facilitatorClient).register(
    EVM_NETWORK,
    new BatchSettlementEvmScheme(receivers[0], {
      voucherStoreMode: "facilitator",
      enforceMinDeposit: false,
    }),
  );

  resourceServer.onVerifyFailure(async context => {
    countReason(stats.verifyFailures, context.error.message);
    if (isRefundPayload(context.paymentPayload.payload)) {
      countReason(stats.refundFailures, context.error.message);
    }
  });
  resourceServer.onSettleFailure(async context => {
    countReason(stats.settleFailures, context.error.message);
    if (isRefundPayload(context.paymentPayload.payload)) {
      countReason(stats.refundFailures, context.error.message);
    }
  });
  resourceServer.onAfterSettle(async context => {
    if (isRefundPayload(context.paymentPayload.payload)) {
      stats.refundRequests += 1;
      return;
    }
    const token = Object.values(TOKENS).find(
      candidate => candidate.asset.toLowerCase() === context.requirements.asset.toLowerCase(),
    );
    const charged = context.result.extra?.chargedAmount;
    if (!token || typeof charged !== "string" || !/^\d+$/.test(charged)) return;
    stats.paidRequests += 1;
    stats.chargedAtomic[token.key] += BigInt(charged);
  });

  const httpServer = new x402HTTPResourceServer(resourceServer, {
    "GET /stress/:receiver/:token": {
      accepts: {
        scheme: "batch-settlement",
        network: EVM_NETWORK,
        payTo,
        price,
      },
      description: "Batch-settlement stress resource",
      mimeType: "application/json",
    },
  });
  await httpServer.initialize();

  const app = express();

  app.get("/stress/config", (_req, res) => {
    res.json({
      network: EVM_NETWORK,
      maxAmountAtomic: MAX_AMOUNT_ATOMIC,
      receivers,
      tokens: Object.values(TOKENS),
    });
  });

  app.get("/stress/stats", (_req, res) => {
    res.json({
      startedAt: stats.startedAt,
      paidRequests: stats.paidRequests,
      refundRequests: stats.refundRequests,
      chargedAtomic: {
        usdc: stats.chargedAtomic.usdc.toString(),
        cbbtc: stats.chargedAtomic.cbbtc.toString(),
      },
      verifyFailures: stats.verifyFailures,
      settleFailures: stats.settleFailures,
      refundFailures: stats.refundFailures,
    });
  });

  app.use(paymentMiddlewareFromHTTPServer(httpServer, undefined, undefined, false));

  app.get("/stress/:receiver/:token", (req, res) => {
    const paymentHeader = req.header("payment-signature") ?? req.header("x-payment");
    if (paymentHeader) {
      // Charge a random 1-100% of the authorized maximum.
      const chargedPercent = 1 + Math.floor(Math.random() * 100);
      setSettlementOverrides(res, { amount: `${chargedPercent}%` });
    }
    res.json({ ok: true });
  });

  app.listen(PORT, () => {
    console.log(`Batch-settlement stress server listening at http://localhost:${PORT}`);
    console.log(`  facilitator: ${facilitatorUrl}`);
    console.log(`  receivers: ${RECEIVER_COUNT} (seed-derived), tokens: usdc, cbbtc`);
    console.log(`  max price per request: ${MAX_AMOUNT_ATOMIC} atomic units`);
    console.log("  GET /stress/:receiver/:token  GET /stress/config  GET /stress/stats");
  });
}

main().catch(error => {
  console.error("Startup failed:", error);
  process.exit(1);
});
