# Batch-Settlement Gateway Client Example

Load-style client for the `voucher-gateway` extension. It simulates `N_CLIENTS` logical clients with distinct channel salts. Each client makes `N_PAYMENTS` sequential payments to a random choice among `M_SERVERS`, sampled with replacement. Client concurrency defaults to `1` so first-deposit RPCs do not trip public Base Sepolia rate limits.

After every payment completes, the client calls the facilitator's `POST /distribute` once so pending commitments are redeemed in a single `claimAndDistribute`. The facilitator also keeps its normal 60s schedule.

See the [extension specification](../../../../specs/extensions/voucher-gateway.md).

## Setup

```bash
cp .env-local .env
# fill EVM_PRIVATE_KEY and use the same M_SERVERS as the gateway server
# set the same dedicated EVM_RPC_URL on the facilitator if raising CLIENT_CONCURRENCY

cd ../../
pnpm install && pnpm build
cd clients/batch-settlement-gateway

pnpm start
```

Start the [gateway facilitator](../../facilitator/batch-settlement-gateway) and [gateway server](../../servers/batch-settlement-gateway) first.

## Environment

| Variable | Required | Description |
| --- | --- | --- |
| `EVM_PRIVATE_KEY` | yes | Payer key shared by the simulated clients |
| `EVM_VOUCHER_SIGNER_PRIVATE_KEY` | no | Dedicated voucher-signing EOA |
| `RESOURCE_SERVER_URL` | no | Gateway server base URL (default `http://localhost:4021`) |
| `FACILITATOR_URL` | no | Gateway facilitator base URL (default `http://localhost:4022`) |
| `EVM_RPC_URL` | no | EVM RPC URL (public `sepolia.base.org` rate-limits concurrent deposits) |
| `N_CLIENTS` | no | Number of salt-isolated logical clients (default `3`) |
| `M_SERVERS` | no | Number of server routes to sample (default `4`) |
| `N_PAYMENTS` | no | Payments made by each client (default `5`) |
| `CLIENT_CONCURRENCY` | no | Max in-flight logical clients (default `1`) |
| `CHANNEL_SALT` | no | Base `bytes32`; each client derives a unique salt from it |
| `DEPOSIT_MULTIPLIER` | no | Deposit multiplier (default `N_PAYMENTS + 2`) |
| `STORAGE_DIR` | no | Persistent state root; one subdirectory is used per client |
