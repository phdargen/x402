# Transport: XMTP

## Summary

The XMTP transport implements x402 payment flows over the XMTP messaging protocol. Unlike the HTTP transport which uses request-response headers, the XMTP transport encodes x402 payment signaling into XMTP messages using custom content types. This enables pay-per-message agent interactions, paid group services and conversational commerce where payment negotiation happens inline within encrypted, decentralized messaging channels.

## Motivation

XMTP is a decentralized, end-to-end encrypted messaging protocol widely used for wallet-to-wallet communication. Integrating x402 into XMTP enables several use cases that HTTP alone cannot serve well:

- **Pay-per-message agent services**: Agents can charge for tool execution, data retrieval or task completion directly in the messaging flow.
- **Conversational commerce**: Users can interact with merchant agents in DMs, with payment handled inline rather than through external redirect flows.
- **Group-based paid services**: Agents in group chats can gate specific capabilities behind x402 payments.

## Payment Flow Overview

```
Client                          Resource Agent                    Facilitator
  |                                   |                               |
  |  1. XMTP message (request)        |                               |
  |---------------------------------->|                               |
  |                                   |                               |
  |  2. x402/payment-required msg     |                               |
  |<----------------------------------|                               |
  |                                   |                               |
  |  3. x402/payment-payload msg      |                               |
  |---------------------------------->|                               |
  |                                   |  4. POST /verify              |
  |                                   |------------------------------>|
  |                                   |  5. VerifyResponse            |
  |                                   |<------------------------------|
  |                                   |  6. POST /settle              |
  |                                   |------------------------------>|
  |                                   |  7. SettleResponse            |
  |                                   |<------------------------------|
  |                                   |                               |
  |  8. x402/settlement-response msg  |                               |
  |<----------------------------------|                               |
  |                                   |                               |
  |  9. Service response (text, etc.) |                               |
  |<----------------------------------|                               |
```

1. The Client sends a normal XMTP message requesting a service (e.g. a text message asking an AI agent a question).
2. The Resource Agent determines payment is required and responds with an `x402/payment-required` message containing the `PaymentRequired` schema.
3. The Client constructs and sends an `x402/payment-payload` message containing the signed `PaymentPayload` schema. For structured requests, the payment-payload MAY include an optional `request` field carrying the request body (see Structured Requests).
4-7. The Resource Agent verifies and settles the payment through the Facilitator's HTTP API (core spec Section 7).
8. The Resource Agent sends an `x402/settlement-response` message with the `SettlementResponse` schema.
9. The Resource Agent delivers the actual service response as a standard XMTP message (text, markdown, attachment, etc.).

The settlement response (step 8) SHOULD be sent as a reply to the payment-payload message, keeping the x402 protocol messages threaded together. The service response (step 9) SHOULD be sent as a separate standalone message.

Unlike HTTP, XMTP messaging is asynchronous. As payment authorizations have a limited validity window (depending on the scheme) and may expire if not processed promptly, resource agents SHOULD process incoming payment payloads immediately and ensure the full payment flow (verify, resource service execution, settlement) completes within their indicated `maxTimeoutSeconds`.

XMTP messages are limited to ~1MB. The x402 protocol messages (payment-required, payment-payload, settlement-response) are small JSON objects well within this limit. Service responses larger than ~1MB SHOULD use XMTP's remote attachment content type.

### Participants

- **Resource Agent**: An XMTP agent that provides paid services. Equivalent to the "Resource Server" in the core spec.
- **Client**: Any XMTP client (human wallet or agent) requesting paid services.
- **Facilitator**: Same as the core spec: an HTTP service handling verification and onchain settlement. The Resource Agent MUST have a pre-configured facilitator URL and access the Facilitator via HTTP (core spec Section 7).


## Payment Required Signaling

The Resource Agent indicates payment is required by sending an `x402/payment-required` content type message.

**Mechanism**: XMTP message with custom content type `x402/payment-required`
**Data Format**: JSON-encoded `PaymentRequired` schema (core spec Section 5.1), transmitted as UTF-8 bytes

**Content Type Identifier:**

```
authorityId: "x402"
typeId: "payment-required"
versionMajor: 1
versionMinor: 0
```

**Content Fallback**: `"Payment required: [amount] [asset name] on [network]. Use an x402-compatible client to pay."`

**shouldPush**: `true`

**Example:**

```json
{
  "x402Version": 2,
  "error": "Payment required for this service",
  "resource": {
    "url": "xmtp://0xAgentAddress/premium-query",
    "description": "Premium AI analysis",
    "mimeType": "text/plain"
  },
  "accepts": [
    {
      "scheme": "exact",
      "network": "eip155:84532",
      "amount": "10000",
      "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      "payTo": "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
      "maxTimeoutSeconds": 60,
      "extra": {
        "name": "USDC",
        "version": "2"
      }
    }
  ],
  "extensions": {}
}
```

