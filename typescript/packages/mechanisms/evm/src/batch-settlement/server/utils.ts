import type { BatchSettlementPaymentResponseExtra } from "../types";

/**
 * Reads a string value from optional payment `extra`, with a fallback when missing or invalid.
 *
 * @param extra - Optional payment extra record.
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
 * @param extra - Optional payment extra record.
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
