import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import {
  x402HTTPResourceServer,
  x402ResourceServer,
  RoutesConfig,
  HTTPRequestContext,
  PaywallConfig,
} from "@x402/core/server";
import { ApiGatewayV2Adapter } from "./adapters/apigateway";
import { PaymentContext, PaymentHandler, WrappedHandler } from "./types";

/**
 * Type guard to check if result is a structured response (not a string)
 *
 * @param result - API Gateway result
 * @returns True if result is a structured response object
 */
function isStructuredResult(
  result: APIGatewayProxyResultV2,
): result is APIGatewayProxyStructuredResultV2 {
  return typeof result === "object" && result !== null;
}

/**
 * Options for withPayment wrapper
 */
export interface WithPaymentOptions {
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
 * Creates an API Gateway response from HTTP response instructions
 *
 * @param status - HTTP status code
 * @param headers - Response headers
 * @param body - Response body
 * @param isHtml - Whether the body is HTML
 * @returns API Gateway response object
 */
function createResponse(
  status: number,
  headers: Record<string, string>,
  body: unknown,
  isHtml?: boolean,
): APIGatewayProxyResultV2 {
  return {
    statusCode: status,
    headers,
    body: isHtml ? String(body) : JSON.stringify(body),
    isBase64Encoded: false,
  };
}

/**
 * Wraps an API Gateway Lambda handler with x402 payment processing.
 *
 * This wrapper:
 * 1. Verifies payment before calling your handler
 * 2. Passes payment context to your handler
 * 3. Settles payment after your handler returns a successful response (status < 400)
 *
 * @param routes - Route configuration for payment-protected endpoints
 * @param server - Pre-configured x402ResourceServer instance
 * @param handler - Your business logic handler that receives payment context
 * @param options - Optional configuration
 * @returns Wrapped Lambda handler
 *
 * @example
 * ```typescript
 * import { withPayment } from "@x402/lambda";
 * import { x402ResourceServer, HTTPFacilitatorClient } from "@x402/core/server";
 *
 * const server = new x402ResourceServer(new HTTPFacilitatorClient());
 * const routes = {
 *   "GET /weather": {
 *     accepts: [{ scheme: "exact", price: "$0.001", network: "eip155:84532", payTo: "0x..." }],
 *     description: "Weather data",
 *   },
 * };
 *
 * const businessLogic = async (event, paymentContext) => {
 *   return {
 *     statusCode: 200,
 *     body: JSON.stringify({ weather: "sunny", payer: paymentContext.payer }),
 *   };
 * };
 *
 * export const handler = withPayment(routes, server, businessLogic);
 * ```
 */
export function withPayment(
  routes: RoutesConfig,
  server: x402ResourceServer,
  handler: PaymentHandler,
  options: WithPaymentOptions = {},
): WrappedHandler {
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

  return async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
    const adapter = new ApiGatewayV2Adapter(event);
    const path = event.requestContext.http.path;
    const method = event.requestContext.http.method;

    const context: HTTPRequestContext = {
      adapter,
      path,
      method,
      paymentHeader:
        adapter.getHeader("payment-signature") || adapter.getHeader("x-payment"),
    };

    // Check if route requires payment
    if (!httpServer.requiresPayment(context)) {
      // No payment required - create a dummy context
      const dummyContext: PaymentContext = {
        payload: {} as PaymentContext["payload"],
        requirements: {} as PaymentContext["requirements"],
        payer: "",
      };
      return handler(event, dummyContext);
    }

    // Initialize server if needed
    await ensureInitialized();

    // Process the request
    const result = await httpServer.processHTTPRequest(context, paywallConfig);

    switch (result.type) {
      case "no-payment-required": {
        // No payment needed - create a dummy context
        const dummyContext: PaymentContext = {
          payload: {} as PaymentContext["payload"],
          requirements: {} as PaymentContext["requirements"],
          payer: "",
        };
        return handler(event, dummyContext);
      }

      case "payment-error": {
        // Return 402 response
        const { response } = result;
        return createResponse(
          response.status,
          {
            ...response.headers,
            "Content-Type": response.isHtml ? "text/html" : "application/json",
          },
          response.isHtml ? response.body : response.body || {},
          response.isHtml,
        );
      }

      case "payment-verified": {
        // Extract payer address safely from payload
        const payloadData = result.paymentPayload.payload as Record<string, unknown> | undefined;
        const authorization = payloadData?.authorization as Record<string, unknown> | undefined;
        const payerAddress = (authorization?.from as string) || "";

        // Create payment context for handler
        const paymentContext: PaymentContext = {
          payload: result.paymentPayload,
          requirements: result.paymentRequirements,
          payer: payerAddress,
        };

        // Call the user's handler
        const handlerResult = await handler(event, paymentContext);

        // Check if handler returned an error (status >= 400)
        // Handle both structured and string responses
        if (isStructuredResult(handlerResult)) {
          const statusCode = handlerResult.statusCode || 200;
          if (statusCode >= 400) {
            // Don't settle on error
            return handlerResult;
          }
        }

        // Process settlement
        const settleResult = await httpServer.processSettlement(
          result.paymentPayload,
          result.paymentRequirements,
        );

        if (!settleResult.success) {
          // Settlement failed
          return createResponse(
            402,
            { "Content-Type": "application/json" },
            {
              error: "Settlement failed",
              details: settleResult.errorReason,
            },
          );
        }

        // Add settlement headers to response
        // Handle both structured and string responses
        if (isStructuredResult(handlerResult)) {
          return {
            ...handlerResult,
            headers: {
              ...handlerResult.headers,
              ...settleResult.headers,
            },
          };
        }

        // String response - wrap it with headers
        return {
          statusCode: 200,
          headers: settleResult.headers,
          body: handlerResult,
        };
      }
    }
  };
}

/**
 * Configuration-based wrapper for withPayment.
 * Creates the x402ResourceServer internally based on provided configuration.
 *
 * @param routes - Route configuration for payment-protected endpoints
 * @param server - Pre-configured x402ResourceServer instance
 * @param handler - Your business logic handler that receives payment context
 * @param options - Optional configuration
 * @returns Wrapped Lambda handler
 */
export function createPaymentHandler(
  routes: RoutesConfig,
  server: x402ResourceServer,
  handler: PaymentHandler,
  options: WithPaymentOptions = {},
): WrappedHandler {
  return withPayment(routes, server, handler, options);
}

export { ApiGatewayV2Adapter } from "./adapters/apigateway";
