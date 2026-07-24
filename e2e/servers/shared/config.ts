import { ExactAvmScheme } from "@x402/avm/exact/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { UptoEvmScheme } from "@x402/evm/upto/server";
import { BatchSettlementEvmScheme } from "@x402/evm/batch-settlement/server";
import { ExactSvmScheme } from "@x402/svm/exact/server";
import { ExactAptosScheme } from "@x402/aptos/exact/server";
import { ExactHederaScheme } from "@x402/hedera/exact/server";
import { ExactKeetaScheme } from "@x402/keeta/exact/server";
import { ExactStellarScheme } from "@x402/stellar/exact/server";
import { ExactTvmScheme } from "@x402/tvm/exact/server";
import { ExactNearScheme } from "@x402/near/exact/server";
import type { XrplAssetTransferMethod } from "@x402/xrpl";
import { ExactXrplScheme } from "@x402/xrpl/exact/server";
import { ExactConcordiumScheme } from "@x402/concordium/exact/server";
import { bazaarResourceServerExtension, declareDiscoveryExtension } from "@x402/extensions/bazaar";
import {
  declareEip2612GasSponsoringExtension,
  declareErc20ApprovalGasSponsoringExtension,
} from "@x402/extensions";
import { HTTPFacilitatorClient, type RoutesConfig, type x402ResourceServer } from "@x402/core/server";
import { privateKeyToAccount } from "viem/accounts";
import { loadServerEnv, type Caip2Network, type ServerEnvConfig } from "../../src/server-env";
import { ROUTE_PATHS } from "./routes";

export type { Caip2Network, ServerEnvConfig } from "../../src/server-env";

/** @deprecated Use {@link loadServerEnv} from the e2e harness. */
export const loadServerConfig = loadServerEnv;

function buildXrplPaymentConfig(
  cfg: ServerEnvConfig,
  payTo: string,
  assetTransferMethod: XrplAssetTransferMethod,
) {
  return {
    accepts: {
      payTo,
      scheme: "exact" as const,
      price: {
        amount: cfg.SERVER_XRPL_AMOUNT || "1000",
        asset: cfg.SERVER_XRPL_ASSET || "XRP",
        extra: {
          assetTransferMethod,
          ...(cfg.SERVER_XRPL_ASSET &&
          cfg.SERVER_XRPL_ASSET !== "XRP" &&
          cfg.SERVER_XRPL_ISSUER
            ? { issuer: cfg.SERVER_XRPL_ISSUER }
            : {}),
        },
      },
      network: cfg.XRPL_NETWORK,
    },
    extensions: {
      ...declareDiscoveryExtension({
        output: {
          example: {
            message: "Protected XRPL endpoint accessed successfully",
            timestamp: "2024-01-01T00:00:00Z",
          },
          schema: {
            properties: {
              message: { type: "string" },
              timestamp: { type: "string" },
            },
            required: ["message", "timestamp"],
          },
        },
      }),
    },
  };
}

/**
 * Builds facilitator clients from FACILITATOR_URL (+ optional MOCK_FACILITATOR_URL).
 */
export function createFacilitatorClients(facilitatorUrl: string): HTTPFacilitatorClient[] {
  const facilitatorClients = [new HTTPFacilitatorClient({ url: facilitatorUrl })];
  const mockFacilitatorUrl = process.env.MOCK_FACILITATOR_URL;
  if (mockFacilitatorUrl) {
    facilitatorClients.push(new HTTPFacilitatorClient({ url: mockFacilitatorUrl }));
  }
  return facilitatorClients;
}

/**
 * Registers all e2e schemes + bazaar extension on a resource server.
 */
