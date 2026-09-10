import type { PaymentRequirements } from "@x402/core/types";
import type { BatchSettlementPaymentResponseExtra } from "./types";
import type { Channel, ChannelStorage } from "./storage/channel";

const MIN_PENDING_TTL_MS = 5_000;
const MAX_PENDING_TTL_MS = 10 * 60 * 1000;

/** Who owns the authoritative offchain voucher store for a request or network. */
export type VoucherStoreMode = "self" | "facilitator";

export type CommitVoucherChargeInput<T extends Channel = Channel> = {
  increment: bigint;
  signedCap: bigint;
  voucher: { maxClaimableAmount: string; signature: string };
  snapshot?: Channel;
  now?: number;
  localVerify?: boolean;
  /** Applied after charge fields. Use to set facilitator extras (network, chargeCount). */
  map?: (updated: T) => T;
};

export type CommitVoucherChargeResult<T extends Channel = Channel> =
  | { status: "missing" }
  | { status: "cap_exceeded"; charged: string }
  | { status: "committed"; previous: Channel; current: T }
  | { status: "conflict" };

/**
 * Returns whether this request uses a facilitator voucher store.
 *
 * @param requirements - Payment requirements (or any object with `extra`).
 * @param requirements.extra - Optional extra record that may contain `voucherStore`.
 * @returns True when `extra.voucherStore === true`.
 */
export function isFacilitatorManaged(requirements: {
  extra?: Record<string, unknown> | undefined;
}): boolean {
  return requirements.extra?.voucherStore === true;
}

/**
 * Resolves {@link VoucherStoreMode} from payment requirements.
 *
 * @param requirements - Current request payment requirements.
 * @returns `"facilitator"` when `extra.voucherStore === true`, otherwise `"self"`.
 */
export function voucherStoreMode(requirements: PaymentRequirements): VoucherStoreMode {
  return isFacilitatorManaged(requirements) ? "facilitator" : "self";
}

/**
 * Computes the bounded admission-lock TTL.
 *
 * @param maxTimeoutSeconds - Resource timeout from payment requirements.
 * @returns TTL in milliseconds, clamped to 5s–600s.
 */
export function pendingTtlMs(maxTimeoutSeconds: number | undefined): number {
  const requestedMs = Math.max(0, maxTimeoutSeconds ?? 0) * 1000;
  return Math.min(MAX_PENDING_TTL_MS, Math.max(MIN_PENDING_TTL_MS, requestedMs));
}

/**
 * Converts stored channel state into the public response snapshot shape.
 *
 * @param channel - Stored channel state.
 * @param chargedCumulativeAmount - Optional current charged cumulative amount.
 * @returns Response-ready channel snapshot.
 */
export function channelStateExtra(
  channel: Pick<
    Channel,
    "channelId" | "balance" | "totalClaimed" | "withdrawRequestedAt" | "refundNonce"
  >,
  chargedCumulativeAmount?: string,
): NonNullable<BatchSettlementPaymentResponseExtra["channelState"]> {
  return {
    channelId: channel.channelId as `0x${string}`,
    balance: channel.balance,
    totalClaimed: channel.totalClaimed,
    withdrawRequestedAt: channel.withdrawRequestedAt,
    refundNonce: String(channel.refundNonce),
    ...(chargedCumulativeAmount !== undefined ? { chargedCumulativeAmount } : {}),
  };
}

/**
 * Builds payment-response `extra` with a stable key order.
 *
 * Self-managed paid responses are `channelState`, then `chargedAmount`.
 * Facilitator-managed adds `chargeCount` after that. Refunds omit `chargedAmount`.
 *
 * @param extra - Channel snapshot and optional charge fields.
 * @param extra.channelState - On-chain channel snapshot included in the response.
 * @param extra.chargedAmount - Amount charged for this payment; omitted for refunds.
 * @param extra.chargeCount - Facilitator-managed charge index when applicable.
 * @returns Extra object with keys in declaration order.
 */
export function paymentResponseExtra(extra: {
  channelState: NonNullable<BatchSettlementPaymentResponseExtra["channelState"]>;
  chargedAmount?: string;
  chargeCount?: number;
}): BatchSettlementPaymentResponseExtra {
  return {
    channelState: extra.channelState,
    ...(extra.chargedAmount !== undefined ? { chargedAmount: extra.chargedAmount } : {}),
    ...(extra.chargeCount !== undefined ? { chargeCount: extra.chargeCount } : {}),
  };
}

/**
 * Atomically increments `chargedCumulativeAmount` under the storage CAS.
 *
 * @param storage - Durable channel store.
 * @param channelId - Channel to update.
 * @param input - Charge increment, signed cap, voucher, and optional snapshot/map.
 * @returns CAS outcome.
 */
export async function commitVoucherCharge<T extends Channel = Channel>(
  storage: ChannelStorage<T>,
  channelId: string,
  input: CommitVoucherChargeInput<T>,
): Promise<CommitVoucherChargeResult<T>> {
  const now = input.now ?? Date.now();
  let outcome: CommitVoucherChargeResult<T> | undefined;

  const updateResult = await storage.updateChannel(channelId, current => {
    const base = (current ?? input.snapshot) as T | undefined;
    if (!base) {
      outcome = { status: "missing" };
      return current;
    }

    const newCharged = BigInt(base.chargedCumulativeAmount) + input.increment;
    if (newCharged > input.signedCap) {
      outcome = { status: "cap_exceeded", charged: newCharged.toString() };
      return current;
    }

    let updatedChannel = {
      ...base,
      ...(input.localVerify || !input.snapshot
        ? {}
        : {
            balance: input.snapshot.balance,
            totalClaimed: input.snapshot.totalClaimed,
            withdrawRequestedAt: input.snapshot.withdrawRequestedAt,
            refundNonce: input.snapshot.refundNonce,
            onchainSyncedAt: now,
          }),
      chargedCumulativeAmount: newCharged.toString(),
      signedMaxClaimable: input.voucher.maxClaimableAmount,
      signature: input.voucher.signature,
      lastRequestTimestamp: now,
    } as T;
    if (input.map) {
      updatedChannel = input.map(updatedChannel);
    }
    outcome = { status: "committed", previous: base, current: updatedChannel };
    return updatedChannel;
  });

  if (outcome?.status === "missing" || outcome?.status === "cap_exceeded") {
    return outcome;
  }

  if (updateResult.status !== "updated" || outcome?.status !== "committed") {
    return { status: "conflict" };
  }

  return outcome;
}
