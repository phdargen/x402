import { x402ResourceServer } from "@x402/core/server";
import { Network } from "@x402/core/types";
import { BatchSvmScheme, type BatchSvmServerConfig } from "./scheme";

/** Configuration for registering the batch-settlement SVM server scheme. */
export interface BatchSvmResourceServerConfig extends BatchSvmServerConfig {
  /** Optional specific networks (defaults to the `solana:*` family). */
  networks?: Network[];
}

/**
 * Register the batch-settlement SVM server scheme on an existing x402ResourceServer.
 *
 * @param server - The x402ResourceServer to register on
 * @param config - Resource-server configuration
 * @returns The server for chaining
 */
export function registerBatchSvmScheme(
  server: x402ResourceServer,
  config: BatchSvmResourceServerConfig = {},
): x402ResourceServer {
  if (config.networks && config.networks.length > 0) {
    config.networks.forEach(network => server.register(network, new BatchSvmScheme(config)));
  } else {
    server.register("solana:*", new BatchSvmScheme(config));
  }
  return server;
}