export function configureResourceServer(server: x402ResourceServer, cfg: ServerEnvConfig): void {
  if (cfg.SERVER_AVM_ADDRESS) {
    server.register("algorand:*", new ExactAvmScheme());
  }
  if (cfg.SERVER_CCD_ADDRESS) {
    server.register("ccd:*", new ExactConcordiumScheme());
  }
  if (cfg.SERVER_EVM_ADDRESS) {
    server.register("eip155:*", new ExactEvmScheme());
    server.register("eip155:*", new UptoEvmScheme());

    // e2e flow does NOT use ChannelManager — settle actions are handled inline.
    const receiverAuthorizerPrivateKey = process.env.SERVER_EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY as
      | `0x${string}`
      | undefined;
    const receiverAuthorizerSigner = receiverAuthorizerPrivateKey
      ? privateKeyToAccount(receiverAuthorizerPrivateKey)
      : undefined;
    server.register(
      "eip155:*",
      new BatchSettlementEvmScheme(cfg.SERVER_EVM_ADDRESS as `0x${string}`, {
        ...(receiverAuthorizerSigner ? { receiverAuthorizerSigner } : {}),
      }),
    );
  }
  if (cfg.SERVER_SVM_ADDRESS) {
    server.register("solana:*", new ExactSvmScheme());
  }
  if (cfg.SERVER_APTOS_ADDRESS) {
    server.register("aptos:*", new ExactAptosScheme());
  }
  if (cfg.SERVER_HEDERA_ADDRESS) {
    server.register("hedera:*", new ExactHederaScheme());
  }
  if (cfg.SERVER_KEETA_ADDRESS) {
    server.register("keeta:*", new ExactKeetaScheme());
  }
  if (cfg.SERVER_STELLAR_ADDRESS) {
    server.register("stellar:*", new ExactStellarScheme());
  }
  if (cfg.SERVER_TVM_ADDRESS) {
    server.register("tvm:*", new ExactTvmScheme());
  }
  if (cfg.SERVER_NEAR_ADDRESS) {
    server.register("near:*", new ExactNearScheme());
  }
  if (cfg.SERVER_XRPL_ADDRESS) {
    server.register("xrpl:*", new ExactXrplScheme());
  }

  server.registerExtension(bazaarResourceServerExtension);
}

/**
 * Shared payment-middleware route map for express/hono/fastify e2e servers.
 */
