import type {
  DeepReadonly,
  Network,
  PaymentPayload,
  SchemeEnrichPaymentRequiredResponseHook,
  SchemeServerHooks,
  SupportedKind,
} from "@x402/core/types";
import type {
  FacilitatorClient,
  SettleResultContext,
  VerifyResultContext,
} from "@x402/core/server";
import { getAddress } from "viem";
import { getDefaultAsset } from "../../../defaultAssets";
import { BATCH_SETTLEMENT_SCHEME, MAX_WITHDRAW_DELAY, MIN_WITHDRAW_DELAY } from "../../constants";
import type { Channel, ChannelStorage } from "../../storage";
import {
  isBatchSettlementDepositPayload,
  isBatchSettlementVoucherPayload,
  type AuthorizerSigner,
  type BatchSettlementChannelStateExtra,
  type BatchSettlementCorrectiveState,
  type BatchSettlementVoucherStateExtra,
} from "../../types";
import * as Errors from "../../errors";
import { BatchSettlementChannelManager } from "../channelManager";
import type { BatchSettlementEvmScheme } from "../scheme";
import { readChannelStateExtra, readExtraNumber, readExtraString } from "../utils";
import type {
  BatchSettlementDelegatedServerConfig,
  EnhanceSupportedKind,
  SchemeVoucherStore,
} from "./types";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * Facilitator-managed custody: the server is a pass-through.
 *
 * Every payload — including `voucher` — goes to `/verify` then `/settle`, and the
 * facilitator's settle response is the payment response. The server keeps no watermark, no
 * per-channel lock, and no claim schedule; the only state it touches is the optional
 * voucher replica, which exists so the receiver can claim or refund out of band.
 */
export class DelegatedVoucherStore implements SchemeVoucherStore {
  readonly mode = "delegated" as const;
  readonly hooks: SchemeServerHooks;

  private readonly replicaStorage: ChannelStorage | undefined;
  private readonly correctiveStates = new WeakMap<
    DeepReadonly<PaymentPayload>,
    BatchSettlementCorrectiveState
  >();
  private withdrawDelay = MIN_WITHDRAW_DELAY;

  /**
   * Wires the pass-through hook set.
   *
   * @param scheme - Owning server scheme, used to resolve the receiver for claim payloads.
   * @param config - Delegated-mode configuration (optional voucher replica).
   */
  constructor(
    private readonly scheme: BatchSettlementEvmScheme,
    config: BatchSettlementDelegatedServerConfig,
  ) {
    this.replicaStorage = config.replicaStorage;
    this.hooks = {
      onAfterVerify: ctx => this.rememberCorrectiveState(ctx),
      ...(this.replicaStorage ? { onAfterSettle: ctx => this.replicateVoucher(ctx) } : {}),
    };
  }

  /**
   * Rebuilds the corrective 402 from the facilitator's mismatch response.
   *
   * @param ctx - Payment-required response context for the current request.
   */
  enrichPaymentRequiredResponse: SchemeEnrichPaymentRequiredResponseHook = async ctx => {
    if (ctx.error !== Errors.ErrCumulativeAmountMismatch || !ctx.paymentPayload) {
      return;
    }

    const corrective = this.correctiveStates.get(ctx.paymentPayload);
    if (!corrective) {
      return;
    }

    const accept = ctx.requirements.find(
      req =>
        req.scheme === BATCH_SETTLEMENT_SCHEME &&
        req.network === ctx.paymentPayload?.accepted.network,
    );
    if (!accept) {
      return;
    }

    accept.extra = {
      ...accept.extra,
      channelState: corrective.channelState,
      ...(corrective.voucherState ? { voucherState: corrective.voucherState } : {}),
    };
  };

  /**
   * Returns the voucher replica.
   *
   * @returns The configured replica storage.
   * @throws When no replica is configured, because the facilitator holds the vouchers.
   */
  getStorage(): ChannelStorage {
    if (!this.replicaStorage) {
      throw new Error(
        "no channel storage in facilitator-managed voucher custody: the facilitator is the " +
          "authoritative store. Configure replicaStorage to keep a local copy.",
      );
    }
    return this.replicaStorage;
  }

