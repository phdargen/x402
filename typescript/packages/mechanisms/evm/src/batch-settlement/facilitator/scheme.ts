import {
  Network,
  PaymentPayload,
  PaymentRequirements,
  SchemeNetworkFacilitator,
  FacilitatorContext,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import { FacilitatorEvmSigner } from "../../signer";
import { BATCH_SETTLEMENT_SCHEME, MAX_WITHDRAW_DELAY, MIN_WITHDRAW_DELAY } from "../constants";
import {
  isBatchSettlementDepositPayload,
  isBatchSettlementVoucherPayload,
  isBatchSettlementClaimPayload,
  isBatchSettlementSettlePayload,
  isBatchSettlementRefundPayload,
  isBatchSettlementEnrichedRefundPayload,
  voucherStoreMode,
} from "../types";
import type { AuthorizerSigner, BatchSettlementSupportedExtra } from "../types";
import { verifyDeposit, settleDeposit } from "./deposit";
import { verifyVoucher } from "./voucher";
import { executeClaimWithSignature } from "./claim";
import { executeSettle } from "./settle";
import { executeRefundWithSignature } from "./refund";
import {
  BatchSettlementVoucherStore,
  BatchSettlementVoucherStoreManager,
  delegatedVerify,
  persistDepositSettlement,
  settleDelegatedVoucher,
  type BatchSettlementVoucherStoreConfig,
} from "./voucherStore";
import { resolveDataSuffix } from "../../shared/extensions";
import * as Errors from "../errors";

type BatchSettlementEvmSchemeBaseConfig = {
  /**
   * Allowlist of factory contract addresses (hex strings, case-insensitive) the facilitator
   * will call to deploy an undeployed (ERC-6492 counterfactual) smart wallet before an
   * ERC-3009 deposit. An empty or omitted list denies all factory deployment (feature
   * disabled by default).
   *
   * @default []
   */
  eip6492AllowedFactories?: string[];
};

/**
 * Facilitator configuration. Providing `voucherStore` opts into facilitator-managed
 * voucher custody: the facilitator becomes the authoritative store for the channels of
 * servers that accept the `voucherStore: true` handshake.
 */
export type BatchSettlementEvmSchemeConfig = BatchSettlementEvmSchemeBaseConfig &
  ({ voucherStore?: undefined } | { voucherStore: BatchSettlementVoucherStoreConfig });

/**
 * Facilitator-side implementation of the `batch-settlement` scheme for EVM networks.
 *
 * Routes incoming verify/settle requests to the appropriate handler based on payload
 * type (deposit, voucher, claim, settle, refund).
 */
export class BatchSettlementEvmScheme implements SchemeNetworkFacilitator {
  readonly scheme = BATCH_SETTLEMENT_SCHEME;
  readonly caipFamily = "eip155:*";
  private readonly eip6492AllowedFactories: string[];
  private readonly voucherStore: BatchSettlementVoucherStore | undefined;

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
   * @param config - Optional configuration (ERC-6492 factory allowlist, voucher store).
   */
  constructor(
    private readonly signer: FacilitatorEvmSigner,
    private readonly authorizerSigner?: AuthorizerSigner,
    config?: BatchSettlementEvmSchemeConfig,
  ) {
    this.eip6492AllowedFactories = config?.eip6492AllowedFactories ?? [];

    if (!config?.voucherStore) {
      this.voucherStore = undefined;
      return;
    }

    // The spec pairs voucherStore with receiverAuthorizer: holding the vouchers is only
    // useful if the facilitator can also authorize the claims that redeem them.
    if (!authorizerSigner) {
      throw new Error(
        "batch-settlement voucherStore requires an authorizerSigner so the facilitator can " +
          "advertise a receiverAuthorizer and claim the vouchers it stores",
      );
    }

    const { withdrawDelay } = config.voucherStore;
    if (withdrawDelay < MIN_WITHDRAW_DELAY || withdrawDelay > MAX_WITHDRAW_DELAY) {
      throw new Error(
        `batch-settlement voucherStore withdrawDelay must be between ${MIN_WITHDRAW_DELAY} and ` +
          `${MAX_WITHDRAW_DELAY} seconds, got ${withdrawDelay}`,
      );
    }

    this.voucherStore = new BatchSettlementVoucherStore(config.voucherStore);
  }

  /**
   * Returns facilitator-specific extra fields to be merged into payment requirements.
   *
   * Exposes the configured `receiverAuthorizer` address so the server and client can
   * embed it in `ChannelConfig`. Returns `undefined` when no authorizer signer is
   * configured, signalling that servers must supply their own authorizer signatures.
   * When a voucher store is configured it also advertises `voucherStore: true` and the
   * `withdrawDelay` every managed channel must use.
   *
   * @param _ - Network identifier (unused).
   * @returns Advertised extra fields, or `undefined`.
   */
  getExtra(_: string): BatchSettlementSupportedExtra | undefined {
    if (!this.authorizerSigner) {
      return undefined;
    }
    const receiverAuthorizer = this.authorizerSigner.address;
    if (!this.voucherStore) {
      return { receiverAuthorizer };
    }
    return {
      voucherStore: true,
      receiverAuthorizer,
      withdrawDelay: this.voucherStore.withdrawDelay,
    };
  }

  /**
   * Returns the facilitator's voucher store, when facilitator-managed custody is enabled.
   *
   * @returns The configured voucher store, or `undefined` in self-managed deployments.
   */
  getVoucherStore(): BatchSettlementVoucherStore | undefined {
    return this.voucherStore;
  }

  /**
   * Creates the manager that claims and settles the vouchers this facilitator holds.
   *
   * @param network - CAIP-2 network identifier the manager operates on.
   * @param options - Claim-urgency policy overrides.
   * @param options.urgencyRatio - Fraction of the withdraw delay after which a withdrawing
   *   channel is claimed ahead of the others.
   * @returns A ready-to-use voucher-store manager.
   * @throws When no voucher store is configured.
   */
  createVoucherStoreManager(
    network: Network,
    options?: { urgencyRatio?: number },
  ): BatchSettlementVoucherStoreManager {
    if (!this.voucherStore || !this.authorizerSigner) {
      throw new Error(
        "createVoucherStoreManager requires a configured voucherStore and authorizerSigner",
      );
    }
    return new BatchSettlementVoucherStoreManager({
      store: this.voucherStore,
      signer: this.signer,
      authorizerSigner: this.authorizerSigner,
      network,
      urgencyRatio: options?.urgencyRatio,
    });
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

    const store = this.resolveVoucherStore(requirements);
    if (store === "unsupported") {
      return { isValid: false, invalidReason: Errors.ErrInvalidPayloadType };
    }

    if (isBatchSettlementDepositPayload(rawPayload)) {
      const deposit = rawPayload;
      const runBaseVerify = () =>
        verifyDeposit(
          this.signer,
          payload,
          deposit,
          requirements,
          context,
          this.eip6492AllowedFactories,
        );
      return store ? delegatedVerify(store, deposit, requirements, runBaseVerify) : runBaseVerify();
    }

    if (isBatchSettlementVoucherPayload(rawPayload)) {
      const voucher = rawPayload;
      const runBaseVerify = () =>
        verifyVoucher(this.signer, voucher, requirements, voucher.channelConfig);
      return store ? delegatedVerify(store, voucher, requirements, runBaseVerify) : runBaseVerify();
    }

    if (isBatchSettlementRefundPayload(rawPayload)) {
      if (store) {
        return {
          isValid: false,
          invalidReason: Errors.ErrInvalidPayloadType,
          invalidMessage: "refunds are not supported in facilitator-managed voucher custody",
          payer: rawPayload.channelConfig.payer,
        };
      }
      return verifyVoucher(this.signer, rawPayload, requirements, rawPayload.channelConfig);
    }

    return { isValid: false, invalidReason: Errors.ErrInvalidPayloadType };
  }

  /**
   * Executes settlement for a payment payload.
   *
   * Dispatches to the correct handler based on payload settle action:
   * - `deposit` → onchain `deposit(config, amount, collector, collectorData)`
   * - `claim` → onchain `claimWithSignature(VoucherClaim[], bytes)`
   * - `settle` → onchain `settle(receiver, token)`
   * - `refund` → optional claim + onchain `refundWithSignature(config, amount, nonce, sig)`
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

    const store = this.resolveVoucherStore(requirements);
    if (store === "unsupported") {
      return this.invalidPayloadType(requirements);
    }

    if (isBatchSettlementDepositPayload(rawPayload)) {
      const result = await settleDeposit(
        this.signer,
        payload,
        rawPayload,
        requirements,
        context,
        dataSuffix,
        this.eip6492AllowedFactories,
      );
      return store ? persistDepositSettlement(store, rawPayload, requirements, result) : result;
    }

    // A voucher settle is a durable offchain write, so it only exists where the
    // facilitator owns the store. Self-managed servers commit it themselves.
    if (isBatchSettlementVoucherPayload(rawPayload)) {
      if (!store) {
        return this.invalidPayloadType(requirements);
      }
      return settleDelegatedVoucher(store, rawPayload, requirements);
    }

    if (isBatchSettlementClaimPayload(rawPayload)) {
      return executeClaimWithSignature(
        this.signer,
        rawPayload,
        requirements,
        this.authorizerSigner,
        dataSuffix,
      );
    }

    if (isBatchSettlementEnrichedRefundPayload(rawPayload)) {
      if (store) {
        return this.invalidPayloadType(requirements);
      }
      return executeRefundWithSignature(
        this.signer,
        rawPayload,
        requirements,
        this.authorizerSigner,
        dataSuffix,
      );
    }

    if (isBatchSettlementSettlePayload(rawPayload)) {
      return executeSettle(this.signer, rawPayload, requirements, dataSuffix);
    }

    return this.invalidPayloadType(requirements);
  }

  /**
   * Resolves which custody mode this request runs in.
   *
   * The mode is the server's choice, taken from `requirements.extra.voucherStore`, so a
   * facilitator with a store still serves self-managed servers statelessly.
   *
   * @param requirements - Payment requirements for the request.
   * @returns The store for facilitator-managed requests, `undefined` for self-managed
   *   requests, or `"unsupported"` when the server asked for a store this facilitator
   *   does not run.
   */
  private resolveVoucherStore(
    requirements: PaymentRequirements,
  ): BatchSettlementVoucherStore | undefined | "unsupported" {
    if (voucherStoreMode(requirements.extra) === "self") {
      return undefined;
    }
    return this.voucherStore ?? "unsupported";
  }

  /**
   * Builds the settle response for a payload this facilitator will not process.
   *
   * @param requirements - Payment requirements for the request.
   * @returns Failed {@link SettleResponse} with `invalid_batch_settlement_evm_payload_type`.
   */
  private invalidPayloadType(requirements: PaymentRequirements): SettleResponse {
    return {
      success: false,
      errorReason: Errors.ErrInvalidPayloadType,
      transaction: "",
      network: requirements.network,
    };
  }
}
