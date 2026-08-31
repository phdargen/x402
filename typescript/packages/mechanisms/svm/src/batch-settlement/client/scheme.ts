/* eslint-disable jsdoc/require-jsdoc, jsdoc/require-param-description, jsdoc/require-returns */
import { type Address } from "@solana/kit";
import { fetchMint } from "@solana-program/token-2022";
import type {
  PaymentPayload,
  PaymentRequirements,
  SchemeClientHooks,
  SchemeNetworkClient,
} from "@x402/core/types";

import { TOKEN_2022_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS } from "../../constants";
import { buildTopUpPaymentChannelTransaction, parseU64 } from "../../payment-channels/open";
import type { ClientSvmConfig } from "../../signer";
import { createRpcClient, resolveBlockhash, resolveOpenSlot } from "../../utils";
import { BATCH_SETTLEMENT_SCHEME, isBatchPayload } from "../types";
import {
  type BatchClientSigner,
  BatchChannelTracker,
  buildDepositPayload,
  buildRefundPayload,
} from "./channel";

interface OpenChannel {
  tracker: BatchChannelTracker;
  deposit: bigint;
}

type PendingChannel = OpenChannel & { key: string; cumulative: bigint };
type PaymentResponseContext = Parameters<NonNullable<SchemeClientHooks["onPaymentResponse"]>>[0];

/** A serializable, confirmed client channel allocation. */
export interface BatchClientChannelRecord {
  channelConfig: OpenChannel["tracker"]["channelConfig"];
  channelId: string;
  chargedCumulativeAmount: string;
  deposit: string;
}

/** Optional durable storage for confirmed client allocations. */
export interface BatchClientChannelStorage {
  get(key: string): Promise<BatchClientChannelRecord | undefined>;
  set(key: string, record: BatchClientChannelRecord): Promise<void>;
}

export interface BatchSvmClientConfig extends ClientSvmConfig {
  /** Deposit used for a new channel. Defaults to one request charge. */
  depositAmount?: bigint | string | undefined;
  /** Persists only PAYMENT-RESPONSE-confirmed allocation state. */
  channelStorage?: BatchClientChannelStorage | undefined;
}

export class BatchSvmScheme implements SchemeNetworkClient {
  readonly scheme = BATCH_SETTLEMENT_SCHEME;
  private readonly channels = new Map<string, OpenChannel>();
  private readonly pending = new Map<string, PendingChannel>();

  readonly schemeHooks: SchemeClientHooks = {
    onPaymentResponse: async ctx => {
      await this.handlePaymentResponse(ctx);
    },
  };

  constructor(
    private readonly signer: BatchClientSigner,
    private readonly config: BatchSvmClientConfig = {},
  ) {}