**Resource URL format**: For XMTP-native resources, the `resource.url` field uses the scheme `xmtp://{address}/{capability}`. This is informational and is not dereferenced over HTTP. Routing to the correct handler is the Resource Agent's responsibility, not a function of this URL.

## Payment Payload Transmission

Clients send payment data by sending an `x402/payment-payload` content type message.

**Mechanism**: XMTP message with custom content type `x402/payment-payload`
**Data Format**: JSON-encoded `PaymentPayload` schema (core spec Section 5.2) with an optional `request` field, transmitted as UTF-8 bytes

**Content Type Identifier:**

```
authorityId: "x402"
typeId: "payment-payload"
versionMajor: 1
versionMinor: 0
```

**Content Fallback**: `"x402 payment submitted. Use an x402-compatible client to view."`

**shouldPush**: `false`

**Fields (XMTP-specific additions to core PaymentPayload):**

| Field Name | Type | Required | Description |
| --- | --- | --- | --- |
| `request` | `object` | Optional | Structured request data accompanying the payment (see Structured Requests) |
| `request.body` | `any` | Required (if `request` present) | The request payload: JSON object, string, or base64-encoded binary |
| `request.contentType` | `string` | Optional | MIME type of the body. Defaults to `"application/json"` |

**Example (conversational / GET-like):**

```json
{
  "x402Version": 2,
  "resource": {
    "url": "xmtp://0xAgentAddress/premium-query",
    "description": "Premium AI analysis",
    "mimeType": "text/plain"
  },
  "accepted": {
    "scheme": "exact",
    "network": "eip155:84532",
    "amount": "10000",
    "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    "payTo": "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
    "maxTimeoutSeconds": 60,
    "extra": {
      "name": "USDC",
      "version": "2"
    }
  },
  "payload": {
    "signature": "0x...",
    "authorization": {
      "from": "0x857b06519E91e3A54538791bDbb0E22373e36b66",
      "to": "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
      "value": "10000",
      "validAfter": "1740672089",
      "validBefore": "1740672154",
      "nonce": "0x..."
    }
  },
  "extensions": {}
}
```

**Example (structured / POST-like):**

```json
{
  "x402Version": 2,
  "resource": {
    "url": "xmtp://0xAgentAddress/generate-image",
    "description": "AI image generation",
    "mimeType": "image/png"
  },
  "accepted": {
    "scheme": "exact",
    "network": "eip155:84532",
    "amount": "50000",
    "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    "payTo": "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
    "maxTimeoutSeconds": 120,
    "extra": {
      "name": "USDC",
      "version": "2"
    }
  },
  "payload": {
    "signature": "0x...",
    "authorization": {
      "from": "0x857b06519E91e3A54538791bDbb0E22373e36b66",
      "to": "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
      "value": "50000",
      "validAfter": "1740672089",
      "validBefore": "1740672254",
      "nonce": "0x..."
    }
  },
  "extensions": {},
  "request": {
    "body": {
      "prompt": "a sunset over the ocean",
      "style": "watercolor",
      "resolution": "1024x1024"
    },
    "contentType": "application/json"
  }
}
```

## Settlement Response Delivery

The Resource Agent communicates payment settlement results by sending an `x402/settlement-response` content type message.

**Mechanism**: XMTP message with custom content type `x402/settlement-response`
**Data Format**: JSON-encoded `SettlementResponse` schema (core spec Section 5.3), transmitted as UTF-8 bytes

**Content Type Identifier:**

```
authorityId: "x402"
typeId: "settlement-response"
versionMajor: 1
versionMinor: 0
```

**Content Fallback (success)**: `"Payment settled. Tx: [transaction hash]"`

**Content Fallback (failure)**: `"Payment failed: [errorReason]"`

**shouldPush**: `true`

**Example (Success):**

```json
{
  "success": true,
  "transaction": "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
  "network": "eip155:84532",
  "payer": "0x857b06519E91e3A54538791bDbb0E22373e36b66"
}
```

**Example (Failure):**

```json
{
  "success": false,
  "errorReason": "insufficient_funds",
  "payer": "0x857b06519E91e3A54538791bDbb0E22373e36b66",
  "transaction": "",
  "network": "eip155:84532"
}
```

The Resource Agent MUST send the `x402/settlement-response` before delivering the service response. If settlement fails, the Resource Agent MUST NOT deliver the service response.

## Content Type Summary

| Content Type | Direction | Description |
| --- | --- | --- |
| `x402/payment-required` | Resource Agent -> Client | `PaymentRequired` object as JSON-encoded UTF-8 bytes |
| `x402/payment-payload` | Client -> Resource Agent | `PaymentPayload` object as JSON-encoded UTF-8 bytes |
| `x402/settlement-response` | Resource Agent -> Client | `SettlementResponse` object as JSON-encoded UTF-8 bytes |

