import { NextRequest, NextResponse } from "next/server";
import { channelManager } from "@/lib/server/x402";
import { authorizeCronRequest } from "@/lib/server/cronAuth";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const unauthorized = authorizeCronRequest(request);
  if (unauthorized) return unauthorized;

  const { claims, settle } = await channelManager.claimAndSettle({ maxClaimsPerBatch: 100 });
  return NextResponse.json({
    claimBatches: claims.length,
    vouchers: claims.reduce((total, claim) => total + claim.vouchers, 0),
    claimTransactions: claims.map(claim => claim.transaction),
    settleTransaction: settle?.transaction,
  });
}
