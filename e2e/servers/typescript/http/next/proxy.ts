import type { NextRequest } from "next/server";
import { x402ResourceServer } from "@x402/core/server";

import { loadServerEnv } from "../../config";
import { createNextPaymentProxy, createResourceServer } from "./lib/setup";

let resourceServer: x402ResourceServer | undefined;
let proxyHandler: ((req: NextRequest) => Promise<Response>) | undefined;

function ensureRuntime(): {
  server: x402ResourceServer;
  proxy: (req: NextRequest) => Promise<Response>;
} {
  if (!resourceServer || !proxyHandler) {
    const cfg = loadServerEnv();
    resourceServer = createResourceServer(cfg);
    proxyHandler = createNextPaymentProxy(cfg, resourceServer);
    console.log(`Using remote facilitator at: ${cfg.facilitatorUrl}`);
  }
  return { server: resourceServer, proxy: proxyHandler };
}

/** Shared resource server for withX402 route modules (initialized on first use). */
export const server = new Proxy({} as x402ResourceServer, {
  get(_target, prop, receiver) {
    return Reflect.get(ensureRuntime().server as object, prop, receiver);
  },
});

export async function proxy(req: NextRequest) {
  return ensureRuntime().proxy(req);
}

/** Static matcher — paymentProxy skips routes not in the catalog-derived config. */
export const config = {
  matcher: ["/api/:path*"],
};

export type NextProxy = (req: NextRequest) => Promise<Response>;
