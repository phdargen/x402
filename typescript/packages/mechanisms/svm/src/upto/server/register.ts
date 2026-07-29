import { x402ResourceServer } from "@x402/core/server";
import { Network } from "@x402/core/types";
import { UptoSvmScheme } from "./scheme";

/** Configuration for registering the upto SVM server scheme to an x402ResourceServer. */
export interface UptoSvmResourceServerConfig {
  /** Optional specific networks (defaults to the `solana:*` family). */
  networks?: Network[];
  /**
   * Optional RPC endpoint. When set, the scheme embeds a recent blockhash and
   * slot in the 402 challenge (`extra.recentBlockhash`, `extra.recentSlot`).
   * The `recentSlot` is required by upto clients to derive the channel PDA.
   */
  rpcUrl?: string;
}

/**
 * Register the upto SVM server scheme on an existing x402ResourceServer.
 *
 * @param server - The x402ResourceServer to register on
 * @param config - Resource-server configuration
 * @returns The server for chaining
 */
export function registerUptoSvmScheme(
  server: x402ResourceServer,
  config: UptoSvmResourceServerConfig = {},
): x402ResourceServer {
  const options = { rpcUrl: config.rpcUrl };
  if (config.networks && config.networks.length > 0) {
    config.networks.forEach(network => server.register(network, new UptoSvmScheme(options)));
  } else {
    server.register("solana:*", new UptoSvmScheme(options));
  }
  return server;
}
