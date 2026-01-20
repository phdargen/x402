import type {
  CloudFrontRequestEvent,
  CloudFrontResponseEvent,
  CloudFrontRequestResult,
  CloudFrontResponseResult,
  CloudFrontRequest,
  CloudFrontHeaders,
} from "aws-lambda";
import {
  x402HTTPResourceServer,
  x402ResourceServer,
  RoutesConfig,
  HTTPRequestContext,
  PaywallConfig,
} from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { CloudFrontRequestAdapter } from "./adapters/cloudfront";
import { PAYMENT_CONTEXT_HEADER, CloudFrontRequestHandler, CloudFrontResponseHandler } from "./types";

/**
 * Options for createCloudFrontProxy
 */
export interface CloudFrontProxyOptions {
  /**
   * Optional paywall configuration for HTML responses
   */
  paywallConfig?: PaywallConfig;

  /**
   * Whether to sync with facilitator on first request (defaults to true)
   */
  syncFacilitatorOnStart?: boolean;
}

/**
 * CloudFront proxy handlers for x402 payment gateway.
 * Returns verify (origin-request) and settle (origin-response) handlers.
 */
export interface CloudFrontProxyHandlers {
  /**
   * Origin-request handler: verifies payment before forwarding to origin
   */
  verify: CloudFrontRequestHandler;

  /**
   * Origin-response handler: settles payment after successful origin response
   */
  settle: CloudFrontResponseHandler;
}

/**
 * Converts HTTPResponseInstructions headers to CloudFront headers format
 *
 * @param headers - Standard HTTP headers object
 * @returns CloudFront headers format
 */
function toCloudFrontHeaders(headers: Record<string, string>): CloudFrontHeaders {
  const cfHeaders: CloudFrontHeaders = {};
  for (const [key, value] of Object.entries(headers)) {
    cfHeaders[key.toLowerCase()] = [{ key, value }];
  }
  return cfHeaders;
}

/**
 * Adds headers to an existing CloudFront headers object
 *
 * @param existing - Existing CloudFront headers
 * @param toAdd - Headers to add
 * @returns Merged CloudFront headers
 */
function addCloudFrontHeaders(
  existing: CloudFrontHeaders,
  toAdd: Record<string, string>,
): CloudFrontHeaders {
  const result = { ...existing };
  for (const [key, value] of Object.entries(toAdd)) {
    result[key.toLowerCase()] = [{ key, value }];
  }
  return result;
}

/**
 * Gets a header value from CloudFront headers format
 *
 * @param headers - CloudFront headers
 * @param name - Header name (case-insensitive)
 * @returns Header value or undefined
 */
function getCloudFrontHeader(headers: CloudFrontHeaders, name: string): string | undefined {
  const lowerName = name.toLowerCase();
  const entry = headers[lowerName];
  return entry?.[0]?.value;
}

/**
 * Removes a header from CloudFront headers
 *
 * @param headers - CloudFront headers
 * @param name - Header name to remove (case-insensitive)
 * @returns New headers object without the specified header
 */
function removeCloudFrontHeader(headers: CloudFrontHeaders, name: string): CloudFrontHeaders {
  const result = { ...headers };
  delete result[name.toLowerCase()];
  return result;
}

/**
 * Creates CloudFront Lambda@Edge handlers for x402 payment proxy.
 *
 * This creates a verify/settle handler pair for use with CloudFront:
 * - `verify`: Deploy to origin-request trigger. Validates payment and blocks with 402 or forwards to origin.
 * - `settle`: Deploy to origin-response trigger. Settles payment if origin returns success (< 400).
 *
 * The handlers communicate via a custom header that carries the payment context
 * from verify to settle.
 *
 * @param routes - Route configuration for payment-protected endpoints
 * @param server - Pre-configured x402ResourceServer instance
 * @param distributionDomain - The CloudFront distribution domain (e.g., "d1234.cloudfront.net")
 * @param options - Optional configuration
 * @returns Object with verify and settle handlers
 *
 * @example
 * ```typescript
 * import { createCloudFrontProxy } from "@x402/lambda";
 * import { x402ResourceServer, HTTPFacilitatorClient } from "@x402/core/server";
 *
 * const server = new x402ResourceServer(new HTTPFacilitatorClient());
 * const routes = {
 *   "/api/*": {
 *     accepts: [{ scheme: "exact", price: "$0.001", network: "eip155:84532", payTo: "0x..." }],
 *     description: "API access",
 *   },
 * };
 *
 * export const { verify, settle } = createCloudFrontProxy(
 *   routes,
 *   server,
 *   "d1234.cloudfront.net"
 * );
 * ```
 */
