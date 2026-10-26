import {
  address,
  createKeyPairFromPrivateKeyBytes,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  getAddressEncoder,
  getAddressFromPublicKey,
  getBase58Decoder,
  getBase58Encoder,
  isTransactionSigner,
  type TransactionSigner,
} from "@solana/kit";
import type { SchemeRegistration } from "@x402/core/client";
import type { Network } from "@x402/core/types";
import { networkMatchesPattern } from "@x402/core/utils";
import {
  DEFAULT_ASSETS,
  DEVNET_RPC_URL,
  ExactSvmScheme,
  findDefaultAsset,
  MAINNET_RPC_URL,
  SOLANA_DEVNET_CAIP2,
  SOLANA_MAINNET_CAIP2,
  SOLANA_TESTNET_CAIP2,
  TESTNET_RPC_URL,
  UptoSvmScheme,
  V1_TO_V2_NETWORK_MAP,
} from "@x402/svm";
import { ExactSvmSchemeV1 } from "@x402/svm/v1";
import {
  WalletError,
  type Balance,
  type NetworkFamily,
  type NetworkInfo,
  type RpcUrls,
  type Signer,
} from "../types";

const DEFAULT_RPC_URLS: Record<string, string> = {
  [SOLANA_MAINNET_CAIP2]: MAINNET_RPC_URL,
  [SOLANA_DEVNET_CAIP2]: DEVNET_RPC_URL,
  [SOLANA_TESTNET_CAIP2]: TESTNET_RPC_URL,
};

const NETWORK_INFO: Record<string, NetworkInfo> = {
  [SOLANA_MAINNET_CAIP2]: { name: "Solana", testnet: false },
  [SOLANA_DEVNET_CAIP2]: { name: "Solana Devnet", testnet: true },
  [SOLANA_TESTNET_CAIP2]: { name: "Solana Testnet", testnet: true },
};

const DEFAULT_BALANCE_NETWORKS: Network[] = [SOLANA_MAINNET_CAIP2, SOLANA_DEVNET_CAIP2];

/**
 * Formats an atomic amount with the given decimals.
 *
 * @param atomic - Integer amount
 * @param decimals - Token decimals
 * @returns Decimal string without trailing zeros
 */
function formatAtomic(atomic: bigint, decimals: number): string {
  const text = atomic.toString().padStart(decimals + 1, "0");
  const whole = text.slice(0, text.length - decimals);
  const fraction = text.slice(text.length - decimals).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

/**
 * Narrows a wallet signer to a Solana transaction signer.
 *
 * @param signer - Signer from a wallet
 * @returns The signer as a TransactionSigner
 */
function asSvmSigner(signer: Signer): TransactionSigner {
  if (!isTransactionSigner(signer as TransactionSigner)) {
    throw new WalletError("The wallet returned an SVM signer that cannot sign transactions.");
  }
  return signer as TransactionSigner;
}

/**
 * Fetches default-asset balances on one Solana network.
 *
 * @param owner - Account address
 * @param network - CAIP-2 network
 * @param rpc - Configured RPC overrides
 * @returns One balance per default asset
 */
async function networkBalances(owner: string, network: Network, rpc: RpcUrls): Promise<Balance[]> {
  const url = rpc[network] ?? DEFAULT_RPC_URLS[network];
  const assets = DEFAULT_ASSETS[network] ?? [];
  const client = url ? createSolanaRpc(url) : undefined;
  return Promise.all(
    assets.map(async ({ asset, symbol, decimals }): Promise<Balance> => {
      if (!client) return { network, asset, symbol, amount: "", error: "No RPC URL configured" };
      try {
        const { value } = await client
          .getTokenAccountsByOwner(
            address(owner),
            { mint: address(asset) },
            { encoding: "jsonParsed" },
          )
          .send();
        const total = value.reduce(
          (sum, account) => sum + BigInt(account.account.data.parsed.info.tokenAmount.amount),
          0n,
        );
        return { network, asset, symbol, amount: formatAtomic(total, decimals) };
      } catch (error) {
        const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
        return { network, asset, symbol, amount: "", error: message };
      }
    }),
  );
}

/**
 * The SVM network family: `exact` and `upto` on `solana:*`, keys as base58 64-byte secret keys.
 *
 * @returns The SVM family
 */
export function svm(): NetworkFamily {
  return {
    id: "svm",
    network: "solana:*",
    keys: {
      async generate() {
        const seed = crypto.getRandomValues(new Uint8Array(32));
        const pair = await createKeyPairFromPrivateKeyBytes(seed, true);
        const publicKey = getAddressEncoder().encode(await getAddressFromPublicKey(pair.publicKey));
        const secret = new Uint8Array(64);
        secret.set(seed, 0);
        secret.set(publicKey, 32);
        return getBase58Decoder().decode(secret);
      },
      async toSigner(secret) {
        let bytes: Uint8Array;
        try {
          bytes = new Uint8Array(getBase58Encoder().encode(secret.trim()));
        } catch {
          throw new WalletError("The SVM secret key must be base58.");
        }
        if (bytes.length !== 64) {
          throw new WalletError(
            "The SVM secret key must decode to 64 bytes (Phantom export format).",
          );
        }
        return createKeyPairSignerFromBytes(bytes);
      },
    },
    schemes(signer: Signer, rpc: RpcUrls) {
      const svmSigner = asSvmSigner(signer);
      const schemes: SchemeRegistration[] = [
        { network: "solana:*", client: new ExactSvmScheme(svmSigner) },
        { network: "solana:*", client: new UptoSvmScheme(svmSigner) },
        ...Object.entries(V1_TO_V2_NETWORK_MAP).map(([name, network]) => ({
          x402Version: 1,
          network: name as Network,
          client: new ExactSvmSchemeV1(svmSigner, { rpcUrl: rpc[network as Network] }),
        })),
      ];
      for (const [network, rpcUrl] of Object.entries(rpc) as [Network, string | undefined][]) {
        if (!rpcUrl || !networkMatchesPattern("solana:*", network)) continue;
        schemes.push(
          { network, client: new ExactSvmScheme(svmSigner, { rpcUrl }) },
          { network, client: new UptoSvmScheme(svmSigner, { rpcUrl }) },
        );
      }
      return schemes;
    },
    fromV1Network(name) {
      return Object.hasOwn(V1_TO_V2_NETWORK_MAP, name)
        ? (V1_TO_V2_NETWORK_MAP[name] as Network)
        : undefined;
    },
    async balances(owner, rpc, networks) {
      const targets = networks?.length
        ? networks.filter(network => networkMatchesPattern("solana:*", network))
        : [...new Set([...DEFAULT_BALANCE_NETWORKS, ...(Object.keys(rpc) as Network[])])].filter(
            network => network.startsWith("solana:") && DEFAULT_ASSETS[network],
          );
      const results = await Promise.all(
        targets.map(network => networkBalances(owner, network, rpc)),
      );
      return results.flat();
    },
    formatAmount(amount, asset, network) {
      const known = findDefaultAsset(asset, network);
      return known ? `${formatAtomic(BigInt(amount), known.decimals)} ${known.symbol}` : undefined;
    },
    describeNetwork(network) {
      return Object.hasOwn(NETWORK_INFO, network) ? NETWORK_INFO[network] : undefined;
    },
  };
}