  async createPaymentPayload(
    x402Version: number,
    requirements: PaymentRequirements,
  ): Promise<Pick<PaymentPayload, "x402Version" | "payload">> {
    const terms = await this.resolveTerms(requirements);
    const charge = parseU64(requirements.amount, "amount");
    if (charge === 0n) throw new Error("batch-settlement amount must be positive");
    const key = this.channelKey(requirements, terms.feePayer, terms.withdrawDelay);
    const existing = await this.loadChannel(key);
    if (this.pending.has(key)) {
      throw new Error(
        "batch-settlement channel has an unconfirmed request; wait for PAYMENT-RESPONSE",
      );
    }
    if (existing) {
      const cumulative = existing.tracker.cumulative + charge;
      const voucher = await existing.tracker.previewVoucher(charge);
      if (cumulative <= existing.deposit) {
        this.pending.set(key, { ...existing, cumulative, key });
        return {
          x402Version,
          payload: { channelConfig: existing.tracker.channelConfig, type: "voucher", voucher },
        };
      }
      const configured = this.config.depositAmount
        ? parseU64(this.config.depositAmount, "depositAmount")
        : charge;
      const topUpAmount =
        configured >= cumulative - existing.deposit ? configured : cumulative - existing.deposit;
      const rpc = createRpcClient(requirements.network, this.config.rpcUrl);
      const blockhash = await resolveBlockhash(rpc, requirements);
      const topUp = await buildTopUpPaymentChannelTransaction({
        amount: topUpAmount,
        blockhash,
        channelId: existing.tracker.channelId,
        feePayer: terms.feePayer,
        memo: terms.memo,
        mint: requirements.asset,
        payer: this.signer,
        tokenProgram: terms.tokenProgram,
      });
      this.pending.set(key, {
        ...existing,
        cumulative,
        deposit: existing.deposit + topUpAmount,
        key,
      });
      return {
        x402Version,
        payload: {
          channelConfig: existing.tracker.channelConfig,
          deposit: { amount: topUpAmount.toString(), transaction: topUp.transaction },
          type: "deposit",
          voucher,
        },
      };
    }

    const deposit = this.config.depositAmount
      ? parseU64(this.config.depositAmount, "depositAmount")
      : charge;
    if (deposit < charge) throw new Error("depositAmount must cover the current request");
    const rpc = createRpcClient(requirements.network, this.config.rpcUrl);
    const [blockhash, openSlot] = await Promise.all([
      resolveBlockhash(rpc, requirements),
      resolveOpenSlot(rpc, requirements),
    ]);
    const built = await buildDepositPayload({
      blockhash,
      depositAmount: deposit,
      feePayer: terms.feePayer,
      firstCharge: charge,
      memo: terms.memo,
      mint: requirements.asset,
      openSlot,
      payer: this.signer,
      receiver: requirements.payTo,
      receiverAuthorizer: terms.receiverAuthorizer,
      tokenProgram: terms.tokenProgram,
      withdrawDelay: terms.withdrawDelay,
    });
    this.pending.set(key, {
      cumulative: charge,
      deposit,
      key,
      tracker: built.tracker,
    });
    return { payload: built.payload, x402Version };
  }

  /**
   * Build the payer-signed portable refund operation for the cached channel.
   *
   * @param x402Version
   * @param requirements
   */
  async createRefundPayload(
    x402Version: number,
    requirements: PaymentRequirements,
  ): Promise<Pick<PaymentPayload, "x402Version" | "payload">> {
    const terms = await this.resolveTerms(requirements);
    const key = this.channelKey(requirements, terms.feePayer, terms.withdrawDelay);
    const existing = await this.loadChannel(key);
    if (!existing) throw new Error("no cached batch-settlement channel to refund");
    const rpc = createRpcClient(requirements.network, this.config.rpcUrl);
    const blockhash = await resolveBlockhash(rpc, requirements);
    return {
      x402Version,
      payload: await buildRefundPayload({
        blockhash,
        channelConfig: existing.tracker.channelConfig,
        channelId: existing.tracker.channelId,
        feePayer: terms.feePayer,
        memo: terms.memo,
        payer: this.signer,
      }),
    };
  }

  private async loadChannel(key: string): Promise<OpenChannel | undefined> {
    const cached = this.channels.get(key);
    if (cached) return cached;
    const saved = await this.config.channelStorage?.get(key);
    if (!saved) return undefined;
    const channel = {
      deposit: parseU64(saved.deposit, "stored deposit"),
      tracker: new BatchChannelTracker(
        saved.channelId,
        saved.channelConfig,
        this.signer,
        parseU64(saved.chargedCumulativeAmount, "stored chargedCumulativeAmount"),
      ),
    };
    this.channels.set(key, channel);
    return channel;
  }

