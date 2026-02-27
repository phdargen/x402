# Extension: `builder-code`

## Summary

The `builder-code` extension enables onchain transaction attribution via
[ERC-8021](https://eip.tools/eip/8021). Resource servers declare a builder code
per network, choosing either the chain's canonical Code Registry (schema 0) or
an explicit registry contract (schema 1). Facilitators
MAY append their own code when they share the same registry context, and MAY
independently append their own code even when the server does not declare the
extension. During settlement, codes are comma-joined and appended as an ERC-8021
data suffix to the calldata. Smart contracts ignore the extra bytes; offchain
indexers parse them for attribution.

---

## `PaymentRequired`

Server declares per-network builder codes in `extensions["builder-code"].info`.
When `registry` is omitted the chain's canonical Code Registry is assumed
(schema 0). When `registry` is present, the suffix is encoded with an explicit
registry reference (schema 1). The registry MAY live on a different chain than
the settlement transaction, enabling multi-chain apps to maintain a single
registry deployment:

```json
{
  "x402Version": 2,
  "error": "PAYMENT-SIGNATURE header is required",
  "resource": {
    "url": "https://api.example.com/premium-data",
    "description": "Access to premium market data",
    "mimeType": "application/json"
  },
  "accepts": [
    {
      "scheme": "exact",
      "network": "eip155:8453",
      "amount": "10000",
      "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "payTo": "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
      "maxTimeoutSeconds": 60,
      "extra": {
        "name": "USDC",
        "version": "2"
      }
    },
    {
      "scheme": "exact",
      "network": "eip155:1",
      "amount": "10000",
      "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "payTo": "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
      "maxTimeoutSeconds": 60,
      "extra": {
        "name": "USDC",
        "version": "2"
      }
    },
    {
      "scheme": "exact",
      "network": "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
      "amount": "10000",
      "asset": "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
      "payTo": "8SxqM9B2Z1f59m2H4Kj3pGQ6w2iF9vA7L4nP5rT6uY7x",
      "maxTimeoutSeconds": 60,
      "extra": {
        "feePayer": "EwWqGE4ZFKLofuestmU4LDdK7XM1N4ALgdZccwYugwGd"
      }
    }
  ],
  "extensions": {
    "builder-code": {
      "info": {
        "version": "1",
        "chains": {
          "eip155:8453": {
            "code": "my_base_app"
          },
          "eip155:1": {
            "code": "my_eth_app",
            "registry": {
              "address": "0xcccccccccccccccccccccccccccccccccccccccc",
              "chainId": "8453"
            }
          }
        }
      }
    }
  }
}
```

### Chain Entry Fields

| Field | Required | Description |
|-------|----------|-------------|
| `code` | Yes | ASCII attribution code (`[a-z0-9_]{1,32}`). |
| `registry` | No | Explicit Code Registry for ERC-8021 schema 1. When absent, schema 0 is used (chain's canonical Code Registry). |
| `registry.address` | If `registry` | Address of a contract implementing `ICodeRegistry` (ERC-8021). |
| `registry.chainId` | If `registry` | Numeric chain ID hosting the registry contract. MAY differ from the settlement chain. ERC-8021 schema 1 supports cross-chain registry references so that multi-chain apps can maintain a single registry on one chain and reference it from transactions on any other chain. |

### Schema Selection

The presence of `registry` determines how the suffix is encoded:

| Server declaration | Schema | Registry resolution |
|--------------------|--------|---------------------|
| No `registry` | **0** | Chain's canonical Code Registry (implicit) |
| `registry` present | **1** | Explicit registry contract. The registry MAY be on the settlement chain itself (e.g. a non-canonical registry) or on a different chain entirely, enabling multi-chain apps to maintain a single registry deployment and reference it from transactions on any chain. |

---

## `PaymentPayload`

Standard extension passthrough, where client echoes `builder-code` from `PaymentRequired` into `PaymentPayload.extensions`.

---

## Facilitator

The facilitator signals `"builder-code"` support in `/supported.extensions`. 

```json
{
  "kinds": [
    {
      "x402Version": 2,
      "scheme": "exact",
      "network": "eip155:84532"
    },
    {
      "x402Version": 2,
      "scheme": "exact",
      "network": "eip155:8453"
    }
  ],
  "extensions": ["builder-code"],
  "signers": {
    "eip155:*": ["0x1234567890abcdef1234567890abcdef12345678"],
    "solana:*": ["CKPKJWNdJEqa81x7CkZ14BVPiY6y16Sxs7owznqtWYp5"]
  }
}
```

Facilitator-owned builder codes are internal configuration, not exposed via
`/supported`. At settlement the facilitator MAY append its own code when it
shares the same registry context as the server's declaration for that network
(canonical registry for schema 0, or the same explicit registry for schema 1).

When the server does **not** declare `builder-code`, the facilitator MAY still
append its own code using whichever schema and registry it chooses. Because the
facilitator pays gas for settlement, this adds no cost to the server and does
not affect onchain execution. Servers should expect that a facilitator
advertising `"builder-code"` in `/supported.extensions` will append attribution
data to settlement transactions regardless of whether the server opts into the
extension.

---

## Settlement Behavior

During `settle()`, the mechanism:

1. Determines settlement `network` from `paymentPayload.accepted.network`
2. Reads the server's chain entry from
   `paymentPayload.extensions["builder-code"].info.chains[network]`
3. Determines the schema from the entry:
   - `registry` absent → schema 0 (canonical)
   - `registry` present → schema 1 (explicit)
4. Collects the server's `code`
5. If the facilitator has its own code for the same network **and** same
   registry context, appends it
6. Encodes the ERC-8021 suffix with the determined schema and appends to
   settlement calldata
7. If no chain entry exists for the settled network **but** the facilitator has
   its own code for that network, the facilitator MAY encode a suffix using
   whichever schema and registry it chooses (the facilitator pays gas, so this
   has no cost impact on the server)
8. If neither a server chain entry nor a facilitator code exists for the settled
   network, settlement proceeds unchanged (no attribution)

**ERC-4337 User Operations:** When settlement uses ERC-4337, the suffix MUST be
appended to `userOp.callData` rather than top-level transaction data, per
ERC-8021.

### ERC-8021 Suffix Encoding

**Schema 0** — canonical registry:

```
TX_CALLDATA + [codes_ascii] + [codes_length: 1B] + [0x00] + [marker: 16B]
```

**Schema 1** — explicit registry:

```
TX_CALLDATA + [codes_ascii] + [codes_length: 1B]
            + [registry_chain_id: variable] + [registry_chain_id_length: 1B]
            + [registry_address: 20B] + [0x01] + [marker: 16B]
```

| Field | Size | Description |
|-------|------|-------------|
| `codes_ascii` | variable | Comma-joined codes as 7-bit ASCII (e.g. `"my_app,facilitator"`) |
| `codes_length` | 1 byte | Length of `codes_ascii` (max 255) |
| `registry_chain_id` | variable | Chain ID hosting the registry (schema 1 only) |
| `registry_chain_id_length` | 1 byte | Length of `registry_chain_id` (schema 1 only) |
| `registry_address` | 20 bytes | Registry contract address (schema 1 only) |
| `schema_id` | 1 byte | `0x00` or `0x01` |
| `marker` | 16 bytes | `0x80218021802180218021802180218021` |

---

## Responsibilities

- **Resource server**: Declares one builder code per network (and optional
  explicit registry) in `PaymentRequired`. Servers should expect that a
  facilitator advertising `"builder-code"` support may append attribution data
  to settlement transactions even when the server does not declare the extension.
- **Client**: Echoes the extension through in `PaymentPayload`
- **Facilitator**: Announces extension support, appends its own code at
  settlement when sharing the same registry context, encodes the correct
  ERC-8021 schema. MAY independently append its own code when the server does
  not declare the extension.
