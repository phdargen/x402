import {
  PaymentPayload,
  PaymentRequirements,
  SchemeNetworkFacilitator,
  FacilitatorContext,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import { InMemoryPendingSettlementStore, PendingSettlementStore } from "@x402/core/facilitator";
import { FacilitatorEvmSigner } from "../../signer";
import { BATCH_SETTLEMENT_SCHEME, MIN_WITHDRAW_DELAY } from "../constants";
import {
  isBatchSettlementDepositPayload,
  isBatchSettlementVoucherPayload,
  isBatchSettlementClaimPayload,
  isBatchSettlementSettlePayload,
  isBatchSettlementRefundPayload,
  isBatchSettlementEnrichedRefundPayload,
} from "../types";
import type { AuthorizerSigner, BatchSettlementEnrichedRefundPayload } from "../types";
import { isFacilitatorManaged } from "../voucherStore";
import { InMemoryDelegatedAuthStore, type DelegatedAuthStore } from "../storage/delegatedAuth";
import type { ChannelLockStorage, ChannelStorage } from "../storage/channel";
import { isChannelLockStorage } from "../storage/channel";
import { verifyDeposit, settleDeposit } from "./deposit";
import { verifyVoucher } from "./voucher";
import { submitClaim } from "./claim";
import { executeSettle } from "./settle";
import { submitRefund } from "./refund";
import { resolveDataSuffix } from "../../shared/extensions";
import * as Errors from "../errors";
import { settleManaged, verifyManaged, type VoucherStoreDeps } from "./voucherStore";
import { afterClaim, FacilitatorChannelManager } from "./channelManager";
import type { DelegatedSettleContext, FacilitatorChannel } from "./types";
import { assertDirectAuthorizerSubmitter, type SubmitContext, type SubmitMode } from "./submit";

export type { DelegatedSettleContext, FacilitatorChannel };

export interface BatchSettlementEvmSchemeConfig {
  /**
   * Allowlist of factory contract addresses (hex strings, case-insensitive) the facilitator
   * will call to deploy an undeployed (ERC-6492 counterfactual) smart wallet before an
   * ERC-3009 deposit. An empty or omitted list denies all factory deployment (feature
   * disabled by default).
   *
   * @default []
   */
  eip6492AllowedFactories?: string[];
  /**
   * Lets a retried deposit settle for the same authorization reconcile
   * against an already-broadcast transaction instead of re-broadcasting
   * (see {@link PendingSettlementStore}). Only the deposit settle path
   * consults this store; claim/settle/refund are single-signature onchain
   * calls with no equivalent broadcast-then-reconcile flow. Defaults to a
   * fresh in-memory store shared across all deposit settle calls on this
   * scheme instance. Inject a shared, network-backed implementation (e.g.
   * Redis) for a multi-instance facilitator so a settle retry landing on a
   * different replica still reconciles correctly.
   */
  pendingSettlementStore?: PendingSettlementStore;
  /**
   * Facilitator voucher store. Requires {@link authorizerSigner}.
   * `withdrawDelay` defaults to {@link MIN_WITHDRAW_DELAY}. Lock storage is
   * inferred from `storage` only when that object implements {@link ChannelLockStorage}.
   */
  voucherStore?: {
    storage: ChannelStorage<FacilitatorChannel>;
    lockStorage?: ChannelLockStorage;
    withdrawDelay?: number;
  };
  /**
   * Resolves a stable caller identity for a delegated settle. Presence of this
   * hook enables unsigned refunds (`/supported` `refundAuth: true`).
   */
  resolveCallerIdentity?: (
    ctx: DelegatedSettleContext,
  ) => Promise<string | undefined> | string | undefined;
  /**
   * Stores `channelId → caller identity` bindings written at self-managed
   * deposit and checked at unsigned refund. Defaults to
   * {@link InMemoryDelegatedAuthStore} when {@link resolveCallerIdentity} is set.
   */
  delegatedAuthStore?: DelegatedAuthStore;
  /**
   * How facilitator-owned `claim` / `refund` transactions are submitted.
   * `"relay"` (default) uses the regular `evmSigner` pool and `*WithSignature`.
   * `"direct"` uses {@link authorizerSubmitter} as `msg.sender` on `claim` / `refund`.
   * A payload that already carries an authorizer signature always relays.
   *
   * @default "relay"
   */
  submitMode?: SubmitMode;
  /**
   * Write-capable signer whose `getAddresses()` is exactly `[authorizerSigner.address]`.
   * Required when {@link submitMode} is `"direct"`; ignored on the relay path.
   */
  authorizerSubmitter?: FacilitatorEvmSigner;
}

/**
 * Facilitator-side implementation of the `batch-settlement` scheme for EVM networks.
 *
 * Routes incoming verify/settle requests to the appropriate handler based on payload
 * type (deposit, voucher, claim, settle, refund).
 */
export class BatchSettlementEvmScheme implements SchemeNetworkFacilitator {
  readonly scheme = BATCH_SETTLEMENT_SCHEME;
  readonly caipFamily = "eip155:*";
  private readonly config: Required<
    Omit<
      BatchSettlementEvmSchemeConfig,
      | "pendingSettlementStore"
      | "voucherStore"
      | "resolveCallerIdentity"
      | "delegatedAuthStore"
      | "submitMode"
      | "authorizerSubmitter"
    >
  >;
  private readonly submitMode: SubmitMode;
  private readonly authorizerSubmitter: FacilitatorEvmSigner | undefined;
  private readonly pendingStore: PendingSettlementStore;
  private readonly voucherStore:
    | {
        storage: ChannelStorage<FacilitatorChannel>;
        lockStorage: ChannelLockStorage;
        withdrawDelay: number;
      }
    | undefined;
  private readonly resolveCallerIdentity: BatchSettlementEvmSchemeConfig["resolveCallerIdentity"];
  private readonly delegatedAuthStore: DelegatedAuthStore | undefined;

  /**
   * Creates a facilitator scheme for verifying and settling batch-settlement payments.
   *
   * @param signer - Facilitator EVM signer(s) used for tx submission and onchain reads.
   * @param authorizerSigner - Optional dedicated key that provides EIP-712 signatures for
   *   `claimWithSignature` / `refundWithSignature`. When provided, the facilitator advertises
   *   its address as `receiverAuthorizer` in `/supported` and signs missing authorizer
   *   signatures using this key when the server omits them. A facilitator that advertises a
   *   `receiverAuthorizer` for servers to delegate to must authenticate refund requests (see the
   *   spec); when no such mechanism exists, omit this signer so no `receiverAuthorizer` is
   *   advertised and servers supply their own signatures.
   * @param config - Optional configuration (e.g. ERC-6492 factory allowlist, voucher store).
   */
  constructor(
    private readonly signer: FacilitatorEvmSigner,
    private readonly authorizerSigner?: AuthorizerSigner,
    config?: BatchSettlementEvmSchemeConfig,
  ) {
    if (config?.voucherStore && !authorizerSigner) {
      throw new Error("voucherStore requires authorizerSigner");
    }
    assertDirectAuthorizerSubmitter(
      config?.submitMode,
      authorizerSigner,
      config?.authorizerSubmitter,
    );
    this.config = {
      eip6492AllowedFactories: config?.eip6492AllowedFactories ?? [],
    };
    this.submitMode = config?.submitMode ?? "relay";
    this.authorizerSubmitter = config?.authorizerSubmitter;
    this.pendingStore = config?.pendingSettlementStore ?? new InMemoryPendingSettlementStore();
    this.resolveCallerIdentity = config?.resolveCallerIdentity;
    this.delegatedAuthStore = this.resolveCallerIdentity
      ? (config?.delegatedAuthStore ?? new InMemoryDelegatedAuthStore())
      : config?.delegatedAuthStore;
    if (config?.voucherStore) {
      const storage = config.voucherStore.storage;
      const lockStorage =
        config.voucherStore.lockStorage ?? (isChannelLockStorage(storage) ? storage : undefined);
      if (!lockStorage) {
        throw new Error(
          "voucherStore.lockStorage is required when storage does not implement ChannelLockStorage",
        );
      }
      this.voucherStore = {
        storage,
        lockStorage,
        withdrawDelay: config.voucherStore.withdrawDelay ?? MIN_WITHDRAW_DELAY,
      };
    }
  }

  /**
   * Returns facilitator-specific extra fields to be merged into payment requirements.
   *
   * Exposes the configured `receiverAuthorizer` address so the server and client can
   * embed it in `ChannelConfig`. Returns `undefined` when no authorizer signer is
   * configured, signalling that servers must supply their own authorizer signatures.
   *
   * @param _ - Network identifier (unused).
   * @returns Extra fields containing `receiverAuthorizer`, or `undefined`.
   */
  getExtra(_: string):
    | {
        receiverAuthorizer: `0x${string}`;
        withdrawDelay?: number;
        voucherStore?: true;
        refundAuth?: true;
      }
    | undefined {
    if (!this.authorizerSigner) {
      return undefined;
    }
    return {
      receiverAuthorizer: this.authorizerSigner.address,
      ...(this.voucherStore
        ? { withdrawDelay: this.voucherStore.withdrawDelay, voucherStore: true as const }
        : {}),
      ...(this.resolveCallerIdentity ? { refundAuth: true as const } : {}),
    };
  }

  /**
   * Returns all facilitator signer addresses available for the given network.
   *
   * @param _ - Network identifier (unused).
   * @returns Array of hex addresses.
   */
  getSigners(_: string): `0x${string}`[] {
    return [...this.signer.getAddresses()];
  }

  /**
   * Verifies a payment payload (deposit or voucher) without executing settlement.
   *
   * @param payload - The x402 payment payload envelope.
   * @param requirements - Server payment requirements (scheme, network, asset, amount).
   * @param context - Optional facilitator extension context.
   * @param _ - Payment required extensions (unused; reserved for interface parity)
   * @returns A {@link VerifyResponse} indicating validity with payer and channel state in `extra`.
   */
  async verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    context?: FacilitatorContext,
    _?: Record<string, unknown>,
  ): Promise<VerifyResponse> {
    const rawPayload = payload.payload;

    if (
      payload.accepted.scheme !== BATCH_SETTLEMENT_SCHEME ||
      requirements.scheme !== BATCH_SETTLEMENT_SCHEME
    ) {
      return { isValid: false, invalidReason: Errors.ErrInvalidScheme };
    }

    if (payload.accepted.network !== requirements.network) {
      return { isValid: false, invalidReason: Errors.ErrNetworkMismatch };
    }

    if (isFacilitatorManaged(requirements)) {
      if (!this.voucherStore || !this.authorizerSigner) {
        return { isValid: false, invalidReason: Errors.ErrVoucherStoreUnavailable };
      }
      return verifyManaged(this.voucherStoreDeps(), payload, requirements, context);
    }

    if (isBatchSettlementDepositPayload(rawPayload)) {
      return verifyDeposit(
        this.signer,
        payload,
        rawPayload,
        requirements,
        context,
        this.config.eip6492AllowedFactories,
      );
    }

    if (isBatchSettlementVoucherPayload(rawPayload)) {
      return verifyVoucher(this.signer, rawPayload, requirements, rawPayload.channelConfig);
    }

    if (isBatchSettlementRefundPayload(rawPayload)) {
      return verifyVoucher(this.signer, rawPayload, requirements, rawPayload.channelConfig);
    }

    return { isValid: false, invalidReason: Errors.ErrInvalidPayloadType };
  }

  /**
   * Executes settlement for a payment payload.
   *
   * Dispatches to the correct handler based on payload settle action:
   * - `deposit` → onchain `deposit(config, amount, collector, collectorData)`
   * - `claim` → onchain `claim` or `claimWithSignature` (see `submitMode`)
   * - `settle` → onchain `settle(receiver, token)`
   * - `refund` → optional claim + onchain `refund` or `refundWithSignature`
   *
   * @param payload - The x402 payment payload envelope.
   * @param requirements - Server payment requirements.
   * @param context - Optional facilitator extension context.
   * @returns A {@link SettleResponse} with the transaction hash on success.
   */
  async settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    context?: FacilitatorContext,
  ): Promise<SettleResponse> {
    const rawPayload = payload.payload;

    const dataSuffix = await resolveDataSuffix(context, {
      paymentPayload: payload,
      paymentRequirements: requirements,
    });

    if (isFacilitatorManaged(requirements)) {
      if (!this.voucherStore || !this.authorizerSigner) {
        return {
          success: false,
          errorReason: Errors.ErrVoucherStoreUnavailable,
          transaction: "",
          network: requirements.network,
        };
      }
      if (isBatchSettlementClaimPayload(rawPayload) || isBatchSettlementSettlePayload(rawPayload)) {
        // claim/settle stay on the existing path even when the kind is managed
      } else {
        return settleManaged(this.voucherStoreDeps(), payload, requirements, context, dataSuffix);
      }
    }

    if (isBatchSettlementDepositPayload(rawPayload)) {
      const settled = await settleDeposit(
        this.signer,
        payload,
        rawPayload,
        requirements,
        context,
        dataSuffix,
        this.config.eip6492AllowedFactories,
        this.pendingStore,
      );
      if (settled.success) {
        await this.bindSelfManagedCaller(
          payload,
          rawPayload.voucher.channelId,
          requirements,
          context,
        );
      }
      return settled;
    }

    if (isBatchSettlementClaimPayload(rawPayload)) {
      const settled = await submitClaim(
        {
          network: requirements.network,
          claims: rawPayload.claims,
          signature: rawPayload.claimAuthorizerSignature,
          dataSuffix,
        },
        this.submitContext(),
      );
      if (settled.success && isFacilitatorManaged(requirements) && this.voucherStore) {
        await afterClaim(
          this.voucherStore.storage,
          this.voucherStore.lockStorage,
          rawPayload.claims,
          requirements.network,
        );
      }
      return settled;
    }

    if (isBatchSettlementEnrichedRefundPayload(rawPayload)) {
      const consentErr = await this.checkSelfManagedRefundCaller(
        payload,
        rawPayload,
        requirements,
        context,
      );
      if (consentErr) {
        return {
          success: false,
          errorReason: consentErr,
          transaction: "",
          network: requirements.network,
        };
      }
      return submitRefund(
        {
          network: requirements.network,
          payload: rawPayload,
          dataSuffix,
        },
        this.submitContext(),
      );
    }

    if (isBatchSettlementSettlePayload(rawPayload)) {
      return executeSettle(this.signer, rawPayload, requirements.network, dataSuffix);
    }

    return {
      success: false,
      errorReason: Errors.ErrInvalidPayloadType,
      transaction: "",
      network: requirements.network,
    };
  }

  /**
   * Creates a {@link FacilitatorChannelManager} wired to this scheme's voucher store.
   *
   * @returns A ready-to-use manager.
   * @throws When no voucher store or authorizer signer is configured.
   */
  createChannelManager(): FacilitatorChannelManager {
    if (!this.voucherStore || !this.authorizerSigner) {
      throw new Error("createChannelManager requires voucherStore and authorizerSigner");
    }
    return new FacilitatorChannelManager({
      storage: this.voucherStore.storage,
      lockStorage: this.voucherStore.lockStorage,
      signer: this.signer,
      authorizerSigner: this.authorizerSigner,
      authorizerSubmitter: this.authorizerSubmitter,
      submitMode: this.submitMode,
    });
  }

  /**
   * Builds the managed-store dependency bag.
   *
   * @returns Dependencies for verify/settle managed handlers.
   */
  private voucherStoreDeps(): VoucherStoreDeps {
    if (!this.voucherStore || !this.authorizerSigner) {
      throw new Error(Errors.ErrVoucherStoreUnavailable);
    }
    return {
      signer: this.signer,
      authorizerSigner: this.authorizerSigner,
      authorizerSubmitter: this.authorizerSubmitter,
      submitMode: this.submitMode,
      storage: this.voucherStore.storage,
      lockStorage: this.voucherStore.lockStorage,
      withdrawDelay: this.voucherStore.withdrawDelay,
      resolveCallerIdentity: this.resolveCallerIdentity,
      delegatedAuthStore: this.delegatedAuthStore,
      eip6492AllowedFactories: this.config.eip6492AllowedFactories,
      pendingStore: this.pendingStore,
    };
  }

  /**
   * Builds the submit context for claim and refund dispatchers.
   *
   * @returns Signers and submit mode.
   */
  private submitContext(): SubmitContext {
    return {
      submitMode: this.submitMode,
      signer: this.signer,
      authorizerSigner: this.authorizerSigner,
      authorizerSubmitter: this.authorizerSubmitter,
    };
  }

  /**
   * Binds caller identity after a successful self-managed deposit.
   *
   * @param payload - Payment envelope.
   * @param channelId - Deposited channel id.
   * @param requirements - Payment requirements.
   * @param context - Facilitator extension context.
   */
  private async bindSelfManagedCaller(
    payload: PaymentPayload,
    channelId: string,
    requirements: PaymentRequirements,
    context?: FacilitatorContext,
  ): Promise<void> {
    if (!this.resolveCallerIdentity || !this.delegatedAuthStore) {
      return;
    }
    const raw = payload.payload;
    const payer = isBatchSettlementDepositPayload(raw) ? raw.channelConfig.payer : undefined;
    const identity = await this.resolveCallerIdentity({
      step: "deposit",
      channelId,
      network: requirements.network,
      payer: payer ?? "",
      amount: isBatchSettlementDepositPayload(raw) ? raw.deposit.amount : undefined,
      payload,
      requirements,
      facilitatorContext: context,
    });
    if (!identity) {
      return;
    }
    await this.delegatedAuthStore.bind({
      channelId,
      network: requirements.network,
      callerIdentity: identity,
    });
  }

  /**
   * Checks unsigned self-managed refunds against the deposit-time identity.
   * A missing binding is allowed (legacy / cross-facilitator). Store errors fail closed.
   *
   * @param payload - Payment envelope.
   * @param raw - Enriched refund payload.
   * @param requirements - Payment requirements.
   * @param context - Facilitator extension context.
   * @returns Error code, or undefined when the refund may proceed.
   */
  private async checkSelfManagedRefundCaller(
    payload: PaymentPayload,
    raw: BatchSettlementEnrichedRefundPayload,
    requirements: PaymentRequirements,
    context?: FacilitatorContext,
  ): Promise<string | undefined> {
    if (raw.refundAuthorizerSignature || !this.resolveCallerIdentity) {
      return undefined;
    }
    if (!this.delegatedAuthStore) {
      return Errors.ErrRefundAuthorizerSignature;
    }
    let identity: string | undefined;
    try {
      identity = await this.resolveCallerIdentity({
        step: "refund",
        channelId: raw.voucher.channelId,
        network: requirements.network,
        payer: raw.channelConfig.payer,
        amount: raw.amount,
        payload,
        requirements,
        facilitatorContext: context,
      });
    } catch {
      return Errors.ErrRefundAuthorizerSignature;
    }
    if (!identity) {
      return Errors.ErrRefundAuthorizerSignature;
    }
    let binding: Awaited<ReturnType<DelegatedAuthStore["get"]>>;
    try {
      binding = await this.delegatedAuthStore.get(raw.voucher.channelId, requirements.network);
    } catch {
      return Errors.ErrRefundAuthorizerSignature;
    }
    if (!binding) {
      return undefined;
    }
    if (binding.callerIdentity !== identity) {
      return Errors.ErrRefundAuthorizerSignature;
    }
    return undefined;
  }
}
