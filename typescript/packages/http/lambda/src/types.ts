import type {
  CloudFrontRequestEvent,
  CloudFrontResponseEvent,
  CloudFrontRequestResult,
  CloudFrontResponseResult,
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from "aws-lambda";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";

/**
 * Payment context passed to handler after successful verification
 */
export interface PaymentContext {
  /**
   * The verified payment payload
   */
  payload: PaymentPayload;

  /**
   * The matching payment requirements
   */
  requirements: PaymentRequirements;

  /**
   * The payer address (extracted from payload for convenience)
   */
  payer: string;
}

/**
 * Internal payment context header name for CloudFront proxy pattern
 */
export const PAYMENT_CONTEXT_HEADER = "x-x402-payment-context";

/**
 * CloudFront request handler type
 */
export type CloudFrontRequestHandler = (
  event: CloudFrontRequestEvent,
) => Promise<CloudFrontRequestResult>;

/**
 * CloudFront response handler type
 */
export type CloudFrontResponseHandler = (
  event: CloudFrontResponseEvent,
) => Promise<CloudFrontResponseResult>;

/**
 * API Gateway v2 handler type with payment context
 */
export type PaymentHandler<TResult = APIGatewayProxyResultV2> = (
  event: APIGatewayProxyEventV2,
  context: PaymentContext,
) => Promise<TResult>;

/**
 * Wrapped API Gateway handler type
 */
export type WrappedHandler = (event: APIGatewayProxyEventV2) => Promise<APIGatewayProxyResultV2>;
