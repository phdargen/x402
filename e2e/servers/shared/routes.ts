import {
  FAMILY_CREDENTIALS,
  FAMILY_DISPLAY_NAME,
  PROTOCOL_FAMILIES,
  type ProtocolFamily,
} from "../../src/networks/networks";
import {
  buildUnconfiguredFamilyError,
  getFamilyNetwork,
  getServerAddress,
  isFamilyConfigured,
  type ServerEnvConfig,
} from "../../src/server-env";

/** Canonical path constants used by payment middleware and route handlers. */
export const ROUTE_PATHS = {
  BATCH_SETTLEMENT_EVM_EIP3009: "/batch-settlement/evm/eip3009",
  BATCH_SETTLEMENT_EVM_PERMIT2: "/batch-settlement/evm/permit2",
  BATCH_SETTLEMENT_EVM_PERMIT2_EIP2612: "/batch-settlement/evm/permit2-eip2612GasSponsoring",
  BATCH_SETTLEMENT_EVM_PERMIT2_ERC20: "/batch-settlement/evm/permit2-erc20ApprovalGasSponsoring",
  EXACT_EVM_EIP3009: "/exact/evm/eip3009",
  EXACT_EVM_PERMIT2: "/exact/evm/permit2",
  EXACT_EVM_PERMIT2_EIP2612: "/exact/evm/permit2-eip2612GasSponsoring",
  EXACT_EVM_PERMIT2_ERC20: "/exact/evm/permit2-erc20ApprovalGasSponsoring",
  EXACT_SVM: "/exact/svm",
  EXACT_AVM: "/exact/avm",
  EXACT_APTOS: "/exact/aptos",
  EXACT_HEDERA: "/exact/hedera",
  EXACT_KEETA: "/exact/keeta",
  EXACT_CCD: "/exact/ccd",
  EXACT_STELLAR: "/exact/stellar",
  EXACT_TVM: "/exact/tvm",
  EXACT_NEAR: "/exact/near",
  EXACT_XRPL_SEQUENCE: "/exact/xrpl/sequence",
  EXACT_XRPL_TICKET_SEQUENCE: "/exact/xrpl/ticketSequence",
  UPTO_EVM_PERMIT2: "/upto/evm/permit2",
  UPTO_EVM_PERMIT2_EIP2612: "/upto/evm/permit2-eip2612GasSponsoring",
  UPTO_EVM_PERMIT2_ERC20: "/upto/evm/permit2-erc20ApprovalGasSponsoring",
  HEALTH: "/health",
  CLOSE: "/close",
} as const;

export type E2eRouteDef = {
  path: string;
  network: ProtocolFamily;
  response: () => Record<string, unknown>;
  settlementOverride?: { amount: string };
};

const timestamp = () => new Date().toISOString();

const defaultProtectedResponse = () => ({
  message: "Protected endpoint accessed successfully",
  timestamp: timestamp(),
});

