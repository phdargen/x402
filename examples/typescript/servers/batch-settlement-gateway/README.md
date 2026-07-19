# Batch-Settlement Gateway Server Example

Express server using **batch-settlement** with the `voucher-gateway` extension.

Unlike vanilla batch-settlement, this server:

- Declares `voucher-gateway` on the route
- Registers `createVoucherGatewayServerExtension()` to copy `info.gateway` from facilitator `/supported.extensionInfo`
- Does **not** run a local `ChannelManager` (facilitator owns redemption via `claimAndDistribute`)
- Always proxies `/verify` then `/settle` to the facilitator, signing `GatewayClaimAuthorization` locally

The [vanilla batch-settlement client](../batch-settlement) works as-is: gateway mode activates when the 402 includes `extensions["voucher-gateway"]`.

See the [extension specification](../../../../specs/extensions/voucher-gateway.md).

## Setup

```bash
cp .env-local .env
# fill EVM_ADDRESS, FACILITATOR_URL, EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY

# start the gateway facilitator first (examples/typescript/facilitator/batch-settlement-gateway)

pnpm dev
```

Listens on `http://localhost:4021`.

## Env

| Variable | Required | Description |
|----------|----------|-------------|
| `EVM_ADDRESS` | yes | Server payout (`payTo`) |
| `FACILITATOR_URL` | yes | Gateway-capable facilitator |
| `EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY` | yes | Signs `GatewayClaimAuthorization` |
