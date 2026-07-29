import { type PaymentPolicy, type SelectPaymentRequirements, x402Client } from "@x402/core/client";
import { Network } from "@x402/core/types";
import { ClientSvmSigner } from "../../signer";
import { UptoSvmScheme } from "./scheme";

/** Configuration for registering the upto SVM client scheme to an x402Client. */
export interface UptoSvmClientConfig {
  /** The payer's SVM signer. */
  signer: ClientSvmSigner;
  /** Optional custom RPC URL. */
  rpcUrl?: string;
  /** Optional payment requirements selector. */
  paymentRequirementsSelector?: SelectPaymentRequirements;
  /** Optional policies to apply. */
  policies?: PaymentPolicy[];
  /** Optional specific networks (defaults to the `solana:*` family). */
  networks?: Network[];
}

/**
 * Register the upto SVM client scheme on an existing x402Client.
 *
 * @param client - The x402Client to register on
 * @param config - Client configuration
 * @returns The client for chaining
 */
export function registerUptoSvmScheme(client: x402Client, config: UptoSvmClientConfig): x402Client {
  const make = () =>
    new UptoSvmScheme(config.signer, config.rpcUrl ? { rpcUrl: config.rpcUrl } : undefined);

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
