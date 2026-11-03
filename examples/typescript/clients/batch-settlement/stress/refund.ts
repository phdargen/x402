export type RefundSkipReason = "no_channel" | "no_refundable_balance" | "balance_too_small";

/**
 * Computes the currently refundable channel balance.
 *
 * @param balance - Local channel balance in token atomic units.
 * @param charged - Cumulative amount charged by the resource server.
 * @returns The uncharged balance, or zero when none remains.
 */
export function refundableBalance(balance: bigint, charged: bigint): bigint {
  return balance > charged ? balance - charged : 0n;
}

/**
 * Selects a partial refund amount while leaving at least one atomic unit in the channel.
 *
 * @param balance - Local channel balance in token atomic units.
 * @param charged - Cumulative amount charged by the resource server.
 * @param fraction - Fraction of the refundable balance to request, from 0 to 1.
 * @param minimum - Smallest requested refund in atomic units.
 * @returns A valid partial amount, or undefined when the balance cannot support one.
 */
export function partialRefundAmount(
  balance: bigint,
  charged: bigint,
  fraction: number,
  minimum: bigint,
): bigint | undefined {
  const refundable = refundableBalance(balance, charged);
  if (refundable <= 1n || minimum <= 0n || refundable - 1n < minimum) return undefined;

  const fractionMicros = BigInt(Math.floor(fraction * 1_000_000));
  const proportional = (refundable * fractionMicros) / 1_000_000n;
  const requested = proportional < minimum ? minimum : proportional;
  return requested >= refundable ? refundable - 1n : requested;
}
