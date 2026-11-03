# @x402/express Batch-Settlement Example Server

Express server that protects a resource with the **batch-settlement** EVM scheme. Each request is paid by an off-chain voucher; the server batches voucher claims and onchain settlements via a `ChannelManager` running in the background.

The route demonstrates **dynamic pricing on EVM**: the client authorizes up to `$0.01` per request, and the handler bills a random fraction of that via `setSettlementOverrides`. Every 402 also includes `extra.minDeposit` (SDK default `10 × amount`) so clients can size the channel deposit. Override per route with `accepts.extra.minDeposit` (`"$0.10"` on the default asset, or an atomic string). The server announces the hint only; it does not reject smaller deposits unless you set `enforceMinDeposit: true`. SVM `batch-settlement` is fixed-price by default, so Solana payments settle at the advertised amount. Set `SVM_OPERATOR_PRIVATE_KEY` to also offer the route **server-signed**: the client signs a per-request proof, the handler meters, and the operator signs the actual cumulative charge. Because that gives the operator authority over the whole channel escrow, the server keeps a client-signed accept on the same route (`extra.voucherSigner: "client"`) and clients use the server-signed one only for origins they have configured as trusted.

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

This is simpler operationally but binds each channel to the current facilitator authorizer. **Switching facilitators (or rotating their authorizer key) requires opening new channels.** Before swapping, claim outstanding vouchers and refund remaining balances on the old channels.

### 3. Facilitator-managed custody (spec v1.1)

Set `VOUCHER_STORE_MODE=facilitator` and point `FACILITATOR_URL` at a facilitator that advertises `voucherManager: ["server", "facilitator"]` in `/supported` (for example the Go facilitator with its voucher store enabled). The server becomes a pass-through: every voucher goes through facilitator `/verify` and `/settle`; the facilitator channel manager owns claim/settle/refund scheduling.

```typescript
new BatchSettlementEvmScheme(evmAddress, {
  voucherStoreMode: "facilitator",
  refundAuthorizerSigner, // or rely on the facilitator's delegatedRefund: true
  storage: new FileChannelStorage({ directory: "./channels" }), // optional replica
});
```

Do **not** set `EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY` in this mode. Optional `STORAGE_DIR` is a replica updated after successful `/settle` (not used on the verify hot path). Do **not** start a server `ChannelManager` — claim, settle, and idle refunds run on the facilitator.

## Settlement Policy

Clients can call `initiateWithdraw` directly onchain at any time, **outside the request flow**. After the channel's `withdrawDelay` elapses, `finalizeWithdraw` drains the escrow and any unclaimed vouchers become unclaimable forever.

This demo uses local-friendly timing for the regular example server. The facilitator-managed soak uses the worker settings in `cdp-facilitator/cmd/config/local.yaml`: production worker gates and capacities, claim every 1 hour, settle every 2 hours, and a 1-day claim-idle policy. The default channel `withdrawDelay` is 1 day.

For production, choose a `withdrawDelay` greater than your claim cadence plus an operational safety margin. A daily claim job pairs well with a `withdrawDelay` longer than one day; settle less frequently when gas savings matter more than receiver cash-flow latency. Idle refunds are usually best on a week-scale cadence unless your product needs faster channel cleanup.

The `ChannelManager` runs the server-side lifecycle: claim vouchers from stored channels, settle claimed funds to `payTo`, and optionally refund idle channels. `start()` enables each job at the configured interval, while callbacks let you choose channels, gate settlement, and hook logging/metrics:

```typescript
manager.start({
  claimIntervalSecs: 60,
  settleIntervalSecs: 120,
  refundIntervalSecs: 180,
  maxClaimsPerBatch: 100,
  selectClaimChannels: (channels, { now }) =>
    channels.filter(
      channel =>
        channel.withdrawRequestedAt > 0 ||
        now - channel.lastRequestTimestamp >= 60_000,
    ),
  shouldSettle: ({ pendingSettle }) => pendingSettle,
  selectRefundChannels: (channels, { now }) =>
    channels.filter(channel => now - channel.lastRequestTimestamp >= 180_000),
  onClaim: result => console.log(`Claimed ${result.vouchers} vouchers`),
  onSettle: result => console.log(`Settled ${result.transaction}`),
  onRefund: result => console.log(`Refunded ${result.channel}`),
  onError: error => console.error("Settlement error:", error),
});
```

In this example, `selectClaimChannels` prioritizes channels with pending withdrawals and channels idle for at least 1 minute, so their vouchers are claimed before a withdrawal can finalize. The same selection callbacks can be reused with one-shot calls such as `claimAndSettle()` and `refundIdleChannels()` from a cron job or external worker.

## Storage

By default, channel sessions are in memory. Set `STORAGE_DIR` to persist them on disk for local restarts.