  private async handlePaymentResponse(ctx: PaymentResponseContext): Promise<void> {
    const payload = ctx.paymentPayload.payload;
    if (!isBatchPayload(payload) || (payload.type !== "voucher" && payload.type !== "deposit")) {
      return;
    }
    const pending = [...this.pending.values()].find(
      candidate => candidate.tracker.channelId === payload.voucher.channelId,
    );
    if (!pending) return;
    this.pending.delete(pending.key);

    if (!ctx.settleResponse?.success) return;
    const extra = ctx.settleResponse.extra as
      | {
          commitmentId?: unknown;
          chargedAmount?: unknown;
          channelState?: { balance?: unknown; chargedCumulativeAmount?: unknown };
        }
      | undefined;
    const charged = extra?.channelState?.chargedCumulativeAmount;
    const balance = extra?.channelState?.balance;
    if (
      extra?.commitmentId !== `${payload.voucher.channelId}:${pending.cumulative}` ||
      extra.chargedAmount !== ctx.requirements.amount ||
      charged !== pending.cumulative.toString() ||
      typeof balance !== "string"
    ) {
      throw new Error("batch-settlement PAYMENT-RESPONSE did not confirm the submitted allocation");
    }
    pending.tracker.commit(pending.cumulative);
    pending.deposit = parseU64(balance, "channelState.balance");
    this.channels.set(pending.key, pending);
    await this.config.channelStorage?.set(pending.key, {
      channelConfig: pending.tracker.channelConfig,
      channelId: pending.tracker.channelId,
      chargedCumulativeAmount: pending.cumulative.toString(),
      deposit: pending.deposit.toString(),
    });
  }

  private channelKey(
    requirements: PaymentRequirements,
    feePayer: string,
    withdrawDelay: number,
  ): string {
    return [
      requirements.network,
      requirements.asset,
      requirements.payTo,
      feePayer,
      withdrawDelay,
      requirements.extra?.receiverAuthorizer ?? "",
    ].join(":");
  }

  private async resolveTerms(requirements: PaymentRequirements): Promise<{
    feePayer: string;
    receiverAuthorizer?: string | undefined;
    tokenProgram: string;
    withdrawDelay: number;
    memo?: string | undefined;
  }> {
    const extra = requirements.extra;
    if (!extra) throw new Error("requirements.extra is required");
    if (extra.paymentFlow !== undefined && extra.paymentFlow !== "authorization") {
      throw new Error('extra.paymentFlow must be "authorization" when present');
    }
    const feePayer = extra.feePayer;
    if (typeof feePayer !== "string" || feePayer.length === 0) {
      throw new Error("extra.feePayer must be a non-empty string");
    }
    const withdrawDelay = extra.withdrawDelay;
    if (
      typeof withdrawDelay !== "number" ||
      !Number.isInteger(withdrawDelay) ||
      withdrawDelay < 900 ||
      withdrawDelay > 2_592_000 ||
      withdrawDelay < requirements.maxTimeoutSeconds
    ) {
      throw new Error("extra.withdrawDelay is outside the allowed range");
    }
    const tokenProgram = extra.tokenProgram;
    if (tokenProgram !== TOKEN_PROGRAM_ADDRESS && tokenProgram !== TOKEN_2022_PROGRAM_ADDRESS) {
      throw new Error("extra.tokenProgram is not a supported SPL token program");
    }
    const rpc = createRpcClient(requirements.network, this.config.rpcUrl);
    const mint = await fetchMint(rpc, requirements.asset as Address);
    if (mint.programAddress.toString() !== tokenProgram) {
      throw new Error("extra.tokenProgram does not own requirements.asset");
    }
    const receiverAuthorizer = extra.receiverAuthorizer;
    if (receiverAuthorizer !== undefined && typeof receiverAuthorizer !== "string") {
      throw new Error("extra.receiverAuthorizer must be a string when present");
    }
    const memo = extra.memo;
    if (memo !== undefined && typeof memo !== "string") {
      throw new Error("extra.memo must be a string when present");
    }
    return {
      feePayer,
      ...(memo !== undefined ? { memo } : {}),
      ...(receiverAuthorizer !== undefined ? { receiverAuthorizer } : {}),
      tokenProgram,
      withdrawDelay,
    };
  }
}
