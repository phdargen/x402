# @x402/express Batch-Settlement Example Server

Express server that protects a resource with the **batch-settlement** EVM scheme. Each request is paid by an off-chain voucher; the server batches voucher claims and on-chain settlements via a `ChannelManager` running in the background.

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

## Settlement Policy

Clients can call `initiateWithdraw` directly on-chain at any time, **outside the request flow**. After the channel's `withdrawDelay` elapses, `finalizeWithdraw` drains the escrow and any unclaimed vouchers become unclaimable forever.

This demo uses local-friendly timing: claim every 1 minute, settle every 2 minutes, and refund channels idle for 3 minutes. The default channel `withdrawDelay` is 1 day.

For production, choose a `withdrawDelay` greater than your claim cadence plus an operational safety margin. A daily claim job pairs well with a `withdrawDelay` longer than one day; settle less frequently when gas savings matter more than receiver cash-flow latency. Idle refunds are usually best on a week-scale cadence unless your product needs faster channel cleanup.

The `ChannelManager` can also be used with one-shot calls such as `claimAndSettle()` and `refundIdleChannels()` from a cron job or external worker.

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
| `EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY` | no | Self-managed authorizer key (omit to delegate to facilitator) |
| `STORAGE_DIR` | no | Persist channel sessions on disk (defaults to in-memory) |
| `DEFERRED_WITHDRAW_DELAY_SECONDS` | no | Channel `withdrawDelay`; defaults to 86,400 (1 day) |
