/**
 * Network and protocol-family configuration for E2E tests.
 *
 * Network credential env keys and identifiers come from e2e/config/mechanisms.json
 * (via src/mechanisms.ts). Paid HTTP routes declare implementing SDKs via
 * `routes.*.sdks`. This module exposes the runtime NetworkSet helpers used by the harness.
 *
 * Adding a network:
 * 1. Add `networks.<id>` to e2e/config/mechanisms.json (`env`, `networkEnv`, `networks`)
 * 2. Add routes under `routes` with `sdks` listing each SDK that implements them
 * 3. Register the scheme in clients|servers|facilitators shared modules for that sdk
 * 4. Add secrets to .env-local / README
 *
 * Legacy v1 is not driven by mechanisms.json.
 */

import {
  NETWORK_IDS,
  catalogCredentials,
  catalogDisplayNames,
  catalogNetworkEnv,
  getCatalogNetwork,
  resolveNetworkRpcUrl,
  type CatalogNetworkId,
} from '../mechanisms';

export type ProtocolFamily = CatalogNetworkId;

/** All protocol families in registry order. */
export const PROTOCOL_FAMILIES: readonly ProtocolFamily[] = NETWORK_IDS;

export type Role = 'server' | 'client' | 'facilitator';

export type FamilyCredentialSchema = {
  /** Root .env keys forwarded unchanged into child processes */
  server: string[];
  client: string[];
  facilitator: string[];
};

export type FamilyNetworkEnv = {
  /** Env var for network identifier (CAIP-2 or legacy v1 string after translation) */
  networkKey: string;
  /** Env var for RPC/WS/gRPC endpoint; omitted when unused */
  rpcUrlKey?: string;
};

/**
 * Credential env keys per network and role — derived from config/mechanisms.json.
 */
export const FAMILY_CREDENTIALS: Record<ProtocolFamily, FamilyCredentialSchema> =
  catalogCredentials();

/** Network env var names injected by proxies from NetworkSet. */
export const FAMILY_NETWORK_ENV: Record<ProtocolFamily, FamilyNetworkEnv> =
  catalogNetworkEnv();

/** Human-readable names for 501 errors, banners, and CLI output. */
export const FAMILY_DISPLAY_NAME: Record<ProtocolFamily, string> =
  catalogDisplayNames();

/** Server payee address env key for a family. */
export function serverAddressKey(family: ProtocolFamily): string {
  return `SERVER_${family.toUpperCase()}_ADDRESS`;
}

/** Collect all credential env keys for a role across families. */
export function allCredentialKeys(role: Role): string[] {
  const keys: string[] = [];
  for (const family of PROTOCOL_FAMILIES) {
    keys.push(...FAMILY_CREDENTIALS[family][role]);
  }
  return keys;
}

/** Required env keys for a family (all roles that have keys). */
export function requiredEnvForFamily(family: ProtocolFamily): string[] {
  const schema = FAMILY_CREDENTIALS[family];
  return [...schema.server, ...schema.client, ...schema.facilitator];
}

export type NetworkMode = 'testnet' | 'mainnet';

export type NetworkConfig = {
  name: string;
  caip2: `${string}:${string}`;
  rpcUrl: string;
  permit2Asset?: string;
};

export type NetworkSet = Record<ProtocolFamily, NetworkConfig>;

function buildNetworkSet(mode: NetworkMode): NetworkSet {
  const set = {} as NetworkSet;
  for (const family of PROTOCOL_FAMILIES) {
    const net = getCatalogNetwork(family, mode);
    set[family] = {
      name: net.name,
      caip2: net.caip2 as `${string}:${string}`,
      rpcUrl: resolveNetworkRpcUrl(family, mode),
      ...(net.permit2Asset ? { permit2Asset: net.permit2Asset } : {}),
    };
  }
  return set;
}

/**
 * Get the network set for a given mode
 *
 * @param mode - 'testnet' or 'mainnet'
 * @returns NetworkSet containing configured protocol network configs
 */
export function getNetworkSet(mode: NetworkMode): NetworkSet {
  return buildNetworkSet(mode);
}

/**
 * Permit2-priced routes read `process.env.EVM_PERMIT2_ASSET` in server processes.
 * Use the same resolution here and when spawning resource servers (`generic-server`)
 * so cold-start revoke/approve targets the token those routes bill.
 *
 * Precedence: non-empty `EVM_PERMIT2_ASSET`, then `networks.evm.permit2Asset`.
 * When the env var is unset, defaults are Base Sepolia USDC (`eip155:84532`) and
 * Base mainnet USDC (`eip155:8453`) from the family catalog.
 */
export function resolveEvmPermit2Asset(networks: NetworkSet): string {
  const fromEnv = process.env.EVM_PERMIT2_ASSET?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  return (networks.evm.permit2Asset ?? '').trim();
}

/**
 * Get network config for a protocol family in a given mode
 */
export function getNetworkForProtocol(
  mode: NetworkMode,
  protocolFamily: ProtocolFamily,
): NetworkConfig {
  return buildNetworkSet(mode)[protocolFamily];
}

/**
 * Get display string for a network mode
 */
export function getNetworkModeDescription(mode: NetworkMode): string {
  const set = buildNetworkSet(mode);
  const networks = PROTOCOL_FAMILIES.map(f => set[f].name);
  return networks.join(' + ');
}
