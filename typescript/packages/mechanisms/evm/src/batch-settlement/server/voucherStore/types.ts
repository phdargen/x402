import type {
  Network,
  SchemeEnrichPaymentRequiredResponseHook,
  SchemeServerHooks,
  SettleContext,
  SettleResultContext,
  SupportedKind,
} from "@x402/core/types";
import type { FacilitatorClient } from "@x402/core/server";
import type { ChannelStorage } from "../../storage";
import type { AuthorizerSigner, BatchSettlementVoucherStoreMode } from "../../types";
import type { BatchSettlementChannelManager } from "../channelManager";

// Core declares these two hook shapes inline on `SchemeNetworkServer` without exporting
// the aliases; structural typing keeps the local copies interchangeable.
export type SchemeEnrichSettlementPayloadHook = (
  ctx: SettleContext,
) => Promise<Record<string, unknown> | void>;

export type SchemeEnrichSettlementResponseHook = (
  ctx: SettleResultContext,
) => Promise<Record<string, unknown> | void>;

export type BatchSettlementSelfServerConfig = {
  /** Keeps the resource server authoritative for channel state. This is the default. */
  voucherStore?: "self";
  storage?: ChannelStorage;
  receiverAuthorizerSigner?: AuthorizerSigner;
  withdrawDelay?: number;
  onchainStateTtlMs?: number;
};

export type BatchSettlementDelegatedServerConfig = {
  /**
   * Hands voucher custody to the facilitator: the server forwards every payload to
   * `/verify` and `/settle` and keeps no authoritative state. Only valid against a
   * facilitator that advertises `voucherStore: true`.
   */
  voucherStore: "delegated";
  /**
   * Optional copy of the latest voucher per channel, written after a successful settle.
   * Never drives cumulative checks, locks, or corrective 402s — it exists so the receiver
   * can claim or refund out of band.
   */
  replicaStorage?: ChannelStorage;
};

export type BatchSettlementEvmSchemeServerConfig =
  | BatchSettlementSelfServerConfig
  | BatchSettlementDelegatedServerConfig;

/** The `supportedKind` shape core passes to `enhancePaymentRequirements`. */
export type EnhanceSupportedKind = {
  x402Version: number;
  scheme: string;
  network: Network;
  extra?: Record<string, unknown>;
};

/**
 * Everything that differs between the two voucher-custody modes, selected once in the
 * scheme constructor. Self-managed mode owns channel state and runs the full hook set;
 * facilitator-managed mode is a pass-through with a single post-verify hook.
 */
export interface SchemeVoucherStore {
  readonly mode: BatchSettlementVoucherStoreMode;
  readonly hooks: SchemeServerHooks;
  readonly enrichPaymentRequiredResponse?: SchemeEnrichPaymentRequiredResponseHook;
  readonly enrichSettlementPayload?: SchemeEnrichSettlementPayloadHook;
  readonly enrichSettlementResponse?: SchemeEnrichSettlementResponseHook;

  /**
   * Channel store backing this mode.
   *
   * @returns The channel storage the server may read and write.
   * @throws In facilitator-managed mode when no replica is configured.
   */
  getStorage(): ChannelStorage;
  getWithdrawDelay(): number;
  getOnchainStateTtlMs(): number;
  getReceiverAuthorizerSigner(): AuthorizerSigner | undefined;

  /**
   * Builds the batch-settlement fields to merge into the 402 `extra`.
   *
   * @param supportedKind - Matched facilitator kind for this scheme/network.
   * @returns Extra fields describing this server's channel parameters.
   */
  requirementsExtra(supportedKind: EnhanceSupportedKind): Record<string, unknown>;

  /**
   * Reports a facilitator that cannot support this mode, failing server startup.
   *
   * @param network - Network being validated.
   * @param supportedKind - Facilitator's advertised kind for this scheme/network.
   * @param facilitatorExtensions - Extensions advertised by the facilitator.
   * @returns A problem message, or void when the facilitator is usable.
   */
  validateFacilitatorSupport(
    network: Network,
    supportedKind: SupportedKind,
    facilitatorExtensions: string[],
  ): string | void;

  /**
   * Creates the claim/settle manager for this mode.
   *
   * @param facilitator - Facilitator client for submitting onchain claims/settlements.
   * @param network - CAIP-2 network identifier.
   * @param token - Explicit token address; defaults to the network's default asset.
   * @returns A ready-to-use channel manager.
   */
  createChannelManager(
    facilitator: FacilitatorClient,
    network: Network,
    token?: `0x${string}`,
  ): BatchSettlementChannelManager;
}
