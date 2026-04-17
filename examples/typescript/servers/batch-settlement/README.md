# Batch-Settlement Server Example

Express server that protects `GET /api/generate` with the **batch-settlement** EVM scheme. Each request is paid by an off-chain voucher; the server batches voucher claims and on-chain settlements via a `ChannelManager` running in the background.

The route demonstrates **dynamic pricing**: the client authorizes up to `$0.01` per request, and the handler bills a random fraction of that via `setSettlementOverrides`.

See the [scheme specification](../../../../specs/schemes/batch-settlement/scheme_batch_settlement_evm.md) and the [scheme README](../../../../typescript/packages/mechanisms/evm/src/batch-settlement/README.md) for protocol details.

## Receiver Authorizer: Pick One

Every channel commits to a `receiverAuthorizer` — the address whose EIP-712 signatures authorize `claimWithSignature` and `refundWithSignature`. This server lets you choose between two strategies:

### 1. Self-managed (recommended)

Set `EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY` to an EOA you own. The scheme uses it to sign claims/refunds locally; **any facilitator** can relay the resulting transactions.

```typescript
const receiverAuthorizerSigner = privateKeyToAccount(process.env.EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY);
new BatchSettlementEvmScheme(evmAddress, { receiverAuthorizerSigner });
```

Channels survive facilitator changes — you can switch facilitators (or add backups) without opening new channels.

### 2. Facilitator-delegated

Leave `EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY` unset. The scheme adopts the address advertised by the facilitator's `/supported`.

```typescript
new BatchSettlementEvmScheme(evmAddress, { /* no receiverAuthorizerSigner */ });
```

This is simpler operationally but locks each channel to the current facilitator. **Switching facilitators (or even rotating their authorizer key) requires opening new channels.** Before swapping, drain the existing ones — claim outstanding vouchers and issue cooperative refunds — otherwise unclaimed value is left exposed to the old authorizer's withdraw delay.

## Withdrawal: Out-of-Band Risk

Clients can call `initiateWithdraw` directly on-chain at any time, **outside the request flow**. After the channel's `withdrawDelay` elapses, `finalizeWithdraw` drains the escrow and any unclaimed vouchers become unclaimable forever.

The server only learns about a pending withdrawal when the facilitator returns it in `extra.withdrawRequestedAt` on the next request — and a long-idle channel may never trigger one. Recommended mitigations, all configurable on `ChannelManager.start()`:

| Strategy | Setting | Why |
|----------|---------|-----|
| Claim immediately when a withdraw is observed | `claimOnWithdrawal: true` | Race the withdraw delay before `finalizeWithdraw` becomes callable |
| Periodic claims regardless of activity | `claimIntervalSecs` / `claimThreshold` | Bound the maximum unclaimed exposure |
| Refund idle channels proactively | `refundOnIdleSecs` | Close out abandoned channels (no idle channel = nothing to lose) |
| Flush on shutdown | `refundOnShutdown: true` | Don't leave outstanding vouchers behind when the server stops |

This example wires a deliberately aggressive policy for demo purposes (`claimIntervalSecs: 10`, `refundOnIdleSecs: 30`); pick values appropriate for your traffic and gas budget.

## Prerequisites

- Node.js v20+, pnpm v10
- A running [batch-settlement facilitator](../../facilitator/batch-settlement) (or a hosted one)
- An EVM `payTo` address (does **not** need ETH — it only receives funds via `settle`)

## Setup

```bash
cp .env-local .env
# fill EVM_ADDRESS, FACILITATOR_URL, optionally EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY

cd ../../
pnpm install && pnpm build
cd servers/batch-settlement

pnpm dev
```

The server listens on `http://localhost:4021`. Hit it with the [client example](../../clients/batch-settlement).

## Environment

| Variable | Required | Description |
|----------|----------|-------------|
| `EVM_ADDRESS` | yes | `payTo` address (channel receiver) |
| `FACILITATOR_URL` | yes | Batch-settlement facilitator endpoint |
| `EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY` | no | Self-managed authorizer key (omit to delegate) |
| `STORAGE_DIR` | no | Persist channel sessions on disk (defaults to in-memory) |
| `DEFERRED_WITHDRAW_DELAY_SECONDS` | no | Channel `withdrawDelay`; 900 (15 min) – 2,592,000 (30 days) |
