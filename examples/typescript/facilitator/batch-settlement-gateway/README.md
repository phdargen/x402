# Batch-Settlement Gateway Facilitator Example

Express facilitator for **batch-settlement** with the `voucher-gateway` extension on Base Sepolia.

Registers `createVoucherGatewayFacilitatorExtension({ gateway, withdrawDelay, storage })`, which:

- Lists `voucher-gateway` in `GET /supported.extensions`
- Advertises `{ gateway, withdrawDelay }` under `extensionInfo["voucher-gateway"]` (not under `kinds[].extra`)
- Owns offchain channel/server commitment storage
- Runs `claimAndDistribute` on a schedule via `createChannelManager(signer, network).start(...)` (disable with `AUTO_CLAIM=false`)
- Exposes `POST /distribute` so the load client can redeem all pending commitments immediately

See the [extension specification](../../../../specs/extensions/voucher-gateway.md).

## Prerequisites

- Node.js v20+, pnpm v10
- A deployed `x402BatchSettlementGateway` address (`GATEWAY_ADDRESS`)
- Base Sepolia ETH on the relayer address (gas)

## Setup

```bash
cp .env-local .env
# fill EVM_PRIVATE_KEY, GATEWAY_ADDRESS, optionally WITHDRAW_DELAY_SECONDS / STORAGE_DIR

cd ../../
pnpm install && pnpm build
cd facilitator/batch-settlement-gateway

pnpm dev
```

Default listen URL: `http://localhost:4022`.

Pair with the [gateway server](../../servers/batch-settlement-gateway) and [gateway client](../../clients/batch-settlement-gateway).

## Env

| Variable | Required | Description |
|----------|----------|-------------|
| `EVM_PRIVATE_KEY` | yes | Relayer wallet (submits deposit / claimAndDistribute / withdraw) |
| `GATEWAY_ADDRESS` | yes | Deployed gateway contract |
| `WITHDRAW_DELAY_SECONDS` | no | Policy advertised in `/supported` (default `900`) |
| `EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY` | no | Optional delegated server authorizer |
| `STORAGE_DIR` | no | File-backed gateway storage directory |
| `AUTO_CLAIM` | no | Scheduled claimAndDistribute loop (`true` by default; set `false` to disable) |
| `EVM_RPC_URL` | no | Default Base Sepolia public RPC |
| `PORT` | no | Default `4022` |
