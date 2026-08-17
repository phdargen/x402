import type { PaymentPayload, PaymentRequirements, SettleResponse } from "@x402/core/types";
import type { DeepReadonly } from "@x402/core/types";
import type {
  SettleContext,
  SettleResultContext,
  VerifiedPaymentCanceledContext,
} from "@x402/core/server";
import type { FacilitatorClient } from "@x402/core/server";
import { getEvmChainId } from "../../utils";
import type { AssetTransferMethod } from "../../types";
import { AUTH_CAPTURE_SCHEME } from "../constants";
import { computePaymentInfoHash, isNonZeroAddress } from "../nonce";
import { parseAuthCaptureExtra } from "../extra";
import {
  buildCaptureEnrichment,
  buildCapturePayload,
  buildChargeCompletionEnrichment,
  buildRefundPayload,
  buildVoidEnrichment,
  buildVoidPayload,
  paymentInfoFromCollect,
} from "../lifecyclePayload";
import type {
  AuthCaptureCollectPayload,
  AuthCaptureExtra,
  AuthorizerSigner,
  CaptureOptions,
  CapturePayload,
  PaymentInfoStruct,
  RefundPayload,
  VoidPayload,
} from "../types";
import { isAuthCaptureCollectPayload, isEip3009Payload } from "../types";
import type { AuthorizedPayment, AuthorizedPaymentStorage } from "./storage";

export interface AuthCaptureLifecycleConfig {
  storage: AuthorizedPaymentStorage;
  authorizerSigner?: AuthorizerSigner;
  facilitator?: FacilitatorClient;
}

/**
 * Narrow a wire payload to a collect envelope, or undefined.
 *
 * @param payload - `PaymentPayload.payload`.
 * @returns Collect payload when the shape matches.
 */
function asCollectPayload(
  payload: DeepReadonly<PaymentPayload>["payload"],
): AuthCaptureCollectPayload | undefined {
  return isAuthCaptureCollectPayload(payload) ? payload : undefined;
}

/**
 * Deferred lifecycle: storage, sync enrichment, and one-shot capture/void/refund helpers.
 */
export class AuthCaptureLifecycleManager {
  private readonly authorizeResults = new WeakMap<object, SettleResponse>();

  /**
   * Create a lifecycle manager with storage and optional deferred helpers.
   *
   * @param config - Storage and optional grouped lifecycle (authorizer signer + facilitator).
   */
  constructor(private readonly config: AuthCaptureLifecycleConfig) {}

  /**
   * Additive payload enrichment for sync capture, bound charge, and cancel void.
   *
   * @param ctx - Settle context from core.
   * @returns Fields to merge into the client payload, or void when not applicable.
   */
  async enrichSettlementPayload(ctx: SettleContext): Promise<Record<string, unknown> | void> {
    if (ctx.phase === "before-handler") return;
    const extraParsed = parseAuthCaptureExtra(ctx.requirements.extra);
    if ("error" in extraParsed) return;
    const extra = extraParsed.extra;
    const collect = asCollectPayload(ctx.paymentPayload.payload);
    if (!collect) return;

    const signer = this.config.authorizerSigner;
    if (!signer) return;

    if (ctx.phase === "cancel") {
      if (extra.paymentFlow !== "escrow") return;
      const paymentInfo = paymentInfoFromCollect(collect, ctx.requirements, extra);
      const chainId = getEvmChainId(ctx.requirements.network);
      return buildVoidEnrichment({
        paymentInfo,
        extra,
        signer,
        chainId,
        paymentInfoHash: computePaymentInfoHash(chainId, paymentInfo),
      });
    }

    if (ctx.phase !== "after-handler") return;

    const chainId = getEvmChainId(ctx.requirements.network);

    if (extra.paymentFlow === "authorization" && isNonZeroAddress(extra.receiverAuthorizer)) {
      return buildChargeCompletionEnrichment({
        collect,
        requirements: ctx.requirements as PaymentRequirements,
        extra,
        signer,
        chainId,
        amount: ctx.requirements.amount,
      });
    }

    if (extra.paymentFlow === "escrow" && extra.captureMode !== "deferred") {
      const paymentInfo = paymentInfoFromCollect(
        collect,
        ctx.paymentPayload.accepted as PaymentRequirements,
        extra,
      );
      const paymentInfoHash = computePaymentInfoHash(chainId, paymentInfo);
      const stored = await this.config.storage.get(paymentInfoHash);
      return buildCaptureEnrichment({
        collect,
        requirements: ctx.requirements as PaymentRequirements,
        extra,
        signer,
        chainId,
        capturable: stored?.capturableAmount ?? paymentInfo.maxAmount,
        refundable: stored?.refundableAmount ?? "0",
        amount: ctx.requirements.amount,
      });
    }
  }

