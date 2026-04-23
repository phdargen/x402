import {
  AssetAmount,
  Network,
  PaymentRequirements,
  Price,
  SchemeNetworkServer,
  SchemeServerHooks,
  MoneyParser,
} from "@x402/core/types";
import { convertToTokenAmount, numberToDecimalString } from "@x402/core/utils";
import type { FacilitatorClient } from "@x402/core/server";
import { BatchSettlementChannelManager } from "./channelManager";
import { getDefaultAsset } from "../../shared/defaultAssets";
import type { AuthorizerSigner } from "../types";
import { BATCH_SETTLEMENT_SCHEME, MIN_WITHDRAW_DELAY } from "../constants";
import { InMemorySessionStorage, SessionStorage } from "./storage";
import { handleAfterVerify, handleBeforeVerify } from "./verify";
import { handleAfterSettle, handleBeforeSettle } from "./settle";

export interface BatchSettlementEvmSchemeServerConfig {
  storage?: SessionStorage;
  receiverAuthorizerSigner?: AuthorizerSigner;
  withdrawDelay?: number;
}

/**
 * Server-side implementation of the `batch-settlement` scheme for EVM networks.
 */
export class BatchSettlementEvmScheme implements SchemeNetworkServer {
  readonly scheme = BATCH_SETTLEMENT_SCHEME;
  readonly schemeHooks: SchemeServerHooks;

  private moneyParsers: MoneyParser[] = [];
  private readonly storage: SessionStorage;
  private readonly receiverAuthorizerSigner: AuthorizerSigner | undefined;
  private readonly receiverAddress: `0x${string}`;
  private readonly withdrawDelay: number;

  /**
   * Constructs a batched server scheme.
   *
   * @param receiverAddress - The server's receiver address (payTo).
   * @param config - Optional configuration for storage, receiver-authorizer signer, and withdraw delay.
   */
  constructor(receiverAddress: `0x${string}`, config?: BatchSettlementEvmSchemeServerConfig) {
    this.receiverAddress = receiverAddress;
    this.storage = config?.storage ?? new InMemorySessionStorage();
    this.receiverAuthorizerSigner = config?.receiverAuthorizerSigner;
    this.withdrawDelay = config?.withdrawDelay ?? MIN_WITHDRAW_DELAY;
    this.schemeHooks = {
      onBeforeVerify: ctx => handleBeforeVerify(this, ctx),
      onAfterVerify: ctx => handleAfterVerify(this, ctx),
      onBeforeSettle: ctx => handleBeforeSettle(this, ctx),
      onAfterSettle: ctx => handleAfterSettle(this, ctx),
    };
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
   * Resolves a human-readable price (e.g. `"$0.01"`) into an on-chain token amount.
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

    const amount = this.parseMoneyToDecimal(price);

    for (const parser of this.moneyParsers) {
      const result = await parser(amount, network);
      if (result !== null) {
        return result;
      }
    }

    return this.defaultMoneyConversion(amount, network);
  }

  /**
   * Injects batched-specific fields into the payment requirements returned to
   * the client (receiverAuthorizer, withdrawDelay, EIP-712 domain info).
   *
   * @param paymentRequirements - Base payment requirements from the middleware.
   * @param _supportedKind - Matched scheme/network kind (extra may contain overrides).
   * @param _supportedKind.x402Version - Protocol version from the matched kind.
   * @param _supportedKind.scheme - Scheme name from the matched kind.
   * @param _supportedKind.network - Network identifier from the matched kind.
   * @param _supportedKind.extra - Optional extra fields on the matched kind.
   * @param _extensionKeys - Extension keys (unused).
   * @returns Enhanced payment requirements with batched fields in `extra`.
   */
  enhancePaymentRequirements(
    paymentRequirements: PaymentRequirements,
    _supportedKind: {
      x402Version: number;
      scheme: string;
      network: Network;
      extra?: Record<string, unknown>;
    },
    _extensionKeys: string[],
  ): Promise<PaymentRequirements> {
    void _supportedKind;
    void _extensionKeys;

    const assetInfo = getDefaultAsset(paymentRequirements.network as Network);

    const receiverAuthorizer = this.receiverAuthorizerSigner
      ? this.receiverAuthorizerSigner.address
      : (_supportedKind.extra?.receiverAuthorizer as string | undefined);

    return Promise.resolve({
      ...paymentRequirements,
      extra: {
        ...paymentRequirements.extra,
        receiverAuthorizer: receiverAuthorizer ?? "",
        withdrawDelay: this.withdrawDelay,
        name: assetInfo.name,
        version: assetInfo.version,
      },
    });
  }

  /**
   * Returns the underlying session storage instance.
   *
   * @returns The configured {@link SessionStorage} backend.
   */
  getStorage(): SessionStorage {
    return this.storage;
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
    return this.withdrawDelay;
  }

  /**
   * Returns the receiver-authorizer signer, if configured.
   *
   * @returns Receiver-authorizer signer, or `undefined` when not set.
   */
  getReceiverAuthorizerSigner(): AuthorizerSigner | undefined {
    return this.receiverAuthorizerSigner;
  }

  /**
   * Creates a {@link BatchSettlementChannelManager} pre-configured with this scheme's
   * receiver, default token for the given network, and the provided facilitator.
   *
   * @param facilitator - Facilitator client for submitting on-chain claims/settlements.
   * @param network - CAIP-2 network identifier (e.g. `"eip155:84532"`).
   * @returns A ready-to-use channel manager.
   */
  createChannelManager(
    facilitator: FacilitatorClient,
    network: Network,
  ): BatchSettlementChannelManager {
    const token = getDefaultAsset(network).address as `0x${string}`;
    return new BatchSettlementChannelManager({
      scheme: this,
      facilitator,
      receiver: this.receiverAddress,
      token,
      network,
    });
  }

  /**
   * Parses a human-readable money string (e.g. `"$1.50"`) into a decimal number.
   *
   * @param money - Money string (may include `$`) or numeric amount.
   * @returns Parsed finite number.
   */
  private parseMoneyToDecimal(money: string | number): number {
    if (typeof money === "number") {
      return money;
    }

    const cleanMoney = money.replace(/^\$/, "").trim();
    const amount = parseFloat(cleanMoney);

    if (isNaN(amount)) {
      throw new Error(`Invalid money format: ${money}`);
    }

    return amount;
  }

  /**
   * Converts a decimal dollar amount to the network's default token amount.
   *
   * @param amount - Decimal amount in display units.
   * @param network - Target chain/network for default asset resolution.
   * @returns {@link AssetAmount} with integer token amount, contract address, and metadata.
   */
  private defaultMoneyConversion(amount: number, network: Network): AssetAmount {
    const assetInfo = getDefaultAsset(network);
    const tokenAmount = convertToTokenAmount(numberToDecimalString(amount), assetInfo.decimals);

    return {
      amount: tokenAmount,
      asset: assetInfo.address,
      extra: {
        name: assetInfo.name,
        version: assetInfo.version,
      },
    };
  }
}
