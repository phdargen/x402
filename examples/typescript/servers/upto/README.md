# Upto Server Example

Express server that protects a resource with the **`upto`** scheme on Base Sepolia and/or Solana Devnet. Each request authorizes a payment ceiling; the handler bills actual usage via `setSettlementOverrides`.

Pair with [`facilitator/upto/`](../../facilitator/upto/) for a full local stack, or point `FACILITATOR_URL` at a hosted facilitator.

See the [SVM upto scheme spec](../../../../specs/schemes/upto/scheme_upto_svm.md) and the [scheme README](../../../../typescript/packages/mechanisms/svm/src/upto/README.md) for protocol details.

## Receiver Authorizer (SVM): Pick One

Every SVM channel commits to an `authorized_signer` (the receiver authorizer). That key signs cumulative vouchers that authorize how much of the deposit is claimed. This example uses **self-managed** mode by default.

### 1. Self-managed (recommended, default)

Set `SVM_RECEIVER_AUTHORIZER_PRIVATE_KEY` to an Ed25519 key you control. The server signs claim vouchers locally; **any facilitator** can relay them.

```typescript
const receiverAuthorizerSigner = await createKeyPairSignerFromBytes(
  base58.decode(process.env.SVM_RECEIVER_AUTHORIZER_PRIVATE_KEY!),
);

new UptoSvmScheme({
  receiverAuthorizerSigner,
  rpcUrl: process.env.SVM_RPC_URL, // optional: embeds recentBlockhash/recentSlot in 402
});
```

The key does not need SOL or tokens — it only signs off-chain vouchers.

### 2. Facilitator-delegated

Omit `receiverAuthorizerSigner` only — keep `rpcUrl` if you want blockhash/slot hints in the 402. The scheme adopts `extra.receiverAuthorizer` from the facilitator's `/supported` endpoint and omits `voucherSignature` on claim settles; the facilitator signs the voucher after authenticating your settle requests. Delegation is not part of the client payment flow — it requires an out-of-band agreement between your server and the facilitator, plus authenticated server→facilitator settle calls.

```typescript
new UptoSvmScheme({
  rpcUrl: process.env.SVM_RPC_URL, // optional: same as self-managed
});
```

Your facilitator must advertise `receiverAuthorizer` and implement `resolveCallerIdentity` (see [`facilitator/upto/README.md`](../../facilitator/upto/README.md)). Authenticate server→facilitator settle calls — for example, attach a bearer token on every settle:

```typescript
const facilitatorClient = new HTTPFacilitatorClient({
  url: process.env.FACILITATOR_URL!,
  createAuthHeaders: async () => ({
    settle: { Authorization: `Bearer ${serviceToken}` },
  }),
});
```

On the facilitator, validate that token in `resolveCallerIdentity` and return a stable subject string. The SDK binds that identity to the channel at deposit and requires the same identity at claim.

> Facilitator-delegated mode is simpler operationally (no server hot key) but binds channels to a facilitator that implements authentication correctly. Self-managed mode is recommended for production unless you operate the facilitator yourself.

## Prerequisites

- Node.js v20+, pnpm v10
- A running [upto facilitator](../../facilitator/upto) (or hosted)
- **EVM**: `EVM_ADDRESS` (payTo; no gas required)
- **SVM**: `SVM_ADDRESS` (payTo) and `SVM_RECEIVER_AUTHORIZER_PRIVATE_KEY` (self-managed authorizer)

## Setup

```bash
cp .env-local .env
# fill EVM_ADDRESS and/or SVM_ADDRESS (+ SVM_RECEIVER_AUTHORIZER_PRIVATE_KEY for SVM)

cd ../../
pnpm install && pnpm build
cd servers/upto

pnpm dev
```

Default listen address: `http://localhost:4021`.

## Full stack

```bash
# Terminal 1 — facilitator
cd facilitator/upto && pnpm dev

# Terminal 2 — resource server (this example)
cd servers/upto && FACILITATOR_URL=http://localhost:4022 pnpm dev

# Terminal 3 — client
cd clients/fetch && RESOURCE_SERVER_URL=http://localhost:4021 ENDPOINT_PATH=/api/generate pnpm start
```