  /**
   * On handler failure after a before-handler authorize, settle a void.
   *
   * @param context - Cancellation context.
   * @returns Requirements to settle, or void when there is no hold to release.
   */
  async settleOnCancel(
    context: VerifiedPaymentCanceledContext,
  ): Promise<PaymentRequirements | void> {
    const extraParsed = parseAuthCaptureExtra(context.requirements.extra);
    if ("error" in extraParsed) return;
    const extra = extraParsed.extra;
    if (extra.paymentFlow !== "escrow") return;
    if (!this.config.authorizerSigner || !isNonZeroAddress(extra.receiverAuthorizer)) return;
    return context.requirements as PaymentRequirements;
  }

  /**
   * Capture a stored authorized payment through the facilitator.
   *
   * @param paymentInfoHash - Escrow payment identifier.
   * @param opts - Capture amount, fees, and optional void-remainder.
   * @returns Facilitator settle response.
   */
  async capture(paymentInfoHash: `0x${string}`, opts?: CaptureOptions): Promise<SettleResponse> {
    const record = await this.requireRecord(paymentInfoHash);
    const extra = extraFromRecord(record);
    const chainId = getEvmChainId(record.network);
    const amount = opts?.amount ?? record.capturableAmount;
    const payload = await buildCapturePayload({
      record: {
        paymentInfo: record.paymentInfo,
        paymentInfoHash: record.paymentInfoHash,
        capturableAmount: record.capturableAmount,
        refundableAmount: record.refundableAmount,
        saltNonce: this.requireSaltNonce(record),
      },
      extra,
      signer: this.requireLifecycle().authorizerSigner,
      chainId,
      amount,
      feeBps: opts?.feeBps,
      feeReceiver: opts?.feeReceiver,
      voidRemainder: opts?.voidRemainder,
    });
    const response = await this.settleLifecycle(record, payload);
    if (response.success) {
      await this.applyCaptureBalances(record.paymentInfoHash, amount, Boolean(opts?.voidRemainder));
    }
    return response;
  }

  /**
   * Void the remaining hold on a stored authorized payment.
   *
   * @param paymentInfoHash - Escrow payment identifier.
   * @returns Facilitator settle response.
   */
  async voidPayment(paymentInfoHash: `0x${string}`): Promise<SettleResponse> {
    const record = await this.requireRecord(paymentInfoHash);
    const extra = extraFromRecord(record);
    const payload = await buildVoidPayload({
      record: {
        paymentInfo: record.paymentInfo,
        paymentInfoHash: record.paymentInfoHash,
        saltNonce: this.requireSaltNonce(record),
      },
      extra,
      signer: this.requireLifecycle().authorizerSigner,
      chainId: getEvmChainId(record.network),
    });
    const response = await this.settleLifecycle(record, payload);
    if (response.success) {
      await this.config.storage.update(record.paymentInfoHash, current =>
        current ? { ...current, capturableAmount: "0" } : current,
      );
    }
    return response;
  }

