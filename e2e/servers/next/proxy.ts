import { paymentProxy } from "@x402/next";
import { x402ResourceServer, HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { UptoEvmScheme } from "@x402/evm/upto/server";
import { BatchSettlementEvmScheme } from "@x402/evm/batch-settlement/server";
import { privateKeyToAccount } from "viem/accounts";
import { ExactSvmScheme } from "@x402/svm/exact/server";
import { ExactAptosScheme } from "@x402/aptos/exact/server";
import { ExactHederaScheme } from "@x402/hedera/exact/server";
import { KEETA_TESTNET_CAIP2 } from "@x402/keeta";
import { ExactKeetaScheme } from "@x402/keeta/exact/server";
import { ExactNearScheme } from "@x402/near/exact/server";
import type { XrplAssetTransferMethod } from "@x402/xrpl";
import { ExactXrplScheme } from "@x402/xrpl/exact/server";
import { ExactStellarScheme } from "@x402/stellar/exact/server";
import { ExactTvmScheme } from "@x402/tvm/exact/server";
import { ExactAvmScheme } from "@x402/avm/exact/server";
import { ExactConcordiumScheme } from "@x402/concordium/exact/server";
import { bazaarResourceServerExtension, declareDiscoveryExtension } from "@x402/extensions/bazaar";
import {
  declareEip2612GasSponsoringExtension,
  declareErc20ApprovalGasSponsoringExtension,
} from "@x402/extensions";

export const SERVER_EVM_ADDRESS = process.env.SERVER_EVM_ADDRESS as `0x${string}`;
export const SERVER_SVM_ADDRESS = process.env.SERVER_SVM_ADDRESS as string;
export const SERVER_AVM_ADDRESS = process.env.SERVER_AVM_ADDRESS as string;
export const SERVER_APTOS_ADDRESS = process.env.SERVER_APTOS_ADDRESS as string;
export const SERVER_HEDERA_ADDRESS = process.env.SERVER_HEDERA_ADDRESS as string | undefined;
export const SERVER_KEETA_ADDRESS = process.env.SERVER_KEETA_ADDRESS as string | undefined;
export const SERVER_STELLAR_ADDRESS = process.env.SERVER_STELLAR_ADDRESS as string | undefined;
export const SERVER_TVM_ADDRESS = process.env.SERVER_TVM_ADDRESS as string | undefined;
export const EVM_NETWORK = (process.env.EVM_NETWORK || "eip155:84532") as `${string}:${string}`;
export const SVM_NETWORK = (process.env.SVM_NETWORK ||
  "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1") as `${string}:${string}`;
export const AVM_NETWORK = (process.env.AVM_NETWORK ||
  "algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDe") as `${string}:${string}`;
export const APTOS_NETWORK = (process.env.APTOS_NETWORK || "aptos:2") as `${string}:${string}`;
export const HEDERA_NETWORK = (process.env.HEDERA_NETWORK ||
  "hedera:testnet") as `${string}:${string}`;
export const HEDERA_ASSET = process.env.HEDERA_ASSET ?? "0.0.0"; // 0.0.0 = HBAR or 0.0.429274 for USDC testnet
export const HEDERA_AMOUNT = process.env.HEDERA_AMOUNT ?? "100000"; // price in smallest units (tinybars or token decimals), defaults to 0.001 HBAR or 0.1 USDC
export const KEETA_NETWORK = (process.env.KEETA_NETWORK || KEETA_TESTNET_CAIP2) as `${string}:${string}`;
export const STELLAR_NETWORK = (process.env.STELLAR_NETWORK ||
  "stellar:testnet") as `${string}:${string}`;
export const TVM_NETWORK = (process.env.TVM_NETWORK || "tvm:-3") as `${string}:${string}`;
export const SERVER_NEAR_ADDRESS = process.env.SERVER_NEAR_ADDRESS as string | undefined;
export const NEAR_NETWORK = (process.env.NEAR_NETWORK || "near:testnet") as `${string}:${string}`;
export const SERVER_NEAR_ASSET = process.env.SERVER_NEAR_ASSET as string | undefined;
export const SERVER_NEAR_AMOUNT = process.env.SERVER_NEAR_AMOUNT as string | undefined;
export const SERVER_XRPL_ADDRESS = process.env.SERVER_XRPL_ADDRESS as string | undefined;
export const XRPL_NETWORK = (process.env.XRPL_NETWORK || "xrpl:1") as `${string}:${string}`;
export const SERVER_XRPL_ASSET = process.env.SERVER_XRPL_ASSET as string | undefined;
export const SERVER_XRPL_AMOUNT = process.env.SERVER_XRPL_AMOUNT as string | undefined;
export const SERVER_XRPL_ISSUER = process.env.SERVER_XRPL_ISSUER as string | undefined;
export const CCD_NETWORK = (process.env.CCD_NETWORK || "ccd:4221332d34e1694168c2a0c0b3fd0f27") as `${string}:${string}`;
export const SERVER_CCD_ADDRESS = process.env.SERVER_CCD_ADDRESS as string | undefined;
export const CCD_WEATHER_PRICE_MICRO_CCD = "1000";
const EVM_PERMIT2_ASSET = process.env.EVM_PERMIT2_ASSET as `0x${string}`;
const facilitatorUrl = process.env.FACILITATOR_URL;

export const createXrplPaymentConfig = (
  payTo: string,
  assetTransferMethod: XrplAssetTransferMethod,
) => ({
  accepts: {
    payTo,
    scheme: "exact" as const,
    price: {
      amount: SERVER_XRPL_AMOUNT || "1000",
      asset: SERVER_XRPL_ASSET || "XRP",
      extra: {
        assetTransferMethod,
        ...(SERVER_XRPL_ASSET && SERVER_XRPL_ASSET !== "XRP" && SERVER_XRPL_ISSUER ? { issuer: SERVER_XRPL_ISSUER } : {}),
      },
    },
    network: XRPL_NETWORK,
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
});

if (!facilitatorUrl) {
  console.error("❌ FACILITATOR_URL environment variable is required");
  process.exit(1);
}

// Create facilitator clients (mock facilitator as fallback for startup validation)
const facilitatorClients = [new HTTPFacilitatorClient({ url: facilitatorUrl })];
const mockFacilitatorUrl = process.env.MOCK_FACILITATOR_URL;
if (mockFacilitatorUrl) {
  facilitatorClients.push(new HTTPFacilitatorClient({ url: mockFacilitatorUrl }));
}

// Create x402 resource server with builder pattern (cleaner!)
export const server = new x402ResourceServer(facilitatorClients);

// Register server schemes
if (SERVER_AVM_ADDRESS) {
  server.register("algorand:*", new ExactAvmScheme());
}
if (SERVER_CCD_ADDRESS) {
  server.register("ccd:*", new ExactConcordiumScheme());
}
server.register("eip155:*", new ExactEvmScheme());
server.register("eip155:*", new UptoEvmScheme());

// Register batch-settlement scheme for the EVM payee.
// e2e flow does NOT use ChannelManager — settle actions are handled inline.
const receiverAuthorizerPrivateKey = process.env.SERVER_EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY as
  | `0x${string}`
  | undefined;
const receiverAuthorizerSigner = receiverAuthorizerPrivateKey
  ? privateKeyToAccount(receiverAuthorizerPrivateKey)
  : undefined;
server.register(
  "eip155:*",
  new BatchSettlementEvmScheme(SERVER_EVM_ADDRESS, {
    ...(receiverAuthorizerSigner ? { receiverAuthorizerSigner } : {}),
  }),
);
server.register("solana:*", new ExactSvmScheme());
if (SERVER_APTOS_ADDRESS) {
  server.register("aptos:*", new ExactAptosScheme());
}
if (SERVER_HEDERA_ADDRESS) {
  server.register("hedera:*", new ExactHederaScheme());
}
if (SERVER_KEETA_ADDRESS) {
  server.register("keeta:*", new ExactKeetaScheme());
}
if (SERVER_STELLAR_ADDRESS) {
  server.register("stellar:*", new ExactStellarScheme());
}
if (SERVER_TVM_ADDRESS) {
  server.register("tvm:*", new ExactTvmScheme());
}
if (SERVER_NEAR_ADDRESS) {
  server.register("near:*", new ExactNearScheme());
}
if (SERVER_XRPL_ADDRESS) {
  server.register("xrpl:*", new ExactXrplScheme());
}

// Register Bazaar discovery extension
server.registerExtension(bazaarResourceServerExtension);

console.log(`Using remote facilitator at: ${facilitatorUrl}`);

export const proxy = paymentProxy(
  {
    "/api/batch-settlement/evm/eip3009/proxy": {
      accepts: {
        payTo: SERVER_EVM_ADDRESS,
        scheme: "batch-settlement",
        price: "$0.001",
        network: EVM_NETWORK,
      },
    },
    "/api/batch-settlement/evm/permit2/proxy": {
      accepts: {
        payTo: SERVER_EVM_ADDRESS,
        scheme: "batch-settlement",
        network: EVM_NETWORK,
        price: {
          amount: "1000",
          asset: EVM_PERMIT2_ASSET,
          extra: {
            assetTransferMethod: "permit2",
            name: EVM_NETWORK == "eip155:84532" ? "USDC" : "USD Coin",
            version: "2",
          },
        },
      },
    },
    "/api/batch-settlement/evm/permit2-eip2612GasSponsoring/proxy": {
      accepts: {
        payTo: SERVER_EVM_ADDRESS,
        scheme: "batch-settlement",
        network: EVM_NETWORK,
        price: "$0.001",
        extra: { assetTransferMethod: "permit2" },
      },
      extensions: {
        ...declareEip2612GasSponsoringExtension(),
      },
    },
    "/api/batch-settlement/evm/permit2-erc20ApprovalGasSponsoring/proxy": {
      accepts: {
        payTo: SERVER_EVM_ADDRESS,
        scheme: "batch-settlement",
        network: EVM_NETWORK,
        price: {
          amount: "1000",
          asset: EVM_PERMIT2_ASSET,
          extra: {
            assetTransferMethod: "permit2",
          },
        },
      },
      extensions: {
        ...declareErc20ApprovalGasSponsoringExtension(),
      },
    },
    "/api/exact/evm/eip3009/proxy": {
      accepts: {
        payTo: SERVER_EVM_ADDRESS,
        scheme: "exact",
        price: "$0.001",
        network: EVM_NETWORK,
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
    "/api/exact/svm": {
      accepts: {
        payTo: SERVER_SVM_ADDRESS,
        scheme: "exact",
        price: "$0.001",
        network: SVM_NETWORK,
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
    ...(SERVER_AVM_ADDRESS
      ? {
          "/api/exact/avm": {
            accepts: {
              payTo: SERVER_AVM_ADDRESS,
              scheme: "exact",
              price: "$0.001",
              network: AVM_NETWORK,
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
    ...(SERVER_CCD_ADDRESS
      ? {
          "/api/exact/ccd": {
            accepts: {
              payTo: SERVER_CCD_ADDRESS,
              scheme: "exact",
              price: {
                amount: CCD_WEATHER_PRICE_MICRO_CCD,
                asset: "CCD",
              },
              network: CCD_NETWORK,
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
    ...(SERVER_APTOS_ADDRESS
      ? {
          "/api/exact/aptos": {
            accepts: {
              payTo: SERVER_APTOS_ADDRESS,
              scheme: "exact",
              price: "$0.001",
              network: APTOS_NETWORK,
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
    ...(SERVER_HEDERA_ADDRESS
      ? {
          "/api/exact/hedera": {
            accepts: {
              payTo: SERVER_HEDERA_ADDRESS,
              scheme: "exact",
              price: {
                amount: HEDERA_AMOUNT,
                asset: HEDERA_ASSET,
              },
              network: HEDERA_NETWORK,
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
    ...(SERVER_KEETA_ADDRESS
      ? {
        "/api/exact/keeta": {
          accepts: {
            payTo: SERVER_KEETA_ADDRESS,
            scheme: "exact",
            price: "$0.001",
            network: KEETA_NETWORK,
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
    ...(SERVER_NEAR_ADDRESS
      ? {
          "/api/exact/near": {
            accepts: {
              payTo: SERVER_NEAR_ADDRESS,
              scheme: "exact" as const,
              price: {
                amount: SERVER_NEAR_AMOUNT || "1000000000000000000000",
                asset: SERVER_NEAR_ASSET || "wrap.testnet",
              },
              network: NEAR_NETWORK,
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
    ...(SERVER_XRPL_ADDRESS
      ? {
          "/api/exact/xrpl/sequence": createXrplPaymentConfig(SERVER_XRPL_ADDRESS, "sequence"),
          "/api/exact/xrpl/ticketSequence": createXrplPaymentConfig(
            SERVER_XRPL_ADDRESS,
            "ticketSequence",
          ),
        }
      : {}),
    ...(SERVER_STELLAR_ADDRESS
      ? {
          "/api/exact/stellar": {
            accepts: {
              payTo: SERVER_STELLAR_ADDRESS,
              scheme: "exact",
              price: "$0.001",
              network: STELLAR_NETWORK,
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
    ...(SERVER_TVM_ADDRESS
      ? {
          "/api/exact/tvm": {
            accepts: {
              payTo: SERVER_TVM_ADDRESS,
              scheme: "exact",
              price: "$0.001",
              network: TVM_NETWORK,
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
    "/api/exact/evm/permit2/proxy": {
      accepts: {
        payTo: SERVER_EVM_ADDRESS,
        scheme: "exact",
        network: EVM_NETWORK,
        price: {
          amount: "1000",
          asset: EVM_PERMIT2_ASSET,
          extra: {
            assetTransferMethod: "permit2",
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
    "/api/exact/evm/permit2-eip2612GasSponsoring/proxy": {
      accepts: {
        payTo: SERVER_EVM_ADDRESS,
        scheme: "exact",
        network: EVM_NETWORK,
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
    "/api/exact/evm/permit2-erc20ApprovalGasSponsoring/proxy": {
      accepts: {
        payTo: SERVER_EVM_ADDRESS,
        scheme: "exact",
        network: EVM_NETWORK,
        price: {
          amount: "1000",
          asset: EVM_PERMIT2_ASSET,
          extra: {
            assetTransferMethod: "permit2",
          },
        },
      },
      extensions: {
        ...declareErc20ApprovalGasSponsoringExtension(),
      },
    },
    "/api/upto/evm/permit2": {
      accepts: {
        payTo: SERVER_EVM_ADDRESS,
        scheme: "upto",
        network: EVM_NETWORK,
        price: {
          amount: "2000",
          asset: EVM_PERMIT2_ASSET,
          extra: {
            assetTransferMethod: "permit2",
            name: EVM_NETWORK == "eip155:84532" ? "USDC" : "USD Coin",
            version: "2",
          },
        },
      },
    },
    "/api/upto/evm/permit2-eip2612GasSponsoring": {
      accepts: {
        payTo: SERVER_EVM_ADDRESS,
        scheme: "upto",
        network: EVM_NETWORK,
        price: {
          amount: "2000",
          asset: EVM_PERMIT2_ASSET,
          extra: {
            assetTransferMethod: "permit2",
            name: EVM_NETWORK == "eip155:84532" ? "USDC" : "USD Coin",
            version: "2",
          },
        },
      },
      extensions: {
        ...declareEip2612GasSponsoringExtension(),
      },
    },
    "/api/upto/evm/permit2-erc20ApprovalGasSponsoring": {
      accepts: {
        payTo: SERVER_EVM_ADDRESS,
        scheme: "upto",
        network: EVM_NETWORK,
        price: {
          amount: "2000",
          asset: EVM_PERMIT2_ASSET,
          extra: {
            assetTransferMethod: "permit2",
          },
        },
      },
      extensions: {
        ...declareErc20ApprovalGasSponsoringExtension(),
      },
    },
  },
  server, // Pass pre-configured server instance
);

export const config = {
  matcher: [
    "/api/exact/evm/eip3009/proxy",
    "/api/exact/svm",
    "/api/exact/avm",
    "/api/exact/aptos",
    "/api/exact/hedera",
    "/api/exact/keeta",
    "/api/exact/near",
    "/api/exact/xrpl/sequence",
    "/api/exact/xrpl/ticketSequence",
    "/api/exact/ccd",
    "/api/exact/stellar",
    "/api/exact/tvm",
    "/api/exact/evm/permit2/proxy",
    "/api/exact/evm/permit2-eip2612GasSponsoring/proxy",
    "/api/exact/evm/permit2-erc20ApprovalGasSponsoring/proxy",
    "/api/upto/evm/permit2",
    "/api/upto/evm/permit2-eip2612GasSponsoring",
    "/api/upto/evm/permit2-erc20ApprovalGasSponsoring",
    "/api/batch-settlement/evm/eip3009/proxy",
    "/api/batch-settlement/evm/permit2/proxy",
    "/api/batch-settlement/evm/permit2-eip2612GasSponsoring/proxy",
    "/api/batch-settlement/evm/permit2-erc20ApprovalGasSponsoring/proxy",
  ],
};
