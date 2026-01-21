# x402 Offer/Receipt Extension

Cryptographically signed offers and receipts for x402 payment flows.

## Overview

This extension adds cryptographic proofs to x402 payments:

- **Offers**: Prove payment requirements originated from a specific resource server
- **Receipts**: Prove service was delivered after payment (privacy-minimal)

## Installation

```bash
pnpm add @x402/extensions
```

## Usage

### Server-side: Register the Extension

```typescript
import { x402ResourceServer } from "@x402/core/server";
import { HTTPFacilitatorClient } from "@x402/core/http";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import {
  createOfferReceiptExtension,
  createJWSSigner,
  declareOfferReceipt,
} from "@x402/extensions/offer-receipt";

// 1. Create a signer (JWS example)
const signer = createJWSSigner(
  "did:web:api.example.com#key-1",
  "ES256K",
  async (payload) => {
    // Sign payload with your private key
    return signWithYourKey(payload);
  }
);

// 2. Create and configure the resource server
const facilitator = new HTTPFacilitatorClient({ url: "https://facilitator.x402.org" });
const server = new x402ResourceServer(facilitator);
server.register("eip155:84532", new ExactEvmScheme());

// 3. Register the offer-receipt extension
server.registerExtension(createOfferReceiptExtension(signer));

// 4. Configure routes with offer-receipt enabled
const routes = {
  "GET /api/data": {
    accepts: {
      scheme: "exact",
      price: "$0.01",
      network: "eip155:84532",
      payTo: "0x...",
    },
    extensions: {
      ...declareOfferReceipt(), // Enable offer-receipt for this route
    },
  },
};

// 5. Use with your HTTP framework
app.use(paymentMiddleware(routes, server, paywallConfig));
```

### EIP-712 Signer (Ethereum)

```typescript
import { createEIP712Signer } from "@x402/extensions/offer-receipt";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const account = privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`);
const walletClient = createWalletClient({
  account,
  transport: http(),
});

const signer = createEIP712Signer(
  `did:pkh:eip155:1:${account.address}`,
  1, // mainnet chainId
  walletClient.signTypedData
);
```

### Client-side: Extract Offers and Receipts

```typescript
import { wrapFetchWithPayment } from "@x402/fetch";
import {
  createOfferReceiptExtractor,
  type OfferReceiptResponse,
} from "@x402/extensions/offer-receipt";

// Create a fetch wrapper with offer-receipt extraction
const fetchWithPay = wrapFetchWithPayment(fetch, client, {
  onPaymentComplete: createOfferReceiptExtractor(),
});

// Make a payment request
const response = (await fetchWithPay(url, { method: "GET" })) as OfferReceiptResponse;

// Access the extracted metadata
if (response.offerReceipt) {
  console.log("Offers:", response.offerReceipt.offers);
  console.log("Accepted offer:", response.offerReceipt.acceptedOffer);
  console.log("Receipt:", response.offerReceipt.receipt);
}
```

## API Reference

### Extension Factory

#### `createOfferReceiptExtension(signer)`

Creates a `ResourceServerExtension` that adds signed offers and receipts to payment flows.

**Parameters:**
- `signer: OfferReceiptSigner` - Signer for creating offers and receipts

**Returns:** `ResourceServerExtension`

### Declaration Helper

#### `declareOfferReceipt(config?)`

Declares the offer-receipt extension for a route.

**Parameters:**
- `config.enabled?: boolean` - Enable/disable the extension (default: `true`)

**Returns:** `Record<string, OfferReceiptDeclaration>`

### Signer Factories

#### `createJWSSigner(kid, algorithm, signFn)`

Creates a JWS-based signer.

**Parameters:**
- `kid: string` - Key identifier DID (e.g., `did:web:api.example.com#key-1`)
- `algorithm: string` - JWS algorithm (`ES256K`, `EdDSA`, `ES256`)
- `signFn: (payload: Uint8Array) => Promise<string>` - Signing function

#### `createEIP712Signer(kid, chainId, signTypedData)`

Creates an EIP-712 based signer.

**Parameters:**
- `kid: string` - Key identifier DID (e.g., `did:pkh:eip155:1:0x...`)
- `chainId: number` - Chain ID for EIP-712 domain
- `signTypedData: SignTypedDataFn` - viem's signTypedData function

### Client Utilities

#### `createOfferReceiptExtractor()`

Creates an extractor for use with `wrapFetchWithPayment`'s `onPaymentComplete` option.

#### `extractOfferFromPaymentRequired(paymentRequired, network?, scheme?)`

Extract a specific offer from a 402 response.

#### `extractAllOffers(paymentRequired)`

Extract all offers from a 402 response.

#### `extractReceiptFromSettlement(settlementResponse)`

Extract the receipt from a settlement response.

## Types

### `SignedOffer`

```typescript
type SignedOffer = JWSSignedOffer | EIP712SignedOffer;

interface JWSSignedOffer {
  format: "jws";
  signature: string; // JWS Compact Serialization
}

interface EIP712SignedOffer {
  format: "eip712";
  payload: OfferPayload;
  signature: string; // Hex-encoded ECDSA signature
}
```

### `SignedReceipt`

```typescript
type SignedReceipt = JWSSignedReceipt | EIP712SignedReceipt;

interface JWSSignedReceipt {
  format: "jws";
  signature: string;
}

interface EIP712SignedReceipt {
  format: "eip712";
  payload: ReceiptPayload;
  signature: string;
}
```

### `OfferPayload`

```typescript
interface OfferPayload {
  resourceUrl: string;
  scheme: string;
  settlement: string;
  network: string;
  asset: string;
  payTo: string;
  amount: string;
  maxTimeoutSeconds?: number;
  issuedAt?: number;
}
```

### `ReceiptPayload`

```typescript
interface ReceiptPayload {
  resourceUrl: string;
  payer: string;
  issuedAt: number;
}
```

## How It Works

1. **Payment Required Response (402)**
   - The extension enriches each payment requirement with a `signedOffer`
   - Offers prove the requirements came from your server

2. **Settlement Response**
   - After successful payment, the extension adds a `signedReceipt`
   - Receipts are privacy-minimal (no transaction/amount details)

3. **Client Extraction**
   - Clients can extract offers and receipts from responses
   - Useful for audit trails, dispute resolution, verified reviews

## Use Cases

- **Verified Reviews**: Prove a user actually paid for and used a service
- **Audit Trails**: Create tamper-proof records of transactions
- **Dispute Resolution**: Provide cryptographic evidence of service delivery
- **Compliance**: Meet regulatory requirements for payment records

## Security Considerations

- Keep private keys secure; use HSMs in production
- Receipts intentionally omit transaction details for privacy
- DIDs (`kid`) should be resolvable for signature verification
- Use appropriate key rotation policies