For serverless deployments or multi-instance servers, configure the scheme with `RedisChannelStorage`; it stores channel sessions in Redis/Valkey so they survive cold starts and update atomically across processes.

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

### Cross-SDK local testing

For local interop, set `FACILITATOR_URL=http://localhost:4022` (same as
`examples/go/servers/batch-settlement/.env.example`). Env keys match the Go
server example; `GET /api/generate` returns the same `usage` fields as the Go
demo for stable assertions across stacks.

## Stress test

`stress.ts` is a facilitator-managed server for load-testing the facilitator's claim/settle workers on Base Sepolia (`eip155:84532`). It serves the stress route on port `4022`, offers USDC and cbBTC, and spreads `payTo` across `STRESS_RECEIVERS` derived receivers so settles span many receiver/token pairs. USDC deposits use EIP-3009; cbBTC deposits use Permit2 because cbBTC does not expose EIP-3009. Each request is billed a random 1-100% of the authorized maximum.

Run order (see the [client stress section](../../clients/batch-settlement/README.md#stress-test) for the load generator):

1. Start local dependencies: `make docker-up` in `cdp-facilitator`.
2. Start the facilitator API: `make run-facilitator-stress` in `cdp-facilitator`. The stress target only raises the local API rate limit; it does not alter worker behavior.
3. Start the regular facilitator worker: `make run-facilitator-worker` in `cdp-facilitator`. Do not run another worker on the same Temporal task queue.
4. Start this server with `STRESS_RECEIVERS=1 STRESS_MAX_AMOUNT_ATOMIC=500`.
5. Start the client with `STRESS_CHANNELS=1000 STRESS_RPS=2.7778 STRESS_DURATION=2h STRESS_CBBTC_SHARE=0.01 DEPOSIT_MULTIPLIER=20 STRESS_REFUND_PROBABILITY=0.005 STRESS_DRAIN_TIMEOUT=1h`.

For a deterministic fresh local run, use `make docker-down-clean` before `make docker-up`; this deletes local Mongo, Redis, and Temporal volumes, so it is destructive to other local test data.

The client offers about 20,000 requests during the 2-hour steady phase. One receiver creates one USDC and one cbBTC settle target; the concentrated USDC traffic crosses the `$1` settle gate while the 1% cbBTC channel slice exercises Permit2 without exceeding the client's `0.001 cbBTC` deposit-authorization budget. The client then observes the worker for up to 1 hour. Treat the run as successful only when the final client report has `drain.completed=true`, `unclaimedChannels=0`, and `unsettledPairs=0`.

Because the worker schedules are interval schedules with Temporal jitter, the report is a timing observation rather than a strict wall-clock guarantee that a scheduled callback fires at an exact second. The 2-hour load plus 1-hour drain window is the minimum documented window for observing the 1-hour claim and 2-hour settle cadence; if the worker was started against an already-existing schedule, use its effective schedule timestamps and extend `STRESS_DRAIN_TIMEOUT` if the settle pass has not fired.

Pass checks:

- Worker logs show two `Processing ClaimBatchSettlement activity` entries followed by two successful `batch settlement claim pass` entries.
- Worker logs show one successful `batch settlement settle pass` entry.
- The client report has `drain.completed=true`, `drain.claimLagAtEnd.unclaimedChannels=0`, and `drain.claimLagAtEnd.unsettledPairs=0`.

| Variable | Default | Description |
|----------|---------|-------------|
| `STRESS_PORT` | `4022` | Listen port |
| `STRESS_SEED` | `x402-stress-default-seed` | Seed that derives the receivers. Must match the client's seed. |
| `STRESS_RECEIVERS` | `80` | Number of derived receiver addresses |
| `STRESS_MAX_AMOUNT_ATOMIC` | `100` | Per-request maximum in token atomic units |
| `FACILITATOR_URL` | `http://localhost:8003/v2/x402` | Facilitator endpoint |

## Environment

| Variable | Required | Description |
|----------|----------|-------------|
| `EVM_ADDRESS` | yes | `payTo` address (channel receiver) |
| `FACILITATOR_URL` | yes | Batch-settlement facilitator endpoint |
| `EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY` | no | Self-managed authorizer key (omit to delegate to facilitator; incompatible with `VOUCHER_STORE_MODE=facilitator`) |
| `VOUCHER_STORE_MODE` | no | `facilitator` for facilitator-managed custody; default is self-managed |
| `EVM_REFUND_AUTHORIZER_PRIVATE_KEY` | no | Managed mode only: signs cooperative refunds when the facilitator does not advertise `delegatedRefund: true` |
| `STORAGE_DIR` | no | Persist channel sessions on disk (defaults to in-memory) |
| `DEFERRED_WITHDRAW_DELAY_SECONDS` | no | Self-managed channel `withdrawDelay`; ignored in facilitator-managed mode (facilitator advertises `withdrawDelay`) |
