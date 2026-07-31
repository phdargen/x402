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
import { parseU64, verifyOpenTransaction } from "../../payment-channels/open";
import { encodeVoucherMessageBytes, verifyVoucherSignature } from "../../payment-channels/voucher";
import { isUptoSvmPayload, type UptoSvmPayloadV2 } from "../../types";
import { createRpcClient, getStablecoinTokenProgram } from "../../utils";
import { resolveUptoSvmPaymentChannelConfig } from "../shared";
import {
  broadcastOpen,
  channelExists,
  fetchAndVerifyOpenChannel,
  simulateZeroChargeSettle,
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
 * (escrowing the ceiling before resource execution); `settle` verifies the
 * server-supplied voucher for the actual metered amount (`actual ≤ max`), then
 * `settle_and_seal` + `distribute`, refunding the remainder to the payer.
 *
 * The fee payer holds the channel `payee` seat with a zero distribution share:
 * it signs `settle_and_seal` (lifecycle authority) and can always seal an
 * abandoned channel with `has_voucher = 0` to recover its rent, while any
 * nonzero settlement still requires the server's receiver-authorizer voucher
 * (payment authority).
 *
 * Fee-payer selection matches the exact SVM facilitator: `getExtra` randomly
 * picks one of the configured signers so load is distributed across keys.
 */
export class UptoSvmScheme implements SchemeNetworkFacilitator {
  readonly scheme = "upto";
  readonly caipFamily = "solana:*";

  private readonly feePayers: ReadonlyMap<string, UptoSvmSigner>;
  private readonly feePayerAddresses: readonly string[];
  private readonly config: UptoSvmFacilitatorConfig;
  private readonly inFlightChannels = new Set<string>();
  private readonly verifiedChannels = new Map<string, VerifiedSettlementChannel>();
  private readonly reservationTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * Create the upto SVM facilitator.
   *
   * @param feePayers - One or more transaction fee payers (also channel rent
   *   payers and zero-share channel payees). `getExtra` randomly selects among them.
   * @param config - Optional RPC configuration
   */
  constructor(
    feePayers: UptoSvmSigner | readonly UptoSvmSigner[],
    config: UptoSvmFacilitatorConfig = {},
  ) {
    const list = Array.isArray(feePayers) ? feePayers : [feePayers];
    if (list.length === 0) {
      throw new Error("UptoSvmScheme requires at least one fee payer signer");
    }
    const byAddress = new Map<string, UptoSvmSigner>();
    for (const signer of list) {
      byAddress.set(signer.address, signer);
    }
    this.feePayers = byAddress;
    this.feePayerAddresses = [...byAddress.keys()];
    this.config = config;
  }

  /**
   * Advertise a randomly selected fee payer for payment-channel opens.
   * Random selection distributes load across multiple signers (same as exact).
   *
   * @param _ - The network identifier (unused)
   * @returns Extra metadata folded into the requirement's `extra`
   */
  getExtra(_: Network): Record<string, unknown> | undefined {
    const randomIndex = Math.floor(Math.random() * this.feePayerAddresses.length);
    return { feePayer: this.feePayerAddresses[randomIndex] };
  }

  /**
   * Signer addresses managed by this facilitator.
   *
   * @param _ - The network identifier (unused)
   * @returns Unique fee-payer addresses
   */
  getSigners(_: string): string[] {
    return [...this.feePayerAddresses];
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

    const feePayer = channelConfig.feePayer;
    const feePayerSigner = this.resolveFeePayer(feePayer);
    if (!feePayerSigner) {
      return { isValid: false, invalidReason: "facilitator_mismatch", payer: p.from };
    }
    const receiverAuthorizer = channelConfig.receiverAuthorizer;
    if (p.receiverAuthorizer !== receiverAuthorizer) {
      return {
        isValid: false,
        invalidReason: "invalid_upto_svm_payload_receiver_authorizer",
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

    const rpc = createRpcClient(requirements.network, this.config.rpcUrl);
    let openSlot: bigint;
    let recentSlot: bigint;
    let nonce: bigint;
    try {
      openSlot = parseU64(p.openSlot, "payload.openSlot");
      nonce = parseU64(p.nonce, "payload.nonce");
      if (requirements.extra?.recentSlot !== undefined && requirements.extra?.recentSlot !== null) {
        recentSlot = parseU64(
          requirements.extra.recentSlot as bigint | number | string,
          "requirements.extra.recentSlot",
        );
      } else {
        recentSlot = await rpc.getSlot().send();
      }
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

    const tokenProgram =
      (requirements.extra?.tokenProgram as string | undefined) ??
      getStablecoinTokenProgram(requirements.asset, requirements.network);

    // Validate the open instruction against the pinned requirements.
    try {
      const open = await verifyOpenTransaction(p.openTransaction, {
        authorizedSigner: receiverAuthorizer,
        feePayer,
        from: p.from,
        maxCap: maxAmount,
        mint: requirements.asset,
        openSlot,
        payee: feePayer,
        recentSlot,
        recipients: channelConfig.splits,
        tokenProgram,
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

    // Escrow the ceiling before resource execution: broadcast the open when
    // needed, then bind the confirmed onchain account to the challenge and
    // simulate the zero-charge settlement path.
    try {
      if (!(await channelExists(rpc, p.channelId))) {
        await broadcastOpen(feePayerSigner, rpc, p.openTransaction);
      }
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
      await simulateZeroChargeSettle(feePayerSigner, rpc, {
        channelId: channel.channelId,
        mint: channel.mint,
        payee: channel.payee,
        payer: channel.payer,
        rentPayer: channel.rentPayer,
        splits: channel.splits,
        tokenProgram,
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
   * channel: verify the server voucher + settle_and_seal + distribute,
   * refunding the remainder. `actual === 0` still seals (full refund) after
   * verifying the zero-amount voucher authenticates the settle request.
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

    let channelConfig: ReturnType<typeof resolveUptoSvmPaymentChannelConfig>;
    try {
      channelConfig = resolveUptoSvmPaymentChannelConfig(requirements);
    } catch (error) {
      this.inFlightChannels.delete(p.channelId);
      return {
        success: false,
        network: payload.accepted.network,
        transaction: "",
        errorReason: "invalid_upto_svm_payment_requirements",
        errorMessage: error instanceof Error ? error.message : String(error),
        payer: p.from,
      };
    }

    if (
      p.receiverAuthorizer !== channelConfig.receiverAuthorizer ||
      p.receiverAuthorizer !== verifiedChannel.authorizedSigner
    ) {
      this.inFlightChannels.delete(p.channelId);
      return {
        success: false,
        network: payload.accepted.network,
        transaction: "",
        errorReason: "invalid_upto_svm_payload_receiver_authorizer",
        payer: p.from,
      };
    }

    if (typeof p.voucherSignature !== "string" || p.voucherSignature.length === 0) {
      this.inFlightChannels.delete(p.channelId);
      return {
        success: false,
        network: payload.accepted.network,
        transaction: "",
        errorReason: "invalid_upto_svm_payload_missing_voucher",
        payer: p.from,
      };
    }

    const voucherMessage = encodeVoucherMessageBytes({
      channelId: verifiedChannel.channelId,
      cumulativeAmount: actual,
      expiresAt: verifiedChannel.expiresAt,
    });
    let voucherOk: boolean;
    try {
      voucherOk = await verifyVoucherSignature({
        message: voucherMessage,
        signatureBase58: p.voucherSignature,
        signerBase58: p.receiverAuthorizer,
      });
    } catch {
      this.inFlightChannels.delete(p.channelId);
      return {
        success: false,
        network: payload.accepted.network,
        transaction: "",
        errorReason: "invalid_upto_svm_payload_voucher_signature",
        payer: p.from,
      };
    }
    if (!voucherOk) {
      this.inFlightChannels.delete(p.channelId);
      return {
        success: false,
        network: payload.accepted.network,
        transaction: "",
        errorReason: "invalid_upto_svm_payload_voucher_signature",
        payer: p.from,
      };
    }

    const feePayerSigner = this.resolveFeePayer(verifiedChannel.payee);
    if (!feePayerSigner) {
      this.inFlightChannels.delete(p.channelId);
      return {
        success: false,
        network: payload.accepted.network,
        transaction: "",
        errorReason: "facilitator_mismatch",
        payer: p.from,
      };
    }

    try {
      // Program requires settled < cumulative_amount, so has_voucher only when actual > 0.
      // The zero-amount voucher still authenticated the settle request above.
      const settle = buildSettleAndSealInstructions({
        channelId: verifiedChannel.channelId,
        payeeSigner: feePayerSigner,
        voucher:
          actual > 0n
            ? {
                authorizedSigner: verifiedChannel.authorizedSigner,
                cumulativeAmount: actual,
                expiresAt: verifiedChannel.expiresAt,
                signatureBase58: p.voucherSignature,
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
      const signature = await submitSettle(feePayerSigner, rpc, instructions);

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
   * Resolve the configured signer for a fee-payer address.
   *
   * @param address - Fee-payer address from the challenge
   * @returns The matching signer, or undefined when not managed
   */
  private resolveFeePayer(address: string): UptoSvmSigner | undefined {
    return this.feePayers.get(address);
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
