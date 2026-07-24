/**
 * Network and protocol-family configuration for E2E tests.
 *
 * Single source of truth for protocol families, credential env keys, network
 * configs, and helpers. Use getNetworkSet() for testnet or mainnet mode.
 *
 * Adding a network SDK: extend ProtocolFamily, FAMILY_CREDENTIALS,
 * FAMILY_NETWORK_ENV, and NETWORK_SETS below.
 */

export type ProtocolFamily =
  | 'evm'
  | 'svm'
  | 'avm'
  | 'aptos'
  | 'hedera'
  | 'keeta'
  | 'near'
  | 'stellar'
  | 'ccd'
  | 'tvm'
  | 'xrpl';

/** All protocol families in registry order. */
export const PROTOCOL_FAMILIES: readonly ProtocolFamily[] = [
  'evm',
  'svm',
  'avm',
  'aptos',
  'hedera',
  'keeta',
  'near',
  'stellar',
  'ccd',
  'tvm',
  'xrpl',
] as const;

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
 * Credential env keys per family and role. Exceptional multi-field shapes
 * (Hedera account+key, CCD key+address, NEAR account+key) live here only.
 */
export const FAMILY_CREDENTIALS: Record<ProtocolFamily, FamilyCredentialSchema> = {
  evm: {
    server: ['SERVER_EVM_ADDRESS'],
    client: ['CLIENT_EVM_PRIVATE_KEY'],
    facilitator: ['FACILITATOR_EVM_PRIVATE_KEY'],
  },
  svm: {
    server: ['SERVER_SVM_ADDRESS'],
    client: ['CLIENT_SVM_PRIVATE_KEY'],
    facilitator: ['FACILITATOR_SVM_PRIVATE_KEY'],
  },
  avm: {
    server: ['SERVER_AVM_ADDRESS'],
    client: ['CLIENT_AVM_PRIVATE_KEY'],
    facilitator: ['FACILITATOR_AVM_PRIVATE_KEY'],
  },
  aptos: {
    server: ['SERVER_APTOS_ADDRESS'],
    client: ['CLIENT_APTOS_PRIVATE_KEY'],
    facilitator: ['FACILITATOR_APTOS_PRIVATE_KEY'],
  },
  ccd: {
    server: ['SERVER_CCD_ADDRESS'],
    client: ['CLIENT_CCD_PRIVATE_KEY', 'CLIENT_CCD_ADDRESS'],
    facilitator: ['FACILITATOR_CCD_PRIVATE_KEY', 'FACILITATOR_CCD_ADDRESS'],
  },
  hedera: {
    server: ['SERVER_HEDERA_ADDRESS'],
    client: ['CLIENT_HEDERA_ACCOUNT_ID', 'CLIENT_HEDERA_PRIVATE_KEY'],
    facilitator: ['FACILITATOR_HEDERA_ACCOUNT_ID', 'FACILITATOR_HEDERA_PRIVATE_KEY'],
  },
  keeta: {
    server: ['SERVER_KEETA_ADDRESS'],
    client: ['CLIENT_KEETA_MNEMONIC'],
    facilitator: ['FACILITATOR_KEETA_MNEMONIC'],
  },
  near: {
    server: ['SERVER_NEAR_ADDRESS'],
    client: ['CLIENT_NEAR_ACCOUNT_ID', 'CLIENT_NEAR_PRIVATE_KEY'],
    facilitator: ['FACILITATOR_NEAR_ACCOUNT_ID', 'FACILITATOR_NEAR_PRIVATE_KEY'],
  },
  stellar: {
    server: ['SERVER_STELLAR_ADDRESS'],
    client: ['CLIENT_STELLAR_PRIVATE_KEY'],
    facilitator: ['FACILITATOR_STELLAR_PRIVATE_KEY'],
  },
  tvm: {
    server: ['SERVER_TVM_ADDRESS'],
    client: ['CLIENT_TVM_PRIVATE_KEY'],
    facilitator: ['FACILITATOR_TVM_PRIVATE_KEY'],
  },
  xrpl: {
    server: ['SERVER_XRPL_ADDRESS'],
    client: ['CLIENT_XRPL_SEED'],
    facilitator: [],
  },
};

