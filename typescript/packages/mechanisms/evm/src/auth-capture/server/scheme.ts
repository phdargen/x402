/**
 * AuthCapture Scheme - Server
 * Handles price parsing, requirement enhancement, and payment-flow selection.
 */

import type {
  AssetAmount,
  MoneyParser,
  Network,
  PaymentFlowConfig,
  PaymentRequirements,
  Price,
  SchemeNetworkServer,
  SchemeServerHooks,
  SettleResponse,
} from "@x402/core/types";
import type { SettleContext, VerifiedPaymentCanceledContext } from "@x402/core/server";
import type { FacilitatorClient } from "@x402/core/server";
import { convertToTokenAmount, numberToDecimalString, parseMoney } from "@x402/core/utils";
import { findDefaultAsset, getDefaultAsset } from "../../defaultAssets";
import type { AssetTransferMethod } from "../../types";
import { AUTH_CAPTURE_SCHEME } from "../constants";
import { isNonZeroAddress } from "../nonce";
import type { AuthorizerSigner, CaptureOptions } from "../types";
import { AuthCaptureLifecycleManager } from "./lifecycleManager";
import {
  InMemoryAuthorizedPaymentStorage,
  type AuthorizedPayment,
  type AuthorizedPaymentStorage,
} from "./storage";

export type AuthCaptureServerConfig = { storage?: AuthorizedPaymentStorage } & (
  | { lifecycle?: never }
  | { lifecycle: { authorizerSigner: AuthorizerSigner; facilitator: FacilitatorClient } }
);

/**
 * Validate a relative-offset extras key and resolve it to an absolute Unix
 * second. Returns `undefined` when the key is absent. Throws on a present-
 * but-invalid value so the merchant gets a clear error at the layer they
 * configured it, rather than a downstream facilitator rejection with a
 * cryptic reason.
 *
 * @param extras - Merged `extra` map being assembled for publication.
 * @param key - The relative-offset key to read (e.g. `"captureDeadlineSeconds"`).
 * @param now - Unix-second clock value used for the conversion.
 * @returns Absolute Unix-second deadline, or `undefined` if the key wasn't set.
 * @throws If `extras[key]` is present but not a finite positive number.
 */
function resolveOffsetToDeadline(
  extras: Record<string, unknown>,
  key: string,
  now: number,
): number | undefined {
  const raw = extras[key];
  if (raw === undefined) return undefined;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    throw new Error(
      `extra.${key} must be a positive finite number of seconds-from-now (got ${String(raw)})`,
    );
  }
  return now + raw;
}

const AUTH_CAPTURE_MERCHANT_FIELD_HINTS: Record<string, string> = {
  captureDeadline:
    " Set extra.captureDeadlineSeconds (relative, recommended) or extra.captureDeadline (absolute).",
  refundDeadline:
    " Set extra.refundDeadlineSeconds (relative, recommended) or extra.refundDeadline (absolute).",
};

/**
 * Assert that the merged `extra` carries every field that comes from the
 * merchant's route config.
 *
 * @param extra - The merged `extra` map about to be returned by `enhancePaymentRequirements`.
 * @throws With a message naming the first missing or wrongly-typed merchant field.
 */
function assertAuthCaptureMerchantExtraComplete(extra: Record<string, unknown>): void {
  const required: Array<[string, "string" | "number"]> = [
    ["captureAuthorizer", "string"],
    ["captureDeadline", "number"],
    ["refundDeadline", "number"],
    ["feeRecipient", "string"],
    ["minFeeBps", "number"],
    ["maxFeeBps", "number"],
  ];
  for (const [key, expectedType] of required) {
    if (typeof extra[key] !== expectedType) {
      const hint = AUTH_CAPTURE_MERCHANT_FIELD_HINTS[key] ?? "";
      throw new Error(`AuthCapture requires extra.${key} (${expectedType}).${hint}`);
    }
  }
}

/**
 * Server-side implementation of the auth-capture scheme.
 */
export class AuthCaptureEvmScheme implements SchemeNetworkServer {
  readonly scheme = AUTH_CAPTURE_SCHEME;
  readonly defaultAssetTransferMethod: AssetTransferMethod = "eip3009";
  readonly paymentFlows = {
    eip3009: { supported: ["escrow", "authorization"], default: "escrow" },
    permit2: { supported: ["escrow", "authorization"], default: "escrow" },
  } as const satisfies Record<AssetTransferMethod, PaymentFlowConfig>;
  readonly schemeHooks: SchemeServerHooks;
  readonly enrichSettlementPayload: (ctx: SettleContext) => Promise<Record<string, unknown> | void>;

  private moneyParsers: MoneyParser[] = [];
  private readonly lifecycle: AuthCaptureLifecycleManager;
  private readonly authorizerSigner: AuthorizerSigner | undefined;

