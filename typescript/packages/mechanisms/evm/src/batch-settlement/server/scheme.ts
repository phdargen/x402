import {
  AssetAmount,
  Network,
  PaymentFlowConfig,
  PaymentPayload,
  PaymentRequirements,
  Price,
  SchemeEnrichPaymentRequiredResponseHook,
  SchemeNetworkServer,
  SchemeServerHooks,
  MoneyParser,
  SupportedKind,
} from "@x402/core/types";
import type { DeepReadonly } from "@x402/core/types";
import { convertToTokenAmount, numberToDecimalString, parseMoney } from "@x402/core/utils";
import type { FacilitatorClient } from "@x402/core/server";
import type { BatchSettlementChannelManager } from "./channelManager";
import { findDefaultAsset, getDefaultAsset } from "../../defaultAssets";
import type {
  AuthorizerSigner,
  BatchSettlementAssetTransferMethod,
  BatchSettlementVoucherStoreMode,
} from "../types";
import { BATCH_SETTLEMENT_SCHEME } from "../constants";
import type { ChannelStorage, Channel } from "../storage";
import { DelegatedVoucherStore } from "./voucherStore/delegated";
import { SelfVoucherStore } from "./voucherStore/self";
import type {
  BatchSettlementEvmSchemeServerConfig,
  SchemeEnrichSettlementPayloadHook,
  SchemeEnrichSettlementResponseHook,
  SchemeVoucherStore,
} from "./voucherStore/types";

export type {
  BatchSettlementDelegatedServerConfig,
  BatchSettlementEvmSchemeServerConfig,
  BatchSettlementSelfServerConfig,
  SchemeVoucherStore,
} from "./voucherStore/types";

export interface BatchSettlementRequestContext {
  channelId?: string;
  pendingId?: string;
  channelSnapshot?: Channel;
  localVerify?: boolean;
  reservationCommitted?: boolean;
}

/**
 * Server-side implementation of the `batch-settlement` scheme for EVM networks.
 */
export class BatchSettlementEvmScheme implements SchemeNetworkServer {
  readonly scheme = BATCH_SETTLEMENT_SCHEME;
  readonly defaultAssetTransferMethod: BatchSettlementAssetTransferMethod = "eip3009";
  readonly paymentFlows = {
    eip3009: { supported: ["authorization"], default: "authorization" },
    permit2: { supported: ["authorization"], default: "authorization" },
  } as const satisfies Record<BatchSettlementAssetTransferMethod, PaymentFlowConfig>;
  readonly schemeHooks: SchemeServerHooks;

  /**
   * Set only in self-managed custody, where the server owns channel state. Facilitator-managed
   * custody leaves all three undefined: the facilitator's settle response is already the
   * payment response.
   */
  readonly enrichPaymentRequiredResponse?: SchemeEnrichPaymentRequiredResponseHook;
  readonly enrichSettlementPayload?: SchemeEnrichSettlementPayloadHook;
  readonly enrichSettlementResponse?: SchemeEnrichSettlementResponseHook;

  private readonly requestContexts = new WeakMap<
    DeepReadonly<PaymentPayload>,
    BatchSettlementRequestContext
  >();
  private moneyParsers: MoneyParser[] = [];
  private readonly receiverAddress: `0x${string}`;
  private readonly voucherStore: SchemeVoucherStore;

  /**
   * Constructs a batched server scheme.
   *
   * @param receiverAddress - The server's receiver address (payTo).
   * @param config - Optional configuration. Defaults to self-managed voucher custody with
   *   in-memory storage; pass `voucherStore: "delegated"` to hand custody to the facilitator.
   */
  constructor(receiverAddress: `0x${string}`, config?: BatchSettlementEvmSchemeServerConfig) {
    this.receiverAddress = receiverAddress;
    this.voucherStore =
      config?.voucherStore === "delegated"
        ? new DelegatedVoucherStore(this, config)
        : new SelfVoucherStore(this, config);
    this.schemeHooks = this.voucherStore.hooks;
    this.enrichPaymentRequiredResponse = this.voucherStore.enrichPaymentRequiredResponse;
    this.enrichSettlementPayload = this.voucherStore.enrichSettlementPayload;
    this.enrichSettlementResponse = this.voucherStore.enrichSettlementResponse;
  }

  /**
   * Merges batch-settlement state into the current request context.
   *
   * @param payload - Request-scoped payment payload object.
   * @param context - Partial context fields to merge.
   */
  mergeRequestContext(
    payload: DeepReadonly<PaymentPayload>,
    context: BatchSettlementRequestContext,
  ): void {
    this.requestContexts.set(payload, {
      ...this.requestContexts.get(payload),
      ...context,
    });
  }