  /**
   * Refund captured funds on a stored authorized payment.
   *
   * @param paymentInfoHash - Escrow payment identifier.
   * @param opts - Refund amount.
   * @param opts.amount - Atomic refund amount in token base units.
   * @returns Facilitator settle response.
   */
  async refund(paymentInfoHash: `0x${string}`, opts: { amount: string }): Promise<SettleResponse> {
    const record = await this.requireRecord(paymentInfoHash);
    const extra = extraFromRecord(record);
    const payload = await buildRefundPayload({
      record: {
        paymentInfo: record.paymentInfo,
        paymentInfoHash: record.paymentInfoHash,
        capturableAmount: record.capturableAmount,
        refundableAmount: record.refundableAmount,
        saltNonce: this.requireSaltNonce(record),
      },
      extra,
      signer: this.requireLifecycle().authorizerSigner,
      chainId: getEvmChainId(record.network),
      amount: opts.amount,
    });
    const response = await this.settleLifecycle(record, payload);
    if (response.success) {
      await this.config.storage.update(record.paymentInfoHash, current => {
        if (!current) return current;
        const next = BigInt(current.refundableAmount) - BigInt(opts.amount);
        return { ...current, refundableAmount: next.toString() };
      });
    }
    return response;
  }

  /**
   * Read a stored authorized payment.
   *
   * @param paymentInfoHash - Escrow payment identifier.
   * @returns The record, or undefined.
   */
  async getAuthorizedPayment(
    paymentInfoHash: `0x${string}`,
  ): Promise<AuthorizedPayment | undefined> {
    return this.config.storage.get(paymentInfoHash);
  }

  /**
   * List stored authorized payments.
   *
   * @returns All records in storage.
   */
  async listAuthorizedPayments(): Promise<AuthorizedPayment[]> {
    return this.config.storage.list();
  }

  /**
   * Skip the after-handler facilitator settle for deferred escrow; echo the authorize receipt.
   *
   * @param ctx - Settle context.
   * @returns Skip directive with the prior authorize result, or void.
   */
  async handleBeforeSettle(
    ctx: SettleContext,
  ): Promise<void | { skip: true; result: SettleResponse }> {
    if (ctx.phase !== "after-handler") return;
    const extraParsed = parseAuthCaptureExtra(ctx.requirements.extra);
    if ("error" in extraParsed) return;
    if (extraParsed.extra.paymentFlow !== "escrow") return;
    if (extraParsed.extra.captureMode !== "deferred") return;
    const prior = this.authorizeResults.get(ctx.paymentPayload);
    if (!prior) return;
    return { skip: true, result: prior };
  }

  /**
   * Persist authorized-payment records and update balances after a successful settle.
   *
   * @param ctx - Settle result context.
   * @returns Nothing.
   */
  async handleAfterSettle(ctx: SettleResultContext): Promise<void> {
    if (!ctx.result.success) return;
    const extraParsed = parseAuthCaptureExtra(ctx.requirements.extra);
    if ("error" in extraParsed) return;
    const extra = extraParsed.extra;
    const collect = asCollectPayload(ctx.paymentPayload.payload);

    if (ctx.phase === "before-handler" && collect) {
      this.authorizeResults.set(ctx.paymentPayload, ctx.result as SettleResponse);
      await this.persistCollect(collect, ctx, extra, "authorize");
      return;
    }
    if (ctx.phase === "after-handler" && extra.paymentFlow === "authorization" && collect) {
      await this.persistCollect(collect, ctx, extra, "charge");
      return;
    }
    if (
      ctx.phase === "after-handler" &&
      extra.paymentFlow === "escrow" &&
      extra.captureMode !== "deferred"
    ) {
      const type = (ctx.paymentPayload.payload as Record<string, unknown>).type;
      if (type === "capture") {
        const amount = ctx.result.amount ?? ctx.requirements.amount;
        const voidRemainder =
          (ctx.paymentPayload.payload as Record<string, unknown>).voidAuthorizerSignature !==
          undefined;
        const paymentInfo = (ctx.paymentPayload.payload as Record<string, unknown>).paymentInfo as
          | PaymentInfoStruct
          | undefined;
        if (paymentInfo) {
          const hash = computePaymentInfoHash(getEvmChainId(ctx.requirements.network), paymentInfo);
          await this.applyCaptureBalances(hash, amount, voidRemainder);
        }
      }
    }
    if (ctx.phase === "cancel") {
      const paymentInfo = (ctx.paymentPayload.payload as Record<string, unknown>).paymentInfo as
        | PaymentInfoStruct
        | undefined;
      if (paymentInfo) {
        const hash = computePaymentInfoHash(getEvmChainId(ctx.requirements.network), paymentInfo);
        await this.config.storage.update(hash, current =>
          current ? { ...current, capturableAmount: "0" } : current,
        );
      }
    }
  }