  /**
   * Construct a server-side auth-capture scheme.
   *
   * @param config - Optional storage and grouped lifecycle (authorizer signer + facilitator).
   */
  constructor(config?: AuthCaptureServerConfig) {
    this.authorizerSigner = config?.lifecycle?.authorizerSigner;
    this.lifecycle = new AuthCaptureLifecycleManager({
      storage: config?.storage ?? new InMemoryAuthorizedPaymentStorage(),
      authorizerSigner: this.authorizerSigner,
      facilitator: config?.lifecycle?.facilitator,
    });
    this.schemeHooks = {
      onBeforeSettle: ctx => this.lifecycle.handleBeforeSettle(ctx),
      onAfterSettle: ctx => this.lifecycle.handleAfterSettle(ctx),
    };
    this.enrichSettlementPayload = ctx => this.lifecycle.enrichSettlementPayload(ctx);
  }

  /**
   * Add a custom money parser to the chain. Parsers run in registration order;
   * the first one to return a non-null `AssetAmount` wins.
   *
   * @param parser - Function that maps a decimal amount to an `AssetAmount`, or `null` to defer.
   * @returns This server scheme instance, for fluent chaining.
   */
  registerMoneyParser(parser: MoneyParser): AuthCaptureEvmScheme {
    this.moneyParsers.push(parser);
    return this;
  }

  /**
   * Decimals for a known default asset, or undefined.
   *
   * @param asset - Asset address or symbol
   * @param network - Target network
   * @returns Decimals when the asset is a known default; otherwise undefined
   */
  getAssetDecimals(asset: string, network: Network): number | undefined {
    return findDefaultAsset(asset, network)?.decimals;
  }

  /**
   * Translate a merchant-supplied `Price` into a fully-resolved `AssetAmount`.
   *
   * @param price - `"$0.01"` / `0.01` / `{ asset, amount }`.
   * @param network - CAIP-2 network identifier used for default-asset lookup.
   * @returns The resolved `AssetAmount` containing token address and base units.
   */
  async parsePrice(price: Price, network: Network): Promise<AssetAmount> {
    if (typeof price === "object" && price !== null && "amount" in price) {
      if (!price.asset) {
        throw new Error(`Asset address must be specified for AssetAmount on network ${network}`);
      }
      return {
        amount: price.amount,
        asset: price.asset,
        extra: price.extra || {},
      };
    }

    const { amount, symbol } = parseMoney(price);

    for (const parser of this.moneyParsers) {
      const result = await parser(amount, network);
      if (result !== null) {
        return result;
      }
    }

    return this.defaultMoneyConversion(amount, network, symbol);
  }

  /**
   * Merge facilitator-advertised `extra` into the merchant's payment
   * requirements, resolve relative deadline offsets into absolute deadlines,
   * write the resolved `paymentFlow` / `captureMode`, and fail-fast on
   * misconfiguration.
   *
   * @param requirements - The merchant-authored payment requirements.
   * @param supportedKind - The facilitator's advertised support entry.
   * @param supportedKind.x402Version - Protocol version the facilitator advertises.
   * @param supportedKind.scheme - Scheme identifier (`"auth-capture"`).
   * @param supportedKind.network - CAIP-2 network identifier.
   * @param supportedKind.extra - Facilitator-injected `extra` fields (lowest priority on collision).
   * @param _ - Unused list of facilitator extensions (interface compatibility).
   * @returns Enhanced `PaymentRequirements` with merged `extra` and resolved deadlines.
   */
  async enhancePaymentRequirements(
    requirements: PaymentRequirements,
    supportedKind: {
      x402Version: number;
      scheme: string;
      network: Network;
      extra?: Record<string, unknown>;
    },
    _: string[],
  ): Promise<PaymentRequirements> {
    const merged: Record<string, unknown> = {
      ...supportedKind.extra,
      ...requirements.extra,
    };

    if ("autoCapture" in merged) {
      throw new Error(
        "AuthCapture extra.autoCapture was removed in v1.1. Use extra.paymentFlow " +
          '("escrow" or "authorization") instead.',
      );
    }

    const now = Math.floor(Date.now() / 1000);
    const hasAbsCapture = typeof merged.captureDeadline === "number";
    const hasAbsRefund = typeof merged.refundDeadline === "number";
    const hasRelCapture = merged.captureDeadlineSeconds !== undefined;
    const hasRelRefund = merged.refundDeadlineSeconds !== undefined;
    const absPair = hasAbsCapture && hasAbsRefund;
    const relPair = hasRelCapture && hasRelRefund;

    if (absPair && relPair) {
      throw new Error(
        "AuthCapture extra must use either both absolute deadlines (captureDeadline and " +
          "refundDeadline) or both relative offsets (captureDeadlineSeconds and " +
          "refundDeadlineSeconds), not a mix.",
      );
    }
    if (
      (hasAbsCapture !== hasAbsRefund || hasRelCapture !== hasRelRefund) &&
      !(absPair || relPair)
    ) {
      throw new Error(
        "AuthCapture extra must use either both absolute deadlines (captureDeadline and " +
          "refundDeadline) or both relative offsets (captureDeadlineSeconds and " +
          "refundDeadlineSeconds), not a mix.",
      );
    }

    const captureFromOffset = resolveOffsetToDeadline(merged, "captureDeadlineSeconds", now);
    const refundFromOffset = resolveOffsetToDeadline(merged, "refundDeadlineSeconds", now);
    delete merged.captureDeadlineSeconds;
    delete merged.refundDeadlineSeconds;

    if (!absPair) {
      if (captureFromOffset !== undefined) merged.captureDeadline = captureFromOffset;
      if (refundFromOffset !== undefined) merged.refundDeadline = refundFromOffset;
    }

    assertAuthCaptureMerchantExtraComplete(merged);

    const paymentFlow = merged.paymentFlow === "authorization" ? "authorization" : "escrow";
    merged.paymentFlow = paymentFlow;

    if (paymentFlow === "authorization") {
      if (merged.captureMode !== undefined) {
        throw new Error(
          'AuthCapture extra.captureMode is only valid with paymentFlow "escrow"; ' +
            "authorization has no hold to finalize.",
        );
      }
    } else {
      const captureMode = merged.captureMode === "deferred" ? "deferred" : "sync";
      merged.captureMode = captureMode;
      if (captureMode === "sync") {
        if (
          !isNonZeroAddress(
            typeof merged.receiverAuthorizer === "string" ? merged.receiverAuthorizer : undefined,
          )
        ) {
          throw new Error(
            'AuthCapture extra.receiverAuthorizer is required for paymentFlow "escrow" with ' +
              'captureMode "sync". Set extra.receiverAuthorizer, or move the route to ' +
              'captureMode "deferred" or paymentFlow "authorization".',
          );
        }
        if (!this.authorizerSigner) {
          throw new Error(
            "AuthCapture escrow sync routes require a lifecycle.authorizerSigner on the scheme " +
              "(to sign capture/void). Pass lifecycle: { authorizerSigner, facilitator } to " +
              'AuthCaptureEvmScheme, or move the route to captureMode "deferred" / paymentFlow ' +
              '"authorization".',
          );
        }
      }
    }

    return { ...requirements, extra: merged };
  }

