import type {
  BatchSettlementPaymentResponseExtra,
  BatchSettlementRefundWithSignaturePayload,
} from "../types";
import { computeChannelId } from "../utils";
import type { ChannelSession } from "./storage";

/**
 * Builds the payment `responseExtra` snapshot after a refund is applied to the session.
 *
 * @param session - Current channel session before the refund.
 * @param payload - Refund payload (amount and claims) used to compute post-refund totals.
 * @returns `BatchSettlementPaymentResponseExtra` reflecting updated balance and refund nonce.
 */
export function buildRefundResponseSnapshot(
  session: ChannelSession,
  payload: BatchSettlementRefundWithSignaturePayload,
): BatchSettlementPaymentResponseExtra {
  const finalClaimed =
    payload.claims[payload.claims.length - 1]?.totalClaimed ?? session.chargedCumulativeAmount;

  return {
    channelId: computeChannelId(payload.config),
    chargedCumulativeAmount: finalClaimed,
    balance: (BigInt(session.balance) - BigInt(payload.amount)).toString(),
    totalClaimed: payload.claims[payload.claims.length - 1]?.totalClaimed ?? session.totalClaimed,
    withdrawRequestedAt: 0,
    refundNonce: String(session.refundNonce + 1),
    refundedAmount: payload.amount,
  };
}

/**
 * Returns a zeroed `responseExtra` snapshot for a channel with no prior session data.
 *
 * @param channelId - Channel id to attach to the snapshot.
 * @returns Default extra fields with zero balances and nonce.
 */
export function emptyResponseSnapshot(
  channelId: `0x${string}`,
): BatchSettlementPaymentResponseExtra {
  return {
    channelId,
    chargedCumulativeAmount: "0",
    balance: "0",
    totalClaimed: "0",
    withdrawRequestedAt: 0,
    refundNonce: "0",
  };
}

/**
 * Reads a string value from optional payment `extra`, with a fallback when missing or invalid.
 *
 * @param extra - Optional `responseExtra` or similar record.
 * @param key - Key on `BatchSettlementPaymentResponseExtra` to read.
 * @param fallback - Value returned when the entry is absent or not coercible to string.
 * @returns String representation of the value, or `fallback`.
 */
export function readExtraString(
  extra: Record<string, unknown> | undefined,
  key: keyof BatchSettlementPaymentResponseExtra,
  fallback: string,
): string {
  const value = extra?.[key];
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return fallback;
}

/**
 * Reads a numeric value from optional payment `extra`, with a fallback when missing or invalid.
 *
 * @param extra - Optional `responseExtra` or similar record.
 * @param key - Key on `BatchSettlementPaymentResponseExtra` to read.
 * @param fallback - Value returned when the entry is absent or not parseable as a number.
 * @returns Parsed number, or `fallback`.
 */
export function readExtraNumber(
  extra: Record<string, unknown> | undefined,
  key: keyof BatchSettlementPaymentResponseExtra,
  fallback: number,
): number {
  const value = extra?.[key];
  if (typeof value === "number") return value;
  if (typeof value === "string") return parseInt(value, 10) || fallback;
  return fallback;
}