  /**
   * Returns the withdraw delay advertised by the facilitator, which every managed channel
   * must use.
   *
   * @returns Withdraw delay in seconds.
   */
  getWithdrawDelay(): number {
    return this.withdrawDelay;
  }

  /**
   * Returns zero: mirrored onchain state is never trusted in this mode, because the server
   * does not verify vouchers locally.
   *
   * @returns Always `0`.
   */
  getOnchainStateTtlMs(): number {
    return 0;
  }

  /**
   * Returns `undefined`: the facilitator owns the receiver-authorizer key.
   *
   * @returns Always `undefined`.
   */
  getReceiverAuthorizerSigner(): AuthorizerSigner | undefined {
    return undefined;
  }

  /**
   * Copies the facilitator's advertised channel parameters onto the 402.
   *
   * `withdrawDelay` is never overridden: the facilitator claims these channels, so its
   * advertised delay is the one the client must sign into `ChannelConfig`.
   *
   * @param supportedKind - Matched facilitator kind for this scheme/network.
   * @returns Extra fields to merge into the payment requirements.
   */
  requirementsExtra(supportedKind: EnhanceSupportedKind): Record<string, unknown> {
    const advertised = readAdvertisedVoucherStore(supportedKind.extra);
    if (!advertised) {
      throw new Error(
        "facilitator-managed voucher custody requires a facilitator advertising " +
          "voucherStore, receiverAuthorizer, and withdrawDelay",
      );
    }

    this.withdrawDelay = advertised.withdrawDelay;
    return {
      receiverAuthorizer: advertised.receiverAuthorizer,
      withdrawDelay: advertised.withdrawDelay,
      voucherStore: true,
    };
  }

  /**
   * Fails server startup unless the facilitator advertises a usable voucher store, which
   * the spec requires before a server may set `voucherStore: true`.
   *
   * @param network - Network being validated.
   * @param supportedKind - Facilitator's advertised kind for this scheme/network.
   * @returns A problem message when the facilitator cannot hold vouchers, or void.
   */
  validateFacilitatorSupport(network: Network, supportedKind: SupportedKind): string | void {
    const extra = supportedKind.extra;
    if (extra?.voucherStore !== true) {
      return (
        `voucherStore is set to "delegated" but the facilitator does not advertise ` +
        `voucherStore on ${network}. Use a facilitator with a voucher store or switch to ` +
        `the default self-managed mode.`
      );
    }

    const advertised = readAdvertisedVoucherStore(extra);
    if (!advertised) {
      return (
        `the facilitator advertises voucherStore on ${network} without a non-zero ` +
        `receiverAuthorizer and a withdrawDelay between ${MIN_WITHDRAW_DELAY} and ` +
        `${MAX_WITHDRAW_DELAY} seconds.`
      );
    }

    this.withdrawDelay = advertised.withdrawDelay;
  }

  /**
   * Creates a channel manager over the voucher replica.
   *
   * Claims and settlements work — the facilitator signs them as `receiverAuthorizer` —
   * while refunds are rejected by the facilitator until managed refunds ship.
   *
   * @param facilitator - Facilitator client for submitting onchain claims/settlements.
   * @param network - CAIP-2 network identifier.
   * @param token - Explicit token address; defaults to the network's default asset.
   * @returns A channel manager reading the replica.
   * @throws When no replica is configured, leaving nothing local to claim from.
   */
  createChannelManager(
    facilitator: FacilitatorClient,
    network: Network,
    token?: `0x${string}`,
  ): BatchSettlementChannelManager {
    if (!this.replicaStorage) {
      throw new Error(
        "createChannelManager requires replicaStorage in facilitator-managed voucher " +
          "custody: the facilitator claims and settles its own store on a schedule.",
      );
    }
    return new BatchSettlementChannelManager({
      scheme: this.scheme,
      facilitator,
      receiver: this.scheme.getReceiverAddress(),
      token: token ?? (getDefaultAsset(network).asset as `0x${string}`),
      network,
    });
  }

