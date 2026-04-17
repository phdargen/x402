import type { NetworkSet } from './networks/networks';

export type ProtocolFamily = 'evm' | 'svm' | 'avm' | 'aptos' | 'hedera' | 'stellar';
export type Transport = 'http' | 'mcp';
export type TransferMethod = 'eip3009' | 'permit2' | 'upto' | 'batch-settlement';

export interface ClientResult {
  success: boolean;
  data?: any;
  status_code?: number;
  payment_response?: any;
  error?: string;
}

/** Scheme-specific configs for a batch-settlement scenario. */
export interface BatchSettlementClientConfig {
  /** Per-scenario unique salt that derives the onchain channel id (avoids collisions across runs). */
  channelSalt: string;
  /** Number of paid requests to issue against the same endpoint within the channel. */
  count: number;
  /** When true, the last request signals a cooperative refund of any unused balance. */
  refundOnLast: boolean;
  /** Optional alternate EOA used to sign vouchers (deposits still use the main client signer). */
  voucherSignerPrivateKey?: string;
}

/** Scheme-specific knobs the harness forwards to a server for a batch-settlement scenario. */
export interface BatchSettlementServerConfig {
  /** Optional EOA private key the server uses as a self-managed receiver authorizer. */
  receiverAuthorizerPrivateKey: string;
}

export interface ClientConfig {
  evmPrivateKey: string;
  svmPrivateKey: string;
  avmPrivateKey: string;
  aptosPrivateKey: string;
  hederaAccountId: string;
  hederaPrivateKey: string;
  stellarPrivateKey: string;
  serverUrl: string;
  endpointPath: string;
  evmNetwork: string;
  evmRpcUrl: string;
  hederaNetwork: string;
  hederaNodeUrl: string;
  batchSettlement?: BatchSettlementClientConfig;
}

export interface ServerConfig {
  port: number;
  evmPayTo: string;
  svmPayTo: string;
  avmPayTo: string;
  aptosPayTo: string;
  hederaPayTo: string;
  hederaAsset?: string;
  hederaAmount?: string;
  stellarPayTo: string;
  networks: NetworkSet;
  facilitatorUrl?: string;
  mockFacilitatorUrl?: string;
  batchSettlement?: BatchSettlementServerConfig;
}

export interface ServerProxy {
  start(config: ServerConfig): Promise<void>;
  stop(): Promise<void>;
  getHealthUrl(): string;
  getProtectedPath(): string;
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
  transferMethod?: TransferMethod;
  extensions?: string[];
  /** For MCP tools: the tool name used in tools/call. Defaults to path if not specified. */
  toolName?: string;
  /** For MCP tools: expected MCP wire transport for discovery metadata. */
  mcpTransport?: 'streamable-http' | 'sse';
  /** True for Permit2 standard/direct settle - requires pre-approval (approve before test, not revoke) */
  permit2Direct?: boolean;
  /** True for endpoints that require Permit2 revocation + fund/drain state setup before the first test (coldstart). */
  coldstart?: boolean;
  /** Batch-settlement scenario configuration: how many vouchers to issue and whether to signal a cooperative refund. */
  batchSettlement?: {
    count: number;
    refundOnLast?: boolean;
  };
  health?: boolean;
  close?: boolean;
}

export interface TestConfig {
  name: string;
  type: 'server' | 'client' | 'facilitator';
  transport?: Transport;
  language: string;
  protocolFamilies?: ProtocolFamily[];
  x402Version?: number;
  x402Versions?: number[];
  extensions?: string[];
  evm?: {
    transferMethods: TransferMethod[];
  };
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