  /**
   * Store a payment record after a successful collect settle.
   *
   * @param collect - Client collect payload.
   * @param ctx - Settle result context.
   * @param extra - Normalized extra used for reconstruction.
   * @param operation - `"authorize"` (hold) or `"charge"` (already captured).
   * @returns Nothing.
   */
  private async persistCollect(
    collect: AuthCaptureCollectPayload,
    ctx: SettleResultContext,
    extra: AuthCaptureExtra & {
      paymentFlow: "escrow" | "authorization";
      operatorType: "delegated" | "custom";
      assetTransferMethod: AssetTransferMethod;
      receiverAuthorizer: `0x${string}`;
      policy: `0x${string}`;
    },
    operation: "authorize" | "charge",
  ): Promise<void> {
    const paymentInfo = paymentInfoFromCollect(
      collect,
      ctx.requirements as PaymentRequirements,
      extra,
    );
    const chainId = getEvmChainId(ctx.requirements.network);
    const paymentInfoHash = computePaymentInfoHash(chainId, paymentInfo);
    const signedAmount = isEip3009Payload(collect)
      ? collect.authorization.value
      : collect.permit2Authorization.permitted.amount;
    const settledAmount = ctx.result.amount ?? signedAmount;
    const saltNonce = "saltNonce" in collect ? collect.saltNonce : undefined;

    const record: AuthorizedPayment = {
      paymentInfoHash,
      paymentInfo,
      ...(saltNonce ? { saltNonce } : {}),
      receiverAuthorizer: extra.receiverAuthorizer,
      policy: extra.policy,
      network: ctx.requirements.network,
      capturableAmount: operation === "authorize" ? signedAmount : "0",
      refundableAmount: operation === "charge" ? settledAmount : "0",
      collectTransaction: ctx.result.transaction,
      createdAt: Date.now(),
      name: extra.name,
      version: extra.version,
      paymentFlow: extra.paymentFlow,
      operatorType: extra.operatorType,
      assetTransferMethod: extra.assetTransferMethod,
    };
    await this.config.storage.update(paymentInfoHash, () => record);
  }

  /**
   * Apply a successful capture to stored capturable/refundable balances.
   *
   * @param paymentInfoHash - Storage key.
   * @param amount - Captured atomic amount.
   * @param voidRemainder - When true, zero the remaining hold.
   * @returns Nothing.
   */
  private async applyCaptureBalances(
    paymentInfoHash: string,
    amount: string,
    voidRemainder: boolean,
  ): Promise<void> {
    await this.config.storage.update(paymentInfoHash, current => {
      if (!current) return current;
      const captured = BigInt(amount);
      const capturable = BigInt(current.capturableAmount) - captured;
      const refundable = BigInt(current.refundableAmount) + captured;
      return {
        ...current,
        capturableAmount: voidRemainder ? "0" : capturable.toString(),
        refundableAmount: refundable.toString(),
      };
    });
  }

