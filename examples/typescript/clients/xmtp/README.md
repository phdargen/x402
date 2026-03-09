# XMTP Client Example - Request Paid Weather

Mirrors the [HTTP fetch example](../fetch/): requests paid weather data over XMTP instead of HTTP.

## Flow

1. Connects to XMTP and starts agent
2. Finds/creates DM with resource agent
3. Sends `/weather` via `sendText`
4. Handles payment flow (payment-required → payment-payload → settlement → response)
5. Prints weather data and payment info

## Setup

1. **Start the server first** (in another terminal):
   ```bash
   cd examples/typescript/servers/xmtp && pnpm dev
   ```
   Note the agent address printed (e.g. `Weather agent listening at 0x...`).

2. Copy `.env.example` to `.env`

3. Set XMTP vars, `EVM_PRIVATE_KEY` (payer), and `RESOURCE_AGENT_ADDRESS` (must match server's agent.address)

4. Run `pnpm dev`

If the client hangs after "Sending /weather...", the server is likely not running or `RESOURCE_AGENT_ADDRESS` is wrong. A 30s timeout will surface a clear error.
