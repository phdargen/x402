import { type PaymentPolicy, type SelectPaymentRequirements, x402Client } from "@x402/core/client";
import { Network } from "@x402/core/types";
import { type BatchClientSigner } from "./channel";
import { BatchSvmScheme, type BatchSvmClientConfig as SchemeConfig } from "./scheme";

/** Configuration for registering the batch-settlement SVM client scheme to an x402Client. */
export interface BatchSvmClientConfig {
  /** The payer / client signer (also the channel authorized signer; must sign messages). */
  signer: BatchClientSigner;
  /** Optional custom RPC URL. */
  rpcUrl?: string;
  /** Deposit used when opening a new channel. */
  depositAmount?: bigint | string;
  /** Optional payment requirements selector. */
  paymentRequirementsSelector?: SelectPaymentRequirements;
  /** Optional policies to apply. */
  policies?: PaymentPolicy[];
  /** Optional specific networks (defaults to the `solana:*` family). */
  networks?: Network[];
}

/**
 * Register the batch-settlement SVM client scheme on an existing x402Client.
 *
 * One {@link BatchSvmScheme} instance is created per registered network so its
 * in-memory channel reuse persists across requests to that network.
 *
 * @param client - The x402Client to register on
 * @param config - Client configuration
 * @returns The client for chaining
 */
export function registerBatchSvmScheme(
  client: x402Client,
  config: BatchSvmClientConfig,
): x402Client {
  const opts: SchemeConfig = {
    ...(config.rpcUrl ? { rpcUrl: config.rpcUrl } : {}),
    ...(config.depositAmount !== undefined ? { depositAmount: config.depositAmount } : {}),
  };
  const make = () => new BatchSvmScheme(config.signer, opts);

  if (config.networks && config.networks.length > 0) {
    config.networks.forEach(network => client.register(network, make()));
  } else {
    client.register("solana:*", make());
  }

  if (config.policies) {
    config.policies.forEach(policy => client.registerPolicy(policy));
  }

  return client;
}
