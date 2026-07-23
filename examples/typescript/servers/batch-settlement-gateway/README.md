# Batch-Settlement Gateway Server Example

Express server using **batch-settlement** with the `voucher-gateway` extension.

Unlike vanilla batch-settlement, this server:

- Declares `voucher-gateway` on the route
- Registers `createVoucherGatewayServerExtension()` to copy `info.gateway` from facilitator `/supported.extensionInfo`
- Does **not** run a local `ChannelManager` (facilitator owns redemption via `claimAndDistribute`)
- Always proxies `/verify` then `/settle` to the facilitator, signing `GatewayClaimAuthorization` locally
- Exposes `GET /weather` for the [vanilla batch-settlement client](../../clients/batch-settlement)
- Exposes `M_SERVERS` extra routes with distinct deterministic payout addresses for the [gateway load client](../../clients/batch-settlement-gateway)

All simulated servers use the facilitator's shared `withdrawDelay`; changing it per route would create separate base channels and defeat the shared-channel gateway test. Each `/server/N/weather` route instead has a distinct `payTo`, which creates the separate `GatewayConfig` identities the contract distributes to.

See the [extension specification](../../../../specs/extensions/voucher-gateway.md).

## Setup

```bash
cp .env-local .env
# fill EVM_ADDRESS, FACILITATOR_URL, EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY

# start the gateway facilitator first (examples/typescript/facilitator/batch-settlement-gateway)

pnpm dev
```

Listens on `http://localhost:4021`.

- `GET /weather` — single payout (`EVM_ADDRESS`); works with the vanilla client
- `GET /server/1/weather` … `GET /server/M_SERVERS/weather` — multi-server load routes

## Env

| Variable | Required | Description |
|----------|----------|-------------|
| `EVM_ADDRESS` | yes | Payout (`payTo`) for `GET /weather` |
| `FACILITATOR_URL` | yes | Gateway-capable facilitator |
| `EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY` | yes | Signs `GatewayClaimAuthorization` and derives deterministic test payout addresses |
| `M_SERVERS` | no | Number of simulated server routes (default `4`; match the gateway client) |
