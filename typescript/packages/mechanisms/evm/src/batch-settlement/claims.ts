import type { Channel } from "./storage";
import type { BatchSettlementVoucherClaim } from "./types";

export type ClaimSelectionOptions = {
  /** Only include channels whose last paid request is at least this old. */
  idleSecs?: number;
  now?: number;
};

/**
 * Returns the channels whose committed charges are ahead of what has been claimed onchain.
 *
 * Shared by the server channel manager and the facilitator voucher-store manager: both
 * claim against the same `Channel` shape, only the transport and grouping differ.
 *
 * @param channels - Channel records to inspect.
 * @param opts - Optional idle filter and clock override.
 * @returns Channels with an outstanding claimable amount.
 */
export function selectClaimableChannels(
  channels: Channel[],
  opts: ClaimSelectionOptions = {},
): Channel[] {
  const now = opts.now ?? Date.now();
  return channels.filter(channel => {
    if (BigInt(channel.chargedCumulativeAmount) <= BigInt(channel.totalClaimed)) {
      return false;
    }
    if (opts.idleSecs !== undefined && now - channel.lastRequestTimestamp < opts.idleSecs * 1000) {
      return false;
    }
    return true;
  });
}

/**
 * Builds the onchain claim row for a channel from its latest signed voucher.
 *
 * @param channel - Channel record holding the voucher and committed charge.
 * @returns Claim row for `claim` / `claimWithSignature`.
 */
export function buildClaimRow(channel: Channel): BatchSettlementVoucherClaim {
  return {
    voucher: {
      channel: channel.channelConfig,
      maxClaimableAmount: channel.signedMaxClaimable,
    },
    signature: channel.signature as `0x${string}`,
    totalClaimed: channel.chargedCumulativeAmount,
  };
}

/**
 * Collects claim rows for every channel with an outstanding claimable amount.
 *
 * @param channels - Channel records to inspect.
 * @param opts - Optional idle filter and clock override.
 * @returns Claim rows ready for batch submission.
 */
export function buildClaimRows(
  channels: Channel[],
  opts: ClaimSelectionOptions = {},
): BatchSettlementVoucherClaim[] {
  return selectClaimableChannels(channels, opts).map(buildClaimRow);
}

/**
 * Reports whether a channel's timed withdrawal is close enough to finalizing that its
 * vouchers must be claimed first. Unclaimed vouchers become unclaimable once
 * `finalizeWithdraw()` reduces the channel balance.
 *
 * @param channel - Channel record to inspect.
 * @param urgencyRatio - Fraction of the withdraw delay after which claiming is urgent.
 * @param now - Current wall-clock time in milliseconds.
 * @returns Whether the channel should be claimed ahead of the others.
 */
export function isWithdrawUrgent(channel: Channel, urgencyRatio: number, now: number): boolean {
  if (channel.withdrawRequestedAt <= 0) {
    return false;
  }
  const urgentAtSecs =
    channel.withdrawRequestedAt + channel.channelConfig.withdrawDelay * urgencyRatio;
  return now / 1000 >= urgentAtSecs;
}