export const E2E_GET_ROUTES: E2eRouteDef[] = [
  {
    path: ROUTE_PATHS.BATCH_SETTLEMENT_EVM_EIP3009,
    network: "evm",
    response: () => ({
      message: "Batch-settlement endpoint accessed successfully",
      timestamp: timestamp(),
    }),
  },
  {
    path: ROUTE_PATHS.BATCH_SETTLEMENT_EVM_PERMIT2,
    network: "evm",
    response: () => ({
      message: "Batch-settlement Permit2 endpoint accessed successfully",
      timestamp: timestamp(),
      method: "batch-settlement-permit2",
    }),
  },
  {
    path: ROUTE_PATHS.BATCH_SETTLEMENT_EVM_PERMIT2_EIP2612,
    network: "evm",
    response: () => ({
      message: "Batch-settlement Permit2 EIP-2612 endpoint accessed successfully",
      timestamp: timestamp(),
      method: "batch-settlement-permit2-eip2612",
    }),
  },
  {
    path: ROUTE_PATHS.BATCH_SETTLEMENT_EVM_PERMIT2_ERC20,
    network: "evm",
    response: () => ({
      message: "Batch-settlement Permit2 ERC-20 approval endpoint accessed successfully",
      timestamp: timestamp(),
      method: "batch-settlement-permit2-erc20-approval",
    }),
  },
  { path: ROUTE_PATHS.EXACT_EVM_EIP3009, network: "evm", response: defaultProtectedResponse },
  { path: ROUTE_PATHS.EXACT_SVM, network: "svm", response: defaultProtectedResponse },
  { path: ROUTE_PATHS.EXACT_AVM, network: "avm", response: defaultProtectedResponse },
  { path: ROUTE_PATHS.EXACT_APTOS, network: "aptos", response: defaultProtectedResponse },
  {
    path: ROUTE_PATHS.EXACT_HEDERA,
    network: "hedera",
    response: () => ({
      message: "Protected Hedera endpoint accessed successfully",
      timestamp: timestamp(),
    }),
  },
  {
    path: ROUTE_PATHS.EXACT_KEETA,
    network: "keeta",
    response: () => ({
      message: "Protected Keeta endpoint accessed successfully",
      timestamp: timestamp(),
    }),
  },
  {
    path: ROUTE_PATHS.EXACT_CCD,
    network: "ccd",
    response: () => ({
      message: "Protected Concordium endpoint accessed successfully",
      timestamp: timestamp(),
    }),
  },
  {
    path: ROUTE_PATHS.EXACT_EVM_PERMIT2,
    network: "evm",
    response: () => ({
      message: "Permit2 endpoint accessed successfully",
      timestamp: timestamp(),
      method: "permit2",
    }),
  },
  {
    path: ROUTE_PATHS.EXACT_EVM_PERMIT2_EIP2612,
    network: "evm",
    response: () => ({
      message: "Permit2 EIP-2612 endpoint accessed successfully",
      timestamp: timestamp(),
      method: "permit2-eip2612",
    }),
  },
  {
    path: ROUTE_PATHS.EXACT_EVM_PERMIT2_ERC20,
    network: "evm",
    response: () => ({
      message: "Permit2 ERC-20 approval endpoint accessed successfully",
      timestamp: timestamp(),
      method: "permit2-erc20-approval",
    }),
  },
  {
    path: ROUTE_PATHS.UPTO_EVM_PERMIT2,
    network: "evm",
    settlementOverride: { amount: "1000" },
    response: () => ({
      message: "Upto Permit2 endpoint accessed successfully",
      timestamp: timestamp(),
      method: "upto-permit2",
    }),
  },
  {
    path: ROUTE_PATHS.UPTO_EVM_PERMIT2_EIP2612,
    network: "evm",
    settlementOverride: { amount: "1000" },
    response: () => ({
      message: "Upto Permit2 EIP-2612 endpoint accessed successfully",
      timestamp: timestamp(),
      method: "upto-permit2-eip2612",
    }),
  },
  {
    path: ROUTE_PATHS.UPTO_EVM_PERMIT2_ERC20,
    network: "evm",
    settlementOverride: { amount: "1000" },
    response: () => ({
      message: "Upto Permit2 ERC-20 approval endpoint accessed successfully",
      timestamp: timestamp(),
      method: "upto-permit2-erc20-approval",
    }),
  },
  {
    path: ROUTE_PATHS.EXACT_STELLAR,
    network: "stellar",
    response: () => ({
      message: "Protected Stellar endpoint accessed successfully",
      timestamp: timestamp(),
    }),
  },
  {
    path: ROUTE_PATHS.EXACT_TVM,
    network: "tvm",
    response: () => ({
      message: "Protected TVM endpoint accessed successfully",
      timestamp: timestamp(),
    }),
  },
  {
    path: ROUTE_PATHS.EXACT_NEAR,
    network: "near",
    response: () => ({
      message: "Protected NEAR endpoint accessed successfully",
      timestamp: timestamp(),
    }),
  },
  {
    path: ROUTE_PATHS.EXACT_XRPL_SEQUENCE,
    network: "xrpl",
    response: () => ({
      message: "Protected XRPL endpoint accessed successfully",
      timestamp: timestamp(),
    }),
  },
  {
    path: ROUTE_PATHS.EXACT_XRPL_TICKET_SEQUENCE,
    network: "xrpl",
    response: () => ({
      message: "Protected XRPL endpoint accessed successfully",
      timestamp: timestamp(),
    }),
  },
];

