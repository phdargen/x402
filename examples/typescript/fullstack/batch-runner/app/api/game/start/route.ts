import { NextRequest, NextResponse } from "next/server";
import { withX402 } from "@x402/next";
import { server, receiverAddress } from "@/lib/server/x402";
import { NETWORK, JUMP_PRICE } from "@/lib/x402/config";

export const runtime = "nodejs";

const handler = async (_: NextRequest) => {
  return NextResponse.json({ ok: true, message: "Channel funded — game on!" }, { status: 200 });
};

export const GET = withX402(
  handler,
  {
    accepts: [
      {
        scheme: "batch-settlement",
        price: JUMP_PRICE,
        network: NETWORK,
        payTo: receiverAddress,
      },
    ],
    description: "Batch Runner game session deposit",
    mimeType: "application/json",
  },
  server,
);