  /**
   * Reads batch-settlement state for the current request without clearing it.
   *
   * @param payload - Request-scoped payment payload object.
   * @returns Request context, if one was recorded.
   */
  readRequestContext(
    payload: DeepReadonly<PaymentPayload>,
  ): BatchSettlementRequestContext | undefined {
    return this.requestContexts.get(payload);
  }

  /**
   * Reads and clears batch-settlement state for the current request.
   *
   * @param payload - Request-scoped payment payload object.
   * @returns Request context, if one was recorded.
   */
  takeRequestContext(
    payload: DeepReadonly<PaymentPayload>,
  ): BatchSettlementRequestContext | undefined {
    const context = this.requestContexts.get(payload);
    this.requestContexts.delete(payload);
    return context;
  }

  /**
   * Stores a channel snapshot for the current settlement request.
   *
   * @param payload - Request-scoped payment payload object.
   * @param channel - Channel state to use during response enrichment.
   */
  rememberChannelSnapshot(payload: DeepReadonly<PaymentPayload>, channel: Channel): void {
    this.mergeRequestContext(payload, {
      channelId: channel.channelId,
      channelSnapshot: channel,
    });
  }

  /**
   * Reads and clears a channel snapshot for the current settlement request.
   *
   * @param payload - Request-scoped payment payload object.
   * @returns Stored channel state, if one was recorded.
   */
  takeChannelSnapshot(payload: DeepReadonly<PaymentPayload>): Channel | undefined {
    return this.takeRequestContext(payload)?.channelSnapshot;
  }

  /**
   * Clears this request's pending reservation without touching newer reservations.
   *
   * @param payload - Request-scoped payment payload object.
   */
  async clearPendingRequest(payload: DeepReadonly<PaymentPayload>): Promise<void> {
    const context = this.takeRequestContext(payload);
    if (!context?.reservationCommitted || !context.channelId || !context.pendingId) {
      return;
    }

    await this.voucherStore.getStorage().updateChannel(context.channelId, current => {
      if (!current || current.pendingRequest?.pendingId !== context.pendingId) {
        return current;
      }

      if (!context.channelSnapshot) {
        return undefined;
      }

      return {
        ...current,
        pendingRequest: undefined,
      };
    });
  }

  /**
   * Registers a custom money parser for converting price strings to token amounts.
   *
   * @param parser - A parser function to try before the default USD→token conversion.
   * @returns `this` for chaining.
   */
  registerMoneyParser(parser: MoneyParser): BatchSettlementEvmScheme {
    this.moneyParsers.push(parser);
    return this;
  }

  /**
   * Resolves a human-readable price (e.g. `"$0.01"`) into an onchain token amount.
   *
   * @param price - A price string, number, or explicit {@link AssetAmount}.
   * @param network - CAIP-2 network identifier for looking up the default asset.
   * @returns Token amount with asset address and metadata.
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
   * Injects batched-specific fields into the payment requirements returned to
   * the client (receiverAuthorizer, withdrawDelay, and `voucherStore` in
   * facilitator-managed custody). Asset metadata (name, version,
   * assetTransferMethod) is left untouched — it is already set by `parsePrice`
   * or supplied explicitly by the caller, and is not re-derived from the
   * default-asset registry here so unlisted networks keep working.
   *
   * @param paymentRequirements - Base payment requirements from the middleware.
   * @param supportedKind - Matched scheme/network kind (extra may contain overrides).
   * @param supportedKind.x402Version - Protocol version from the matched kind.
   * @param supportedKind.scheme - Scheme name from the matched kind.
   * @param supportedKind.network - Network identifier from the matched kind.
   * @param supportedKind.extra - Optional extra fields on the matched kind.
   * @param _extensionKeys - Extension keys (unused).
   * @returns Enhanced payment requirements with batched fields in `extra`.
   */
  async enhancePaymentRequirements(
    paymentRequirements: PaymentRequirements,
    supportedKind: {
      x402Version: number;
      scheme: string;
      network: Network;
      extra?: Record<string, unknown>;
    },
    _extensionKeys: string[],
  ): Promise<PaymentRequirements> {
    void _extensionKeys;

    return {
      ...paymentRequirements,
      extra: {
        ...paymentRequirements.extra,
        ...this.voucherStore.requirementsExtra(supportedKind),
      },
    };
  }

