import {
  InMemoryChannelStorage,
  isPendingLive,
  pendingExpiresAt,
  type Channel,
  type ChannelStorage,
} from "../../storage";
import type {
  BatchSettlementChannelSnapshot,
  BatchSettlementChannelStateExtra,
  BatchSettlementCorrectiveState,
  BatchSettlementVoucherFields,
  BatchSettlementVoucherStateExtra,
  ChannelConfig,
} from "../../types";
import { ErrMissingChannel } from "../../errors";

export type BatchSettlementVoucherStoreConfig = {
  /** Persistence backend. Defaults to an in-memory store (single instance only). */
  storage?: ChannelStorage;
  /** Withdraw delay advertised on `/supported` and required of every managed channel. */
  withdrawDelay: number;
};

type ReserveParams = {
  channelConfig: ChannelConfig;
  voucher: BatchSettlementVoucherFields;
  snapshot: BatchSettlementChannelSnapshot;
  /** `requirements.amount` — the per-request maximum the voucher must cover. */
  amount: string;
  maxTimeoutSeconds?: number;
};

export type ReserveOutcome =
  | { status: "reserved"; channelState: BatchSettlementChannelStateExtra }
  | { status: "busy" }
  | ({ status: "mismatch" } & BatchSettlementCorrectiveState);

export type CommitOutcome =
  | { status: "committed"; channelState: BatchSettlementChannelStateExtra }
  | { status: "busy" }
  | { status: "missing" }
  | { status: "over_charge"; charged: string; limit: string };

/**
 * The facilitator's authoritative voucher store for facilitator-managed custody.
 *
 * `/verify` reserves a channel (watermark check plus a short-lived per-channel lock keyed
 * on the voucher signature) and `/settle` commits the charge and the voucher that covers
 * it. The watermark never advances at verify time, so a crashed handler leaves nothing
 * charged once the reservation expires.
 */
export class BatchSettlementVoucherStore {
  readonly withdrawDelay: number;
  private readonly storage: ChannelStorage;

  /**
   * Creates the facilitator voucher store.
   *
   * @param config - Persistence backend and advertised withdraw delay.
   */
  constructor(config: BatchSettlementVoucherStoreConfig) {
    this.storage = config.storage ?? new InMemoryChannelStorage();
    this.withdrawDelay = config.withdrawDelay;
  }

  /**
   * Returns the underlying persistence backend.
   *
   * @returns The configured {@link ChannelStorage}.
   */
  getStorage(): ChannelStorage {
    return this.storage;
  }

  /**
   * Checks the voucher against the stored watermark and takes the per-channel lock.
   *
   * A channel with no record cold-starts at `chargedCumulativeAmount = totalClaimed`, so
   * charges lost with the record are forfeited rather than double-charged.
   *
   * @param params - Channel config, incoming voucher, onchain snapshot, and request amount.
   * @returns Whether the channel was reserved, is busy, or the watermark disagrees.
   */
  async reserve(params: ReserveParams): Promise<ReserveOutcome> {
    const { channelConfig, voucher, snapshot, amount } = params;
    const now = Date.now();
    let outcome: ReserveOutcome | undefined;

    const result = await this.storage.updateChannel(voucher.channelId, current => {
      if (isPendingLive(current?.pendingRequest, now)) {
        outcome = { status: "busy" };
        return current;
      }

      const charged = current?.chargedCumulativeAmount ?? snapshot.totalClaimed;
      if (BigInt(voucher.maxClaimableAmount) !== BigInt(charged) + BigInt(amount)) {
        const voucherState = committedVoucherState(current);
        outcome = {
          status: "mismatch",
          channelState: { ...snapshot, chargedCumulativeAmount: charged },
          ...(voucherState ? { voucherState } : {}),
        };
        return current;
      }

      outcome = {
        status: "reserved",
        channelState: { ...snapshot, chargedCumulativeAmount: charged },
      };
      return {
        ...mirrorSnapshot(current, channelConfig, snapshot, charged, now),
        pendingRequest: {
          pendingId: voucher.signature,
          signedMaxClaimable: voucher.maxClaimableAmount,
          verifiedAmount: amount,
          expiresAt: pendingExpiresAt(params.maxTimeoutSeconds, now),
        },
      };
    });

    if (!outcome || (outcome.status === "reserved" && result.status !== "updated")) {
      return { status: "busy" };
    }
    return outcome;
  }

  /**
   * Commits a paid voucher: advances the watermark by the settle-time charge, stores the
   * voucher that covers it, and releases the reservation.
   *
   * @param voucher - Voucher fields from the settle payload.
   * @param actual - Settle-time charge, which may be below the verified amount.
   * @returns The committed channel state, or why the commit was refused.
   */
  async commitVoucher(
    voucher: BatchSettlementVoucherFields,
    actual: string,
  ): Promise<CommitOutcome> {
    const now = Date.now();
    let outcome: CommitOutcome | undefined;

    const result = await this.storage.updateChannel(voucher.channelId, current => {
      if (!current) {
        outcome = { status: "missing" };
        return current;
      }
      const pending = current.pendingRequest;
      if (!pending || pending.pendingId !== voucher.signature) {
        outcome = { status: "busy" };
        return current;
      }

      const charge = BigInt(actual);
      if (charge > BigInt(pending.verifiedAmount)) {
        outcome = { status: "over_charge", charged: actual, limit: pending.verifiedAmount };
        return { ...current, pendingRequest: undefined };
      }

      const charged = BigInt(current.chargedCumulativeAmount) + charge;
      if (charged > BigInt(voucher.maxClaimableAmount)) {
        outcome = {
          status: "over_charge",
          charged: charged.toString(),
          limit: voucher.maxClaimableAmount,
        };
        return { ...current, pendingRequest: undefined };
      }

      const committed: Channel = {
        ...current,
        chargedCumulativeAmount: charged.toString(),
        signedMaxClaimable: voucher.maxClaimableAmount,
        signature: voucher.signature,
        lastRequestTimestamp: now,
        pendingRequest: undefined,
      };
      outcome = { status: "committed", channelState: channelStateOf(committed) };
      return committed;
    });

    if (!outcome || (outcome.status === "committed" && result.status !== "updated")) {
      return { status: "busy" };
    }
    return outcome;
  }

