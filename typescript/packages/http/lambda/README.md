# @x402/lambda

AWS Lambda integration for the x402 payment protocol. This package provides two patterns for adding x402 payments to Lambda-based applications:

1. **CloudFront Proxy Pattern** - Lambda@Edge as a payment gateway in front of any origin
2. **API Gateway Pattern** - Direct Lambda service with payment wrapper

## Installation

```bash
pnpm add @x402/lambda @x402/core
# For EVM support:
pnpm add @x402/evm
# For Solana support:
pnpm add @x402/svm
```

## Patterns Overview

### CloudFront Proxy Pattern

Use this when you want to add payment requirements to an existing API without modifying its code. The Lambda@Edge functions act as a payment gateway:

```
Client → CloudFront → [verify Lambda] → Origin → [settle Lambda] → Client
```

- **verify** (origin-request): Validates payment, returns 402 or forwards to origin
- **settle** (origin-response): Settles payment after successful origin response

### API Gateway Pattern  

Use this when building a new Lambda service or when you want tighter integration with your business logic:

```
Client → API Gateway → [Lambda with withPayment wrapper] → Client
```

The `withPayment` wrapper handles verification and settlement around your handler.

## CloudFront Proxy Usage

```typescript
import { createCloudFrontProxy } from "@x402/lambda";
import { x402ResourceServer, HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";

// Create and configure the resource server
const facilitator = new HTTPFacilitatorClient({ 
  url: process.env.FACILITATOR_URL 
});
const server = new x402ResourceServer(facilitator)
  .register("eip155:84532", new ExactEvmScheme());

// Define payment routes
const routes = {
  "/api/*": {
    accepts: [{
      scheme: "exact",
      price: "$0.001",
      network: "eip155:84532",
      payTo: "0xYourAddress...",
    }],
    description: "API access",
  },
};

// Create handlers
export const { verify, settle } = createCloudFrontProxy(
  routes,
  server,
  "d1234567890.cloudfront.net", // Your distribution domain
);
```

Deploy configuration:
- `verify` → Origin Request trigger
- `settle` → Origin Response trigger

## API Gateway Usage

```typescript
import { withPayment } from "@x402/lambda";
import { x402ResourceServer, HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";

// Create and configure the resource server
const facilitator = new HTTPFacilitatorClient({ 
  url: process.env.FACILITATOR_URL 
});
const server = new x402ResourceServer(facilitator)
  .register("eip155:84532", new ExactEvmScheme());

// Define payment routes
const routes = {
  "GET /weather": {
    accepts: [{
      scheme: "exact",
      price: "$0.001",
      network: "eip155:84532",
      payTo: "0xYourAddress...",
    }],
    description: "Weather data",
  },
};

// Your business logic
const businessLogic = async (event, paymentContext) => {
  // paymentContext contains: payload, requirements, payer
  return {
    statusCode: 200,
    body: JSON.stringify({
      weather: "sunny",
      temperature: 72,
      payer: paymentContext.payer,
    }),
  };
};

// Export wrapped handler
export const handler = withPayment(routes, server, businessLogic);
```

## Payment Context

When payment is verified, your handler receives a `PaymentContext` object:

```typescript
interface PaymentContext {
  payload: PaymentPayload;      // The verified payment
  requirements: PaymentRequirements;  // Matching requirements
  payer: string;                // Payer address for convenience
}
```

## Configuration Options

### CloudFront Proxy Options

```typescript
createCloudFrontProxy(routes, server, domain, {
  paywallConfig: {
    appName: "My App",
    appLogo: "https://example.com/logo.png",
    testnet: true,
  },
  syncFacilitatorOnStart: true, // Default: true
});
```

### API Gateway Options

```typescript
withPayment(routes, server, handler, {
  paywallConfig: {
    appName: "My App",
    appLogo: "https://example.com/logo.png",
    testnet: true,
  },
  syncFacilitatorOnStart: true, // Default: true
});
```

## Route Configuration

Routes follow the standard x402 configuration format:

```typescript
const routes = {
  // Match specific method and path
  "GET /api/weather": { ... },
  
  // Wildcard matching
  "/api/*": { ... },
  
  // Path parameters
  "/users/[id]/data": { ... },
};
```

Each route accepts:
- `accepts` - Payment option(s): scheme, price, network, payTo
- `description` - Human-readable description
- `resource` - Override URL in payment response
- `mimeType` - Response MIME type
- `customPaywallHtml` - Custom 402 page HTML

## Adapters

The package exports HTTP adapters for direct use:

```typescript
import { CloudFrontRequestAdapter, ApiGatewayV2Adapter } from "@x402/lambda";

// CloudFront adapter
const cfAdapter = new CloudFrontRequestAdapter(request, "example.cloudfront.net");

// API Gateway v2 adapter  
const apigwAdapter = new ApiGatewayV2Adapter(event);
```

## Error Handling

### Settlement Failures

If payment verification succeeds but settlement fails (e.g., network issues), the response is a 402 with error details:

```json
{
  "error": "Settlement failed",
  "details": "Timeout waiting for transaction confirmation"
}
```

### Origin Errors (CloudFront Pattern)

If the origin returns an error (status >= 400), payment is NOT settled and the origin's error response is passed through unchanged.

### Handler Errors (API Gateway Pattern)

If your handler returns status >= 400, payment is NOT settled and your error response is returned as-is.

## TypeScript Support

Full TypeScript support with exported types:

```typescript
import type {
  PaymentContext,
  PaymentHandler,
  WrappedHandler,
  CloudFrontRequestHandler,
  CloudFrontResponseHandler,
  CloudFrontProxyOptions,
  WithPaymentOptions,
} from "@x402/lambda";
```

## License

Apache-2.0
