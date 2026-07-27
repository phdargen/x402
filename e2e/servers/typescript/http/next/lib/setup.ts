import { NextRequest, NextResponse } from "next/server";
import { paymentProxy, withX402 } from "@x402/next";
import {
  SETTLEMENT_OVERRIDES_HEADER,
  x402ResourceServer,
  type RouteConfig,
  type RoutesConfig,
} from "@x402/core/server";

import {
  catalogPathFromNextSegments,
  nextProxyHttpPath,
  PROTECTED_ROUTE_MESSAGE,
} from "../../../../../src/mechanisms";
import {
  buildUnconfiguredFamilyError,
  isFamilyConfigured,
  loadServerEnv,
  type ServerEnvConfig,
} from "../../../../../src/server-env";
import { catalogRoutes, resolvedRoutes } from "../../../shared/catalog";
import {
  buildResolvedRouteConfig,
  configureResourceServer,
  createFacilitatorClients,
} from "../../../shared/config";

export { nextProxyHttpPath, nextWithX402HttpPath } from "../../../../../src/mechanisms";

/** Map a Next API path back to its catalog path, if it is a known paid route. */
export function catalogPathFromNextPath(path: string): string | null {
  if (!path.startsWith("/api")) {
    return null;
  }
  const rest = path.slice("/api".length);
  if (rest.endsWith("/withx402")) {
    return rest.slice(0, -"/withx402".length);
  }
  return catalogPathFromNextSegments(rest.split("/").filter(Boolean));
}

/** Payment-proxy route map keyed by Next URL paths (only configured payees). */
export function buildNextProxyRoutes(cfg: ServerEnvConfig): RoutesConfig {
  const routes: Record<string, unknown> = {};
  for (const route of resolvedRoutes(cfg)) {
    routes[nextProxyHttpPath(route)] = buildResolvedRouteConfig(route);
  }
  return routes as RoutesConfig;
}

/** 501 payload when a Next path belongs to a network with no payee configured. */
export function getUnconfiguredResponseForNextPath(
  path: string,
  cfg: ServerEnvConfig,
): { error: string; message: string } | null {
  const catalogPath = catalogPathFromNextPath(path);
  if (!catalogPath) {
    return null;
  }
  const route = catalogRoutes().find(entry => entry.path === catalogPath);
  if (!route || isFamilyConfigured(cfg, route.network)) {
    return null;
  }
  return buildUnconfiguredFamilyError(route.network);
}

/** App Router handler for catalog routes served behind paymentProxy. */
export function createProxyRouteHandler(catalogPath: string) {
  return async function GET() {
    const cfg = loadServerEnv();
    const route = resolvedRoutes(cfg).find(entry => entry.path === catalogPath);
    const response = NextResponse.json({
      message: PROTECTED_ROUTE_MESSAGE,
      timestamp: new Date().toISOString(),
    });
    if (route?.settlementOverride) {
      response.headers.set(
        SETTLEMENT_OVERRIDES_HEADER,
        JSON.stringify(route.settlementOverride),
      );
    }
    return response;
  };
}

export function createResourceServer(cfg: ServerEnvConfig): x402ResourceServer {
  const server = new x402ResourceServer(createFacilitatorClients(cfg.facilitatorUrl));
  configureResourceServer(server, cfg);
  return server;
}

/** Wrap paymentProxy so unconfigured catalog routes answer 501 like express/hono/fastify. */
export function createNextPaymentProxy(
  cfg: ServerEnvConfig,
  server: x402ResourceServer,
): (req: NextRequest) => Promise<NextResponse | Response> {
  const routes = buildNextProxyRoutes(cfg);
  const baseProxy = paymentProxy(routes, server);

  return async (req: NextRequest) => {
    const unconfigured = getUnconfiguredResponseForNextPath(req.nextUrl.pathname, cfg);
    if (unconfigured) {
      return NextResponse.json(unconfigured, { status: 501 });
    }
    return baseProxy(req);
  };
}

export function buildWithX402RouteConfig(
  catalogPath: string,
  cfg: ServerEnvConfig,
): RouteConfig | null {
  const route = resolvedRoutes(cfg).find(entry => entry.path === catalogPath);
  if (!route) {
    return null;
  }
  return buildResolvedRouteConfig(route) as unknown as RouteConfig;
}

function buildWithX402Handler(catalogPath: string, cfg: ServerEnvConfig) {
  return async (_req: NextRequest) => {
    const route = resolvedRoutes(cfg).find(entry => entry.path === catalogPath);
    const response = NextResponse.json({
      message: PROTECTED_ROUTE_MESSAGE,
      timestamp: new Date().toISOString(),
      wrapper: "withX402",
    });
    if (route?.settlementOverride) {
      response.headers.set(
        SETTLEMENT_OVERRIDES_HEADER,
        JSON.stringify(route.settlementOverride),
      );
    }
    return response;
  };
}

/** App Router GET handler for any catalog route's withX402 variant. */
export function createWithX402GetHandler(catalogPath: string, server: x402ResourceServer) {
  if (!catalogRoutes().some(route => route.path === catalogPath)) {
    throw new Error(`Unknown catalog path for withX402 route: ${catalogPath}`);
  }

  let wrapped: ((req: NextRequest) => Promise<Response>) | undefined;

  return async (req: NextRequest) => {
    const cfg = loadServerEnv();
    const routeConfig = buildWithX402RouteConfig(catalogPath, cfg);
    if (!routeConfig) {
      const catalogRoute = catalogRoutes().find(entry => entry.path === catalogPath);
      return NextResponse.json(
        catalogRoute
          ? buildUnconfiguredFamilyError(catalogRoute.network)
          : { error: "Not configured", message: "Route is not configured" },
        { status: 501 },
      );
    }

    if (!wrapped) {
      wrapped = withX402(buildWithX402Handler(catalogPath, cfg), routeConfig, server);
    }
    return wrapped(req);
  };
}

/** Resolve a catalog path from a catch-all proxy route's URL segments. */
export function resolveProxyCatalogPath(segments: string[]): string | null {
  return catalogPathFromNextSegments(segments);
}

export function isKnownCatalogPath(catalogPath: string): boolean {
  return catalogRoutes().some(route => route.path === catalogPath);
}
