import {
  AssetAmount,
  Network,
  PaymentRequirements,
  Price,
  SchemeNetworkServer,
  MoneyParser,
  SettlementTiming,
} from "@x402/core/types";
import { ExactEvmScheme } from "../../exact/server/scheme";

/**
 * EVM server for the upfront scheme. Delegates pricing to exact; settles before handler execution.
 */
export class UpfrontEvmScheme implements SchemeNetworkServer {
  readonly scheme = "upfront";
  readonly settlementTiming: SettlementTiming = "preExecute";
  private readonly exact = new ExactEvmScheme();

  /**
   * Registers a custom money parser for converting prices to asset amounts.
   *
   * @param parser - Custom money parser chained before the default conversion
   * @returns This instance for chaining
   */
  registerMoneyParser(parser: MoneyParser): UpfrontEvmScheme {
    this.exact.registerMoneyParser(parser);
    return this;
  }

  /**
   * Returns the decimal precision of the asset on the given network.
   *
   * @param asset - Asset identifier
   * @param network - Network identifier
   * @returns Decimal places for the asset
   */
  getAssetDecimals(asset: string, network: Network): number {
    return this.exact.getAssetDecimals(asset, network);
  }

  /**
   * Parses a price into an asset amount for the given network.
   *
   * @param price - Price to parse
   * @param network - Target network
   * @returns Parsed asset amount
   */
  parsePrice(price: Price, network: Network): Promise<AssetAmount> {
    return this.exact.parsePrice(price, network);
  }

  /**
   * Build payment requirements for this scheme/network combination.
   *
   * @param paymentRequirements - Base payment requirements
   * @param supportedKind - Facilitator supported kind metadata
   * @param supportedKind.x402Version - The x402 version
   * @param supportedKind.scheme - The logical payment scheme
   * @param supportedKind.network - The network identifier in CAIP-2 format
   * @param supportedKind.extra - Optional extra metadata regarding scheme/network implementation details
   * @param extensionKeys - Declared extension keys on the route
   * @returns Enhanced payment requirements
   */
  enhancePaymentRequirements(
    paymentRequirements: PaymentRequirements,
    supportedKind: {
      x402Version: number;
      scheme: string;
      network: Network;
      extra?: Record<string, unknown>;
    },
    extensionKeys: string[],
  ): Promise<PaymentRequirements> {
    return this.exact.enhancePaymentRequirements(paymentRequirements, supportedKind, extensionKeys);
  }
}
