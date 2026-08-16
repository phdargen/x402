import type {
  Network,
  SchemeEnrichPaymentRequiredResponseHook,
  SchemeServerHooks,
  SupportedKind,
} from "@x402/core/types";
import type { FacilitatorClient } from "@x402/core/server";
import { getAddress } from "viem";
import { getDefaultAsset } from "../../../defaultAssets";
import { MIN_WITHDRAW_DELAY } from "../../constants";
import { InMemoryChannelStorage, type ChannelStorage } from "../../storage";
import type { AuthorizerSigner } from "../../types";
import { BatchSettlementChannelManager } from "../channelManager";
import type { BatchSettlementEvmScheme } from "../scheme";
import {
  handleAfterVerify,
  handleBeforeVerify,
  handleEnrichPaymentRequiredResponse,
  handleVerifiedPaymentCanceled,
  handleVerifyFailure,
} from "../verify";
import {
  handleAfterSettle,
  handleBeforeSettle,
  handleEnrichSettlementPayload,
  handleEnrichSettlementResponse,
  handleSettleFailure,
} from "../settle";
import type {
  BatchSettlementSelfServerConfig,
  EnhanceSupportedKind,
  SchemeEnrichSettlementPayloadHook,
  SchemeEnrichSettlementResponseHook,
  SchemeVoucherStore,
} from "./types";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * Self-managed custody: the resource server owns per-channel state, verifies plain EOA
 * vouchers locally while its mirrored onchain state is fresh, commits the charge itself,
 * and runs its own claim/settle schedule.
 */
export class SelfVoucherStore implements SchemeVoucherStore {
  readonly mode = "self" as const;
  readonly hooks: SchemeServerHooks;

  private readonly storage: ChannelStorage;
  private readonly receiverAuthorizerSigner: AuthorizerSigner | undefined;
  private readonly withdrawDelay: number;
  private readonly onchainStateTtlMs: number;

  /**
   * Wires the self-managed hook set onto the owning scheme.
   *
   * @param scheme - Owning server scheme, passed to the lifecycle handlers.
   * @param config - Storage, receiver-authorizer signer, and channel timing options.
   */
  constructor(
    private readonly scheme: BatchSettlementEvmScheme,
    config?: BatchSettlementSelfServerConfig,
  ) {
    this.storage = config?.storage ?? new InMemoryChannelStorage();
    this.receiverAuthorizerSigner = config?.receiverAuthorizerSigner;
    this.withdrawDelay = config?.withdrawDelay ?? MIN_WITHDRAW_DELAY;
    this.onchainStateTtlMs =
      config?.onchainStateTtlMs ?? defaultOnchainStateTtlMs(this.withdrawDelay);
    this.hooks = {
      onBeforeVerify: ctx => handleBeforeVerify(scheme, ctx),
      onAfterVerify: ctx => handleAfterVerify(scheme, ctx),
      onBeforeSettle: ctx => handleBeforeSettle(scheme, ctx),
      onAfterSettle: ctx => handleAfterSettle(scheme, ctx),
      onVerifyFailure: ctx => handleVerifyFailure(scheme, ctx),
      onSettleFailure: ctx => handleSettleFailure(scheme, ctx),
      onVerifiedPaymentCanceled: ctx => handleVerifiedPaymentCanceled(scheme, ctx),
    };
  }

  /**
   * Adds corrective channel state to payment-required responses when available.
   *
   * @param ctx - Payment-required response context for the current request.
   * @returns Updated payment requirements, or nothing when no enrichment is needed.
   */
  enrichPaymentRequiredResponse: SchemeEnrichPaymentRequiredResponseHook = ctx =>
    handleEnrichPaymentRequiredResponse(this.scheme, ctx);

  /**
   * Adds server-owned settlement fields before facilitator settlement.
   *
   * @param ctx - Settlement context for the current payment.
   * @returns Additive payload fields, or nothing when no enrichment is needed.
   */
  enrichSettlementPayload: SchemeEnrichSettlementPayloadHook = ctx =>
    handleEnrichSettlementPayload(this.scheme, ctx);

  /**
   * Adds server-owned extra fields after facilitator settlement.
   *
   * @param ctx - Settlement result context for the current payment.
   * @returns Additive response extra fields, or nothing when no enrichment is needed.
   */
  enrichSettlementResponse: SchemeEnrichSettlementResponseHook = ctx =>
    handleEnrichSettlementResponse(this.scheme, ctx);

