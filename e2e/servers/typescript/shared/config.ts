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
import { ExactXrplScheme } from "@x402/xrpl/exact/server";
import { ExactConcordiumScheme } from "@x402/concordium/exact/server";
import { bazaarResourceServerExtension, declareDiscoveryExtension } from "@x402/extensions/bazaar";
import {
  declareEip2612GasSponsoringExtension,
  declareErc20ApprovalGasSponsoringExtension,
} from "@x402/extensions";
import { HTTPFacilitatorClient, type RoutesConfig, type x402ResourceServer } from "@x402/core/server";
import { privateKeyToAccount } from "viem/accounts";
import type { Caip2Network, ServerEnvConfig } from "../../../src/server-env";
import { resolvedRoutes, type ResolvedRoute } from "./catalog";
import { routeDiscoveryOutput } from "../../../src/mechanisms";

export type { Caip2Network, ServerEnvConfig } from "../../../src/server-env";
export { loadServerEnv } from "../../../src/server-env";

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

/** Maps a catalog extension id to the SDK call that declares it on a route. */
function declareExtension(id: string, route: ResolvedRoute): Record<string, unknown> {
  switch (id) {
    case "bazaar":
      return declareDiscoveryExtension({ output: routeDiscoveryOutput() });
    case "eip2612GasSponsoring":
      return declareEip2612GasSponsoringExtension();
    case "erc20ApprovalGasSponsoring":
      return declareErc20ApprovalGasSponsoringExtension();
    default:
      throw new Error(`Route ${route.path} declares unknown extension "${id}"`);
  }
}

/** Single-route payment config shared by HTTP frameworks and the Next e2e server. */
export function buildResolvedRouteConfig(route: ResolvedRoute): Record<string, unknown> {
  const extensions = Object.assign({}, ...route.extensions.map(id => declareExtension(id, route)));

  return {
    accepts: {
      payTo: route.payTo,
      scheme: route.scheme,
      network: route.network as Caip2Network,
      price: route.price,
      ...(route.extra ? { extra: route.extra } : {}),
    },
    ...(route.extensions.length > 0 ? { extensions } : {}),
  };
}

/**
 * Payment-middleware route map for the express/hono/fastify e2e servers, derived
 * from config/mechanisms.json. Routes whose network has no payee address
 * configured are omitted by the resolver.
 */
export function buildPaymentRoutes(cfg: ServerEnvConfig): RoutesConfig {
  const routes: Record<string, unknown> = {};

  for (const route of resolvedRoutes(cfg)) {
    routes[`GET ${route.path}`] = buildResolvedRouteConfig(route);
  }

  return routes as RoutesConfig;
}