  /**
   * POST a signed lifecycle payload to the configured facilitator client.
   *
   * @param record - Stored payment.
   * @param payload - Capture, void, or refund envelope.
   * @returns Facilitator settle response.
   */
  private async settleLifecycle(
    record: AuthorizedPayment,
    payload: CapturePayload | VoidPayload | RefundPayload,
  ): Promise<SettleResponse> {
    const { facilitator } = this.requireLifecycle();
    const requirements = buildRequirements(record);
    const paymentPayload: PaymentPayload = {
      x402Version: 2,
      accepted: requirements,
      payload: payload as unknown as Record<string, unknown>,
    };
    return facilitator.settle(paymentPayload, requirements);
  }

  /**
   * Load a stored payment or throw.
   *
   * @param paymentInfoHash - Storage key.
   * @returns The record.
   */
  private async requireRecord(paymentInfoHash: `0x${string}`): Promise<AuthorizedPayment> {
    const record = await this.config.storage.get(paymentInfoHash);
    if (!record) {
      throw new Error(`AuthCapture: no authorized payment ${paymentInfoHash}`);
    }
    return record;
  }

  /**
   * Bound-payment `saltNonce` from storage, required for lifecycle settles.
   *
   * @param record - Stored payment.
   * @returns The 32-byte nonce.
   */
  private requireSaltNonce(record: AuthorizedPayment): `0x${string}` {
    if (!record.saltNonce) {
      throw new Error(
        "AuthCapture: saltNonce is required for lifecycle settles (salt binding is on)",
      );
    }
    return record.saltNonce;
  }

  /**
   * Constructor lifecycle config, or throw if helpers were called without it.
   *
   * @returns Authorizer signer and facilitator client.
   */
  private requireLifecycle(): {
    authorizerSigner: AuthorizerSigner;
    facilitator: FacilitatorClient;
  } {
    if (!this.config.authorizerSigner || !this.config.facilitator) {
      throw new Error(
        "AuthCapture lifecycle helpers require lifecycle: { authorizerSigner, facilitator } " +
          "on AuthCaptureEvmScheme",
      );
    }
    return {
      authorizerSigner: this.config.authorizerSigner,
      facilitator: this.config.facilitator,
    };
  }
}

/**
 * Rebuild extra from a stored authorized-payment record.
 *
 * @param record - Stored payment.
 * @returns Extra sufficient to reconstruct and settle lifecycle payloads.
 */
function extraFromRecord(record: AuthorizedPayment): AuthCaptureExtra & {
  paymentFlow: "escrow" | "authorization";
  operatorType: "delegated" | "custom";
  assetTransferMethod: AssetTransferMethod;
  receiverAuthorizer: `0x${string}`;
  policy: `0x${string}`;
} {
  return {
    captureAuthorizer: record.paymentInfo.operator,
    captureDeadline: record.paymentInfo.authorizationExpiry,
    refundDeadline: record.paymentInfo.refundExpiry,
    feeRecipient: record.paymentInfo.feeReceiver,
    minFeeBps: record.paymentInfo.minFeeBps,
    maxFeeBps: record.paymentInfo.maxFeeBps,
    name: record.name,
    version: record.version,
    paymentFlow: record.paymentFlow,
    operatorType: record.operatorType,
    assetTransferMethod: record.assetTransferMethod,
    receiverAuthorizer: record.receiverAuthorizer,
    policy: record.policy,
  };
}

/**
 * PaymentRequirements for a facilitator lifecycle settle from a stored record.
 *
 * @param record - Stored payment.
 * @returns Requirements whose extra matches the original collect.
 */
function buildRequirements(record: AuthorizedPayment): PaymentRequirements {
  return {
    scheme: AUTH_CAPTURE_SCHEME,
    network: record.network,
    asset: record.paymentInfo.token,
    amount: record.paymentInfo.maxAmount,
    payTo: record.paymentInfo.receiver,
    maxTimeoutSeconds: 1,
    extra: extraFromRecord(record) as unknown as Record<string, unknown>,
  };
}