  /**
   * Records a settled deposit: mirrors the post-deposit snapshot, stores the deposit's
   * voucher, and initialises the watermark for a channel seen for the first time.
   *
   * @param params - Channel config, deposit voucher, post-deposit snapshot, and charge.
   * @param params.channelConfig - Channel configuration from the deposit payload.
   * @param params.voucher - Voucher accompanying the deposit.
   * @param params.snapshot - Channel snapshot read after the deposit transaction.
   * @param params.actual - Amount charged for the request that carried the deposit.
   * @returns The committed channel state.
   */
  async commitDeposit(params: {
    channelConfig: ChannelConfig;
    voucher: BatchSettlementVoucherFields;
    snapshot: BatchSettlementChannelSnapshot;
    actual: string;
  }): Promise<BatchSettlementChannelStateExtra> {
    const { channelConfig, voucher, snapshot, actual } = params;
    const now = Date.now();

    const result = await this.storage.updateChannel(voucher.channelId, current => {
      const base = current?.chargedCumulativeAmount ?? snapshot.totalClaimed;
      const charged = (BigInt(base) + BigInt(actual)).toString();
      return {
        ...mirrorSnapshot(current, channelConfig, snapshot, charged, now),
        signedMaxClaimable: voucher.maxClaimableAmount,
        signature: voucher.signature,
      };
    });

    if (!result.channel) {
      throw new Error(ErrMissingChannel);
    }
    return channelStateOf(result.channel);
  }

  /**
   * Releases a reservation after a failed settlement so the channel is usable again
   * before the reservation TTL expires.
   *
   * @param channelId - Channel holding the reservation.
   * @param pendingId - Reservation identifier (the voucher signature).
   */
  async release(channelId: `0x${string}`, pendingId: string): Promise<void> {
    await this.storage.updateChannel(channelId, current => {
      if (!current || current.pendingRequest?.pendingId !== pendingId) {
        return current;
      }
      return { ...current, pendingRequest: undefined };
    });
  }
}

/**
 * Builds the channel row for a reservation or deposit commit, keeping fields the
 * facilitator owns and refreshing the mirrored onchain snapshot.
 *
 * @param current - Existing channel row, when the channel is already known.
 * @param channelConfig - Channel configuration from the payload.
 * @param snapshot - Freshly read onchain snapshot.
 * @param charged - Watermark to store.
 * @param now - Current wall-clock time in milliseconds.
 * @returns Channel row without a reservation.
 */
function mirrorSnapshot(
  current: Channel | undefined,
  channelConfig: ChannelConfig,
  snapshot: BatchSettlementChannelSnapshot,
  charged: string,
  now: number,
): Channel {
  return {
    channelId: snapshot.channelId,
    channelConfig,
    chargedCumulativeAmount: charged,
    signedMaxClaimable: current?.signedMaxClaimable ?? snapshot.totalClaimed,
    signature: current?.signature ?? "",
    balance: snapshot.balance,
    totalClaimed: snapshot.totalClaimed,
    withdrawRequestedAt: snapshot.withdrawRequestedAt,
    refundNonce: Number(snapshot.refundNonce),
    onchainSyncedAt: now,
    lastRequestTimestamp: now,
  };
}

/**
 * Projects a stored channel row onto the wire channel-state object.
 *
 * @param channel - Stored channel row.
 * @returns Channel snapshot including the facilitator's watermark.
 */
export function channelStateOf(channel: Channel): BatchSettlementChannelStateExtra {
  return {
    channelId: channel.channelId as `0x${string}`,
    balance: channel.balance,
    totalClaimed: channel.totalClaimed,
    withdrawRequestedAt: channel.withdrawRequestedAt,
    refundNonce: String(channel.refundNonce),
    chargedCumulativeAmount: channel.chargedCumulativeAmount,
  };
}

/**
 * Returns the last committed voucher, which lets a client re-synchronise after a
 * watermark mismatch. Absent until the first successful settle on the channel.
 *
 * @param channel - Stored channel row, when the channel is known.
 * @returns Voucher proof, or undefined when no voucher has been committed yet.
 */
function committedVoucherState(
  channel: Channel | undefined,
): BatchSettlementVoucherStateExtra | undefined {
  if (!channel || !channel.signature) {
    return undefined;
  }
  return {
    signedMaxClaimable: channel.signedMaxClaimable,
    signature: channel.signature as `0x${string}`,
  };
}