/** Network env var names injected by proxies from NetworkSet. */
export const FAMILY_NETWORK_ENV: Record<ProtocolFamily, FamilyNetworkEnv> = {
  evm: { networkKey: 'EVM_NETWORK', rpcUrlKey: 'EVM_RPC_URL' },
  svm: { networkKey: 'SVM_NETWORK', rpcUrlKey: 'SVM_RPC_URL' },
  avm: { networkKey: 'AVM_NETWORK', rpcUrlKey: 'AVM_RPC_URL' },
  aptos: { networkKey: 'APTOS_NETWORK', rpcUrlKey: 'APTOS_RPC_URL' },
  ccd: { networkKey: 'CCD_NETWORK', rpcUrlKey: 'CCD_GRPC_URL' },
  hedera: { networkKey: 'HEDERA_NETWORK', rpcUrlKey: 'HEDERA_NODE_URL' },
  keeta: { networkKey: 'KEETA_NETWORK' },
  near: { networkKey: 'NEAR_NETWORK', rpcUrlKey: 'NEAR_RPC_URL' },
  stellar: { networkKey: 'STELLAR_NETWORK', rpcUrlKey: 'STELLAR_RPC_URL' },
  tvm: { networkKey: 'TVM_NETWORK' },
  xrpl: { networkKey: 'XRPL_NETWORK', rpcUrlKey: 'XRPL_WS_URL' },
};

/** Human-readable names for 501 errors, banners, and CLI output. */
export const FAMILY_DISPLAY_NAME: Record<ProtocolFamily, string> = {
  evm: 'EVM',
  svm: 'SVM',
  avm: 'AVM',
  aptos: 'Aptos',
  hedera: 'Hedera',
  keeta: 'Keeta',
  near: 'NEAR',
  stellar: 'Stellar',
  ccd: 'Concordium',
  tvm: 'TVM',
  xrpl: 'XRPL',
};

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

/**
 * All supported networks, organized by mode and protocol family
 */
