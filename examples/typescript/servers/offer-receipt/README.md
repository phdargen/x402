# Offer-Receipt Extension Server Example

This example demonstrates how to use the x402 offer-receipt extension with an Express server to add cryptographically signed offers and receipts to payment flows.

## Features

- **Signed Offers**: Each 402 response includes a cryptographically signed offer proving the payment requirements came from your server
- **Signed Receipts**: After successful payment, a privacy-minimal receipt proves service was delivered
- **Per-Route Configuration**: Enable offer-receipt on specific routes while leaving others as standard x402

## Setup

1. Copy the environment file and configure:

```bash
cp .env-local .env
```

2. Edit `.env` with your values:

```env
EVM_ADDRESS=0xYourAddressHere
FACILITATOR_URL=https://facilitator.x402.org
```

3. Install dependencies (from monorepo root):

```bash
pnpm install
```

4. Run the server:

```bash
pnpm dev
```

## Endpoints

| Endpoint | Price | Offer-Receipt |
|----------|-------|---------------|
| `GET /weather` | $0.001 | Yes |
| `GET /premium-data` | $0.01 | Yes |
| `GET /basic` | $0.0001 | No |

## How It Works

### 1. Register the Extension

```typescript
import { createOfferReceiptExtension, createJWSSigner } from "@x402/extensions/offer-receipt";

// Create a signer
const signer = createJWSSigner(kid, "ES256", signFn);

// Register with resource server
const resourceServer = new x402ResourceServer(facilitatorClient)
  .register("eip155:84532", new ExactEvmScheme())
  .registerExtension(createOfferReceiptExtension(signer));
```

### 2. Enable Per Route

```typescript
import { declareOfferReceipt } from "@x402/extensions/offer-receipt";

const routes = {
  "GET /weather": {
    accepts: { ... },
    extensions: {
      ...declareOfferReceipt(), // Enable for this route
    },
  },
};
```

### 3. Response Flow

**402 Payment Required Response:**
```json
{
  "x402Version": 2,
  "accepts": [
    {
      "scheme": "exact",
      "network": "eip155:84532",
      "amount": "1000",
      "signedOffer": {
        "format": "jws",
        "signature": "eyJhbGciOiJFUzI1NiIs..."
      }
    }
  ],
  "extensions": {
    "offer-receipt": {
      "kid": "did:web:localhost:4022#key-1",
      "format": "jws"
    }
  }
}
```

**Settlement Response (in PAYMENT-RESPONSE header):**
```json
{
  "success": true,
  "transaction": "0x...",
  "extensions": {
    "offer-receipt": {
      "receipt": {
        "format": "jws",
        "signature": "eyJhbGciOiJFUzI1NiIs..."
      }
    }
  }
}
```

## Signing Modes

The example supports two signing modes for offers and receipts:

### JWS Mode (Default)

Uses the jose library with ES256 algorithm. Good for general-purpose signing.

```env
SIGNER_MODE=jws
```

#### Development (Ephemeral Key)

By default, the server generates an ephemeral key on startup. This is fine for testing but **not for production**.

#### Production (Persistent Key)

Generate an ES256 key pair:

```bash
openssl ecparam -name prime256v1 -genkey -noout -out private.pem
openssl ec -in private.pem -pubout -out public.pem
```

Set the key in your environment:

```env
SIGNER_MODE=jws
SIGNING_KEY_PEM="-----BEGIN PRIVATE KEY-----
...your key...
-----END PRIVATE KEY-----"
SIGNING_KEY_KID=did:web:your-domain.com#key-1
```

### EIP-712 Mode

Uses viem wallet client for Ethereum-native typed data signing. Ideal when you want signatures verifiable on-chain or using standard Ethereum tooling.

```env
SIGNER_MODE=eip712
PRIVATE_KEY=0xYourPrivateKeyHere
```

The signer's DID will be automatically derived from the wallet address:
`did:pkh:eip155:84532:0xYourAddress`

#### Code Example

```typescript
import { createEIP712Signer } from "@x402/extensions/offer-receipt";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

const account = privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`);
const walletClient = createWalletClient({
  account,
  chain: baseSepolia,
  transport: http(),
});

const signer = createEIP712Signer(
  `did:pkh:eip155:84532:${account.address}`,
  baseSepolia.id,
  walletClient.signTypedData.bind(walletClient)
);
```

## Client Usage

Clients can extract offers and receipts using the client utilities:

```typescript
import { wrapFetchWithPayment } from "@x402/fetch";
import { createOfferReceiptExtractor, type OfferReceiptResponse } from "@x402/extensions/offer-receipt";

const fetchWithPay = wrapFetchWithPayment(fetch, client, {
  onPaymentComplete: createOfferReceiptExtractor(),
});

const response = await fetchWithPay("http://localhost:4022/weather") as OfferReceiptResponse;

console.log("Offers:", response.offerReceipt?.offers);
console.log("Receipt:", response.offerReceipt?.receipt);
```

## Use Cases

- **Verified Reviews**: Prove a user actually paid for and used your service
- **Audit Trails**: Create tamper-proof records of transactions
- **Dispute Resolution**: Provide cryptographic evidence of service delivery
- **Compliance**: Meet regulatory requirements for payment records