export function buildPaymentRoutes(cfg: ServerEnvConfig): RoutesConfig {
  const evmRoutes = cfg.SERVER_EVM_ADDRESS
    ? {
        [`GET ${ROUTE_PATHS.BATCH_SETTLEMENT_EVM_EIP3009}`]: {
          accepts: {
            payTo: cfg.SERVER_EVM_ADDRESS,
            scheme: "batch-settlement",
            price: "$0.001",
            network: cfg.EVM_NETWORK,
          },
        },
        [`GET ${ROUTE_PATHS.BATCH_SETTLEMENT_EVM_PERMIT2}`]: {
          accepts: {
            payTo: cfg.SERVER_EVM_ADDRESS,
            scheme: "batch-settlement",
            network: cfg.EVM_NETWORK,
            price: {
              amount: "1000",
              asset: cfg.EVM_PERMIT2_ASSET,
              extra: {
                assetTransferMethod: "permit2",
                name: cfg.EVM_NETWORK == "eip155:84532" ? "USDC" : "USD Coin",
                version: "2",
              },
            },
          },
        },
        [`GET ${ROUTE_PATHS.BATCH_SETTLEMENT_EVM_PERMIT2_EIP2612}`]: {
          accepts: {
            payTo: cfg.SERVER_EVM_ADDRESS,
            scheme: "batch-settlement",
            network: cfg.EVM_NETWORK,
            price: "$0.001",
            extra: { assetTransferMethod: "permit2" },
          },
          extensions: {
            ...declareEip2612GasSponsoringExtension(),
          },
        },
        [`GET ${ROUTE_PATHS.BATCH_SETTLEMENT_EVM_PERMIT2_ERC20}`]: {
          accepts: {
            payTo: cfg.SERVER_EVM_ADDRESS,
            scheme: "batch-settlement",
            network: cfg.EVM_NETWORK,
            price: {
              amount: "1000",
              asset: cfg.EVM_PERMIT2_ASSET,
              extra: {
                assetTransferMethod: "permit2",
              },
            },
          },
          extensions: {
            ...declareErc20ApprovalGasSponsoringExtension(),
          },
        },
        [`GET ${ROUTE_PATHS.EXACT_EVM_EIP3009}`]: {
          accepts: {
            payTo: cfg.SERVER_EVM_ADDRESS,
            scheme: "exact",
            price: "$0.001",
            network: cfg.EVM_NETWORK,
          },
          extensions: {
            ...declareDiscoveryExtension({
              output: {
                example: {
                  message: "Protected endpoint accessed successfully",
                  timestamp: "2024-01-01T00:00:00Z",
                },
                schema: {
                  properties: {
                    message: { type: "string" },
                    timestamp: { type: "string" },
                  },
                  required: ["message", "timestamp"],
                },
              },
            }),
          },
        },
        [`GET ${ROUTE_PATHS.EXACT_EVM_PERMIT2}`]: {
          accepts: {
            payTo: cfg.SERVER_EVM_ADDRESS,
            scheme: "exact",
            network: cfg.EVM_NETWORK,
            price: {
              amount: "1000",
              asset: cfg.EVM_PERMIT2_ASSET,
              extra: {
                assetTransferMethod: "permit2",
                name: cfg.EVM_NETWORK == "eip155:84532" ? "USDC" : "USD Coin",
                version: "2",
              },
            },
          },
          extensions: {
            ...declareDiscoveryExtension({
              output: {
                example: {
                  message: "Permit2 endpoint accessed successfully",
                  timestamp: "2024-01-01T00:00:00Z",
                  method: "permit2",
                },
                schema: {
                  properties: {
                    message: { type: "string" },
                    timestamp: { type: "string" },
                    method: { type: "string" },
                  },
                  required: ["message", "timestamp", "method"],
                },
              },
            }),
          },
        },
        [`GET ${ROUTE_PATHS.EXACT_EVM_PERMIT2_EIP2612}`]: {
          accepts: {
            payTo: cfg.SERVER_EVM_ADDRESS,
            scheme: "exact",
            network: cfg.EVM_NETWORK,
            price: "$0.001",
            extra: { assetTransferMethod: "permit2" },
          },
          extensions: {
            ...declareDiscoveryExtension({
              output: {
                example: {
                  message: "Permit2 EIP-2612 endpoint accessed successfully",
                  timestamp: "2024-01-01T00:00:00Z",
                  method: "permit2-eip2612",
                },
                schema: {
                  properties: {
                    message: { type: "string" },
                    timestamp: { type: "string" },
                    method: { type: "string" },
                  },
                  required: ["message", "timestamp", "method"],
                },
              },
            }),
            ...declareEip2612GasSponsoringExtension(),
          },
        },
        [`GET ${ROUTE_PATHS.EXACT_EVM_PERMIT2_ERC20}`]: {
          accepts: {
            payTo: cfg.SERVER_EVM_ADDRESS,
            scheme: "exact",
            network: cfg.EVM_NETWORK,
            price: {
              amount: "1000",
              asset: cfg.EVM_PERMIT2_ASSET,
              extra: {
                assetTransferMethod: "permit2",
              },
            },
          },
          extensions: {
            ...declareErc20ApprovalGasSponsoringExtension(),
          },
        },
        [`GET ${ROUTE_PATHS.UPTO_EVM_PERMIT2}`]: {
          accepts: {
            payTo: cfg.SERVER_EVM_ADDRESS,
            scheme: "upto",
            network: cfg.EVM_NETWORK,
            price: {
              amount: "2000",
              asset: cfg.EVM_PERMIT2_ASSET,
              extra: {
                assetTransferMethod: "permit2",
                name: cfg.EVM_NETWORK == "eip155:84532" ? "USDC" : "USD Coin",
                version: "2",
              },
            },
          },
        },
        [`GET ${ROUTE_PATHS.UPTO_EVM_PERMIT2_EIP2612}`]: {
          accepts: {
            payTo: cfg.SERVER_EVM_ADDRESS,
            scheme: "upto",
            network: cfg.EVM_NETWORK,
            price: {
              amount: "2000",
              asset: cfg.EVM_PERMIT2_ASSET,
              extra: {
                assetTransferMethod: "permit2",
                name: cfg.EVM_NETWORK == "eip155:84532" ? "USDC" : "USD Coin",
                version: "2",
              },
            },
          },
          extensions: {
            ...declareEip2612GasSponsoringExtension(),
          },
        },
        [`GET ${ROUTE_PATHS.UPTO_EVM_PERMIT2_ERC20}`]: {
          accepts: {
            payTo: cfg.SERVER_EVM_ADDRESS,
            scheme: "upto",
            network: cfg.EVM_NETWORK,
            price: {
              amount: "2000",
              asset: cfg.EVM_PERMIT2_ASSET,
              extra: {
                assetTransferMethod: "permit2",
              },
            },
          },
          extensions: {
            ...declareErc20ApprovalGasSponsoringExtension(),
          },
        },
      }
    : {};

  const svmRoutes = cfg.SERVER_SVM_ADDRESS
    ? {
        [`GET ${ROUTE_PATHS.EXACT_SVM}`]: {
          accepts: {
            payTo: cfg.SERVER_SVM_ADDRESS,
            scheme: "exact",
            price: "$0.001",
            network: cfg.SVM_NETWORK,
          },
          extensions: {
            ...declareDiscoveryExtension({
              output: {
                example: {
                  message: "Protected endpoint accessed successfully",
                  timestamp: "2024-01-01T00:00:00Z",
                },
                schema: {
                  properties: {
                    message: { type: "string" },
                    timestamp: { type: "string" },
                  },
                  required: ["message", "timestamp"],
                },
              },
            }),
          },
        },
      }
    : {};

  return {
      ...evmRoutes,
      ...svmRoutes,
      ...(cfg.SERVER_AVM_ADDRESS
        ? {
            [`GET ${ROUTE_PATHS.EXACT_AVM}`]: {
              accepts: {
                payTo: cfg.SERVER_AVM_ADDRESS,
                scheme: "exact",
                price: "$0.001",
                network: cfg.AVM_NETWORK,
              },
              extensions: {
                ...declareDiscoveryExtension({
                  output: {
                    example: {
                      message: "Protected endpoint accessed successfully",
                      timestamp: "2024-01-01T00:00:00Z",
                    },
                    schema: {
                      properties: {
                        message: { type: "string" },
                        timestamp: { type: "string" },
                      },
                      required: ["message", "timestamp"],
                    },
                  },
                }),
              },
            },
          }
        : {}),
      ...(cfg.SERVER_CCD_ADDRESS
        ? {
            [`GET ${ROUTE_PATHS.EXACT_CCD}`]: {
              accepts: {
                payTo: cfg.SERVER_CCD_ADDRESS,
                scheme: "exact",
                price: {
                  amount: cfg.CCD_WEATHER_PRICE_MICRO_CCD,
                  asset: "CCD",
                },
                network: cfg.CCD_NETWORK,
              },
              extensions: {
                ...declareDiscoveryExtension({
                  output: {
                    example: {
                      message: "Protected endpoint accessed successfully",
                      timestamp: "2024-01-01T00:00:00Z",
                    },
                    schema: {
                      properties: {
                        message: { type: "string" },
                        timestamp: { type: "string" },
                      },
                      required: ["message", "timestamp"],
                    },
                  },
                }),
              },
            },
          }
        : {}),
      ...(cfg.SERVER_APTOS_ADDRESS
        ? {
            [`GET ${ROUTE_PATHS.EXACT_APTOS}`]: {
              accepts: {
                payTo: cfg.SERVER_APTOS_ADDRESS,
                scheme: "exact",
                price: "$0.001",
                network: cfg.APTOS_NETWORK,
              },
              extensions: {
                ...declareDiscoveryExtension({
                  output: {
                    example: {
                      message: "Protected endpoint accessed successfully",
                      timestamp: "2024-01-01T00:00:00Z",
                    },
                    schema: {
                      properties: {
                        message: { type: "string" },
                        timestamp: { type: "string" },
                      },
                      required: ["message", "timestamp"],
                    },
                  },
                }),
              },
            },
          }
        : {}),
      ...(cfg.SERVER_HEDERA_ADDRESS
        ? {
            [`GET ${ROUTE_PATHS.EXACT_HEDERA}`]: {
              accepts: {
                payTo: cfg.SERVER_HEDERA_ADDRESS,
                scheme: "exact",
                price: {
                  amount: cfg.HEDERA_AMOUNT,
                  asset: cfg.HEDERA_ASSET,
                },
                network: cfg.HEDERA_NETWORK,
              },
              extensions: {
                ...declareDiscoveryExtension({
                  output: {
                    example: {
                      message: "Protected Hedera endpoint accessed successfully",
                      timestamp: "2024-01-01T00:00:00Z",
                    },
                    schema: {
                      properties: {
                        message: { type: "string" },
                        timestamp: { type: "string" },
                      },
                      required: ["message", "timestamp"],
                    },
                  },
                }),
              },
            },
          }
        : {}),
      ...(cfg.SERVER_KEETA_ADDRESS
        ? {
            [`GET ${ROUTE_PATHS.EXACT_KEETA}`]: {
              accepts: {
                payTo: cfg.SERVER_KEETA_ADDRESS,
                scheme: "exact",
                price: "$0.001",
                network: cfg.KEETA_NETWORK,
              },
              extensions: {
                ...declareDiscoveryExtension({
                  output: {
                    example: {
                      message: "Protected Keeta endpoint accessed successfully",
                      timestamp: "2024-01-01T00:00:00Z",
                    },
                    schema: {
                      properties: {
                        message: { type: "string" },
                        timestamp: { type: "string" },
                      },
                      required: ["message", "timestamp"],
                    },
                  },
                }),
              },
            },
          }
        : {}),
      ...(cfg.SERVER_STELLAR_ADDRESS
        ? {
            [`GET ${ROUTE_PATHS.EXACT_STELLAR}`]: {
              accepts: {
                payTo: cfg.SERVER_STELLAR_ADDRESS!,
                scheme: "exact",
                price: "$0.001",
                network: cfg.STELLAR_NETWORK,
              },
              extensions: {
                ...declareDiscoveryExtension({
                  output: {
                    example: {
                      message: "Protected Stellar endpoint accessed successfully",
                      timestamp: "2024-01-01T00:00:00Z",
                    },
                    schema: {
                      properties: {
                        message: { type: "string" },
                        timestamp: { type: "string" },
                      },
                      required: ["message", "timestamp"],
                    },
                  },
                }),
              },
            },
          }
        : {}),
      ...(cfg.SERVER_TVM_ADDRESS
        ? {
            [`GET ${ROUTE_PATHS.EXACT_TVM}`]: {
              accepts: {
                payTo: cfg.SERVER_TVM_ADDRESS,
                scheme: "exact",
                price: "$0.001",
                network: cfg.TVM_NETWORK,
              },
              extensions: {
                ...declareDiscoveryExtension({
                  output: {
                    example: {
                      message: "Protected TVM endpoint accessed successfully",
                      timestamp: "2024-01-01T00:00:00Z",
                    },
                    schema: {
                      properties: {
                        message: { type: "string" },
                        timestamp: { type: "string" },
                      },
                      required: ["message", "timestamp"],
                    },
                  },
                }),
              },
            },
          }
        : {}),
      ...(cfg.SERVER_NEAR_ADDRESS
        ? {
            [`GET ${ROUTE_PATHS.EXACT_NEAR}`]: {
              accepts: {
                payTo: cfg.SERVER_NEAR_ADDRESS,
                scheme: "exact",
                price: {
                  amount: cfg.SERVER_NEAR_AMOUNT || "1000000000000000000000",
                  asset: cfg.SERVER_NEAR_ASSET || "wrap.testnet",
                },
                network: cfg.NEAR_NETWORK,
              },
              extensions: {
                ...declareDiscoveryExtension({
                  output: {
                    example: {
                      message: "Protected NEAR endpoint accessed successfully",
                      timestamp: "2024-01-01T00:00:00Z",
                    },
                    schema: {
                      properties: {
                        message: { type: "string" },
                        timestamp: { type: "string" },
                      },
                      required: ["message", "timestamp"],
                    },
                  },
                }),
              },
            },
          }
        : {}),
      ...(cfg.SERVER_XRPL_ADDRESS
        ? {
            [`GET ${ROUTE_PATHS.EXACT_XRPL_SEQUENCE}`]: buildXrplPaymentConfig(
              cfg,
              cfg.SERVER_XRPL_ADDRESS,
              "sequence",
            ),
            [`GET ${ROUTE_PATHS.EXACT_XRPL_TICKET_SEQUENCE}`]: buildXrplPaymentConfig(
              cfg,
              cfg.SERVER_XRPL_ADDRESS,
              "ticketSequence",
            ),
          }
        : {}),
  } as RoutesConfig;
}
