/**
 * Server-authored cooperative close of a `Closing` channel (`type: "seal"`).
 *
 * Once a payer calls `request_close`, program `settle` is unavailable and only
 * the channel `payee` (the facilitator) can apply a final voucher through
 * `settle_and_seal` during the grace period. Without this path a server that
 * was serving requests a minute ago has no way to collect vouchers above the
 * onchain watermark once the payer walks. The server proves it authored the
 * request with a `CloseAuthorization` signed by the receiver authorizer bound
 * to the channel at its first deposit, so a payer holding a stale voucher
 * cannot freeze the watermark low.
 */

import type {
  Network,
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
} from "@x402/core/types";

import type { Channel } from "../../payment-channels/generated/accounts/channel";
import {
  buildSettleAndSealInstructions,
  ChannelStatus,
  type ServerInstruction,
} from "../../payment-channels/onchain";
import { parseU64 } from "../../payment-channels/open";
import type { PaymentChannelRecord, PaymentChannelStorage } from "../../payment-channels/storage";
import { encodeVoucherMessageBytes, verifyVoucherSignature } from "../../payment-channels/voucher";
import type { SettlementCache } from "../../settlement-cache";
import type { FacilitatorSigningCapabilities } from "../../signer";
import { verifyCloseAuthorization } from "../closeAuthorization";
import { BatchError } from "../errors";
import type { BatchChannelConfig, BatchSealPayload } from "../types";
import type { BatchPendingSettlementStore } from "./recovery";
import { CHANNEL_BUSY, sealResponse, settleFailure, settlementPending } from "./responses";

/** The terms the scheme resolved from `PaymentRequirements`, as `seal` needs them. */
export interface SealTerms {
  feePayer: string;
  feePayerSigner: FacilitatorSigningCapabilities;
  receiverAuthorizer?: string | undefined;
  tokenProgram: string;
}

/** Scheme internals the seal path borrows, so it can live outside the scheme file. */
export interface SealDependencies {
  channelStorage: PaymentChannelStorage;
  pendingStore: BatchPendingSettlementStore;
  settlementCache: SettlementCache;
  /** Facilitator-registered receiver authorizers by `payTo`, for channels with no stored binding. */
  trustedReceiverAuthorizers?: Readonly<Record<string, readonly string[]>> | undefined;
  resolveTerms(config: BatchChannelConfig, requirements: PaymentRequirements): Promise<SealTerms>;
  deriveChannelId(config: BatchChannelConfig, feePayer: string): Promise<string>;
  fetchChannel(network: string, channelId: string): Promise<Channel>;
  readChannel(network: string, channelId: string): Promise<Channel | undefined>;
  assertClaimChannel(
    channel: Channel,
    config: BatchChannelConfig,
    terms: SealTerms,
    requirements: PaymentRequirements,
    allowedStatuses: readonly ChannelStatus[],
  ): void;
  distributeInstruction(
    channelId: string,
    channel: Channel,
    terms: SealTerms,
    requirements: PaymentRequirements,
  ): Promise<ServerInstruction>;
  submitRedemption(
    feePayer: string,
    network: Network,
    instructions: readonly ServerInstruction[],
    key: string,
    payer: string,
  ): Promise<
    { ok: true; replayed: boolean; signature: string } | { ok: false; response: SettleResponse }
  >;
  completeOrPending(
    key: string,
    signature: string,
    network: Network,
    payer: string,
  ): Promise<SettleResponse | undefined>;
  trackChannel(record: Omit<PaymentChannelRecord, "firstSeenAt" | "lastActivityAt">): Promise<void>;
  nowSeconds(): number;
}

/**
 * Reject a `Closing` channel with the dedicated code, so a server can tell
 * "the payer started a forced close, retry with `seal`" from every other
 * channel-state mismatch (spec 4.5).
 *
 * @param channel - Decoded channel account
 * @param channelId - Channel PDA, for the message
 */
export function assertNotClosing(channel: Channel, channelId: string): void {
  if (channel.status === ChannelStatus.Closing) {
    throw new Error(
      `${BatchError.CHANNEL_CLOSING}: ${channelId} is closing; apply the final voucher with a seal payload`,
    );
  }
}

/**
 * Apply the server's latest voucher to a `Closing` channel with
 * `settle_and_seal` and pay out with a sealed `distribute`, in one
 * transaction, before the payer's grace period ends.
 *
 * @param deps - Scheme internals
 * @param payment - The settle request envelope
 * @param payload - The `seal` payload
 * @param requirements - The server's requirements for the channel
 * @returns The settle response
 */