Each content type requires a codec registered with the XMTP client per the [XIP-5](https://github.com/xmtp/XIPs/blob/main/XIPs/xip-5-message-content-types.md) framework. 

## Correlation and Ordering

Because XMTP messaging is asynchronous, messages may arrive out of order or a client may have multiple pending payment flows. To correlate payment messages with their originating requests, implementations SHOULD use XMTP's reply content type to thread the x402 protocol messages:

- The `payment-required` message SHOULD be sent as a reply to the original request message.
- The `payment-payload` message SHOULD be sent as a reply to the `payment-required` message.
- The `settlement-response` SHOULD be sent as a reply to the `payment-payload` message.
- The service response SHOULD be sent as a separate standalone message (not a reply in the payment thread).

If an agent receives a `payment-payload` that is not a reply to any outstanding `payment-required`, it SHOULD still attempt to verify and settle it if the payment parameters are acceptable. This allows clients that already know the agent's pricing (via discovery or prior interaction) to skip the `payment-required` round-trip.

## Structured Requests

The XMTP transport supports two request patterns, analogous to GET and POST in HTTP:

**Conversational (GET-like)**: The client sends a natural-language text message (step 1). The agent prices the request and replies with `payment-required`. After payment, the agent uses the original text message as the handler input. This is the default pattern for simple queries like "analyze AAPL" or "what's the weather?".

**Structured (POST-like)**: The client includes a `request` field in the `x402/payment-payload` message (step 3) carrying structured parameters such as JSON objects, form data, or base64-encoded binary. 

This mirrors HTTP where the POST body and `PAYMENT-SIGNATURE` header travel on the same request. In XMTP, the `request` field bundles structured data with the payment in a single message, ensuring atomic delivery.

## Routing and Pricing

In HTTP, the URL path implicitly routes requests to resources with pre-configured pricing. In XMTP, there are no URL paths: the Resource Agent receives freeform messages and decides at the application level which capability to invoke and whether payment is required.

Agents MAY use any strategy for this routing decision, including but not limited to:
- Fixed command matching (e.g. `/weather`, `analyze AAPL`)
- LLM-based intent classification
- Conversation-history-aware logic (e.g. freemium models with N free messages)

Because the payment-required response is issued per-message by agent logic, the `PaymentRequired` response MAY vary per request -- different amounts, assets, or schemes depending on the inferred complexity or capability. This enables dynamic pricing that adapts to message content, unlike the typically static per-route pricing in HTTP.

## Group Chat Considerations

When a group chat member requests a paid service, the Resource Agent SHOULD initiate the x402 payment flow in a DM with that member rather than in the group. This keeps the payment flow identical to the 1:1 case and avoids exposing payment details to other group members.

## Error Handling

The XMTP transport maps x402 errors to content type messages rather than status codes:

| x402 Error | XMTP Behavior |
| --- | --- |
| Payment Required | Send `x402/payment-required` message |
| Invalid Payment | Send `x402/settlement-response` with `success: false` and `errorReason` |
| Payment Failed | Send `x402/settlement-response` with `success: false` and `errorReason` |
| Server Error | Send text message describing the error |
| Success | Send `x402/settlement-response` with `success: true`, then the service response |

The `errorReason` values defined in core spec Section 9 apply unchanged.

There is currently no structured content type for a Client to reject payment requirements. If a Client cannot or does not wish to pay, it SHOULD send a plain text message indicating rejection. A future version of this specification may introduce an `x402/payment-rejected` content type for this purpose.

## Security Considerations

### End-to-End Encryption

XMTP messages are encrypted using MLS (Messaging Layer Security, RFC 9420). Payment payloads containing signed authorizations are encrypted in transit and at rest within the XMTP network. Only conversation participants can read payment details.

### Identity Binding

XMTP identities are associated with wallet addresses. Clients and Resource Agents MAY use different addresses for messaging and payments.

### Replay Prevention

The core x402 replay protections apply as specified. XMTP message-level deduplication MAY be used as an optimization to avoid redundant facilitator calls.

### Consent

XMTP's consent model applies. Users must consent to conversations with Resource Agents before any x402 messages can be exchanged. This prevents unsolicited payment requests from unknown agents. Resource Agents SHOULD accept all incoming conversations by default.

## Discovery

Resource Agents MAY advertise their x402 capabilities through a greeting message sent at conversation start and/or the Bazaar discovery API (core spec Section 8).


## References

- [Core x402 Specification v2](../x402-specification-v2.md)
- [x402 HTTP Transport](./http.md)
- [XMTP Documentation](https://docs.xmtp.org)
- [XMTP Content Types (XIP-5)](https://github.com/xmtp/XIPs/blob/main/XIPs/xip-5-message-content-types.md)
- [XMTP Agent SDK](https://www.npmjs.com/package/@xmtp/agent-sdk)

---

## Version History

| Version | Date | Changes | Author |
| --- | --- | --- | --- |
| v1.0 | 2026-03-07 | Initial draft | @phdargen |
