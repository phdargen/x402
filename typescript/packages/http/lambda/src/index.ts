// Main exports
export { createCloudFrontProxy, CloudFrontRequestAdapter } from "./cloudfront";
export type { CloudFrontProxyOptions, CloudFrontProxyHandlers } from "./cloudfront";

export { withPayment, createPaymentHandler, ApiGatewayV2Adapter } from "./apigateway";
export type { WithPaymentOptions } from "./apigateway";

// Adapter exports
export { CloudFrontRequestAdapter as CloudFrontAdapter } from "./adapters/cloudfront";
export { ApiGatewayV2Adapter as ApiGatewayAdapter } from "./adapters/apigateway";

// Type exports
export type {
  PaymentContext,
  CloudFrontRequestHandler,
  CloudFrontResponseHandler,
  PaymentHandler,
  WrappedHandler,
} from "./types";

export { PAYMENT_CONTEXT_HEADER } from "./types";

// Re-export core types for convenience
export { x402ResourceServer, x402HTTPResourceServer } from "@x402/core/server";

export type {
  PaymentRequired,
  PaymentRequirements,
  PaymentPayload,
  Network,
  SchemeNetworkServer,
} from "@x402/core/types";

export type { PaywallProvider, PaywallConfig, RoutesConfig, RouteConfig } from "@x402/core/server";

export { RouteConfigurationError } from "@x402/core/server";

export type { RouteValidationError } from "@x402/core/server";
