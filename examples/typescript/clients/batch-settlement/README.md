# Batch-Settlement Client Example

Fetch-based client that pays for a sequence of requests over a single payment channel using the **batch-settlement** EVM or SVM scheme. The first request opens the channel with a deposit; subsequent requests pay with a fresh cumulative voucher.

See the [EVM specification](../../../../specs/schemes/batch-settlement/scheme_batch_settlement_evm.md), [SVM specification](../../../../specs/schemes/batch-settlement/scheme_batch_settlement_svm.md), and [EVM scheme README](../../../../typescript/packages/mechanisms/evm/src/batch-settlement/README.md) for protocol details.

## Voucher Signer Delegation

By default, vouchers are signed by the same key as the payer (`EVM_PRIVATE_KEY`). Set `EVM_VOUCHER_SIGNER_PRIVATE_KEY` to delegate voucher signing to a dedicated EOA — its address is committed into the channel as the `payerAuthorizer`.

```typescript
const voucherSigner = toClientEvmSigner(privateKeyToAccount(VOUCHER_KEY));
const scheme = new BatchSettlementEvmScheme(signer, { voucherSigner });
```

Use this when:

- The payer key should only sign deposit authorizations.
- The payer is a smart wallet (EIP-1271). Delegating to an EOA voucher signer lets the facilitator verify vouchers with ECDSA recovery instead of an onchain `isValidSignature` call.

## Deposit policy

The client deposits `extra.minDeposit` when the server announced a valid hint, otherwise `amount × DEPOSIT_MULTIPLIER` (default `5`, minimum `3`).

`x402Client` spend controls still cap each request's `amount` (default `$1` on USDC). That same atomic cap is the escrow ceiling:

`maxDeposit = maxAmountPerPayment × depositMultiplier`

So the default `$1` cap and multiplier `5` lock at most `$5`. `spendControls: false` (or any uncapped asset) leaves the deposit uncapped too.

Use `depositStrategy` only for app-specific decisions:

- **`undefined`** — use the SDK default (`depositAmount` in context).
- **`false`** — skip this deposit attempt.
- **Base-unit string or `bigint`** — custom amount; must be **≥ `minimumDepositAmount`**, and still respects `maxDeposit` when a spend cap is set.

```typescript
const maxDeposit = 1_000_000n;

const scheme = new BatchSettlementEvmScheme(signer, {
  depositPolicy: { depositMultiplier },
  depositStrategy: ({ depositAmount }) => {
    const amount = BigInt(depositAmount);
    return amount > maxDeposit ? maxDeposit : undefined;
  },
});
```

## Prerequisites

- Node.js v20+, pnpm v10
- A running [batch-settlement server](../../servers/batch-settlement)
- A funded `EVM_PRIVATE_KEY` or `SVM_PRIVATE_KEY` holding the deposit token

## Setup

```bash
cp .env-local .env
# fill EVM_PRIVATE_KEY or SVM_PRIVATE_KEY

cd ../../
pnpm install && pnpm build
cd clients/batch-settlement

pnpm start
```

## Concurrent requests

Use the concurrent example to send requests over multiple channels in parallel. Each slot uses `CONCURRENT_CHANNEL_SALT + index` (default base `0x1000`, so slots `0x1000`, `0x1001`, …). This is a separate variable from `CHANNEL_SALT`, so the concurrent example never shares a channel with `pnpm start`. The base must be below 2^96: when a facilitator-managed 402 carries a `refundAuthorizer`, the SDK keeps only the low 96 bits of the salt as the channel index, and a larger base would collapse every slot into one channel (the server then answers `invalid_batch_settlement_evm_channel_busy`). The example validates this and fails fast. The server serializes work per channel while still processing channels concurrently.

```bash
NUMBER_OF_CHANNELS=3 NUMBER_OF_REQUESTS=3 pnpm dev:concurrent
```

## Stress test

