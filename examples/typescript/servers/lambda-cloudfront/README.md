# Lambda CloudFront x402 Example

This example demonstrates using `@x402/lambda` with CloudFront Lambda@Edge to create a payment gateway in front of any origin.

## Architecture

```
Client → CloudFront → [verify Lambda@Edge] → Your Origin → [settle Lambda@Edge] → Client
```

1. **verify** (origin-request): Validates payment before forwarding to origin
2. **settle** (origin-response): Settles payment after successful origin response

## Setup

1. Install dependencies:

```bash
pnpm install
```

2. Build the handlers:

```bash
pnpm run build
```

3. Deploy to AWS Lambda@Edge:
   - Create a Lambda function in `us-east-1` (required for Lambda@Edge)
   - Deploy `dist/handlers.js` 
   - Associate with your CloudFront distribution:
     - `verify` → Origin Request trigger
     - `settle` → Origin Response trigger

## Configuration

Set these environment variables in your Lambda function:

```
EVM_ADDRESS=0xYourEvmAddress
SVM_ADDRESS=YourSolanaAddress
CLOUDFRONT_DOMAIN=d1234567890.cloudfront.net
FACILITATOR_URL=https://facilitator.x402.org
```

## Route Configuration

The example protects all `/api/*` routes. Modify `src/config.ts` to customize:

```typescript
export const routes: RoutesConfig = {
  "/api/*": {
    accepts: [
      {
        scheme: "exact",
        price: "$0.001",
        network: "eip155:84532",
        payTo: evmAddress,
      },
    ],
    description: "Protected API",
  },
  // Add more routes...
};
```

## How It Works

1. Client makes request to CloudFront
2. **verify** handler checks for payment header
   - If missing/invalid: Returns 402 with payment requirements
   - If valid: Forwards request to origin with payment context header
3. Origin processes request normally
4. **settle** handler checks origin response
   - If origin error (>= 400): Pass through, no settlement
   - If success: Settle payment, add receipt headers

## Testing

Use the x402 client to make paid requests:

```typescript
import { wrapFetch } from "@x402/fetch";

const paidFetch = wrapFetch(fetch, wallet);

const response = await paidFetch("https://your-cloudfront-domain.net/api/data");
```

## Lambda@Edge Limitations

- Functions must be in `us-east-1`
- 5 second timeout for origin-request/response
- 1MB response body limit for generated responses
- No environment variables by default (use Lambda@Edge environment variable workarounds or config in code)