const NETWORK_SETS: Record<NetworkMode, NetworkSet> = {
  testnet: {
    evm: {
      name: 'Base Sepolia',
      caip2: 'eip155:84532',
      rpcUrl: process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org',
      permit2Asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    },
    svm: {
      name: 'Solana Devnet',
      caip2: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
      rpcUrl: process.env.SOLANA_DEVNET_RPC_URL || 'https://api.devnet.solana.com',
    },
    avm: {
      name: 'Algorand Testnet',
      caip2: 'algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDe',
      rpcUrl: process.env.AVM_TESTNET_RPC_URL || 'https://testnet-api.4160.nodely.dev',
    },
    ccd: {
      name: 'Concordium Testnet',
      caip2: 'ccd:4221332d34e1694168c2a0c0b3fd0f27',
      rpcUrl: process.env.CONCORDIUM_TESTNET_GRPC_URL || 'grpc.testnet.concordium.com:20000',
    },
    aptos: {
      name: 'Aptos Testnet',
      caip2: 'aptos:2',
      rpcUrl: process.env.APTOS_TESTNET_RPC_URL || 'https://fullnode.testnet.aptoslabs.com/v1',
    },
    hedera: {
      name: 'Hedera Testnet',
      caip2: 'hedera:testnet',
      rpcUrl: process.env.HEDERA_TESTNET_NODE_URL || '',
    },
    keeta: {
      name: 'Keeta Testnet',
      caip2: 'keeta:1413829460',
      // Unused in Keeta, representative API endpoints are set in the SDK itself
      rpcUrl: '',
    },
    stellar: {
      name: 'Stellar Testnet',
      caip2: 'stellar:testnet',
      rpcUrl: process.env.STELLAR_TESTNET_RPC_URL || 'https://soroban-testnet.stellar.org',
    },
    tvm: {
      name: 'TON Testnet',
      caip2: 'tvm:-3',
      rpcUrl: process.env.TONCENTER_TESTNET_BASE_URL || 'https://testnet.toncenter.com',
    },
    near: {
      name: 'NEAR Testnet',
      caip2: 'near:testnet',
      rpcUrl: process.env.NEAR_TESTNET_RPC_URL || 'https://rpc.testnet.fastnear.com',
    },
    xrpl: {
      name: 'XRPL Testnet',
      caip2: 'xrpl:1',
      rpcUrl: process.env.XRPL_TESTNET_WS_URL || 'wss://s.altnet.rippletest.net:51233',
    },
  },
  mainnet: {
    evm: {
      name: 'Base',
      caip2: 'eip155:8453',
      rpcUrl: process.env.BASE_RPC_URL || 'https://mainnet.base.org',
      permit2Asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    },
    svm: {
      name: 'Solana',
      caip2: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
      rpcUrl: process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
    },
    avm: {
      name: 'Algorand Mainnet',
      caip2: 'algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73k',
      rpcUrl: process.env.AVM_RPC_URL || 'https://mainnet-api.4160.nodely.dev',
    },
    ccd: {
      name: 'Concordium Mainnet',
      caip2: 'ccd:9dd9ca4d19e9393877d2c44b70f89acb',
      rpcUrl: process.env.CONCORDIUM_MAINNET_GRPC_URL || 'grpc.mainnet.concordium.software:20000',
    },
    aptos: {
      name: 'Aptos',
      caip2: 'aptos:1',
      rpcUrl: process.env.APTOS_RPC_URL || 'https://fullnode.mainnet.aptoslabs.com/v1',
    },
    hedera: {
      name: 'Hedera Mainnet',
      caip2: 'hedera:mainnet',
      rpcUrl: process.env.HEDERA_NODE_URL || '',
    },
    keeta: {
      name: 'Keeta',
      caip2: 'keeta:21378',
      // Unused in Keeta, representative API endpoints are set in the SDK itself
      rpcUrl: '',
    },
    stellar: {
      name: 'Stellar Pubnet',
      caip2: 'stellar:pubnet',
      rpcUrl: process.env.STELLAR_RPC_URL || 'https://mainnet.sorobanrpc.com',
    },
    tvm: {
      name: 'TON Mainnet',
      caip2: 'tvm:-239',
      rpcUrl: process.env.TONCENTER_MAINNET_BASE_URL || 'https://toncenter.com',
    },
    near: {
      name: 'NEAR',
      caip2: 'near:mainnet',
      rpcUrl: process.env.NEAR_RPC_URL || 'https://rpc.mainnet.fastnear.com',
    },
    xrpl: {
      name: 'XRPL',
      caip2: 'xrpl:0',
      rpcUrl: process.env.XRPL_MAINNET_WS_URL || 'wss://s1.ripple.com:51233',
    },
  },
};

/**
 * Get the network set for a given mode
 *
 * @param mode - 'testnet' or 'mainnet'
 * @returns NetworkSet containing configured protocol network configs
 */
export function getNetworkSet(mode: NetworkMode): NetworkSet {
  return NETWORK_SETS[mode];
}

/**
 * Permit2-priced routes read `process.env.EVM_PERMIT2_ASSET` in server processes.
 * Use the same resolution here and when spawning resource servers (`generic-server`)
 * so cold-start revoke/approve targets the token those routes bill.
 *
 * Precedence: non-empty `EVM_PERMIT2_ASSET`, then `networks.evm.permit2Asset`.
 * When the env var is unset, defaults are Base Sepolia USDC (`eip155:84532`) and
 * Base mainnet USDC (`eip155:8453`) from {@link NETWORK_SETS}.
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
 *
 * @param mode - 'testnet' or 'mainnet'
 * @param protocolFamily - 'evm', 'svm', 'avm', 'aptos', 'hedera', 'near', 'stellar', 'ccd', 'tvm', or 'xrpl'
 * @returns NetworkConfig for the specified protocol
 */
export function getNetworkForProtocol(
  mode: NetworkMode,
  protocolFamily: ProtocolFamily,
): NetworkConfig {
  return NETWORK_SETS[mode][protocolFamily];
}

/**
 * Get display string for a network mode
 *
 * @param mode - 'testnet' or 'mainnet'
 * @returns Human-readable description of the networks
 */
export function getNetworkModeDescription(mode: NetworkMode): string {
  const set = NETWORK_SETS[mode];
  const networks = PROTOCOL_FAMILIES.map(f => set[f].name);
  return networks.join(' + ');
}
