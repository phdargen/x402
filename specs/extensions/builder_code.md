# Extension: `builder-code`

## Summary

The `builder-code` extension enables onchain transaction attribution via [ERC-8021](https://eip.tools/eip/8021). Both resource servers and facilitators declare per-network builder codes. During settlement, all codes for the target network are collected and appended to the transaction calldata as an ERC-8021 suffix. Smart contracts ignore the extra bytes; offchain indexers parse them for attribution.

---

## `PaymentRequired`

Server declares per-network builder codes:

```json
{
  "extensions": {
    "builder-code": {
      "info": {
        "eip155:8453": "my-base-app",
        "eip155:84532": "my-base-sepolia-app"
      },
      "schema": {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "patternProperties": {
          "^eip155:[0-9]+$": {
            "type": "string",
            "minLength": 1,
            "maxLength": 64,
            "pattern": "^[a-zA-Z0-9_-]+$"
          }
        },
        "additionalProperties": false
      }
    }
  }
}
```

---

## `PaymentPayload`

Standard extension passthrough — client echoes `builder-code` from `PaymentRequired` into `PaymentPayload.extensions`.

---

## Facilitator

The facilitator registers `"builder-code"` in its `extensions` list. Per-network facilitator codes are stored internally and are **not** exposed in `/supported`.

---

## Settlement Behavior

During `settle()`, the mechanism:

1. Extracts the server's code from `payload.extensions["builder-code"].info[network]`
2. Extracts the facilitator's code from its internal extension config for `network`
3. If any codes exist, encodes the ERC-8021 suffix and appends to settlement calldata
4. If no codes exist for the settlement network, settlement proceeds unchanged

### ERC-8021 Suffix Encoding

```
TX_CALLDATA + [codes_ascii] + [codes_length: 1 byte] + [schema_id: 1 byte] + [8021_marker: 14 bytes]
```

| Field | Description |
|-------|-------------|
| `codes_ascii` | Comma-joined codes as ASCII bytes (e.g., `"my-app,my-facilitator"`) |
| `codes_length` | Length of `codes_ascii` as a single `uint8` byte |
| `schema_id` | `0x00` |
| `8021_marker` | 14-byte constant `0x80218021802180218021802180218021` |

---

## Responsibilities

- **Resource server**: Declares per-network builder codes in `PaymentRequired`
- **Client**: Echoes the extension through in `PaymentPayload`
- **Facilitator**: Stores its own per-network codes internally; combines them with the server's codes at settlement time
