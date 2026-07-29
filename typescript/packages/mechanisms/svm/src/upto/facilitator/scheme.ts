import type {
  Network,
  PaymentPayload,
  PaymentRequirements,
  SchemeNetworkFacilitator,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";

import {
  buildDistributeInstruction,
  buildSettleAndSealInstructions,
  type ServerInstruction,
} from "../../payment-channels/onchain";
import {
  DEFAULT_GRACE_PERIOD_SECONDS,
  parseU64,
  verifyOpenTransaction,
} from "../../payment-channels/open";
import { isUptoSvmPayload, type UptoSvmPayloadV2 } from "../../types";
import { createRpcClient, getStablecoinTokenProgram } from "../../utils";
import { resolveUptoSvmPaymentChannelConfig } from "../shared";
import {
  broadcastOpen,
  channelExists,
  fetchAndVerifyOpenChannel,
  signVoucher,
  submitSettle,
  type UptoSvmSigner,
  type VerifiedOpenChannel,
} from "./channel";

/** Scheme-specific error returned when the settlement amount exceeds the ceiling. */
export const ERR_SETTLEMENT_EXCEEDS_AMOUNT = "invalid_upto_svm_payload_settlement_exceeds_amount";

/** Optional configuration for the upto SVM facilitator. */
export interface UptoSvmFacilitatorConfig {
  /** Custom RPC URL (per-network defaults are used when omitted). */
  rpcUrl?: string;
  /** Forced-close grace period advertised as `extra.withdrawDelay`. */
  withdrawDelay?: number;
}

interface VerifiedSettlementChannel extends VerifiedOpenChannel {
  expiresAt: bigint;
  maxAmount: bigint;
  network: Network;
  tokenProgram: string;
}

/**
 * SVM facilitator for the `upto` payment scheme.
 *
 * `verify` validates the client authorization and broadcasts the channel `open`
 * (escrowing the ceiling before the resource is served); `settle` signs a single
 * receiver-authorizer voucher for the actual metered amount (`actual ≤ max`),
 * then `settle_and_seal` + `distribute`, refunding the remainder to the payer.
 *
 * The fee payer holds the channel `payee` seat with a zero distribution share:
 * it signs `settle_and_seal` (lifecycle authority) and can always seal an
 * abandoned channel with `has_voucher = 0` to recover its rent, while any
 * nonzero settlement still requires the receiver authorizer's voucher
 * (payment authority).
 *
 * Unlike the exact scheme's minimal `FacilitatorSvmSigner`, this facilitator
 * needs a fee-payer signer for transactions/close authorization and a
 * receiver-authorizer signer for vouchers, so it takes Solana signers directly.
 */
export class UptoSvmScheme implements SchemeNetworkFacilitator {
  readonly scheme = "upto";
  readonly caipFamily = "solana:*";

  private readonly feePayer: UptoSvmSigner;
  private readonly receiverAuthorizer: UptoSvmSigner;
  private readonly config: UptoSvmFacilitatorConfig;
  private readonly inFlightChannels = new Set<string>();
  private readonly verifiedChannels = new Map<string, VerifiedSettlementChannel>();
  private readonly reservationTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * Create the upto SVM facilitator.
   *
   * @param feePayer - Transaction fee payer, channel rent payer, and zero-share channel payee
   * @param receiverAuthorizer - Voucher signer. Defaults to `feePayer` for self-facilitation.
   * @param config - Optional RPC configuration
   */
  constructor(
    feePayer: UptoSvmSigner,
    receiverAuthorizer?: UptoSvmSigner,
    config: UptoSvmFacilitatorConfig = {},
  ) {
    this.feePayer = feePayer;
    this.receiverAuthorizer = receiverAuthorizer ?? feePayer;
    this.config = config;
  }

  /**
   * Advertise the fee payer and receiver authorizer for payment-channel opens.
   *
   * @param _ - The network identifier (unused)
   * @returns Extra metadata folded into the requirement's `extra`
   */
  getExtra(_: Network): Record<string, unknown> | undefined {
    return {
      feePayer: this.feePayer.address,
      receiverAuthorizer: this.receiverAuthorizer.address,
      withdrawDelay: this.config.withdrawDelay ?? DEFAULT_GRACE_PERIOD_SECONDS,
    };
  }

  /**
   * Signer addresses managed by this facilitator.
   *
   * @param _ - The network identifier (unused)
   * @returns Unique signer addresses
   */
  getSigners(_: string): string[] {
    return [...new Set([this.feePayer.address, this.receiverAuthorizer.address])];
  }

  /**
   * Verify the authorization and broadcast the channel open (idempotently).
   *
   * `requirements.amount` is treated as the authorized ceiling here.
   *
   * @param payload - The payment payload
   * @param requirements - The payment requirements (amount = ceiling)
   * @returns The verification response
   */
  async verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    const raw = payload.payload as Record<string, unknown>;
    if (!isUptoSvmPayload(raw)) {
      return { isValid: false, invalidReason: "unsupported_payload_type", payer: "" };
    }
    const p: UptoSvmPayloadV2 = raw;

    if (payload.accepted.scheme !== "upto" || requirements.scheme !== "upto") {
      return { isValid: false, invalidReason: "unsupported_scheme", payer: p.from };
    }
    if (payload.accepted.network !== requirements.network) {
      return { isValid: false, invalidReason: "network_mismatch", payer: p.from };
    }

    let channelConfig: ReturnType<typeof resolveUptoSvmPaymentChannelConfig>;
    try {
      channelConfig = resolveUptoSvmPaymentChannelConfig(requirements);
    } catch (error) {
      return {
        isValid: false,
        invalidReason: "invalid_upto_svm_payment_requirements",
        invalidMessage: error instanceof Error ? error.message : String(error),
        payer: p.from,
      };
    }

    const feePayer = this.feePayer.address;
    const receiverAuthorizer = this.receiverAuthorizer.address;
    if (channelConfig.feePayer !== feePayer) {
      return { isValid: false, invalidReason: "facilitator_mismatch", payer: p.from };
    }
    if (channelConfig.receiverAuthorizer !== receiverAuthorizer) {
      return {
        isValid: false,
        invalidReason: "invalid_upto_svm_receiver_authorizer_mismatch",
        payer: p.from,
      };
    }
    if (p.authorizedSigner !== receiverAuthorizer) {
      return {
        isValid: false,
        invalidReason: "invalid_upto_svm_payload_authorized_signer",
        payer: p.from,
      };
    }

    // Ceiling: the signed maxAmount must equal the verification-phase amount.
    let maxAmount: bigint;
    let deposit: bigint;
    try {
      maxAmount = BigInt(p.maxAmount);
      deposit = BigInt(p.deposit);
    } catch {
      return { isValid: false, invalidReason: "invalid_upto_svm_payload_amount", payer: p.from };
    }
    if (maxAmount !== BigInt(requirements.amount)) {
      return {
        isValid: false,
        invalidReason: "invalid_upto_svm_payload_amount_mismatch",
        payer: p.from,
      };
    }
    if (deposit !== maxAmount) {
      return {
        isValid: false,
        invalidReason: "invalid_upto_svm_payload_deposit_not_ceiling",
        payer: p.from,
      };
    }
    let openSlot: bigint;
    let recentSlot: bigint;
    let nonce: bigint;
    try {
      openSlot = parseU64(p.openSlot, "payload.openSlot");
      recentSlot = parseU64(
        requirements.extra?.recentSlot as bigint | number | string,
        "requirements.extra.recentSlot",
      );
      nonce = parseU64(p.nonce, "payload.nonce");
    } catch {
      return {
        isValid: false,
        invalidReason: "invalid_upto_svm_payload_channel_seed",
        payer: p.from,
      };
    }

    const now = Math.floor(Date.now() / 1000);
    if (now < p.validAfter) {
      return {
        isValid: false,
        invalidReason: "invalid_upto_svm_payload_not_yet_active",
        payer: p.from,
      };
    }
    if (p.expiresAt === 0 || now >= p.expiresAt) {
      return { isValid: false, invalidReason: "invalid_upto_svm_payload_expired", payer: p.from };
    }

    // Validate the open instruction against the pinned requirements.
    try {
      const open = await verifyOpenTransaction(p.openTransaction, {
        authorizedSigner: receiverAuthorizer,
        feePayer,
        maxCap: maxAmount,
        mint: requirements.asset,
        openSlot,
        payee: feePayer,
        recentSlot,
        recipients: channelConfig.splits,
        tokenProgram:
          (requirements.extra?.tokenProgram as string | undefined) ??
          getStablecoinTokenProgram(requirements.asset, requirements.network),
        withdrawDelay: channelConfig.withdrawDelay,
      });
      if (open.channelId !== p.channelId) {
        return {
          isValid: false,
          invalidReason: "invalid_upto_svm_payload_channel_id",
          invalidMessage: `open channel ${open.channelId} != payload.channelId ${p.channelId}`,
          payer: p.from,
        };
      }
      if (open.salt !== nonce) {
        return {
          isValid: false,
          invalidReason: "invalid_upto_svm_payload_nonce",
          invalidMessage: `open salt ${open.salt} != payload.nonce ${p.nonce}`,
          payer: p.from,
        };
      }
      // Bind the channel payer to `payload.from`: settlement builds the
      // distribute (refund) instruction from `p.from`, so a mismatch with the
      // open transaction's payer would make settlement fail onchain.
      if (open.payer !== p.from) {
        return {
          isValid: false,
          invalidReason: "invalid_upto_svm_payload_payer_mismatch",
          invalidMessage: `open payer ${open.payer} != payload.from ${p.from}`,
          payer: p.from,
        };
      }
    } catch (error) {
      return {
        isValid: false,
        invalidReason: "invalid_upto_svm_payload_open_transaction",
        invalidMessage: error instanceof Error ? error.message : String(error),
        payer: p.from,
      };
    }

    if (this.inFlightChannels.has(p.channelId)) {
      return {
        isValid: false,
        invalidReason: "invalid_upto_svm_payload_channel_in_flight",
        invalidMessage: "channel is already being processed",
        payer: p.from,
      };
    }
    this.inFlightChannels.add(p.channelId);

    // Escrow the ceiling before the resource is served: broadcast the open
    // when needed, then bind the confirmed onchain account to the challenge.
    try {
      const rpc = createRpcClient(requirements.network, this.config.rpcUrl);
      if (!(await channelExists(rpc, p.channelId))) {
        await broadcastOpen(this.feePayer, rpc, p.openTransaction);
      }
      const tokenProgram =
        (requirements.extra?.tokenProgram as string | undefined) ??
        getStablecoinTokenProgram(requirements.asset, requirements.network);
      const channel = await fetchAndVerifyOpenChannel(rpc, p.channelId, {
        authorizedSigner: receiverAuthorizer,
        deposit: maxAmount,
        gracePeriod: channelConfig.withdrawDelay,
        mint: requirements.asset,
        payee: feePayer,
        payer: p.from,
        rentPayer: feePayer,
        splits: channelConfig.splits,
      });
      const verifiedChannel = {
        ...channel,
        expiresAt: BigInt(p.expiresAt),
        maxAmount,
        network: requirements.network,
        tokenProgram,
      };
      this.verifiedChannels.set(p.channelId, verifiedChannel);
      this.scheduleReservationExpiry(p.channelId, verifiedChannel, p.expiresAt);
    } catch (error) {
      this.inFlightChannels.delete(p.channelId);
      return {
        isValid: false,
        invalidReason: "upto_channel_open_failed",
        invalidMessage: error instanceof Error ? error.message : String(error),
        payer: p.from,
      };
    }

    return { isValid: true, invalidReason: undefined, payer: p.from };
  }

  /**
   * Settle the actual metered amount (`requirements.amount`) against the open
   * channel: receiver-authorizer voucher + settle_and_seal + distribute,
   * refunding the remainder. `actual === 0` still seals (full refund).
   *
   * @param payload - The payment payload
   * @param requirements - The payment requirements (amount = actual charge)
   * @returns The settlement response
   */
  async settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    const raw = payload.payload as Record<string, unknown>;
    if (!isUptoSvmPayload(raw)) {
      return {
        success: false,
        network: payload.accepted.network,
        transaction: "",
        errorReason: "unsupported_payload_type",
        payer: "",
      };
    }
    const p: UptoSvmPayloadV2 = raw;
    const verifiedChannel = this.verifiedChannels.get(p.channelId);
    if (verifiedChannel) {
      // Consume atomically so two settle calls cannot race the same verified open.
      this.verifiedChannels.delete(p.channelId);
      const timer = this.reservationTimers.get(p.channelId);
      if (timer !== undefined) clearTimeout(timer);
      this.reservationTimers.delete(p.channelId);
    }

    // Enforce actual ≤ ceiling first, against the signed `maxAmount` (never the
    // settlement-phase `amount`). Checked before any RPC work.
    let actual: bigint;
    let payloadMaxAmount: bigint;
    try {
      actual = BigInt(requirements.amount);
      payloadMaxAmount = BigInt(p.maxAmount);
    } catch {
      this.inFlightChannels.delete(p.channelId);
      return {
        success: false,
        network: payload.accepted.network,
        transaction: "",
        errorReason: "invalid_upto_svm_payload_amount",
        payer: p.from,
      };
    }
    if (actual < 0n) {
      this.inFlightChannels.delete(p.channelId);
      return {
        success: false,
        network: payload.accepted.network,
        transaction: "",
        errorReason: "invalid_upto_svm_payload_amount",
        payer: p.from,
      };
    }
    if (
      actual > payloadMaxAmount ||
      (verifiedChannel !== undefined && actual > verifiedChannel.maxAmount)
    ) {
      this.inFlightChannels.delete(p.channelId);
      return {
        success: false,
        network: payload.accepted.network,
        transaction: "",
        errorReason: ERR_SETTLEMENT_EXCEEDS_AMOUNT,
        payer: p.from,
      };
    }

    if (!verifiedChannel) {
      this.inFlightChannels.delete(p.channelId);
      return {
        success: false,
        network: payload.accepted.network,
        transaction: "",
        errorReason: "invalid_upto_svm_payload_channel_not_verified",
        payer: p.from,
      };
    }

    try {
      const settle = buildSettleAndSealInstructions({
        channelId: verifiedChannel.channelId,
        payeeSigner: this.feePayer,
        voucher:
          actual > 0n
            ? {
                authorizedSigner: this.receiverAuthorizer.address,
                cumulativeAmount: actual,
                expiresAt: verifiedChannel.expiresAt,
                signatureBase58: await signVoucher(this.receiverAuthorizer, {
                  channelId: verifiedChannel.channelId,
                  cumulativeAmount: actual,
                  expiresAt: verifiedChannel.expiresAt,
                }),
              }
            : undefined,
      });

      const distribute = await buildDistributeInstruction({
        channelId: verifiedChannel.channelId,
        mint: verifiedChannel.mint,
        payee: verifiedChannel.payee,
        payer: verifiedChannel.payer,
        rentPayer: verifiedChannel.rentPayer,
        splits: verifiedChannel.splits,
        tokenProgram: verifiedChannel.tokenProgram,
      });

      const instructions: ServerInstruction[] = [...settle, distribute];
      const rpc = createRpcClient(verifiedChannel.network, this.config.rpcUrl);
      const signature = await submitSettle(this.feePayer, rpc, instructions);

      return {
        success: true,
        transaction: signature,
        network: verifiedChannel.network,
        amount: actual.toString(),
        payer: verifiedChannel.payer,
      };
    } catch (error) {
      return {
        success: false,
        network: payload.accepted.network,
        transaction: "",
        errorReason: "transaction_failed",
        errorMessage: error instanceof Error ? error.message : String(error),
        payer: p.from,
      };
    } finally {
      this.inFlightChannels.delete(p.channelId);
    }
  }

  /**
   * Release an abandoned verify reservation when its signed voucher window
   * expires. Rust carries an RAII guard through settlement; the split
   * verify/settle TypeScript interface needs an explicit equivalent.
   *
   * @param channelId - Reserved channel
   * @param channel - Exact verified state associated with the reservation
   * @param expiresAt - Payload expiry as Unix seconds
   */
  private scheduleReservationExpiry(
    channelId: string,
    channel: VerifiedSettlementChannel,
    expiresAt: number,
  ): void {
    const delayMs = Math.max(0, Math.min(2_147_483_647, expiresAt * 1_000 - Date.now()));
    const timer = setTimeout(() => {
      if (this.verifiedChannels.get(channelId) !== channel) return;
      this.verifiedChannels.delete(channelId);
      this.inFlightChannels.delete(channelId);
      this.reservationTimers.delete(channelId);
    }, delayMs);

    if (
      typeof timer === "object" &&
      "unref" in timer &&
      typeof (timer as { unref?: unknown }).unref === "function"
    ) {
      (timer as { unref: () => void }).unref();
    }
    this.reservationTimers.set(channelId, timer);
  }
}
