/**
 * Env-driven multi-chain registration for x402 examples.
 *
 * New chain support should be added here in alphabetic order by network prefix
 * (e.g., "algorand" before "eip155" before "solana").
 */

import { toClientAvmSigner } from "@x402/avm";
import { ExactAvmScheme } from "@x402/avm/exact/client";
import { toFacilitatorAvmSigner } from "@x402/avm";
import { ExactAvmScheme as ExactAvmFacilitatorScheme } from "@x402/avm/exact/facilitator";
import { ExactAvmScheme as ExactAvmServerScheme } from "@x402/avm/exact/server";
import type { x402Client } from "@x402/fetch";
import { x402Facilitator } from "@x402/core/facilitator";
import type { x402ResourceServer } from "@x402/express";
import type { Network, Price } from "@x402/core/types";
import { toFacilitatorEvmSigner } from "@x402/evm";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { ExactEvmScheme as ExactEvmFacilitatorScheme } from "@x402/evm/exact/facilitator";
import { ExactEvmScheme as ExactEvmServerScheme } from "@x402/evm/exact/server";
import { UptoEvmScheme } from "@x402/evm/upto/client";
import { UptoEvmScheme as UptoEvmFacilitatorScheme } from "@x402/evm/upto/facilitator";
import {
  AccountId,
  Client,
  PrivateKey,
  createClientHederaSigner,
  createHederaClient,
  createHederaPreflightTransfer,
  createHederaSignAndSubmitTransaction,
  toFacilitatorHederaSigner,
} from "@x402/hedera";
import { ExactHederaScheme } from "@x402/hedera/exact/client";
import { ExactHederaScheme as ExactHederaFacilitatorScheme } from "@x402/hedera/exact/facilitator";
import { ExactHederaScheme as ExactHederaServerScheme } from "@x402/hedera/exact/server";
import { toFacilitatorSvmSigner } from "@x402/svm";
import { ExactSvmScheme } from "@x402/svm/exact/client";
import { ExactSvmScheme as ExactSvmFacilitatorScheme } from "@x402/svm/exact/facilitator";
import { ExactSvmScheme as ExactSvmServerScheme } from "@x402/svm/exact/server";
import { createEd25519Signer } from "@x402/stellar";
import { ExactStellarScheme } from "@x402/stellar/exact/client";
import { ExactStellarScheme as ExactStellarFacilitatorScheme } from "@x402/stellar/exact/facilitator";
import { ExactStellarScheme as ExactStellarServerScheme } from "@x402/stellar/exact/server";
import { base58 } from "@scure/base";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { createWalletClient, http, publicActions } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { optionalEnv } from "./env.js";

/** Default testnet network identifiers used across examples. */
export const NETWORKS = {
  AVM: "algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=" as const,
  EVM: "eip155:84532" as const,
  HEDERA: "hedera:testnet" as const,
  SVM: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" as const,
  STELLAR: "stellar:testnet" as const,
};

const HEDERA_HBAR_ASSET = "0.0.0" as const;
const HEDERA_WEATHER_PRICE_TINYBARS = "100000" as const;

type AcceptEntry = {
  scheme: string;
  price: Price;
  network: Network;
  payTo: string;
};

/**
 * Returns true when at least one client network key is configured.
 *
 * @returns Whether any client network env vars are set
 */
export function hasClientNetworkConfig(): boolean {
  return Boolean(
    optionalEnv("AVM_PRIVATE_KEY") ||
      optionalEnv("EVM_PRIVATE_KEY") ||
      optionalEnv("SVM_PRIVATE_KEY") ||
      optionalEnv("STELLAR_PRIVATE_KEY") ||
      (optionalEnv("HEDERA_ACCOUNT_ID") && optionalEnv("HEDERA_PRIVATE_KEY")),
  );
}

/**
 * Returns true when at least one server network address is configured.
 *
 * @returns Whether any server network env vars are set
 */
export function hasServerNetworkConfig(): boolean {
  return Boolean(
    optionalEnv("AVM_ADDRESS") ||
      optionalEnv("EVM_ADDRESS") ||
      optionalEnv("SVM_ADDRESS") ||
      optionalEnv("STELLAR_ADDRESS") ||
      optionalEnv("HEDERA_ACCOUNT_ID"),
  );
}

/**
 * Returns true when at least one facilitator network key is configured.
 *
 * @returns Whether any facilitator network env vars are set
 */
export function hasFacilitatorNetworkConfig(): boolean {
  return hasClientNetworkConfig();
}

/**
 * Registers client payment schemes for every configured network.
 *
 * @param client - x402 HTTP client to register schemes on
 * @returns Whether at least one network was registered
 */
