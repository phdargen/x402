import { NextResponse } from "next/server";
import { getAddress, verifyTypedData } from "viem";
import {
  BATCH_SETTLEMENT_ADDRESS,
  BATCH_SETTLEMENT_DOMAIN,
  voucherTypes,
  type ChannelConfig,
} from "@x402/evm";
import { computeChannelId } from "@x402/evm/batch-settlement/client";
import type { Channel } from "@x402/evm/batch-settlement/server";
import {
  CHAIN_ID,
  NETWORK,
  RECEIVER_ADDRESS,
  USDC_ADDRESS,
  WITHDRAW_DELAY,
} from "@/lib/x402/config";
import { storage } from "@/lib/server/x402";

export const runtime = "nodejs";

type VoucherCheckpoint = {
  channelConfig: ChannelConfig;
  voucher: {
    channelId: `0x${string}`;
    maxClaimableAmount: string;
    signature: `0x${string}`;
  };
  jumpCount: number;
  distance: number;
  roundSpent: string;
};

export async function POST(req: Request) {
  const body = (await req.json()) as Partial<VoucherCheckpoint>;
  const parsed = parseCheckpoint(body);
  if ("error" in parsed) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  const checkpoint = parsed.checkpoint;
  const configError = validateGameChannelConfig(checkpoint.channelConfig);
  if (configError) {
    return NextResponse.json({ error: configError }, { status: 400 });
  }

  const channelId = computeChannelId(checkpoint.channelConfig, NETWORK);
  if (channelId.toLowerCase() !== checkpoint.voucher.channelId.toLowerCase()) {
    return NextResponse.json({ error: "Channel id does not match channel config" }, { status: 400 });
  }

  const signatureOk = await verifyCheckpointVoucher(checkpoint);
  if (!signatureOk) {
    return NextResponse.json({ error: "Invalid voucher signature" }, { status: 403 });
  }

  const signedMax = BigInt(checkpoint.voucher.maxClaimableAmount);
  let outcome:
    | { status: "missing" }
    | { status: "stale"; current: string }
    | { status: "exceeds_balance"; balance: string }
    | { status: "stored"; channel: Channel }
    | undefined;

  const updateResult = await storage.updateChannel(channelId, current => {
    if (!current) {
      outcome = { status: "missing" };
      return current;
    }

    const currentCharged = BigInt(current.chargedCumulativeAmount);
    if (signedMax < currentCharged) {
      outcome = { status: "stale", current: current.chargedCumulativeAmount };
      return current;
    }

    if (signedMax > BigInt(current.balance)) {
      outcome = { status: "exceeds_balance", balance: current.balance };
      return current;
    }

    const next: Channel = {
      ...current,
      channelConfig: checkpoint.channelConfig,
      chargedCumulativeAmount: signedMax.toString(),
      signedMaxClaimable: checkpoint.voucher.maxClaimableAmount,
      signature: checkpoint.voucher.signature,
      lastRequestTimestamp: Date.now(),
    };
    outcome = { status: "stored", channel: next };
    return next;
  });

  if (outcome?.status === "missing") {
    return NextResponse.json({ error: "Channel is not funded on this server" }, { status: 409 });
  }
  if (outcome?.status === "stale") {
    return NextResponse.json(
      { error: "Checkpoint is older than stored voucher", chargedCumulativeAmount: outcome.current },
      { status: 409 },
    );
  }
  if (outcome?.status === "exceeds_balance") {
    return NextResponse.json(
      { error: "Voucher exceeds channel balance", balance: outcome.balance },
      { status: 402 },
    );
  }
  if (updateResult.status !== "updated" || outcome?.status !== "stored") {
    return NextResponse.json({ error: "Failed to store checkpoint" }, { status: 409 });
  }

  return NextResponse.json({
    ok: true,
    channelId,
    chargedCumulativeAmount: outcome.channel.chargedCumulativeAmount,
    balance: outcome.channel.balance,
    jumpCount: checkpoint.jumpCount,
    distance: checkpoint.distance,
  });
}

function parseCheckpoint(
  body: Partial<VoucherCheckpoint>,
): { ok: true; checkpoint: VoucherCheckpoint } | { ok: false; error: string } {
  if (!body.channelConfig || !body.voucher) {
    return { ok: false, error: "Missing channel config or voucher" };
  }
  if (!isHex(body.voucher.channelId) || !isHex(body.voucher.signature)) {
    return { ok: false, error: "Invalid voucher fields" };
  }
  if (!isDecimalString(body.voucher.maxClaimableAmount) || !isDecimalString(body.roundSpent)) {
    return { ok: false, error: "Invalid amount fields" };
  }
  if (!Number.isInteger(body.jumpCount) || body.jumpCount < 0) {
    return { ok: false, error: "Invalid jump count" };
  }
  if (typeof body.distance !== "number" || !Number.isFinite(body.distance) || body.distance < 0) {
    return { ok: false, error: "Invalid distance" };
  }

  return { ok: true, checkpoint: body as VoucherCheckpoint };
}

function validateGameChannelConfig(config: ChannelConfig): string | undefined {
  if (!/^0x[0-9a-fA-F]{40}$/.test(RECEIVER_ADDRESS)) {
    return "Game receiver is not configured";
  }

  try {
    if (getAddress(config.receiver) !== getAddress(RECEIVER_ADDRESS)) {
      return "Channel receiver does not match game receiver";
    }
    if (getAddress(config.token) !== getAddress(USDC_ADDRESS)) {
      return "Channel token does not match game token";
    }
    getAddress(config.payer);
    getAddress(config.payerAuthorizer);
    getAddress(config.receiverAuthorizer);
  } catch {
    return "Invalid channel address";
  }
  if (config.withdrawDelay !== WITHDRAW_DELAY) {
    return "Channel withdraw delay does not match game config";
  }
  if (!isHex(config.salt)) {
    return "Invalid channel salt";
  }
}

async function verifyCheckpointVoucher(checkpoint: VoucherCheckpoint): Promise<boolean> {
  try {
    return await verifyTypedData({
      address: getAddress(checkpoint.channelConfig.payerAuthorizer),
      domain: {
        ...BATCH_SETTLEMENT_DOMAIN,
        chainId: CHAIN_ID,
        verifyingContract: getAddress(BATCH_SETTLEMENT_ADDRESS),
      },
      types: voucherTypes,
      primaryType: "Voucher",
      message: {
        channelId: checkpoint.voucher.channelId,
        maxClaimableAmount: BigInt(checkpoint.voucher.maxClaimableAmount),
      },
      signature: checkpoint.voucher.signature,
    });
  } catch {
    return false;
  }
}

function isHex(value: unknown): value is `0x${string}` {
  return typeof value === "string" && /^0x[0-9a-fA-F]+$/.test(value);
}

function isDecimalString(value: unknown): value is string {
  return typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value);
}