export function createCloudFrontProxy(
  routes: RoutesConfig,
  server: x402ResourceServer,
  distributionDomain: string,
  options: CloudFrontProxyOptions = {},
): CloudFrontProxyHandlers {
  const { paywallConfig, syncFacilitatorOnStart = true } = options;

  // Create the HTTP server instance
  const httpServer = new x402HTTPResourceServer(server, routes);

  // Lazy initialization promise
  let initPromise: Promise<void> | null = syncFacilitatorOnStart ? null : Promise.resolve();

  /**
   * Initialize the server on first protected request
   *
   * @returns Promise that resolves when initialization is complete
   */
  async function ensureInitialized(): Promise<void> {
    if (!initPromise) {
      initPromise = httpServer.initialize();
    }
    await initPromise;
  }

  /**
   * Verify handler (origin-request trigger)
   *
   * @param event - CloudFront request event
   * @returns CloudFront request result - either 402 response or forwarded request
   */
  const verify: CloudFrontRequestHandler = async (
    event: CloudFrontRequestEvent,
  ): Promise<CloudFrontRequestResult> => {
    const request = event.Records[0].cf.request;
    const adapter = new CloudFrontRequestAdapter(request, distributionDomain);

    const context: HTTPRequestContext = {
      adapter,
      path: request.uri,
      method: request.method,
      paymentHeader:
        adapter.getHeader("payment-signature") || adapter.getHeader("x-payment"),
    };

    // Check if route requires payment
    if (!httpServer.requiresPayment(context)) {
      return request;
    }

    // Initialize server if needed
    await ensureInitialized();

    // Process the request
    const result = await httpServer.processHTTPRequest(context, paywallConfig);

    switch (result.type) {
      case "no-payment-required":
        return request;

      case "payment-error": {
        // Return 402 response directly
        const { response } = result;
        return {
          status: String(response.status),
          statusDescription: "Payment Required",
          headers: toCloudFrontHeaders({
            ...response.headers,
            "Content-Type": response.isHtml ? "text/html" : "application/json",
          }),
          body: response.isHtml
            ? String(response.body)
            : JSON.stringify(response.body || {}),
        };
      }

      case "payment-verified": {
        // Forward request with payment context header for settle handler
        const paymentContext = {
          payload: result.paymentPayload,
          requirements: result.paymentRequirements,
        };

        const contextHeader = Buffer.from(JSON.stringify(paymentContext)).toString("base64");
        const modifiedRequest: CloudFrontRequest = {
          ...request,
          headers: addCloudFrontHeaders(request.headers, {
            [PAYMENT_CONTEXT_HEADER]: contextHeader,
          }),
        };

        return modifiedRequest;
      }
    }
  };

  /**
   * Settle handler (origin-response trigger)
   *
   * @param event - CloudFront response event
   * @returns CloudFront response result with settlement headers or error
   */
  const settle: CloudFrontResponseHandler = async (
    event: CloudFrontResponseEvent,
  ): Promise<CloudFrontResponseResult> => {
    const response = event.Records[0].cf.response;
    const request = event.Records[0].cf.request;

    // Get payment context from header
    const contextHeader = getCloudFrontHeader(request.headers, PAYMENT_CONTEXT_HEADER);
    if (!contextHeader) {
      // No payment context - pass through response
      return response;
    }

    // Parse payment context
    let paymentContext: {
      payload: PaymentPayload;
      requirements: PaymentRequirements;
    };
    try {
      const decoded = Buffer.from(contextHeader, "base64").toString("utf-8");
      paymentContext = JSON.parse(decoded);
    } catch {
      // Invalid context - pass through response
      console.error("Failed to parse payment context header");
      return response;
    }

    // Check if origin response was successful (status < 400)
    const statusCode = parseInt(response.status, 10);
    if (statusCode >= 400) {
      // Origin error - don't settle, just pass through
      return response;
    }

    // Ensure initialized for settlement
    await ensureInitialized();

    // Process settlement
    const settleResult = await httpServer.processSettlement(
      paymentContext.payload,
      paymentContext.requirements,
    );

    if (!settleResult.success) {
      // Settlement failed - return 402 error
      return {
        status: "402",
        statusDescription: "Payment Required",
        headers: toCloudFrontHeaders({
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({
          error: "Settlement failed",
          details: settleResult.errorReason,
        }),
      };
    }

    // Settlement succeeded - add headers and remove internal context header
    const modifiedHeaders = addCloudFrontHeaders(
      removeCloudFrontHeader(response.headers, PAYMENT_CONTEXT_HEADER),
      settleResult.headers,
    );

    return {
      ...response,
      headers: modifiedHeaders,
    };
  };

  return { verify, settle };
}

export { CloudFrontRequestAdapter } from "./adapters/cloudfront";
