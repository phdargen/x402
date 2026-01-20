# Lambda x402 Example

This example demonstrates using `@x402/lambda` with API Gateway v2 (HTTP API) to create a Lambda service with built-in payment processing.

## Architecture

```
Client → API Gateway v2 → [Lambda with withPayment wrapper] → Client
```

The `withPayment` wrapper:
1. Validates payment before calling your business logic
2. Passes payment context to your handler
3. Settles payment after successful response

## Setup

1. Install dependencies:

```bash
pnpm install
```

2. Build the handler:

```bash
pnpm run build
```

3. Deploy to AWS Lambda:
   - Create a Lambda function
   - Deploy `dist/handler.js`
   - Create an API Gateway v2 HTTP API
   - Configure routes to invoke your Lambda

## Configuration

Set these environment variables in your Lambda function:

```
EVM_ADDRESS=0xYourEvmAddress
SVM_ADDRESS=YourSolanaAddress
FACILITATOR_URL=https://facilitator.x402.org
```

## Endpoints

This example exposes two endpoints:

### GET /weather
- Price: $0.001
- Returns weather data with payer info

### GET /premium/*  
- Price: $0.01
- Returns premium content based on path

## Handler Structure

```typescript
import { withPayment, PaymentContext } from "@x402/lambda";

// Your business logic receives payment context
const businessLogic = async (event, paymentContext: PaymentContext) => {
  // paymentContext.payer - the address that paid
  // paymentContext.payload - full payment payload
  // paymentContext.requirements - matched requirements
  
  return {
    statusCode: 200,
    body: JSON.stringify({ data: "..." }),
  };
};

// Wrap with payment processing
export const handler = withPayment(routes, server, businessLogic);
```

## Payment Flow

1. Client sends request without payment → 402 response with requirements
2. Client signs payment and retries with `PAYMENT-SIGNATURE` header
3. Lambda verifies payment
4. Your handler executes
5. If handler returns status < 400, payment is settled
6. Response returned with settlement receipt headers

## Testing

Use the x402 client to make paid requests:

```typescript
import { wrapFetch } from "@x402/fetch";

const paidFetch = wrapFetch(fetch, wallet);

const response = await paidFetch("https://your-api.execute-api.region.amazonaws.com/weather");
const data = await response.json();
console.log(data);
// { report: { weather: "sunny", ... }, payment: { payer: "0x...", ... } }
```

## Error Handling

- If your handler returns status >= 400, payment is NOT settled
- If settlement fails, client receives 402 with error details
- Invalid payments return 402 with requirements

## Extending

Add more routes by updating the routes configuration:

```typescript
const routes = {
  "GET /weather": { ... },
  "POST /data": { ... },
  "GET /api/*": { ... }, // Wildcards supported
};
```
