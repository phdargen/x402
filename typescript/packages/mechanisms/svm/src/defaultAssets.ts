import type {
  DefaultAsset,
  DefaultAssetTable,
  FindDefaultAsset,
  GetDefaultAsset,
  Network,
} from "@x402/core/types";
import {
  SOLANA_DEVNET_CAIP2,
  SOLANA_MAINNET_CAIP2,
  SOLANA_TESTNET_CAIP2,
  USDC_DEVNET_ADDRESS,
  USDC_MAINNET_ADDRESS,
  USDC_TESTNET_ADDRESS,
} from "./constants";
import { normalizeNetwork } from "./constants";

export type SvmDefaultAsset = DefaultAsset;

/** Default USD-pegged assets by CAIP-2 network; index 0 is the `"$0.10"` default. */
export const DEFAULT_ASSETS: DefaultAssetTable<SvmDefaultAsset> = {
  [SOLANA_MAINNET_CAIP2]: [{ asset: USDC_MAINNET_ADDRESS, decimals: 6, symbol: "USDC" }],
  [SOLANA_DEVNET_CAIP2]: [{ asset: USDC_DEVNET_ADDRESS, decimals: 6, symbol: "USDC" }],
  [SOLANA_TESTNET_CAIP2]: [{ asset: USDC_TESTNET_ADDRESS, decimals: 6, symbol: "USDC" }],
};

/**
 * Map CAIP-2 or v1 name to a {@link DEFAULT_ASSETS} key.
 *
 * @param network - CAIP-2 or legacy Solana network id
 * @returns Normalized CAIP-2 network key
 */
function resolveNetworkKey(network: Network): string {
  return normalizeNetwork(network);
}

/**
 * Look up a default asset by network and optional ticker.
 *
 * @param network - CAIP-2 or v1 network
 * @param symbol - Ticker; omit for the network default
 * @returns Matching entry
 * @throws If network or ticker is unknown
 */
export const getDefaultAsset: GetDefaultAsset<SvmDefaultAsset> = (network, symbol?) => {
  const key = resolveNetworkKey(network);
  const assets = DEFAULT_ASSETS[key];
  if (!assets || assets.length === 0) {
    throw new Error(`No default asset configured for network ${network}`);
  }
  if (!symbol) {
    return assets[0];
  }
  const normalized = symbol.toUpperCase();
  const match = assets.find(entry => entry.symbol.toUpperCase() === normalized);
  if (!match) {
    throw new Error(`No ${symbol} default asset configured for network ${network}`);
  }
  return match;
};

/**
 * Reverse lookup by asset id and network.
 *
 * @param asset - Mint address from payment requirements
 * @param network - CAIP-2 or v1 network
 * @returns Matching entry, or undefined
 */
export const findDefaultAsset: FindDefaultAsset<SvmDefaultAsset> = (asset, network) => {
  const key = resolveNetworkKey(network);
  const assets = DEFAULT_ASSETS[key];
  if (!assets) {
    return undefined;
  }
  return assets.find(entry => entry.asset === asset);
};
