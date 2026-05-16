import { NextResponse } from "next/server";
import { verifyTypedData, getAddress } from "viem";
import {
  BATCH_SETTLEMENT_DOMAIN,
  BATCH_SETTLEMENT_ADDRESS,
  voucherTypes,
} from "@x402/evm";

type LeaderboardEntry = {
  address: string;
  distance: number;
  voucherCount: number;
};

// In-memory leaderboard fallback when no Redis is configured
const inMemoryLeaderboard: LeaderboardEntry[] = [];

function getRedis() {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;

  // Lazy import to avoid errors when @upstash/redis isn't available
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Redis } = require("@upstash/redis");
    return new Redis({ url, token });
  } catch {
    return null;
  }
}

const LEADERBOARD_KEY = "batch-runner:leaderboard";
const MAX_ENTRIES = 50;

export async function GET() {
  const redis = getRedis();

  if (redis) {
    try {
      const raw = await redis.zrange(LEADERBOARD_KEY, 0, MAX_ENTRIES - 1, { rev: true, withScores: true });
      const entries: LeaderboardEntry[] = [];
      for (let i = 0; i < raw.length; i += 2) {
        const parsed = typeof raw[i] === "string" ? JSON.parse(raw[i] as string) : raw[i];
        entries.push(parsed as LeaderboardEntry);
      }
      return NextResponse.json({ entries });
    } catch {
      // Fall through to in-memory
    }
  }

  const sorted = [...inMemoryLeaderboard].sort((a, b) => b.distance - a.distance).slice(0, MAX_ENTRIES);
  return NextResponse.json({ entries: sorted });
}

export async function POST(req: Request) {
  const body = await req.json();
  const { address, distance, voucherCount, lastVoucher, signerAddress } = body;

  if (!address || typeof distance !== "number" || typeof voucherCount !== "number") {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  // Verify voucher signature if provided (signed by session key, not main wallet)
  if (lastVoucher?.channelId && lastVoucher?.signature && signerAddress) {
    try {
      const valid = await verifyTypedData({
        address: getAddress(signerAddress),
        domain: {
          ...BATCH_SETTLEMENT_DOMAIN,
          chainId: 84532,
          verifyingContract: getAddress(BATCH_SETTLEMENT_ADDRESS),
        },
        types: voucherTypes,
        primaryType: "Voucher",
        message: {
          channelId: lastVoucher.channelId,
          maxClaimableAmount: BigInt(lastVoucher.maxClaimableAmount),
        },
        signature: lastVoucher.signature,
      });

      if (!valid) {
        return NextResponse.json({ error: "Invalid voucher signature" }, { status: 403 });
      }
    } catch {
      return NextResponse.json({ error: "Invalid voucher signature" }, { status: 403 });
    }
  }

  const entry: LeaderboardEntry = {
    address: getAddress(address),
    distance,
    voucherCount,
  };

  const redis = getRedis();
  let rank: number | null = null;

  if (redis) {
    try {
      await redis.zadd(LEADERBOARD_KEY, { score: distance, member: JSON.stringify(entry) });
      rank = await redis.zrevrank(LEADERBOARD_KEY, JSON.stringify(entry));
      if (rank !== null) rank += 1;
    } catch {
      // Fall through
    }
  }

  if (rank === null) {
    inMemoryLeaderboard.push(entry);
    inMemoryLeaderboard.sort((a, b) => b.distance - a.distance);
    rank = inMemoryLeaderboard.findIndex(
      (e) => e.address === entry.address && e.distance === entry.distance,
    ) + 1;
  }

  return NextResponse.json({ rank });
}
