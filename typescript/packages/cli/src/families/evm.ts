import type { Network } from "@x402/core/types";
import { networkMatchesPattern } from "@x402/core/utils";
import {
  DEFAULT_ASSETS,
  ExactEvmScheme,
  findDefaultAsset,
  UptoEvmScheme,
  type ClientEvmSigner,
} from "@x402/evm";
import { EVM_NETWORK_CHAIN_ID_MAP, ExactEvmSchemeV1, NETWORKS as V1_NETWORKS } from "@x402/evm/v1";
import { createPublicClient, erc20Abi, formatUnits, http, isHex, type Chain } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import * as chains from "viem/chains";
import { WalletError, type Balance, type NetworkFamily, type RpcUrls, type Signer } from "../types";

const DEFAULT_BALANCE_NETWORKS: Network[] = ["eip155:8453", "eip155:84532"];

const chainsById = new Map<number, Chain>(
  Object.values(chains as Record<string, Chain>)
    .filter(chain => typeof chain === "object" && typeof chain.id === "number")
    .map(chain => [chain.id, chain]),
);

/**
 * Parses an `eip155:<chainId>` network.
 *
 * @param network - CAIP-2 network
 * @returns The chain id, or undefined for non-EVM or wildcard networks
 */
function chainIdOf(network: string): number | undefined {
  const match = /^eip155:(\d+)$/.exec(network);
  return match ? Number(match[1]) : undefined;
}

/**
 * Picks the RPC URL for an EVM network: the configured override, else viem's default.
 *
 * @param network - CAIP-2 network
 * @param rpc - Configured overrides
 * @returns The RPC URL, or undefined when none is known
 */
function rpcUrlFor(network: Network, rpc: RpcUrls): string | undefined {
  const chainId = chainIdOf(network);
  return rpc[network] ?? (chainId ? chainsById.get(chainId)?.rpcUrls.default.http[0] : undefined);
}

/**
 * Narrows a wallet signer to the EVM client signer type.
 *
 * @param signer - Signer from a wallet
 * @returns The signer as a ClientEvmSigner
 */
function asEvmSigner(signer: Signer): ClientEvmSigner {
  const candidate = signer as Partial<ClientEvmSigner>;
  if (!isHex(candidate.address) || typeof candidate.signTypedData !== "function") {
    throw new WalletError("The wallet returned an EVM signer without an address or signTypedData.");
  }
  return candidate as ClientEvmSigner;
}

/**
 * Fetches default-asset balances on one EVM network.
 *
 * @param address - Account address
 * @param network - CAIP-2 network
 * @param rpc - Configured RPC overrides
 * @returns One balance per default asset
 */
async function networkBalances(
  address: string,
  network: Network,
  rpc: RpcUrls,
): Promise<Balance[]> {
  const assets = DEFAULT_ASSETS[network] ?? [];
  const url = rpcUrlFor(network, rpc);
  const client = url ? createPublicClient({ transport: http(url) }) : undefined;
  return Promise.all(
    assets.map(async ({ asset, symbol, decimals }): Promise<Balance> => {
      if (!client) return { network, asset, symbol, amount: "", error: "No RPC URL configured" };
      try {
        const raw = await client.readContract({
          address: asset as `0x${string}`,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [address as `0x${string}`],
        });
        return { network, asset, symbol, amount: formatUnits(raw, decimals) };
      } catch (error) {
        const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
        return { network, asset, symbol, amount: "", error: message };
      }
    }),
  );
}

/**
 * The EVM network family: `exact` and `upto` on `eip155:*`, keys as 0x hex private keys.
 *
 * @returns The EVM family
 */
export function evm(): NetworkFamily {
  return {
    id: "evm",
    network: "eip155:*",
    keys: {
      async generate() {
        return generatePrivateKey();
      },
      async toSigner(secret) {
        if (!/^0x[0-9a-fA-F]{64}$/.test(secret.trim())) {
          throw new WalletError("The EVM private key must be 0x followed by 64 hex characters.");
        }
        return privateKeyToAccount(secret.trim() as `0x${string}`);
      },
    },
    schemes(signer: Signer, rpc: RpcUrls) {
      const schemeOptions: Record<number, { rpcUrl: string }> = {};
      for (const network of new Set([...Object.keys(DEFAULT_ASSETS), ...Object.keys(rpc)])) {
        const chainId = chainIdOf(network);
        const rpcUrl = rpcUrlFor(network as Network, rpc);
        if (chainId && rpcUrl) schemeOptions[chainId] = { rpcUrl };
      }
      const evmSigner = asEvmSigner(signer);
      const exactV1 = new ExactEvmSchemeV1(evmSigner);
      return [
        { network: "eip155:*", client: new ExactEvmScheme(evmSigner, schemeOptions) },
        { network: "eip155:*", client: new UptoEvmScheme(evmSigner, schemeOptions) },
        ...V1_NETWORKS.map(name => ({ x402Version: 1, network: name as Network, client: exactV1 })),
      ];
    },
    fromV1Network(name) {
      const chainIds: Record<string, number> = EVM_NETWORK_CHAIN_ID_MAP;
      return Object.hasOwn(chainIds, name) ? `eip155:${chainIds[name]}` : undefined;
    },
    async balances(address, rpc, networks) {
      const targets = networks?.length
        ? networks.filter(network => networkMatchesPattern("eip155:*", network))
        : [...new Set([...DEFAULT_BALANCE_NETWORKS, ...(Object.keys(rpc) as Network[])])].filter(
            network => network.startsWith("eip155:") && DEFAULT_ASSETS[network],
          );
      const results = await Promise.all(
        targets.map(network => networkBalances(address, network, rpc)),
      );
      return results.flat();
    },
    formatAmount(amount, asset, network) {
      const known = findDefaultAsset(asset, network);
      return known ? `${formatUnits(BigInt(amount), known.decimals)} ${known.symbol}` : undefined;
    },
    describeNetwork(network) {
      const chainId = chainIdOf(network);
      const chain = chainId === undefined ? undefined : chainsById.get(chainId);
      return chain && { name: chain.name, testnet: chain.testnet === true };
    },
  };
}
