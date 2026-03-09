# XMTP Server Example - Paid Weather Agent

Mirrors the [HTTP express example](../express/): a resource agent that charges for weather data over XMTP messages.

## Flow

1. Client sends "weather" to the agent
2. Agent responds with `x402/payment-required`
3. Client sends `x402/payment-payload` (signed payment)
4. Agent verifies/settles via facilitator, then sends weather data

## Setup

1. Copy `.env.example` to `.env`
2. Set `XMTP_WALLET_KEY`, `XMTP_DB_ENCRYPTION_KEY`, `XMTP_ENV`
3. Set `EVM_ADDRESS` (payment recipient) and `FACILITATOR_URL`
4. Run `pnpm dev`

## Usage

After starting, the agent prints its address. Use the [XMTP client example](../../clients/xmtp/) or [xmtp.chat](https://xmtp.chat) to message it.

- **weather** - Paid ($0.001) weather data
- **/help** - Free help