const E2E_GET_ROUTE_BY_PATH = new Map(E2E_GET_ROUTES.map(route => [route.path, route]));

/** Returns a 501 payload when `path` is a protected route whose network is not configured. */
export function getUnconfiguredResponseForPath(
  path: string,
  cfg: ServerEnvConfig,
): { error: string; message: string } | null {
  const route = E2E_GET_ROUTE_BY_PATH.get(path);
  if (!route) {
    return null;
  }
  if (isFamilyConfigured(cfg, route.network)) {
    return null;
  }
  return buildUnconfiguredFamilyError(route.network);
}

export function buildHealthResponse(cfg: ServerEnvConfig): Record<string, unknown> {
  return {
    status: "ok",
    network: getFamilyNetwork(cfg, "evm"),
    payee: getServerAddress(cfg, "evm") ?? null,
    version: "2.0.0",
  };
}

export function buildCloseResponse(): Record<string, unknown> {
  return { message: "Server shutting down gracefully" };
}

export function formatStartupBanner(
  cfg: ServerEnvConfig,
  options: { title: string; address: string },
): string {
  const optional = (value: string | undefined) => value || "(not configured)";

  const networkLines = PROTOCOL_FAMILIES.map(family => {
    const label = FAMILY_DISPLAY_NAME[family];
    const network = getFamilyNetwork(cfg, family);
    return `║  ${label} Network: ${network}`.padEnd(57) + "║";
  }).join("\n");

  const payeeLines = PROTOCOL_FAMILIES.map(family => {
    const label = FAMILY_DISPLAY_NAME[family];
    const addressKey = FAMILY_CREDENTIALS[family].server[0];
    const payee = optional(cfg[addressKey as keyof ServerEnvConfig] as string | undefined);
    return `║  ${label} Payee: ${payee}`.padEnd(57) + "║";
  }).join("\n");

  return `
╔════════════════════════════════════════════════════════╗
║           ${options.title.padEnd(39)}║
╠════════════════════════════════════════════════════════╣
║  Server:       ${options.address.padEnd(39)}║
${networkLines}
${payeeLines}
║                                                        ║
║  Endpoints:                                            ║
║  • GET  /exact/avm                            (AVM)           ║
║  • GET  /exact/evm/eip3009                    (EVM EIP-3009)  ║
║  • GET  /batch-settlement/evm/eip3009         (Batch-settlement) ║
║  • GET  /batch-settlement/evm/permit2         (Batch Permit2)  ║
║  • GET  /batch-settlement/evm/permit2-eip2612GasSponsoring    ║
║  • GET  /batch-settlement/evm/permit2-erc20ApprovalGasSponsoring ║
║  • GET  /exact/evm/permit2                    (Permit2)       ║
║  • GET  /exact/evm/permit2-eip2612GasSponsoring               ║
║  • GET  /exact/evm/permit2-erc20ApprovalGasSponsoring         ║
║  • GET  /exact/svm                            (SVM)           ║
║  • GET  /exact/aptos                          (Aptos)         ║
║  • GET  /exact/hedera                         (Hedera)        ║
║  • GET  /exact/keeta                          (Keeta)        ║
║  • GET  /exact/ccd                            (CCD)           ║
║  • GET  /exact/stellar                        (Stellar)       ║
║  • GET  /exact/tvm                            (TVM)           ║
║  • GET  /exact/near                           (NEAR)          ║
║  • GET  /exact/xrpl/sequence                  (XRPL Sequence) ║
║  • GET  /exact/xrpl/ticketSequence            (XRPL Ticket)   ║
║  • GET  /health                (no payment required)       ║
║  • POST /close                 (shutdown server)           ║
╚════════════════════════════════════════════════════════╝
  `;
}