  /**
   * On handler failure after a before-handler authorize, settle a void.
   *
   * @param context - Cancellation context.
   * @returns Requirements to settle, or void when there is no hold to release.
   */
  settleOnCancel(context: VerifiedPaymentCanceledContext): Promise<PaymentRequirements | void> {
    return this.lifecycle.settleOnCancel(context);
  }

  /**
   * Capture a stored authorized payment through the facilitator.
   *
   * @param paymentInfoHash - Escrow payment identifier.
   * @param opts - Capture amount, fees, and optional void-remainder.
   * @returns Facilitator settle response.
   */
  capture(paymentInfoHash: `0x${string}`, opts?: CaptureOptions): Promise<SettleResponse> {
    return this.lifecycle.capture(paymentInfoHash, opts);
  }

  /**
   * Void the remaining hold on a stored authorized payment.
   *
   * @param paymentInfoHash - Escrow payment identifier.
   * @returns Facilitator settle response.
   */
  voidPayment(paymentInfoHash: `0x${string}`): Promise<SettleResponse> {
    return this.lifecycle.voidPayment(paymentInfoHash);
  }

  /**
   * Refund captured funds on a stored authorized payment.
   *
   * @param paymentInfoHash - Escrow payment identifier.
   * @param opts - Refund amount.
   * @param opts.amount - Atomic refund amount in token base units.
   * @returns Facilitator settle response.
   */
  refund(paymentInfoHash: `0x${string}`, opts: { amount: string }): Promise<SettleResponse> {
    return this.lifecycle.refund(paymentInfoHash, opts);
  }

  /**
   * Read a stored authorized payment.
   *
   * @param paymentInfoHash - Escrow payment identifier.
   * @returns The record, or undefined.
   */
  getAuthorizedPayment(paymentInfoHash: `0x${string}`): Promise<AuthorizedPayment | undefined> {
    return this.lifecycle.getAuthorizedPayment(paymentInfoHash);
  }

  /**
   * List stored authorized payments.
   *
   * @returns All records in storage.
   */
  listAuthorizedPayments(): Promise<AuthorizedPayment[]> {
    return this.lifecycle.listAuthorizedPayments();
  }

  /**
   * Fall-through converter: resolves a decimal amount against the default
   * asset registered for the network in `getDefaultAsset`.
   *
   * @param amount - Decimal amount in the token's display units.
   * @param network - CAIP-2 network identifier.
   * @param symbol - Optional ticker from a suffixed price.
   * @returns Resolved `AssetAmount` with the network's default asset.
   */
  private defaultMoneyConversion(amount: number, network: Network, symbol?: string): AssetAmount {
    const assetInfo = getDefaultAsset(network, symbol);
    const tokenAmount = convertToTokenAmount(numberToDecimalString(amount), assetInfo.decimals);
    const includeEip712Domain = !assetInfo.assetTransferMethod || assetInfo.supportsEip2612;
    return {
      asset: assetInfo.asset,
      amount: tokenAmount,
      extra: {
        ...(includeEip712Domain && {
          name: assetInfo.name,
          version: assetInfo.version,
        }),
        ...(assetInfo.assetTransferMethod && {
          assetTransferMethod: assetInfo.assetTransferMethod,
        }),
      },
    };
  }
}