export async function registerClientNetworks(client: x402Client): Promise<boolean> {
  const avmPrivateKey = optionalEnv("AVM_PRIVATE_KEY");
  const evmPrivateKey = optionalEnv("EVM_PRIVATE_KEY") as `0x${string}` | undefined;
  const svmPrivateKey = optionalEnv("SVM_PRIVATE_KEY");
  const stellarPrivateKey = optionalEnv("STELLAR_PRIVATE_KEY");
  const hederaAccountId = optionalEnv("HEDERA_ACCOUNT_ID");
  const hederaPrivateKey = optionalEnv("HEDERA_PRIVATE_KEY");
  const hederaNetwork = process.env.HEDERA_NETWORK || "hedera:testnet";
  const evmRpcUrl = optionalEnv("EVM_RPC_URL");
  const rpcOptions = evmRpcUrl ? { rpcUrl: evmRpcUrl } : undefined;

  let registered = false;

  if (avmPrivateKey) {
    const avmSigner = toClientAvmSigner(avmPrivateKey);
    client.register("algorand:*", new ExactAvmScheme(avmSigner));
    console.log(`Initialized AVM account: ${avmSigner.address}`);
    registered = true;
  }

  if (evmPrivateKey) {
    const evmSigner = privateKeyToAccount(evmPrivateKey);
    client.register("eip155:*", new ExactEvmScheme(evmSigner, rpcOptions));
    client.register("eip155:*", new UptoEvmScheme(evmSigner, rpcOptions));
    console.log(`Initialized EVM account: ${evmSigner.address}`);
    registered = true;
  }

  if (svmPrivateKey) {
    const svmSigner = await createKeyPairSignerFromBytes(base58.decode(svmPrivateKey));
    client.register("solana:*", new ExactSvmScheme(svmSigner));
    console.log(`Initialized SVM account: ${svmSigner.address}`);
    registered = true;
  }

  if (hederaAccountId && hederaPrivateKey) {
    const hederaSigner = createClientHederaSigner(
      hederaAccountId,
      PrivateKey.fromStringECDSA(hederaPrivateKey),
      { network: hederaNetwork },
    );
    client.register("hedera:*", new ExactHederaScheme(hederaSigner));
    console.log(`Initialized Hedera account: ${hederaAccountId} on ${hederaNetwork}`);
    registered = true;
  }

  if (stellarPrivateKey) {
    const stellarSigner = createEd25519Signer(stellarPrivateKey);
    client.register("stellar:*", new ExactStellarScheme(stellarSigner));
    console.log(`Initialized Stellar account: ${stellarSigner.address}`);
    registered = true;
  }

  return registered;
}

/**
 * Registers server payment schemes and builds weather endpoint accepts.
 *
 * @param server - x402 resource server to register schemes on
 * @returns Accept entries and whether any network was registered
 */
export function registerServerNetworks(server: x402ResourceServer): {
  accepts: AcceptEntry[];
  registered: boolean;
} {
  const avmAddress = optionalEnv("AVM_ADDRESS");
  const evmAddress = optionalEnv("EVM_ADDRESS") as `0x${string}` | undefined;
  const svmAddress = optionalEnv("SVM_ADDRESS");
  const stellarAddress = optionalEnv("STELLAR_ADDRESS");
  const hederaAddress = optionalEnv("HEDERA_ACCOUNT_ID");

  const accepts: AcceptEntry[] = [];
  let registered = false;

  if (avmAddress) {
    accepts.push({
      scheme: "exact",
      price: "$0.001",
      network: NETWORKS.AVM,
      payTo: avmAddress,
    });
    server.register(NETWORKS.AVM, new ExactAvmServerScheme());
    registered = true;
  }

  if (evmAddress) {
    accepts.push({
      scheme: "exact",
      price: "$0.001",
      network: NETWORKS.EVM,
      payTo: evmAddress,
    });
    server.register(NETWORKS.EVM, new ExactEvmServerScheme());
    registered = true;
  }

  if (svmAddress) {
    accepts.push({
      scheme: "exact",
      price: "$0.001",
      network: NETWORKS.SVM,
      payTo: svmAddress,
    });
    server.register(NETWORKS.SVM, new ExactSvmServerScheme());
    registered = true;
  }

  if (stellarAddress) {
    accepts.push({
      scheme: "exact",
      price: "$0.001",
      network: NETWORKS.STELLAR,
      payTo: stellarAddress,
    });
    server.register(NETWORKS.STELLAR, new ExactStellarServerScheme());
    registered = true;
  }

  if (hederaAddress) {
    accepts.push({
      scheme: "exact",
      price: {
        amount: HEDERA_WEATHER_PRICE_TINYBARS,
        asset: HEDERA_HBAR_ASSET,
      },
      network: NETWORKS.HEDERA,
      payTo: hederaAddress,
    });
    server.register(NETWORKS.HEDERA, new ExactHederaServerScheme());
    registered = true;
  }

  return { accepts, registered };
}

/**
 * Registers facilitator payment schemes for every configured network.
 *
 * @param facilitator - x402 facilitator to register schemes on
 * @returns Whether at least one network was registered
 */
