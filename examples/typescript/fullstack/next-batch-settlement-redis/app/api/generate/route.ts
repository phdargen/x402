import { NextRequest, NextResponse } from "next/server";
import { setSettlementOverrides, withX402 } from "@x402/next";

import { paywall } from "../../../lib/paywall";
import { evmAddress, NETWORK, server } from "../../../lib/server";

const maxPrice = "$0.01";

/**
 * Demo handler mirroring `examples/typescript/servers/batch-settlement`: usage-based partial
 * settlement via {@link setSettlementOverrides}.
 *
 * @param _ - Incoming Next.js request
 * @returns JSON with generated payload and usage metadata
 */
const handler = async (_: NextRequest) => {
  const chargedPercent = 1 + Math.floor(Math.random() * 100);

  const maxDollars = parseFloat(maxPrice.slice(1));
  const chargedDollars = (maxDollars * chargedPercent) / 100;
  const chargedPrice = `$${String(Math.round(chargedDollars * 1e6) / 1e6)}`;

  const response = NextResponse.json(
    {
      result: "Here is your generated text...",
      usage: {
        maxPrice,
        chargedPrice,
      },
    },
    { status: 200 },
  );

  setSettlementOverrides(response, { amount: `${chargedPercent}%` });

  return response;
};

/**
 * Batch-settlement API route using `withX402` (no `paymentProxy`).
 * Redis-backed channel state is configured in `lib/server.ts`.
 */
export const GET = withX402(
  handler,
  {
    accepts: [
      {
        scheme: "batch-settlement",
        price: maxPrice,
        network: NETWORK,
        payTo: evmAddress,
      },
    ],
    description: "Batch-settlement demo — voucher updates session without per-request chain settle",
    mimeType: "application/json",
  },
  server,
  undefined,
  paywall,
);
