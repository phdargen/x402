import type { NetworkSet, ProtocolFamily } from './networks/networks';

export type { ProtocolFamily } from './networks/networks';
export type Transport = 'http' | 'mcp';
export type PaymentScheme = 'exact' | 'upto' | 'batch-settlement';
export type AssetTransferMethod = 'eip3009' | 'permit2' | 'sequence' | 'ticketSequence';
/** Payment ordering on the accept. Omitted on an endpoint means `authorization`. */
export type PaymentFlow = 'authorization' | 'upfront' | 'escrow';

/**
 * Resolved asset transfer method for an endpoint.
 */
export function endpointAssetTransferMethod(endpoint: TestEndpoint): AssetTransferMethod | undefined {
  const family = endpoint.protocolFamily ?? 'evm';
  if (endpoint.assetTransferMethod != null) {
    return endpoint.assetTransferMethod;
  }
  if (family === 'evm') {
    const scheme = endpoint.scheme ?? 'exact';
    return scheme === 'upto' ? 'permit2' : 'eip3009';
  }
  if (family === 'xrpl') {
    return 'sequence';
  }
  return undefined;
}

/**
 * Resolved payment scheme for an endpoint.
 * Defaults to `exact` when omitted.
 */
export function endpointPaymentScheme(endpoint: TestEndpoint): PaymentScheme {
  return endpoint.scheme ?? 'exact';
}

/**
 * Resolved payment flow for an endpoint.
 * Defaults to `authorization` when omitted.
 */
export function endpointPaymentFlow(endpoint: TestEndpoint): PaymentFlow {
  return endpoint.paymentFlow ?? 'authorization';
}

/** Harness knobs for exact / upto endpoints (Permit2 settle paths). */
export interface Permit2SchemeOptions {
  permit2Direct?: boolean;
  coldstart?: boolean;
}

/** Harness knobs for batch-settlement endpoints. */
export interface BatchSettlementSchemeOptions extends Permit2SchemeOptions {
  /** True when the route uses facilitator-managed voucher custody. */
  facilitatorManaged?: boolean;
}

export type SchemeOptions = Permit2SchemeOptions | BatchSettlementSchemeOptions;

export function endpointUsesBatchSettlement(endpoint: TestEndpoint): boolean {
  return endpoint.scheme === 'batch-settlement';
}

/** Server-side custody role for batch-settlement routes. */
export type BatchServerRole = 'standard' | 'managed-batch';

/**
 * True when an endpoint is a facilitator-managed batch-settlement route
 * (`schemeOptions.facilitatorManaged === true`).
 */
export function endpointUsesFacilitatorManagedBatch(endpoint: TestEndpoint): boolean {
  return (
    endpoint.scheme === 'batch-settlement' &&
    (endpoint.schemeOptions as BatchSettlementSchemeOptions | undefined)?.facilitatorManaged === true
  );
}

/** Map a batch custody role to the voucher-store mode server processes use. */
export function voucherStoreModeForBatchRole(role: BatchServerRole): 'self' | 'facilitator' {
  switch (role) {
    case 'managed-batch':
      return 'facilitator';
    case 'standard':
      return 'self';
    default:
      throw new Error(`Unknown batch server role: ${(role as never) satisfies never}`);
  }
}

export interface ClientResult {
  success: boolean;
  data?: any;
  status_code?: number;
  payment_response?: any;
  error?: string;
}

/** Scheme-specific configs for a batch-settlement scenario. */
export type BatchSettlementPhase = 'initial' | 'recovery-refund' | 'full';

export interface BatchSettlementClientConfig {
  /** Per-scenario unique salt that derives the onchain channel id (avoids collisions across runs). */
  channelSalt: string;
  /** Fixed e2e phase to run for this one-shot client process. */
  phase: BatchSettlementPhase;
  /** Optional alternate EOA used to sign vouchers (deposits still use the main client signer). */
  voucherSignerPrivateKey?: string;
}
export interface ClientConfig {
  serverUrl: string;
  endpointPath: string;
  networks: NetworkSet;
  batchSettlement?: BatchSettlementClientConfig;
}

export interface ServerConfig {
  port: number;
  networks: NetworkSet;
  /** When set, only forward SERVER_* addresses for these families */
  enabledFamilies?: ProtocolFamily[];
  facilitatorUrl?: string;
  mockFacilitatorUrl?: string;
  /** Batch custody role for this server process (dual-server harness). */
  batchServerRole?: BatchServerRole;
}

export interface ServerProxy {
  start(config: ServerConfig): Promise<void>;
  stop(): Promise<void>;
  getUrl(): string;
}

export interface ClientProxy {
  call(config: ClientConfig): Promise<ClientResult>;
}

export interface TestEndpoint {
  path: string;
  method: string;
  description: string;
  requiresPayment?: boolean;
  protocolFamily?: ProtocolFamily;
  scheme?: PaymentScheme;
  assetTransferMethod?: AssetTransferMethod;
  /** Omitted or `authorization` is the default (verify → resource → settle). */
  paymentFlow?: PaymentFlow;
  schemeOptions?: SchemeOptions;
  extensions?: string[];
  /** For MCP tools: the tool name used in tools/call. Defaults to path if not specified. */
  toolName?: string;
  /** For MCP tools: expected MCP wire transport for discovery metadata. */
  mcpTransport?: 'streamable-http' | 'sse';
  health?: boolean;
  close?: boolean;
}

export interface TestConfig {
  name: string;
  type: 'server' | 'client' | 'facilitator';
  enabled?: boolean;
  transport?: Transport;
  language: string;
  protocolFamilies?: ProtocolFamily[];
  x402Version?: number;
  x402Versions?: number[];
  extensions?: string[];
  /**
   * Payment schemes the component supports. Required on clients and
   * facilitators that participate in EVM scenarios; the discovery filter
   * skips pairings whose endpoint scheme is not in this list.
   */
  schemes?: PaymentScheme[];
  evm?: {
    assetTransferMethods?: AssetTransferMethod[];
  };
  facilitators?: string[];
  endpoints?: TestEndpoint[];
  supportedMethods?: string[];
  capabilities?: {
    payment?: boolean;
    authentication?: boolean;
  };
  environment: {
    required: string[];
    optional: string[];
  };
}

export interface DiscoveredServer {
  name: string;
  directory: string;
  config: TestConfig;
  proxy: ServerProxy;
}

export interface DiscoveredClient {
  name: string;
  directory: string;
  config: TestConfig;
  proxy: ClientProxy;
}

export interface FacilitatorProxy {
  start(config: any): Promise<void>;
  stop(): Promise<void>;
  getUrl(): string;
}

export interface DiscoveredFacilitator {
  name: string;
  directory: string;
  config: TestConfig;
  proxy: FacilitatorProxy;
  isExternal?: boolean;
}

export interface TestScenario {
  client: DiscoveredClient;
  server: DiscoveredServer;
  facilitator?: DiscoveredFacilitator;
  endpoint: TestEndpoint;
  protocolFamily: ProtocolFamily;
}

export interface ScenarioResult {
  success: boolean;
  error?: string;
  data?: any;
  status_code?: number;
  payment_response?: any;
}