export async function registerFacilitatorNetworks(facilitator: x402Facilitator): Promise<boolean> {
  const avmPrivateKey = optionalEnv("AVM_PRIVATE_KEY");
  const evmPrivateKey = optionalEnv("EVM_PRIVATE_KEY") as `0x${string}` | undefined;
  const svmPrivateKey = optionalEnv("SVM_PRIVATE_KEY");
  const stellarPrivateKey = optionalEnv("STELLAR_PRIVATE_KEY");
  const hederaAccountId = optionalEnv("HEDERA_ACCOUNT_ID");
  const hederaPrivateKey = optionalEnv("HEDERA_PRIVATE_KEY");

  let registered = false;

  if (avmPrivateKey) {
    const avmSigner = toFacilitatorAvmSigner(avmPrivateKey);
    console.info(`AVM Facilitator account: ${avmSigner.getAddresses()[0]}`);
    facilitator.register(NETWORKS.AVM, new ExactAvmFacilitatorScheme(avmSigner));
    registered = true;
  }

  if (evmPrivateKey) {
    const evmAccount = privateKeyToAccount(evmPrivateKey);
    console.info(`EVM Facilitator account: ${evmAccount.address}`);

    const viemClient = createWalletClient({
      account: evmAccount,
      chain: baseSepolia,
      transport: http(),
    }).extend(publicActions);

    const evmSigner = toFacilitatorEvmSigner({
      getCode: (args: { address: `0x${string}` }) => viemClient.getCode(args),
      address: evmAccount.address,
      readContract: (args: {
        address: `0x${string}`;
        abi: readonly unknown[];
        functionName: string;
        args?: readonly unknown[];
      }) =>
        viemClient.readContract({
          ...args,
          args: args.args || [],
        }),
      verifyTypedData: (args: {
        address: `0x${string}`;
        domain: Record<string, unknown>;
        types: Record<string, unknown>;
        primaryType: string;
        message: Record<string, unknown>;
        signature: `0x${string}`;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) => viemClient.verifyTypedData(args as any),
      writeContract: (args: {
        address: `0x${string}`;
        abi: readonly unknown[];
        functionName: string;
        args: readonly unknown[];
      }) =>
        viemClient.writeContract({
          ...args,
          args: args.args || [],
        }),
      sendTransaction: (args: { to: `0x${string}`; data: `0x${string}` }) =>
        viemClient.sendTransaction(args),
      waitForTransactionReceipt: (args: { hash: `0x${string}` }) =>
        viemClient.waitForTransactionReceipt(args),
    });

    facilitator.register(
      NETWORKS.EVM,
      new ExactEvmFacilitatorScheme(evmSigner, {
        eip6492AllowedFactories: [],
      }),
    );
    facilitator.register(NETWORKS.EVM, new UptoEvmFacilitatorScheme(evmSigner));
    registered = true;
  }

  if (svmPrivateKey) {
    const svmAccount = await createKeyPairSignerFromBytes(base58.decode(svmPrivateKey));
    console.info(`SVM Facilitator account: ${svmAccount.address}`);
    const svmSigner = toFacilitatorSvmSigner(svmAccount);
    facilitator.register(NETWORKS.SVM, new ExactSvmFacilitatorScheme(svmSigner));
    registered = true;
  }

  if (stellarPrivateKey) {
    const stellarSigner = createEd25519Signer(stellarPrivateKey);
    console.info(`Stellar Facilitator account: ${stellarSigner.address}`);
    facilitator.register(NETWORKS.STELLAR, new ExactStellarFacilitatorScheme([stellarSigner]));
    registered = true;
  }

  if (hederaAccountId && hederaPrivateKey) {
    const hederaKey = PrivateKey.fromStringECDSA(hederaPrivateKey);
    const buildHederaClient = (network: string): Client => {
      const client = createHederaClient(network);
      client.setOperator(AccountId.fromString(hederaAccountId), hederaKey);
      return client;
    };

    const hederaSigner = toFacilitatorHederaSigner({
      getAddresses: () => [hederaAccountId],
      signAndSubmitTransaction: createHederaSignAndSubmitTransaction(buildHederaClient, hederaKey),
      preflightTransfer: createHederaPreflightTransfer(buildHederaClient),
    });
    facilitator.register(NETWORKS.HEDERA, new ExactHederaFacilitatorScheme(hederaSigner));
    console.info(`Hedera Facilitator account: ${hederaAccountId}`);
    registered = true;
  }

  return registered;
}

/**
 * Logs configured server network addresses on startup.
 */
export function logServerNetworks(): void {
  const avmAddress = optionalEnv("AVM_ADDRESS");
  const evmAddress = optionalEnv("EVM_ADDRESS");
  const svmAddress = optionalEnv("SVM_ADDRESS");
  const stellarAddress = optionalEnv("STELLAR_ADDRESS");
  const hederaAddress = optionalEnv("HEDERA_ACCOUNT_ID");

  if (avmAddress) {
    console.log(`   AVM: ${avmAddress} on ${NETWORKS.AVM}`);
  }
  if (evmAddress) {
    console.log(`   EVM: ${evmAddress} on ${NETWORKS.EVM}`);
  }
  if (svmAddress) {
    console.log(`   SVM: ${svmAddress} on ${NETWORKS.SVM}`);
  }
  if (stellarAddress) {
    console.log(`   Stellar: ${stellarAddress} on ${NETWORKS.STELLAR}`);
  }
  if (hederaAddress) {
    console.log(`   Hedera: ${hederaAddress} on ${NETWORKS.HEDERA}`);
  }
}
