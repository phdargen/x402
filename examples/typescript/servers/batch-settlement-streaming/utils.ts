import type { PaymentPayload, SettleResponse } from "@x402/core/types";
import { isBatchSettlementDepositPayload, isBatchSettlementVoucherPayload } from "@x402/evm";
import type { BatchSettlementEvmScheme } from "@x402/evm/batch-settlement/server";
import type express from "express";

export type ServerCliOptions = {
  verbose: boolean;
};

export type VoucherResolver = {
  resolve: (payload: PaymentPayload) => void;
  reject: (err: Error) => void;
};

/**
 * Returns whether an environment variable is set to a truthy string.
 *
 * @param value - Raw env value or undefined.
 * @returns True when value is 1, true, yes, or on (case-insensitive).
 */
export function isTruthyEnvFlag(value: string | undefined): boolean {
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

/**
 * Parses CLI argv for `--verbose` / `-v`.
 *
 * @param argv - Arguments after the script name (e.g. `process.argv.slice(2)`).
 * @returns Parsed verbose flag.
 */
export function parseServerCliOptions(argv: string[]): ServerCliOptions {
  const verbose = argv.includes("-v") || argv.includes("--verbose");
  return { verbose };
}

/**
 * Writes one Server-Sent Event block to the Express response.
 *
 * @param res - Express response with an open writable stream.
 * @param event - SSE event name.
 * @param data - Payload serialized as JSON in the `data` field.
 */
export function sseWrite(res: express.Response, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * Computes the amount to charge for the current token count within a chunk window.
 *
 * @param tokenCount - Tokens emitted so far in the current chunk.
 * @param chunkSize - Tokens per priced chunk.
 * @param chunkAmountAtomic - Atomic units charged for a full chunk.
 * @returns Pro-rated or full chunk amount as a decimal string.
 */
export function getChunkChargeAmount(
  tokenCount: number,
  chunkSize: number,
  chunkAmountAtomic: string,
): string {
  if (tokenCount <= 0) return "0";
  if (tokenCount >= chunkSize) return chunkAmountAtomic;

  return ((BigInt(chunkAmountAtomic) * BigInt(tokenCount)) / BigInt(chunkSize)).toString();
}

/**
 * Returns the next cumulative charge cap after adding one chunk amount.
 *
 * @param chargedCumulativeAmount - Current charged total (atomic units).
 * @param chunkAmountAtomic - One chunk price in atomic units.
 * @returns Sum as a decimal string.
 */
export function getNextMaxClaimableAmount(
  chargedCumulativeAmount: string,
  chunkAmountAtomic: string,
): string {
  return (BigInt(chargedCumulativeAmount) + BigInt(chunkAmountAtomic)).toString();
}

/**
 * Extracts batch-settlement channel id from a deposit or voucher payload.
 *
 * @param paymentPayload - Decoded x402 payment payload.
 * @returns Channel id when present, otherwise undefined.
 */
export function getChannelIdFromPayload(paymentPayload: PaymentPayload): string | undefined {
  const raw = paymentPayload.payload as Record<string, unknown>;

  if (isBatchSettlementVoucherPayload(raw)) {
    return typeof raw.channelId === "string" ? raw.channelId : undefined;
  }

  if (!isBatchSettlementDepositPayload(raw)) {
    return undefined;
  }

  const voucher = raw.voucher as Record<string, unknown>;
  return typeof voucher.channelId === "string" ? voucher.channelId : undefined;
}

/**
 * Shortens a long channel id for log output.
 *
 * @param channelId - Full channel id or undefined.
 * @returns Original, shortened, or "unknown" display string.
 */
export function formatChannelId(channelId: string | undefined): string {
  if (!channelId) return "unknown";
  if (channelId.length <= 14) return channelId;

  return `${channelId.slice(0, 6)} ... ${channelId.slice(-5)}`;
}

/**
 * Wraps text in ANSI green for terminal output.
 *
 * @param text - Raw message.
 * @returns Text with green foreground reset codes.
 */
export function colorizeGreen(text: string): string {
  return `\u001b[32m${text}\u001b[0m`;
}

/**
 * Wraps text in ANSI red for terminal output.
 *
 * @param text - Raw message.
 * @returns Text with red foreground reset codes.
 */
export function colorizeRed(text: string): string {
  return `\u001b[31m${text}\u001b[0m`;
}

/**
 * Builds the settle response for the trailer, with session totals for this request.
 *
 * @param batchedScheme - Server batch-settlement scheme (storage access).
 * @param paymentResponse - Baseline settle response from verification.
 * @param channelId - Channel id for this stream, if known.
 * @param requestStartCharged - Charged amount at request start (atomic string).
 * @returns Augmented settle response including amount and session extras.
 */
export async function buildFinalPaymentResponse(
  batchedScheme: BatchSettlementEvmScheme,
  paymentResponse: SettleResponse,
  channelId: string | undefined,
  requestStartCharged: string,
): Promise<SettleResponse> {
  if (!channelId) {
    return paymentResponse;
  }

  const session = await batchedScheme.getStorage().get(channelId);
  if (!session) {
    return paymentResponse;
  }

  const totalAmount = (
    BigInt(session.chargedCumulativeAmount) - BigInt(requestStartCharged)
  ).toString();

  return {
    ...paymentResponse,
    amount: totalAmount,
    extra: {
      ...paymentResponse.extra,
      channelId,
      chargedCumulativeAmount: session.chargedCumulativeAmount,
      balance: session.balance,
      totalClaimed: session.totalClaimed,
      withdrawRequestedAt: session.withdrawRequestedAt,
    },
  };
}

/**
 * Derives display state for an accepted voucher renewal (deposit vs voucher).
 *
 * @param paymentPayload - Latest payment payload after renewal.
 * @param chargedCumulativeAmount - Updated charged total.
 * @param balance - Remaining balance on the channel.
 * @returns Fields for the `x402-voucher-accepted` SSE event.
 */
export function getAcceptedRenewalState(
  paymentPayload: PaymentPayload,
  chargedCumulativeAmount: string,
  balance: string,
): {
  chargedCumulativeAmount: string;
  balance: string;
  signedMaxClaimable: string;
  toppedUp: boolean;
} {
  const raw = paymentPayload.payload as Record<string, unknown>;

  if (isBatchSettlementDepositPayload(raw)) {
    const voucher = raw.voucher as Record<string, unknown>;

    return {
      chargedCumulativeAmount,
      balance,
      signedMaxClaimable: String(voucher.maxClaimableAmount ?? "0"),
      toppedUp: true,
    };
  }

  return {
    chargedCumulativeAmount,
    balance,
    signedMaxClaimable: String(raw.maxClaimableAmount ?? "0"),
    toppedUp: false,
  };
}

/**
 * Normalizes a payment payload to voucher form for side-channel POST bodies.
 *
 * @param paymentPayload - Current payment payload.
 * @param requirements - Accepted requirements to attach to the payload.
 * @returns Channel id and payload suitable for voucher renewal POST.
 */
export function toVoucherPayload(
  paymentPayload: PaymentPayload,
  requirements: PaymentPayload["accepted"],
): { channelId: string; payload: PaymentPayload } {
  const raw = paymentPayload.payload as Record<string, unknown>;

  if (!isBatchSettlementDepositPayload(raw)) {
    return {
      channelId: raw.channelId as string,
      payload: paymentPayload,
    };
  }

  const voucherPart = raw.voucher as Record<string, unknown>;
  const depositPart = raw.deposit as Record<string, unknown>;

  return {
    channelId: voucherPart.channelId as string,
    payload: {
      x402Version: paymentPayload.x402Version,
      accepted: requirements,
      payload: {
        type: "voucher",
        channelConfig: depositPart.channelConfig,
        channelId: voucherPart.channelId,
        maxClaimableAmount: voucherPart.maxClaimableAmount,
        signature: voucherPart.signature,
      },
    },
  };
}

/**
 * Registers a pending resolver until a voucher POST arrives or timeout.
 *
 * @param pendingVouchers - Map of channel id to promise resolver.
 * @param channelId - Channel waiting for renewal.
 * @param timeoutMs - Max wait before rejecting.
 * @returns Promise that resolves with the posted payment payload.
 */
export function waitForVoucher(
  pendingVouchers: Map<string, VoucherResolver>,
  channelId: string,
  timeoutMs: number,
): Promise<PaymentPayload> {
  return new Promise<PaymentPayload>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingVouchers.delete(channelId);
      reject(new Error("Voucher renewal timed out"));
    }, timeoutMs);

    pendingVouchers.set(channelId, {
      resolve: (payload: PaymentPayload) => {
        clearTimeout(timer);
        pendingVouchers.delete(channelId);
        resolve(payload);
      },
      reject: (err: Error) => {
        clearTimeout(timer);
        pendingVouchers.delete(channelId);
        reject(err);
      },
    });
  });
}