  /**
   * Fails server startup when the facilitator cannot support this scheme's voucher-custody
   * mode: self-managed custody needs a receiver authorizer it can delegate to,
   * facilitator-managed custody needs a facilitator that advertises a voucher store.
   *
   * @param network - The network identifier being validated.
   * @param supportedKind - The facilitator's advertised kind for this scheme/network.
   * @param facilitatorExtensions - Extensions advertised by the facilitator.
   * @returns A problem message when the facilitator is unusable, or void when valid.
   */
  validateFacilitatorSupport(
    network: Network,
    supportedKind: SupportedKind,
    facilitatorExtensions: string[],
  ): string | void {
    return this.voucherStore.validateFacilitatorSupport(
      network,
      supportedKind,
      facilitatorExtensions,
    );
  }

  /**
   * Returns which side of the protocol owns the voucher store.
   *
   * @returns `"self"` when this server is authoritative, `"delegated"` when the facilitator is.
   */
  getVoucherStoreMode(): BatchSettlementVoucherStoreMode {
    return this.voucherStore.mode;
  }

  /**
   * Returns the underlying channel storage instance.
   *
   * @returns The configured {@link ChannelStorage} backend.
   * @throws In facilitator-managed custody when no `replicaStorage` is configured.
   */
  getStorage(): ChannelStorage {
    return this.voucherStore.getStorage();
  }

  /**
   * Returns the server's receiver address.
   *
   * @returns Receiver wallet address for the payment channel.
   */
  getReceiverAddress(): `0x${string}` {
    return this.receiverAddress;
  }

  /**
   * Returns the configured withdraw delay (seconds).
   *
   * @returns Withdraw delay in seconds before uncooperative withdrawal is allowed.
   */
  getWithdrawDelay(): number {
    return this.voucherStore.getWithdrawDelay();
  }

  /**
   * Returns how long mirrored onchain channel state is trusted for local voucher verification.
   *
   * @returns Freshness window in milliseconds; `0` in facilitator-managed custody.
   */
  getOnchainStateTtlMs(): number {
    return this.voucherStore.getOnchainStateTtlMs();
  }

  /**
   * Returns the receiver-authorizer signer, if configured.
   *
   * @returns Receiver-authorizer signer, or `undefined` when not set.
   */
  getReceiverAuthorizerSigner(): AuthorizerSigner | undefined {
    return this.voucherStore.getReceiverAuthorizerSigner();
  }

  /**
   * Creates a {@link BatchSettlementChannelManager} pre-configured with this scheme's
   * receiver, a token for the given network, and the provided facilitator.
   *
   * @param facilitator - Facilitator client for submitting onchain claims/settlements.
   * @param network - CAIP-2 network identifier (e.g. `"eip155:84532"`).
   * @param token - Explicit token address to use. Falls back to the network's
   *   default asset (from the registry) when omitted.
   * @returns A ready-to-use channel manager.
   * @throws In facilitator-managed custody when no `replicaStorage` is configured.
   */
  createChannelManager(
    facilitator: FacilitatorClient,
    network: Network,
    token?: `0x${string}`,
  ): BatchSettlementChannelManager {
    return this.voucherStore.createChannelManager(facilitator, network, token);
  }

  /**
   * Parses a human-readable money string (e.g. `"$1.50"`) into a decimal number.
   *
   * @param money - Money string (may include `$`) or numeric amount.
   * @returns Parsed finite number.
   */
  /**
   * Converts a decimal dollar amount to the network's default token amount.
   *
   * @param amount - Decimal amount in display units.
   * @param network - Target chain/network for default asset resolution.
   * @param symbol - Optional ticker from a suffixed price
   * @returns {@link AssetAmount} with integer token amount, contract address, and metadata.
   */
  private defaultMoneyConversion(amount: number, network: Network, symbol?: string): AssetAmount {
    const assetInfo = getDefaultAsset(network, symbol);
    const tokenAmount = convertToTokenAmount(numberToDecimalString(amount), assetInfo.decimals);

    // EIP-3009 tokens always need name/version for their transferWithAuthorization domain.
    // Permit2 tokens only need them if the token supports EIP-2612 (for gasless permit signing).
    // Omitting name/version for permit2 tokens signals the client to skip EIP-2612 and use
    // ERC-20 approval gas sponsoring instead.
    const includeEip712Domain = !assetInfo.assetTransferMethod || assetInfo.supportsEip2612;

    return {
      amount: tokenAmount,
      asset: assetInfo.asset,
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
