# Auth-Capture Server (Go)

Demo resource server using the auth-capture scheme's escrow payment flow: the
facilitator authorizes funds into escrow *before* the handler runs, the
handler serves the request, and then this server signs a Capture (success)
or Void (failure/cancel) message that lets the facilitator release the
escrowed funds.

The receiver authorizer that signs Capture/Void is either:

- **Self:** set `EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY`; its address is published as `extra.receiverAuthorizer`
- **Delegated:** omit the key; `extra.receiverAuthorizer` is taken from the facilitator's `/supported`, this server sends unsigned payloads, and the facilitator signs them after authenticating the caller

## Run

```bash
cp .env-example .env
# fill in EVM_PAYEE_ADDRESS, FACILITATOR_URL, and optionally EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY

go run .
```

The server listens on `http://localhost:4021` and exposes `GET /weather`. Pair
with `examples/go/clients/http` (it pays auth-capture routes too) and `examples/go/facilitator/auth-capture`.

## Environment

| Variable                              | Required | Description |
|----------------------------------------|----------|-------------|
| `EVM_PAYEE_ADDRESS`                    | yes      | `payTo` address (escrow receiver) |
| `FACILITATOR_URL`                      | yes      | Auth-capture facilitator endpoint (e.g. `http://localhost:4022`) |
| `EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY`  | no       | Self-managed receiver authorizer that signs the Capture/Void EIP-712 messages; omit to delegate lifecycle signing to the facilitator |