  /**
   * Stores the facilitator's corrective state so a cumulative-amount mismatch can be
   * turned into a corrective 402. This hook also fires for invalid verify results, which
   * is exactly when the corrective state arrives.
   *
   * @param ctx - Post-verify lifecycle context.
   */
  private async rememberCorrectiveState(ctx: VerifyResultContext): Promise<void> {
    if (ctx.result.isValid || ctx.result.invalidReason !== Errors.ErrCumulativeAmountMismatch) {
      return;
    }

    const channelState = ctx.result.extra?.channelState;
    if (typeof channelState !== "object" || channelState === null) {
      return;
    }

    const voucherState = ctx.result.extra?.voucherState;
    this.correctiveStates.set(ctx.paymentPayload, {
      channelState: channelState as BatchSettlementChannelStateExtra,
      ...(typeof voucherState === "object" && voucherState !== null
        ? { voucherState: voucherState as BatchSettlementVoucherStateExtra }
        : {}),
    });
  }

  /**
   * Copies the settled voucher into the replica. Write-through only: nothing in the paid
   * path reads it back.
   *
   * @param ctx - Post-settle lifecycle context.
   */
  private async replicateVoucher(ctx: SettleResultContext): Promise<void> {
    const storage = this.replicaStorage;
    if (!storage || !ctx.result.success) {
      return;
    }

    const raw = ctx.paymentPayload.payload;
    if (!isBatchSettlementVoucherPayload(raw) && !isBatchSettlementDepositPayload(raw)) {
      return;
    }

    const state = readChannelStateExtra(ctx.result.extra);
    const now = Date.now();

    await storage.updateChannel(raw.voucher.channelId, current => {
      const replica: Channel = {
        channelId: raw.voucher.channelId,
        channelConfig: raw.channelConfig,
        chargedCumulativeAmount: readExtraString(
          state,
          "chargedCumulativeAmount",
          current?.chargedCumulativeAmount ?? "0",
        ),
        signedMaxClaimable: raw.voucher.maxClaimableAmount,
        signature: raw.voucher.signature,
        balance: readExtraString(state, "balance", current?.balance ?? "0"),
        totalClaimed: readExtraString(state, "totalClaimed", current?.totalClaimed ?? "0"),
        withdrawRequestedAt: readExtraNumber(
          state,
          "withdrawRequestedAt",
          current?.withdrawRequestedAt ?? 0,
        ),
        refundNonce: readExtraNumber(state, "refundNonce", current?.refundNonce ?? 0),
        onchainSyncedAt: now,
        lastRequestTimestamp: now,
      };
      return replica;
    });
  }
}

/**
 * Reads a facilitator's voucher-store advertisement.
 *
 * @param extra - `extra` from the facilitator's advertised kind.
 * @returns The paired receiver authorizer and withdraw delay, or undefined when the
 *   advertisement is incomplete or out of range.
 */
function readAdvertisedVoucherStore(
  extra: Record<string, unknown> | undefined,
): { receiverAuthorizer: `0x${string}`; withdrawDelay: number } | undefined {
  if (extra?.voucherStore !== true) {
    return undefined;
  }

  const receiverAuthorizer = extra.receiverAuthorizer;
  if (typeof receiverAuthorizer !== "string" || getAddress(receiverAuthorizer) === ZERO_ADDRESS) {
    return undefined;
  }

  const withdrawDelay = extra.withdrawDelay;
  if (
    typeof withdrawDelay !== "number" ||
    withdrawDelay < MIN_WITHDRAW_DELAY ||
    withdrawDelay > MAX_WITHDRAW_DELAY
  ) {
    return undefined;
  }

  return { receiverAuthorizer: getAddress(receiverAuthorizer), withdrawDelay };
}
