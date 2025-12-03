import { NextRequest, NextResponse } from "next/server";
import {
  HTTPRequestContext,
  HTTPResponseInstructions,
  PaywallProvider,
  x402HTTPResourceServer,
  x402ResourceServer,
  RoutesConfig,
} from "@x402/core/server";
import { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { NextAdapter } from "./adapter";

/**
 * Controls when the middleware syncs with the facilitator to discover supported payment kinds.
 *
 * - `'onStart'` - Sync immediately at module load. Use when facilitator is external and always available.
 * - `'lazy'` - Sync on first request. Use when facilitator might not be ready at startup.
 * - `'manual'` - Don't sync automatically. Caller must call `syncFacilitator()` themselves.
 *               Use for AWS Lambda warmup, custom caching, or testing scenarios.
 */
export type FacilitatorSyncMode = "onStart" | "lazy" | "manual";

/**
 * Result of createHttpServer
 */
export interface HttpServerInstance {
  httpServer: x402HTTPResourceServer;
  init: () => Promise<void>;
  syncFacilitator: () => Promise<void>;
}

/**
 * Creates and configures the x402 HTTP server with initialization logic
 *
 * @param routes - The route configuration for the server
 * @param server - The x402 resource server instance
 * @param paywall - Optional paywall provider for custom payment UI
 * @param facilitatorSync - When to sync with the facilitator (defaults to 'onStart')
 * @returns The HTTP server instance with initialization and sync functions
 */
export function createHttpServer(
  routes: RoutesConfig,
  server: x402ResourceServer,
  paywall?: PaywallProvider,
  facilitatorSync: FacilitatorSyncMode = "onStart",
): HttpServerInstance {
  // Create the x402 HTTP server instance with the resource server
  const httpServer = new x402HTTPResourceServer(server, routes);

  // Register custom paywall provider if provided
  if (paywall) {
    httpServer.registerPaywallProvider(paywall);
  }

  // Track sync state
  let syncPromise: Promise<void> | null = null;
  let synced = false;

  console.log(`[x402] createHttpServer: facilitatorSync=${facilitatorSync}`);

  // Start sync immediately if mode is 'onStart'
  if (facilitatorSync === "onStart") {
    console.log("[x402] Starting immediate sync (onStart mode)");
    syncPromise = server
      .initialize()
      .then(() => {
        synced = true;
        console.log("[x402] Sync completed successfully (onStart)");
      })
      .catch(err => {
        console.error("[x402] Sync failed (onStart):", err);
      });
  }

  // Function to manually trigger sync
  const syncFacilitator = async (): Promise<void> => {
    console.log(`[x402] syncFacilitator called: synced=${synced}, hasPromise=${!!syncPromise}`);
    if (synced) return;

    if (!syncPromise) {
      console.log("[x402] Starting manual sync");
      syncPromise = server
        .initialize()
        .then(() => {
          synced = true;
          console.log("[x402] Manual sync completed");
        })
        .catch(err => {
          console.error("[x402] Manual sync failed:", err);
        });
    }

    await syncPromise;
  };

  return {
    httpServer,
    syncFacilitator,
    async init() {
      console.log(
        `[x402] init() called: mode=${facilitatorSync}, synced=${synced}, hasPromise=${!!syncPromise}`,
      );

      // For 'manual' mode, don't auto-sync - caller must call syncFacilitator()
      if (facilitatorSync === "manual") {
        console.log("[x402] Manual mode - skipping sync");
        return;
      }

      // For 'onStart' mode, wait for sync to complete
      if (facilitatorSync === "onStart" && syncPromise) {
        console.log("[x402] Waiting for onStart sync to complete...");
        await syncPromise;
        console.log("[x402] onStart sync awaited, synced=", synced);
        return;
      }

      // For 'lazy' mode, start sync and wait for it
      if (facilitatorSync === "lazy") {
        if (!synced && !syncPromise) {
          console.log("[x402] Starting lazy sync...");
          syncPromise = server
            .initialize()
            .then(() => {
              synced = true;
              console.log("[x402] Lazy sync completed");
            })
            .catch(err => {
              console.error("[x402] Lazy sync failed:", err);
            });
        }
        if (syncPromise) {
          console.log("[x402] Waiting for lazy sync to complete...");
          await syncPromise;
          console.log("[x402] Lazy sync awaited, synced=", synced);
        }
      }
    },
  };
}

/**
 * Creates HTTP request context from a Next.js request
 *
 * @param request - The Next.js request object
 * @returns The HTTP request context for x402 processing
 */
export function createRequestContext(request: NextRequest): HTTPRequestContext {
  // Create adapter and context
  const adapter = new NextAdapter(request);
  return {
    adapter,
    path: request.nextUrl.pathname,
    method: request.method,
    paymentHeader: adapter.getHeader("payment-signature") || adapter.getHeader("x-payment"),
  };
}

/**
 * Handles payment error result by creating a 402 response
 *
 * @param response - The HTTP response instructions from payment verification
 * @returns A Next.js response with the appropriate 402 status and headers
 */
export function handlePaymentError(response: HTTPResponseInstructions): NextResponse {
  // Payment required but not provided or invalid
  const headers = new Headers(response.headers);
  if (response.isHtml) {
    headers.set("Content-Type", "text/html");
    return new NextResponse(response.body as string, {
      status: response.status,
      headers,
    });
  }
  headers.set("Content-Type", "application/json");
  return new NextResponse(JSON.stringify(response.body || {}), {
    status: response.status,
    headers,
  });
}

/**
 * Handles settlement after a successful response
 *
 * @param httpServer - The x402 HTTP resource server instance
 * @param response - The Next.js response from the protected route
 * @param paymentPayload - The payment payload from the client
 * @param paymentRequirements - The payment requirements for the route
 * @returns The response with settlement headers or an error response if settlement fails
 */
export async function handleSettlement(
  httpServer: x402HTTPResourceServer,
  response: NextResponse,
  paymentPayload: PaymentPayload,
  paymentRequirements: PaymentRequirements,
): Promise<NextResponse> {
  // If the response from the protected route is >= 400, do not settle payment
  if (response.status >= 400) {
    return response;
  }

  try {
    const result = await httpServer.processSettlement(paymentPayload, paymentRequirements);

    if (!result.success) {
      // Settlement failed - do not return the protected resource
      return new NextResponse(
        JSON.stringify({
          error: "Settlement failed",
          details: result.errorReason,
        }),
        {
          status: 402,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    // Settlement succeeded - add headers and return original response
    Object.entries(result.headers).forEach(([key, value]) => {
      response.headers.set(key, value);
    });

    return response;
  } catch (error) {
    console.error("Settlement failed:", error);
    // If settlement fails, return an error response
    return new NextResponse(
      JSON.stringify({
        error: "Settlement failed",
        details: error instanceof Error ? error.message : "Unknown error",
      }),
      {
        status: 402,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
}