  /**
   * Returns the authoritative channel store.
   *
   * @returns The configured {@link ChannelStorage} backend.
   */
  getStorage(): ChannelStorage {
    return this.storage;
  }

  /**
   * Returns the configured withdraw delay (seconds).
   *
   * @returns Withdraw delay in seconds before uncooperative withdrawal is allowed.
   */
  getWithdrawDelay(): number {
    return this.withdrawDelay;
  }

  /**
   * Returns how long mirrored onchain channel state is trusted for local voucher verification.
   *
   * @returns Freshness window in milliseconds.
   */
  getOnchainStateTtlMs(): number {
    return this.onchainStateTtlMs;
  }

  /**
   * Returns the receiver-authorizer signer, if configured.
   *
   * @returns Receiver-authorizer signer, or `undefined` when the facilitator signs.
   */
  getReceiverAuthorizerSigner(): AuthorizerSigner | undefined {
    return this.receiverAuthorizerSigner;
  }

  /**
   * Injects this server's channel parameters (receiverAuthorizer, withdrawDelay).
   *
   * Asset metadata (name, version, assetTransferMethod) is left untouched — it is already
   * set by `parsePrice` or supplied explicitly by the caller, and is not re-derived from
   * the default-asset registry here so unlisted networks keep working.
   *
   * @param supportedKind - Matched scheme/network kind (extra may carry a receiverAuthorizer).
   * @returns Extra fields to merge into the payment requirements.
   */
  requirementsExtra(supportedKind: EnhanceSupportedKind): Record<string, unknown> {
    const receiverAuthorizer =
      this.receiverAuthorizerSigner?.address ??
      (typeof supportedKind.extra?.receiverAuthorizer === "string"
        ? supportedKind.extra.receiverAuthorizer
        : undefined);

    if (!receiverAuthorizer || getAddress(receiverAuthorizer) === ZERO_ADDRESS) {
      throw new Error("Payment requirements must include a non-zero extra.receiverAuthorizer");
    }

    return {
      receiverAuthorizer: getAddress(receiverAuthorizer),
      withdrawDelay: this.withdrawDelay,
    };
  }

  /**
   * Fails server startup when this scheme delegates the receiver-authorizer role but the
   * facilitator does not advertise a usable `receiverAuthorizer`.
   *
   * @param network - The network identifier being validated.
   * @param supportedKind - The facilitator's advertised kind for this scheme/network.
   * @returns A problem message when delegation is impossible, or void when valid.
   */
  validateFacilitatorSupport(network: Network, supportedKind: SupportedKind): string | void {
    if (this.receiverAuthorizerSigner) return;

    const advertised = supportedKind.extra?.receiverAuthorizer;
    const hasValid = typeof advertised === "string" && getAddress(advertised) !== ZERO_ADDRESS;

    if (!hasValid) {
      return (
        `no receiverAuthorizerSigner is configured and the facilitator does not advertise a ` +
        `receiverAuthorizer on ${network}. Configure a receiverAuthorizerSigner or use a ` +
        `facilitator that advertises one.`
      );
    }
  }

  /**
   * Creates a channel manager bound to this server's receiver and channel store.
   *
   * @param facilitator - Facilitator client for submitting onchain claims/settlements.
   * @param network - CAIP-2 network identifier (e.g. `"eip155:84532"`).
   * @param token - Explicit token address to use. Falls back to the network's default asset.
   * @returns A ready-to-use channel manager.
   */
  createChannelManager(
    facilitator: FacilitatorClient,
    network: Network,
    token?: `0x${string}`,
  ): BatchSettlementChannelManager {
    return new BatchSettlementChannelManager({
      scheme: this.scheme,
      facilitator,
      receiver: this.scheme.getReceiverAddress(),
      token: token ?? (getDefaultAsset(network).asset as `0x${string}`),
      network,
    });
  }
}

/**
 * Derives a reasonable onchain state freshness window from the channel withdraw delay.
 *
 * @param withdrawDelaySeconds - Onchain withdraw delay for the channel, in seconds.
 * @returns TTL in milliseconds, clamped between 30 seconds and 5 minutes.
 */
function defaultOnchainStateTtlMs(withdrawDelaySeconds: number): number {
  const withdrawDelayMs = Math.max(0, withdrawDelaySeconds) * 1000;
  return Math.min(5 * 60 * 1000, Math.max(30 * 1000, Math.floor(withdrawDelayMs / 3)));
}