export async function settleSeal(
  deps: SealDependencies,
  payment: PaymentPayload,
  payload: BatchSealPayload,
  requirements: PaymentRequirements,
): Promise<SettleResponse> {
  const network = requirements.network;
  const payer = payload.channelConfig.payer;
  const terms = await deps.resolveTerms(payload.channelConfig, requirements);
  const channelId = await deps.deriveChannelId(payload.channelConfig, terms.feePayer);
  if (channelId !== payload.channelId || channelId !== payload.voucher.channelId) {
    throw new Error(BatchError.CHANNEL_ID_MISMATCH);
  }
  if (payload.voucher.expiresAt !== 0) throw new Error(BatchError.VOUCHER_EXPIRY);
  const cumulative = parseU64(payload.voucher.maxClaimableAmount, "maxClaimableAmount");
  const validVoucher = await verifyVoucherSignature({
    message: encodeVoucherMessageBytes({ channelId, cumulativeAmount: cumulative, expiresAt: 0n }),
    signatureBase58: payload.voucher.signature,
    signerBase58: payload.channelConfig.payerAuthorizer,
  });
  if (!validVoucher) throw new Error(BatchError.VOUCHER_SIGNATURE);

  await authenticateServer(deps, payload, requirements, terms, channelId, cumulative);

  // Namespace from spec Phase 5: ("close", channelId, maxClaimableAmount).
  const key = `batch:seal:${network}:${channelId}:${cumulative}`;
  const previous = await deps.pendingStore.get(`${key}:result`);
  if (previous) return JSON.parse(previous) as SettleResponse;

  const channel = await deps.fetchChannel(network, channelId);
  if (channel.status !== ChannelStatus.Closing) {
    throw new Error(
      `${BatchError.CLOSE_STATE}: seal applies only to a Closing channel; observed status ${channel.status}`,
    );
  }
  deps.assertClaimChannel(channel, payload.channelConfig, terms, requirements, [
    ChannelStatus.Closing,
  ]);
  const deadline = channel.closureStartedAt + BigInt(channel.gracePeriod);
  if (BigInt(deps.nowSeconds()) >= deadline) {
    throw new Error(
      `${BatchError.CLOSE_STATE}: grace period elapsed; the permissionless seal path applies`,
    );
  }
  const settled = channel.settlement.settled;
  if (cumulative < settled || cumulative > channel.deposit) {
    throw new Error(
      `${BatchError.CLOSE_STATE}: voucher ${cumulative} must lie within settled ${settled} and deposit ${channel.deposit}`,
    );
  }
  // An equal voucher would fail the program's strict monotonicity check, so
  // the channel is sealed at its current watermark instead (spec 4.5).
  const instructions: ServerInstruction[] = [
    ...buildSettleAndSealInstructions({
      channelId,
      payeeSigner: terms.feePayerSigner,
      ...(cumulative > settled
        ? {
            voucher: {
              authorizedSigner: payload.channelConfig.payerAuthorizer,
              cumulativeAmount: cumulative,
              expiresAt: 0n,
              signatureBase58: payload.voucher.signature,
            },
          }
        : {}),
    }),
    await deps.distributeInstruction(channelId, channel, terms, requirements),
  ];
  if (deps.settlementCache.isDuplicate(key)) {
    return settleFailure(payment.accepted.network, CHANNEL_BUSY, payer);
  }
  const submitted = await deps.submitRedemption(terms.feePayer, network, instructions, key, payer);
  if (!submitted.ok) return submitted.response;

  // The sealed distribute may deallocate the PDA outright; a still-Closing
  // read means the confirmed state is not visible yet.
  const observed = await deps.readChannel(network, channelId);
  if (observed && observed.status === ChannelStatus.Closing) {
    return settlementPending(
      network,
      payer,
      submitted.signature,
      "seal confirmed but the sealed state is not visible yet",
    );
  }
  const incomplete = await deps.completeOrPending(key, submitted.signature, network, payer);
  if (incomplete) return incomplete;

  const response = sealResponse({
    channelId,
    deposit: channel.deposit,
    finalSettled: cumulative,
    network,
    paidToReceiver: cumulative - channel.settlement.payoutWatermark,
    payer,
    transaction: submitted.signature,
  });
  await deps.pendingStore.set(`${key}:result`, JSON.stringify(response));
  // A confirmed seal is facilitator-visible activity; cleanup will find the
  // PDA gone or Distributed and reclaim rent from there.
  await deps.trackChannel({
    channelId,
    expiresAt: 0,
    network,
    payTo: requirements.payTo,
    tokenProgram: terms.tokenProgram,
  });
  return response;
}

/**
 * Bind the request to the server through its `CloseAuthorization`.
 *
 * The key it must verify against is the receiver authorizer recorded at the
 * channel's first deposit, or a facilitator-registered key for `payTo`. A key
 * that merely appears in the request is never trusted on its own (spec §3).
 *
 * @param deps - Scheme internals
 * @param payload - The `seal` payload
 * @param requirements - The server's requirements
 * @param terms - Resolved terms
 * @param channelId - Channel PDA
 * @param cumulative - Final voucher amount the authorization must bind
 */
async function authenticateServer(
  deps: SealDependencies,
  payload: BatchSealPayload,
  requirements: PaymentRequirements,
  terms: SealTerms,
  channelId: string,
  cumulative: bigint,
): Promise<void> {
  const record = await deps.channelStorage.get(channelId);
  const registered = deps.trustedReceiverAuthorizers?.[requirements.payTo] ?? [];
  const trusted = record?.receiverAuthorizer ? [record.receiverAuthorizer] : registered;
  if (trusted.length === 0) {
    throw new Error(
      `${BatchError.CLOSE_AUTHORIZATION}: no receiver authorizer is bound to ${channelId}`,
    );
  }
  if (terms.receiverAuthorizer !== undefined && !trusted.includes(terms.receiverAuthorizer)) {
    throw new Error(
      `${BatchError.RECEIVER_AUTHORIZER_MISMATCH}: advertised key is not the channel's trusted binding`,
    );
  }
  if (!payload.closeAuthorization) {
    throw new Error(`${BatchError.CLOSE_AUTHORIZATION}: seal requires a closeAuthorization`);
  }
  const binding = {
    channelId,
    feePayer: terms.feePayer,
    maxClaimableAmount: cumulative,
    network: requirements.network,
    voucherExpiresAt: 0n,
  };
  const now = deps.nowSeconds();
  for (const key of trusted) {
    if (
      await verifyCloseAuthorization(
        payload.closeAuthorization,
        binding,
        key,
        requirements.maxTimeoutSeconds,
        now,
      )
    ) {
      return;
    }
  }
  throw new Error(
    `${BatchError.CLOSE_AUTHORIZATION}: signature does not bind this close or is outside its validity window`,
  );
}
