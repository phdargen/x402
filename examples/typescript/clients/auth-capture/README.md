# auth-capture Client Example

Fetch-based client that pays for a single request to an [auth-capture v1.1](../../../../specs/proposed/scheme_auth_capture_evm.md)-protected endpoint. Signs an ERC-3009 `ReceiveWithAuthorization` whose `nonce` is the payer-agnostic PaymentInfo hash.

Works with all three [server flows](../servers/auth-capture/): delegated sync, delegated deferred, and custom escrow collect-only.

## Prerequisites

- Node.js v20+, pnpm v10
- A running [auth-capture server](../servers/auth-capture/) and [facilitator](../facilitator/auth-capture/)
- A funded EVM key holding USDC on Base Sepolia

## Setup

```bash
cp .env-local .env
# Fill EVM_PRIVATE_KEY (and override RESOURCE_SERVER_URL if needed)

cd ../../..
pnpm install && pnpm build
cd examples/typescript/clients/auth-capture

pnpm start
```

Start the matching server flow first (`pnpm delegated-sync`, `delegated-deferred`, or `custom-escrow` under `servers/auth-capture`).

For **delegated deferred**, capture the hold after paying:

```bash
cd ../servers/auth-capture && pnpm capture-pending
```

## Environment

| Variable | Required | Default |
| :-- | :-- | :-- |
| `EVM_PRIVATE_KEY` | Yes | (none) |
| `RESOURCE_SERVER_URL` | No | `http://localhost:4021` |
| `ENDPOINT_PATH` | No | `/weather` |

## What happens

1. Client builds and signs an ERC-3009 payload (`Eip3009Payload` shape; Permit2 is also supported when advertised).
2. `wrapFetchWithPayment` retries the request with the `PAYMENT-SIGNATURE` header on first `402`.
3. Server verifies, then asks the facilitator to settle.
4. **Delegated sync:** facilitator submits `authorize`, handler runs, server relays signed `capture`.
5. **Delegated deferred:** facilitator submits `authorize`; after-handler settle is skipped — run `pnpm capture-pending` on the server.
6. **Custom escrow:** facilitator submits collect `authorize` via the custom operator; lifecycle is out of band.

The client only participates in the collect step. Capture, void, and refund are server/operator responsibilities.