`stress.ts` drives many channels against the [stress server](../../servers/batch-settlement/README.md#stress-test) to exercise the facilitator's real claim and settle workers on Base Sepolia. It runs an open-loop **steady** phase (Poisson arrivals at `STRESS_RPS`, with a Zipf-hot/cold channel mix while channels are opened progressively), then takes one onchain backlog snapshot. It prints progress lines, persists failure records as NDJSON, and writes a JSON report to `STRESS_REPORT_DIR`.

For the local production-like soak, start the local facilitator API and the regular facilitator worker with `cdp-facilitator/cmd/config/local.yaml`. That config uses production worker gates and capacities, with a 1-hour claim schedule and a 2-hour settle schedule. Start the worker before the load so its Temporal schedules are active:

```bash
cd cdp-facilitator
make docker-up
make run-facilitator-stress
make run-facilitator-worker
```

In another terminal, start the stress server with one concentrated receiver, a 500-atomic-unit maximum request, and a 1% cbBTC slice. The 1% slice is intentional: with 1,000 channels, the client's bounded `0.001 cbBTC` Permit2 budget can fund exactly 10 cbBTC channels at a 20x deposit multiplier.

```bash
cd x402/examples/typescript/servers/batch-settlement
FACILITATOR_URL=http://localhost:8003/v2/x402 \
STRESS_RECEIVERS=1 \
STRESS_MAX_AMOUNT_ATOMIC=500 \
STRESS_SEED=x402-local-prod-soak \
pnpm dev:stress
```

Then run the client for 2 hours. This offers about 20,000 attempts, uses all 1,000 configured channels progressively, and concentrates enough charged USDC at one receiver to cross the local `$0.10` settle gate. With a 1-hour claim schedule and a 2-hour settle schedule, expect some backlog at the end; it is recorded as `endBacklog` for comparison with the worker report.

```bash
cd x402/examples/typescript/clients/batch-settlement
EVM_PRIVATE_KEY=0x... \
STRESS_SEED=x402-local-prod-soak \
RESOURCE_SERVER_URL=http://localhost:4022 \
STRESS_CHANNELS=1000 \
STRESS_RPS=2.7778 \
STRESS_DURATION=2h \
STRESS_CBBTC_SHARE=0.01 \
DEPOSIT_MULTIPLIER=20 \
STRESS_REFUND_PROBABILITY=0.005 \
STRESS_REFUND_FRACTION=0.05 \
pnpm dev:stress
```

The load generator's `STRESS_RPS` is the offered request-arrival rate, not a concurrency setting: it samples exponential inter-arrival times and attempts that many requests per second. `STRESS_MAX_INFLIGHT` is the separate concurrency cap. Requests are serialized per channel, so busy channels are counted as skipped rather than issuing concurrent vouchers.

### Against dev, staging or prod

The client needs no facilitator credentials: it only talks to the stress server and reads Base Sepolia. To test a deployed facilitator, start the stress server with `STRESS_TARGET=dev|staging|prod` (see the [server README](../../servers/batch-settlement/README.md#running-against-dev-staging-or-prod)), then run the client against that server with the same `STRESS_SEED`. The report records the server's `target` and `facilitatorHost` under `config`.

```bash
RESOURCE_SERVER_URL=http://localhost:4022 \
STRESS_SEED=x402-stress-dev \
STRESS_CHANNELS=100 STRESS_RPS=1 STRESS_DURATION=10m \
STRESS_BACKLOG_WAIT=2h STRESS_BACKLOG_POLL_INTERVAL=2m \
pnpm dev:stress
```

### Where the claim and settle numbers come from

`endBacklog` (`channelsClaimed`, `unclaimedChannels`, `pairsSettled`, `unsettledPairs`, `unclaimedAtomic`) is not read from the facilitator or its worker, so it works against any environment that settles on Base Sepolia:

- The charged amount per channel is tracked locally from the `PAYMENT-RESPONSE` header.
- Claimed and settled amounts are read onchain from the batch-settlement contract (`channels(channelId).totalClaimed`, `receivers(receiver, token)`), through `BASE_SEPOLIA_RPC_URL` or the public RPC.

The snapshot is a single read taken when the load ends, so it only shows what the facilitator has claimed and settled by then. A worker that claims hourly will report most channels as unclaimed after a short run. Set `STRESS_BACKLOG_WAIT` to keep polling; each snapshot is printed as `backlog +<secs>s ...` and stored in the report as `backlogTimeline`. The wait ends early once everything is claimed and settled. The first Ctrl-C during the wait ends it and writes the report.

### Facilitator signer balances

The stress server reads the facilitator's EVM signer addresses from `/supported` (the `eip155:*` entry plus any entry for Base Sepolia) and publishes them in `/stress/config`. The client reads each signer's native ETH balance on Base Sepolia before the load and again right before the report is written, so with `STRESS_BACKLOG_WAIT` the end balance includes the gas the worker spends on claims and settles during the wait. The report's `facilitatorSignerBalances` holds, per signer, `startEth`, `endEth` and `deltaEth` in human-readable ETH (negative means gas spent), plus `totalDeltaEth`. A failed balance read is recorded per signer as an error instead of failing the run. Against a server that predates this field the section is empty.

Run the refund unit checks before the soak:

```bash
pnpm test:refund
```

`EVM_PRIVATE_KEY` must hold Base Sepolia ETH plus enough USDC and cbBTC to cover every channel's deposit. cbBTC uses Permit2 because this token does not expose EIP-3009; the client automatically approves up to the run budget when needed. The default cbBTC share and budget cap the run's cbBTC deposit authorizations at `0.001 cbBTC` (100,000 atomic units). Deposits are sized from the server's `minDeposit` hint or `DEPOSIT_MULTIPLIER` (default `20` here).

The default steady phase runs for 10 minutes while channel openings are interleaved with voucher traffic. The soak command above runs for roughly 2 hours, plus request and RPC jitter.

Ctrl-C stops new arrivals, waits for in-flight requests, and writes the final report and backlog snapshot. Because voucher signers and channel salts are derived from `STRESS_SEED` and the channel index, re-running with the same seed resumes the same channels instead of opening new ones. Use a new seed for a fresh run. Do not run the regular facilitator worker alongside another worker on the same Temporal task queue.

| Variable | Default | Description |
| --- | --- | --- |
| `STRESS_SEED` | `x402-stress-default-seed` | Derivation seed. Must match the server. |
| `STRESS_CHANNELS` | `1000` | Number of channels |
| `STRESS_RPS` | `5` | Offered payments per second in the steady phase |
| `STRESS_DURATION` | `10m` | Steady phase length (`500ms`, `90s`, `10m`, `2h`) |
| `STRESS_OPEN_CONCURRENCY` | `8` | Maximum simultaneous initial channel deposits during the opening ramp |
| `STRESS_MAX_INFLIGHT` | `64` | In-flight request cap; arrivals over it are dropped and counted |
| `STRESS_REFUND_PROBABILITY` | `0.005` | Probability of a partial refund after a successful voucher |
| `STRESS_REFUND_FRACTION` | `0.05` | Fraction of the locally refundable balance requested by a refund |
| `STRESS_REFUND_MIN_ATOMIC` | `10` | Minimum partial refund amount in token atomic units |
| `STRESS_CBBTC_SHARE` | `0.01` | Share of channels using cbBTC instead of USDC (0-1) |
| `STRESS_CBBTC_BUDGET_ATOMIC` | `100000` | Maximum cbBTC deposit authorizations for the whole run (0.001 cbBTC at 8 decimals) |
| `STRESS_HOT_SHARE` | `0.7` | Share of steady traffic aimed at hot channels (0-1) |
| `STRESS_ZIPF_S` | `1.1` | Zipf exponent for the hot-channel skew |
| `STRESS_PROGRESS_INTERVAL` | `30s` | Progress line interval |
| `STRESS_BACKLOG_WAIT` | `0` | After the load, keep re-reading the onchain backlog for up to this long (`90s`, `10m`, `2h`) or until everything is claimed and settled. `0` takes a single snapshot. |
| `STRESS_BACKLOG_POLL_INTERVAL` | `60s` | Time between backlog snapshots while waiting (minimum `1s`) |
| `STRESS_REPORT_DIR` | `.` | Directory for the JSON report |
| `BASE_SEPOLIA_RPC_URL` | public RPC | RPC used for funding and the end backlog snapshot |
| `RESOURCE_SERVER_URL` | `http://localhost:4022` | Stress server URL |

## Environment

| Variable | Required | Description |
| --- | --- | --- |
| `EVM_PRIVATE_KEY` | one of | EVM payer key (funds the deposit) |
| `EVM_VOUCHER_SIGNER_PRIVATE_KEY` | no | Dedicated voucher-signing EOA (committed as `payerAuthorizer`) |
| `SVM_PRIVATE_KEY` | one of | Base58-encoded SVM payer keypair bytes |
| `SVM_RPC_URL` | no | SVM RPC endpoint override |
| `SVM_SERVER_SIGNED_OPERATORS` | no | Comma-separated base58 operator keys allowed to sign vouchers for this client (server-signed, metered channels). Empty means server-signed accepts are refused and the client pays with its own vouchers. The operator of a server-signed channel can claim up to the whole escrow. Works over any transport. |
| `SVM_SERVER_SIGNED_MAX_DEPOSIT` | no | USD cap (e.g. `$0.05`, default) on the escrow locked per channel under a trusted operator, for default assets; server `minDeposit` hints above it are clamped. Non-default tokens need an `allowedAssets` entry with an atomic cap in code. |
| `RESOURCE_SERVER_URL` | no | Server base URL (default `http://localhost:4021`) |
| `ENDPOINT_PATH` | no | Path on the server (default `/weather`) |
| `CHANNEL_SALT` | no | EVM channel index (hex) for `pnpm start` |
| `CONCURRENT_CHANNEL_SALT` | no | Base EVM channel index (decimal or hex, must be < 2^96) for `pnpm dev:concurrent`; slots add `0`, `1`, `2`, … (default `0x1000`) |
| `SVM_CHANNEL_SALT` | no | SVM decimal `u64` channel salt (default `0`); change to open a fresh channel |
| `DEPOSIT_MULTIPLIER` | no | Deposit target is `amount ×` this multiplier when `extra.minDeposit` is absent; lock ceiling is `spendCap ×` this multiplier (integer **≥ 3**; default `5`) |
| `STORAGE_DIR` | no | Persist client session state (defaults to in-memory) |
| `NUMBER_OF_REQUESTS` | no | How many paid requests to issue (default 3) |
| `NUMBER_OF_CHANNELS` | no | How many channels to run in parallel in `pnpm dev:concurrent` (default 3) |
| `REFUND_AFTER_REQUESTS` | no | If `true`, issue a self-contained refund via `scheme.refund(url)` after the request loop |
| `REFUND_AMOUNT` | no | Partial EVM refund amount in base units; omit for a full refund. SVM supports full refund only. |
