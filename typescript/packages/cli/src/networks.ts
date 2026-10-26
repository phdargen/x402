import type { PaymentPolicy } from "@x402/core/client";
import type { Network, PaymentRequirements } from "@x402/core/types";
import { networkMatchesPattern } from "@x402/core/utils";
import { WalletError, type NetworkFamily, type NetworkInfo } from "./types";

const NAMESPACE = "[-a-z0-9]{3,8}";
const NETWORK_ID = new RegExp(`^${NAMESPACE}:[-_a-zA-Z0-9]{1,32}$`);
const NETWORK_PATTERN = new RegExp(`^${NAMESPACE}:\\*$`);

/** No offered network is allowed. `offered` lists the CAIP-2 ids the server accepted. */
export class NetworkNotAllowedError extends WalletError {
  readonly offered: Network[];

  /**
   * Creates the error.
   *
   * @param message - What was rejected
   * @param offered - Offered CAIP-2 ids, in the server's order
   */
  constructor(message: string, offered: Network[]) {
    super(message);
    this.name = "NetworkNotAllowedError";
    this.offered = offered;
  }
}

/**
 * Checks for a concrete CAIP-2 id such as `eip155:8453`.
 *
 * @param value - Candidate
 * @returns True for a CAIP-2 id without wildcards
 */
export function isNetworkId(value: string): value is Network {
  return NETWORK_ID.test(value);
}

/**
 * Checks for an http(s) URL.
 *
 * @param value - Candidate
 * @returns True when the value parses as an http or https URL
 */
function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

/**
 * Validates a `networks` list.
 *
 * @param networks - Candidate list
 * @returns What is wrong, or undefined when valid or unset
 */
export function networksProblem(networks: unknown): string | undefined {
  if (networks === undefined) return undefined;
  if (!Array.isArray(networks)) {
    return "networks must be a list of CAIP-2 networks or patterns such as solana:*";
  }
  if (networks.length === 0) {
    return "networks must list at least one network; remove it to pay on every network except testnets";
  }
  const bad = networks.find(
    entry => typeof entry !== "string" || !(NETWORK_ID.test(entry) || NETWORK_PATTERN.test(entry)),
  );
  return bad === undefined
    ? undefined
    : `networks entry ${JSON.stringify(bad)} must be a CAIP-2 network such as eip155:8453 or a pattern such as solana:*`;
}

/**
 * Validates RPC overrides. Messages never include the URL, which may embed an API key.
 *
 * @param rpc - Candidate map
 * @returns What is wrong, or undefined when valid or unset
 */
export function rpcUrlsProblem(rpc: unknown): string | undefined {
  if (rpc === undefined) return undefined;
  if (typeof rpc !== "object" || rpc === null || Array.isArray(rpc)) {
    return "rpc must map CAIP-2 networks to URLs";
  }
  for (const [network, url] of Object.entries(rpc)) {
    if (!isNetworkId(network)) {
      return `rpc key ${JSON.stringify(network)} must be a CAIP-2 network such as eip155:8453; patterns are not supported`;
    }
    if (typeof url !== "string" || !isHttpUrl(url)) {
      return `rpc["${network}"] must be an http(s) URL`;
    }
  }
  return undefined;
}

/**
 * CAIP-2 id of a network as a server names it: x402 v1 names are converted, others pass through.
 *
 * @param families - Registered families
 * @param network - Network from a payment requirement or receipt
 * @returns The CAIP-2 id
 */
export function toCaip2(families: NetworkFamily[], network: string): Network {
  for (const family of families) {
    const id = family.fromV1Network?.(network);
    if (id) return id;
  }
  return network as Network;
}

/**
 * Asks the families to describe a network.
 *
 * @param families - Registered families
 * @param network - CAIP-2 id
 * @returns The first description, or undefined when no family knows the network
 */
export function describeNetwork(
  families: NetworkFamily[],
  network: Network,
): NetworkInfo | undefined {
  for (const family of families) {
    const info = family.describeNetwork?.(network);
    if (info) return info;
  }
  return undefined;
}

/**
 * Display label for a network, e.g. `"Base Sepolia (testnet)"`.
 *
 * @param families - Registered families
 * @param network - CAIP-2 id
 * @returns The label, or the id itself when no family knows it
 */
export function networkLabel(families: NetworkFamily[], network: Network): string {
  const info = describeNetwork(families, network);
  if (!info) return network;
  return info.testnet ? `${info.name} (testnet)` : info.name;
}

/**
 * Builds the policy that applies `networks`: drop requirements on networks it does not allow,
 * then order the rest by list position. Without `networks`, only known testnets are dropped.
 *
 * @param families - Registered families, used to spot testnets
 * @param networks - Allowed networks, most preferred first
 * @returns The policy
 */
export function networkPolicy(families: NetworkFamily[], networks?: Network[]): PaymentPolicy {
  const rank = (requirementNetwork: string): number => {
    const network = toCaip2(families, requirementNetwork);
    if (!networks) return describeNetwork(families, network)?.testnet ? -1 : 0;
    return networks.findIndex(pattern => networkMatchesPattern(pattern, network));
  };
  return (_version, requirements) => {
    const ranked = requirements
      .map(requirement => ({ requirement, rank: rank(requirement.network) }))
      .filter(entry => entry.rank >= 0)
      .sort((a, b) => a.rank - b.rank)
      .map(entry => entry.requirement);
    if (ranked.length === 0) throw rejection(families, requirements, networks);
    return ranked;
  };
}

/**
 * Explains why every requirement was dropped.
 *
 * @param families - Registered families
 * @param requirements - Requirements the policy received
 * @param networks - Allowed networks, if configured
 * @returns The error
 */
function rejection(
  families: NetworkFamily[],
  requirements: PaymentRequirements[],
  networks?: Network[],
): NetworkNotAllowedError {
  const offered = [...new Set(requirements.map(r => toCaip2(families, r.network)))];
  const list = offered
    .map(id => {
      const info = describeNetwork(families, id);
      return info ? `${info.name} (${id}${info.testnet ? ", testnet" : ""})` : id;
    })
    .join(", ");
  const message = networks
    ? `No payment option is on an allowed network. Offered: ${list}. Allowed: ${networks.join(", ")}.`
    : `Skipped testnet payment options: ${list}. Testnets are off unless listed in networks.`;
  return new NetworkNotAllowedError(message, offered);
}
