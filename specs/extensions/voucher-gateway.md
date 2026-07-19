# Extension: `voucher-gateway`

## Summary

The `voucher-gateway` extension layers facilitator-managed voucher storage on the EVM `[batch-settlement](../schemes/batch-settlement/scheme_batch_settlement_evm.md)` scheme. The client funds one shared channel whose onchain `receiver` and `receiverAuthorizer` are a facilitator-deployed **gateway contract**. Wire-level `payTo` and `extra.receiverAuthorizer` remain the server's payout address and actual-charge authority. The extension does not modify `[x402BatchSettlement](../../contracts/evm/src/x402BatchSettlement.sol)`; it adds `[x402BatchSettlementGateway](../../contracts/evm/src/x402BatchSettlementGateway.sol)` (one deployment per facilitator).

`payload.type` values stay those of the base scheme (`deposit`, `voucher`, `settle`). Gateway-specific fields live under `extensions["voucher-gateway"]`. Base-scheme fields keep their usual shape under `extra` / `accepts[].extra`.

---



## Design goals

1. **Simpler server setup.** The server stores no per-channel voucher state and runs no async claim/settle. The facilitator owns all channel state and orchestrates redemption. Request handling is as simple as the `exact` scheme: present a 402, proxy payment to the facilitator, serve the resource, authorize the actual charge, optionally withdraw accrued funds.
2. **Shared client deposit across many servers.** Without a gateway, each `(client, server)` pair needs its own channel. With a gateway, one client deposit serves every server behind that facilitator, so the number of channels scales as `#clients × #facilitators` instead of `#clients × #servers`, reducing onchain deposit transactions.
3. **Non-breaking and optional.** No changes to `x402BatchSettlement`. Servers and clients that do not advertise or implement `voucher-gateway` continue to use vanilla batch-settlement.

The facilitator does the heavy lifting (storage, `/verify`/`/settle`, periodic onchain redemption) but cannot redirect funds or alter accounting. The additional risk is facilitator state loss: recovery falls back to the last onchain snapshot and forfeits unredeemed server revenue.

---



## Mental model: two nested channels

Gateway mode nests two unidirectional payment channels that share the client's voucher-signing identity:


|                      | Channel 1 (base `x402BatchSettlement`) | Channel 2 (gateway)                         |
| -------------------- | -------------------------------------- | ------------------------------------------- |
| Direction            | client → gateway                       | gateway → server                            |
| `payer`              | client                                 | gateway                                     |
| `payerAuthorizer`    | client voucher signer                  | client voucher signer (same identity)       |
| `receiver`           | gateway                                | server (`payTo`)                            |
| `receiverAuthorizer` | gateway                                | server hot wallet (or delegated authorizer) |


**Channel 1** uses the base `ChannelConfig` / `Voucher`. On deposit or top-up the client signs an aggregate voucher with `maxClaimableAmount` equal to the post-deposit channel balance (typically the full escrow). That signature is echoed on later `voucher` requests and reused at redemption.

**Channel 2** binds each server via a client-signed `GatewayConfig(channelId, receiver, receiverAuthorizer)` whose hash is `gatewayId`, and a per-request `GatewayVoucher(gatewayId, maxClaimableAmount)` ceiling. The server (or its delegated authorizer) signs a `GatewayClaimAuthorization` for the actual cumulative charged.

Onchain, channel-1 `receiver` and `receiverAuthorizer` are both the gateway, so neither server address enters `ChannelConfig` and one deposit funds many servers. The wire `payTo` and `extra.receiverAuthorizer` enter `GatewayConfig` instead.

**Claim amount is derived, not chosen.** `claimAndDistribute` sets channel-1 `totalClaimed` to the sum of included server deltas. A full-balance aggregate voucher therefore does **not** drain escrow: the gateway claims only what client `GatewayVoucher`s and matching `GatewayClaimAuthorization`s authorize, and `x402BatchSettlement` still enforces `totalClaimed <= maxClaimableAmount <= balance`.

---



## Facilitator trust model

- **Cannot redirect funds or overcharge.** Recipients and ceilings come from client-signed `GatewayConfig` / `GatewayVoucher`. Actuals come from `receiverAuthorizer`-signed `GatewayClaimAuthorization` with `totalClaimed <= GatewayVoucher.maxClaimableAmount`. Without those signatures the facilitator cannot move value to a different address or inflate a charge.
- **Cannot call base** `claim` **or** `settle` **on gateway channels.** Both onchain channel-1 roles are the gateway contract. The only redemption path is `claimAndDistribute`, which atomically runs `x402BatchSettlement.claim` (derived voucher-1 amount) + `settle` (lump into the gateway) + per-server credit from voucher-2 authorizations. Completed accounting requires `distributedByChannel[channelId] == x402BatchSettlement.totalClaimed[channelId]`.
- **State-loss risk for servers.** Between onchain redemptions, committed charges live in facilitator storage. If that state is lost without the signed proofs, recovery uses onchain `distributedCumulative` / `totalClaimed` and forfeits undistributed revenue. A fully stateless server accepts this trade-off; servers needing stronger availability SHOULD retain their latest signed `claimAuthorization`.

Funds move `x402BatchSettlement` → gateway → server. No facilitator-controlled account has custody.

---



## Gateway contract

Reference: `[x402BatchSettlementGateway.sol](../../contracts/evm/src/x402BatchSettlementGateway.sol)`. One deployment per facilitator; `SETTLEMENT()` MUST be the canonical `x402BatchSettlement` for the chain.

EIP-712 domain:

```javascript
{
  name: "x402 Batch Settlement Gateway",
  version: "1",
  chainId: <evm chain id>,
  verifyingContract: <gateway address>
}
```

```solidity
// gatewayId = EIP712Hash(GatewayConfig)
keccak256("GatewayConfig(bytes32 channelId,address receiver,address receiverAuthorizer)")

// Signed message references gatewayId, mirroring base Voucher → channelId
keccak256("GatewayVoucher(bytes32 gatewayId,uint128 maxClaimableAmount)")

keccak256("GatewayClaimAuthorization(bytes32 gatewayVoucherDigest,uint128 totalClaimed)")
```

`GatewayConfig.receiver` is wire `payTo`. `GatewayConfig.receiverAuthorizer` is wire `extra.receiverAuthorizer`. The `GatewayVoucher` is signed by the same payer authorization identity as the channel-1 voucher. `GatewayClaimAuthorization` binds the exact gateway-voucher digest so an actual cannot be paired with a different ceiling or receiver.

Key operations:

- `claimAndDistribute(distributions)` — For each channel, verify per-server `GatewayVoucher` + `GatewayClaimAuthorization` rows, derive channel-1 `totalClaimed` as prior distributed sum plus nonzero deltas, call base `claim` then `settle` into the gateway, credit `withdrawable[receiver][token]`. Atomic: any failure reverts the batch. The same deposit-signed aggregate voucher MAY be reused across calls (including subsets of servers) while `newTotalClaimed <= voucher.maxClaimableAmount`.
- `withdraw(receiver, token)` — Permissionless transfer of `withdrawable[receiver][token]` to `receiver`. The caller cannot redirect funds.

---



## Channel configuration


| `ChannelConfig` field | Value in gateway mode                                                                   |
| --------------------- | --------------------------------------------------------------------------------------- |
| `payer`               | Client wallet                                                                           |
| `payerAuthorizer`     | Client voucher-signing EOA, or `address(0)` for EIP-1271 via `payer`                    |
| `receiver`            | Gateway address from `extensions["voucher-gateway"].info.gateway`                       |
| `receiverAuthorizer`  | Same gateway address                                                                    |
| `token`               | ERC-20 payment token                                                                    |
| `withdrawDelay`       | Facilitator policy from `/supported`, copied into `extra.withdrawDelay`                 |
| `salt`                | Client-chosen; reused for the client's shared `(gateway, token, withdrawDelay)` channel |


---



## 402 Response (`PaymentRequired`)

`accepts[]` uses `scheme: "batch-settlement"` with normal wire semantics: `payTo` is the server payout address and `extra.receiverAuthorizer` controls the actual charge. Gateway mode is activated by the `voucher-gateway` extension. Clients MUST map `info.gateway` → onchain `ChannelConfig.receiver` and `receiverAuthorizer`, and map `payTo` / `extra.receiverAuthorizer` → `GatewayConfig`.

```json
{
  "x402Version": 2,
  "resource": {
    "url": "https://api.example.com/premium-data",
    "description": "Access to premium market data",
    "mimeType": "application/json"
  },
  "accepts": [
    {
      "scheme": "batch-settlement",
      "network": "eip155:8453",
      "amount": "1000",
      "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "payTo": "0xServerPayoutAddress",
      "maxTimeoutSeconds": 3600,
      "extra": {
        "receiverAuthorizer": "0xServerHotWalletOrDelegatedFacilitatorAddress",
        "withdrawDelay": 900,
        "name": "USDC",
        "version": "2"
      }
    }
  ],
  "extensions": {
    "voucher-gateway": {
      "info": {
        "gateway": "0xGatewayContractAddress"
      },
      "schema": {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "properties": {
          "gateway": { "type": "string" },
          "gatewayConfig": {
            "type": "object",
            "properties": {
              "channelId": { "type": "string" },
              "receiver": { "type": "string" },
              "receiverAuthorizer": { "type": "string" }
            },
            "required": ["channelId", "receiver", "receiverAuthorizer"]
          },
          "gatewayVoucher": {
            "type": "object",
            "properties": {
              "gatewayId": { "type": "string" },
              "maxClaimableAmount": { "type": "string" },
              "signature": { "type": "string" }
            },
            "required": ["gatewayId", "maxClaimableAmount", "signature"]
          },
          "claimAuthorization": {
            "type": "object",
            "properties": {
              "totalClaimed": { "type": "string" },
              "signature": { "type": "string" }
            },
            "required": ["totalClaimed", "signature"]
          }
        },
        "required": ["gateway"]
      }
    }
  }
}
```


| Field          | Type     | Required | Description                                                                                           |
| -------------- | -------- | -------- | ----------------------------------------------------------------------------------------------------- |
| `info.gateway` | `string` | yes      | Gateway contract address used as both `ChannelConfig.receiver` and `ChannelConfig.receiverAuthorizer` |


A client that omits the extension envelope against a gateway channel MUST be rejected before any deposit is processed.

---



## Client: payment construction

Payloads reuse base `deposit` / `voucher` shapes. Gateway mode is signaled by appending `gatewayConfig` and `gatewayVoucher` under `extensions["voucher-gateway"].info` (echoing server-provided `info.gateway`).

### Signing cadence


| Payload                    | Fresh client signatures                      | Aggregate `payload.voucher`                                                               |
| -------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `deposit` (open or top-up) | Aggregate `Voucher` **and** `GatewayVoucher` | Newly signed; `maxClaimableAmount` MUST equal channel `balance` after the deposit         |
| `voucher` (steady state)   | `GatewayVoucher` **only**                    | Echo of the last deposit-signed aggregate; MUST NOT raise or replace it without a deposit |


For a request of maximum price `amount` to server `S`:

```
gatewayId = getGatewayId({channelId, receiver: payTo, receiverAuthorizer: extra.receiverAuthorizer})
GatewayVoucher.maxClaimableAmount = serverChargedCumulative[S] + amount
```

`serverChargedCumulative[S]` comes from the last verified `GatewayClaimAuthorization` for that server (or onchain `distributedCumulative` after recovery).

### Deposit payload

```json
{
  "x402Version": 2,
  "accepted": { "...": "..." },
  "payload": {
    "type": "deposit",
    "channelConfig": {
      "payer": "0xClientAddress",
      "payerAuthorizer": "0xClientPayerAuthorizerEOA",
      "receiver": "0xGatewayContractAddress",
      "receiverAuthorizer": "0xGatewayContractAddress",
      "token": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "withdrawDelay": 900,
      "salt": "0x0000000000000000000000000000000000000000000000000000000000000000"
    },
    "voucher": {
      "channelId": "0xabc123...channelId",
      "maxClaimableAmount": "100000",
      "signature": "0x...EIP-712 aggregate voucher signature"
    },
    "deposit": {
      "amount": "100000",
      "authorization": {
        "erc3009Authorization": {
          "validAfter": "0",
          "validBefore": "1770000000",
          "salt": "0x...authorization salt",
          "signature": "0x...ERC-3009 signature"
        }
      }
    }
  },
  "extensions": {
    "voucher-gateway": {
      "info": {
        "gateway": "0xGatewayContractAddress",
        "gatewayConfig": {
          "channelId": "0xabc123...channelId",
          "receiver": "0xServerPayoutAddress",
          "receiverAuthorizer": "0xServerHotWalletOrDelegatedFacilitatorAddress"
        },
        "gatewayVoucher": {
          "gatewayId": "0x...GatewayConfig digest",
          "maxClaimableAmount": "1000",
          "signature": "0x...EIP-712 GatewayVoucher signature"
        }
      }
    }
  }
}
```



### Voucher payload

Steady-state requests freshly sign only the `GatewayVoucher`. The aggregate `payload.voucher` echoes the last deposit-signed voucher:

```json
{
  "x402Version": 2,
  "accepted": { "...": "..." },
  "payload": {
    "type": "voucher",
    "channelConfig": {
      "payer": "0xClientAddress",
      "payerAuthorizer": "0xClientPayerAuthorizerEOA",
      "receiver": "0xGatewayContractAddress",
      "receiverAuthorizer": "0xGatewayContractAddress",
      "token": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "withdrawDelay": 900,
      "salt": "0x0000000000000000000000000000000000000000000000000000000000000000"
    },
    "voucher": {
      "channelId": "0xabc123...channelId",
      "maxClaimableAmount": "100000",
      "signature": "0x...EIP-712 aggregate voucher signature from last deposit"
    }
  },
  "extensions": {
    "voucher-gateway": {
      "info": {
        "gateway": "0xGatewayContractAddress",
        "gatewayConfig": {
          "channelId": "0xabc123...channelId",
          "receiver": "0xServerPayoutAddress",
          "receiverAuthorizer": "0xServerHotWalletOrDelegatedFacilitatorAddress"
        },
        "gatewayVoucher": {
          "gatewayId": "0x...GatewayConfig digest",
          "maxClaimableAmount": "2000",
          "signature": "0x...EIP-712 GatewayVoucher signature"
        }
      }
    }
  }
}
```

---



## Flow: vanilla vs gateway



### Vanilla batch-settlement

- **Verify:** Server verifies the voucher locally and periodically calls facilitator `/verify` to sync onchain state.
- **Settle:** Server calls facilitator `/settle` asynchronously with `claim` / `settle` payloads when it chooses to redeem onchain.

The server owns per-channel voucher state and schedules redemption.

### Batch-settlement gateway

- **Verify:** Server always calls facilitator `/verify`. The facilitator verifies vouchers (aggregate + per-server) and reserves channel/server capacity.
- **Settle:** Server calls facilitator `/settle` synchronously on every paid request with the actual amount `<=` the request `amount`. The facilitator updates offchain storage only — no funds move on the request path.
- **Redeem:** The facilitator calls `claimAndDistribute` asynchronously and independently of the server (e.g. on a schedule, when pending credit exceeds a threshold, and/or before a server withdraw). Servers do not submit `claim` payloads.

Per request:

1. Server proxies the `deposit` or `voucher` payload (+ extension) to `/verify`.
2. On success, server serves the resource and determines `actualPrice <= amount`.
3. Server signs `GatewayClaimAuthorization` with `totalClaimed = (gatewayVoucher.maxClaimableAmount - amount) + actualPrice` (or authenticates a delegated facilitator authorizer to sign the same message).
4. Server calls `/settle` with the same payload plus `claimAuthorization` in the extension. Facilitator stores the commitment.
5. Server returns `PAYMENT-RESPONSE` with the facilitator's settle result (including the claim-authorization proof). The client MUST verify that proof before adopting the new cumulative.

Unlike the base scheme, a `voucher`-typed request MUST call `/settle` every time: it is how the stateless server reports success and the actual charge.

---



## Facilitator interface

Standard endpoints only: `/verify`, `/settle`, `/supported`.

### POST /verify

Validates a `deposit` or `voucher` payload with `gatewayConfig` / `gatewayVoucher`. Response `extra` is the base onchain channel snapshot. Gateway-only fields are under the extension:

```json
{
  "isValid": true,
  "payer": "0xClientAddress",
  "extra": {
    "channelId": "0xabc123...",
    "balance": "1000000",
    "totalClaimed": "500000",
    "withdrawRequestedAt": 0,
    "refundNonce": "0"
  },
  "extensions": {
    "voucher-gateway": {
      "info": {
        "gateway": "0xGatewayContractAddress",
        "aggregateChargedCumulativeAmount": "500200",
        "gatewayState": {
          "gatewayId": "0x...GatewayConfig digest",
          "distributedCumulative": "1500"
        }
      }
    }
  }
}
```



### POST /settle


| `payload.type` | When                             | Facilitator action                                                                             |
| -------------- | -------------------------------- | ---------------------------------------------------------------------------------------------- |
| `deposit`      | First request or top-up          | Execute onchain deposit; store new aggregate voucher + per-server commitment                   |
| `voucher`      | Every voucher-authorized request | Store per-server commitment; no onchain action. MUST NOT be skipped                            |
| `settle`       | Server payout                    | Ensure recent `claimAndDistribute` for that server if needed, then `withdraw(receiver, token)` |
| `claim`        | Not used                         | Redemption is internal via `claimAndDistribute`                                                |


**Committing the actual (**`deposit` **/** `voucher`**).** Same payload as `/verify`, plus:

```json
"claimAuthorization": {
  "totalClaimed": "1700",
  "signature": "0x...receiverAuthorizer signature"
}
```

`gatewayVoucherDigest` is omitted on the wire; both sides derive it from the request's `gatewayVoucher`. When `extra.receiverAuthorizer` is a facilitator address, the facilitator MUST authenticate the server before signing. Response `extra` matches the base voucher-only payment response (`transaction` and top-level `amount` are `""`). Extension `gatewayState` MUST include the new `claimAuthorization` proof:

```json
{
  "success": true,
  "transaction": "",
  "network": "eip155:8453",
  "payer": "0xClientAddress",
  "amount": "",
  "extra": {
    "chargedAmount": "700",
    "channelState": {
      "channelId": "0xabc123...",
      "balance": "1000000",
      "totalClaimed": "500000",
      "withdrawRequestedAt": 0,
      "refundNonce": "0",
      "chargedCumulativeAmount": "500900"
    }
  },
  "extensions": {
    "voucher-gateway": {
      "info": {
        "gateway": "0xGatewayContractAddress",
        "gatewayState": {
          "gatewayId": "0x...GatewayConfig digest",
          "distributedCumulative": "1500",
          "claimAuthorization": {
            "totalClaimed": "1700",
            "signature": "0x...receiverAuthorizer signature"
          }
        }
      }
    }
  }
}
```

The server copies this response into the client-facing `PAYMENT-RESPONSE`.

**Server withdraw (**`settle`**).** Because channel-1 `receiver` is the gateway, a bare base settle would leave funds in the gateway. The extension names the payout target:

```json
{
  "type": "settle",
  "receiver": "0xGatewayContractAddress",
  "token": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  "extensions": {
    "voucher-gateway": {
      "info": {
        "gateway": "0xGatewayContractAddress",
        "receiver": "0xServerPayoutAddress"
      }
    }
  }
}
```

The facilitator calls `withdraw` for that receiver. Response `amount` is the transferred amount (`"0"` if no-op). Reject a missing `info.receiver` with `invalid_voucher_gateway_settle_target_missing`.

### Async redemption jobs

Independently of the request path, the facilitator SHOULD run `claimAndDistribute` on a schedule, when aggregate pending credit exceeds a threshold, and before honoring a server `settle` withdraw when the server has uncredited commitments. Each call reuses the stored deposit-signed aggregate voucher plus selected per-server claims. Batch sizing is an operational choice; failed simulations MUST NOT leave partial offchain credits applied onchain.

### GET /supported

```json
{
  "kinds": [
    {
      "x402Version": 2,
      "scheme": "batch-settlement",
      "network": "eip155:8453",
      "extra": {
        "gateway": "0xGatewayContractAddress",
        "withdrawDelay": 900
      }
    }
  ],
  "extensions": ["voucher-gateway"],
  "signers": {
    "eip155:*": ["0xFacilitatorAuthorizerAddress"]
  }
}
```

Participating servers MUST copy `gateway` and `withdrawDelay` into their 402. `signers` lists addresses available for delegated `receiverAuthorizer`.

### Verification rules

Retain base `batch-settlement` [EVM rules](../schemes/batch-settlement/scheme_batch_settlement_evm.md) except the direct receiver / receiver-authorizer match mappings, which this extension replaces. A facilitator MUST enforce:

1. **Gateway extension required.** Reject `deposit`/`voucher` against a gateway channel lacking well-formed `gatewayConfig` and `gatewayVoucher` (`invalid_voucher_gateway_voucher_payload`).
2. **Gateway policy.** `info.gateway`, `ChannelConfig.receiver`, and `ChannelConfig.receiverAuthorizer` MUST equal a gateway operated by this facilitator; `withdrawDelay` MUST match `/supported`. Reject address or policy mismatch before deposit.
3. **Receiver match.** `gatewayConfig.receiver` MUST equal `accepts[].payTo` (`invalid_voucher_gateway_receiver_mismatch`).
4. **Wire receiver-authorizer match.** `gatewayConfig.receiverAuthorizer` MUST equal `accepts[].extra.receiverAuthorizer` (`invalid_voucher_gateway_receiver_authorizer_mismatch`).
5. **Config / voucher binding.** `gatewayConfig.channelId == getChannelId(ChannelConfig)` and `gatewayVoucher.gatewayId == getGatewayId(gatewayConfig)`.
6. **Gateway voucher signature.** Verify the gateway-domain digest against the configured client authorization identity (same as the aggregate voucher).
7. **Per-server cumulative.** `gatewayVoucher.maxClaimableAmount == storedServerChargedCumulative + paymentRequirements.amount`. On mismatch, return a corrective 402 (`invalid_voucher_gateway_cumulative_mismatch`). Do **not** require the aggregate ceiling to equal `storedAggregate + amount`.
8. **Aggregate cadence.** On `deposit`: verify aggregate signature; require `maxClaimableAmount` equal to post-deposit balance; store for redemption and echo checks. On `voucher`: require `payload.voucher` equal to the stored deposit-signed aggregate (`invalid_voucher_gateway_aggregate_mismatch` otherwise).
9. **Per-server monotonicity.** `gatewayVoucher.maxClaimableAmount` MUST be greater than `distributedCumulative(channelId, receiver)`.
10. **Exclusive claim path.** Require `x402BatchSettlement.totalClaimed == gateway.distributedByChannel`. Reject drift (`invalid_voucher_gateway_accounting_mismatch`); MUST NOT attempt a direct base claim for a gateway channel.
11. **Settlement authorization.** On `/settle`, require `actualPrice <= amount`, `totalClaimed == (gatewayVoucher.maxClaimableAmount - amount) + actualPrice`, and a valid `GatewayClaimAuthorization` signature from `gatewayConfig.receiverAuthorizer`.
12. **Mandatory commit.** MUST NOT charge or return a successful payment response for a `voucher` request without a corresponding `/settle` carrying a valid `claimAuthorization`.
13. **Settle target.** A `settle`-typed call MUST carry `extensions["voucher-gateway"].info.receiver`.

Serialize request processing per `(channel, receiver)` when updating server cumulatives, and per channel when updating the aggregate charged sum.

### Client response verification

Before using a payment response as the next baseline, the client MUST:

1. Recompute the submitted `GatewayVoucher` digest and verify the returned `claimAuthorization` signature against the `receiverAuthorizer` bound in `GatewayConfig`.
2. Require `totalClaimed <= GatewayVoucher.maxClaimableAmount`.
3. Require `totalClaimed - previousServerChargedCumulative == chargedAmount <= paymentRequirements.amount`.
4. Require the returned aggregate charged cumulative to equal previous aggregate + `chargedAmount`.

If any check fails, the client MUST NOT sign another voucher from that response.

### State recovery

Onchain baselines: per-server `gateway.distributedCumulative(channelId, receiver)`; aggregate `gateway.distributedByChannel(channelId)` which MUST equal base `totalClaimed`. Offchain actuals are trusted only with valid signatures. Without proofs, set baselines to onchain values and forfeit undistributed charges. Without a stored aggregate voucher signature, redemption cannot proceed until the client submits a new `deposit`.

A stale per-server cumulative yields a corrective 402 with base `channelState` / `voucherState` under `accepts[].extra` and per-server snapshot under the extension:

```json
{
  "x402Version": 2,
  "error": "invalid_voucher_gateway_cumulative_mismatch",
  "accepts": [
    {
      "scheme": "batch-settlement",
      "network": "eip155:8453",
      "amount": "1000",
      "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "payTo": "0xServerPayoutAddress",
      "maxTimeoutSeconds": 3600,
      "extra": {
        "receiverAuthorizer": "0xServerHotWalletOrDelegatedFacilitatorAddress",
        "withdrawDelay": 900,
        "name": "USDC",
        "version": "2",
        "channelState": {
          "channelId": "0xabc123...channelId",
          "balance": "1000000",
          "totalClaimed": "500000",
          "withdrawRequestedAt": 0,
          "refundNonce": "0",
          "chargedCumulativeAmount": "500200"
        },
        "voucherState": {
          "signedMaxClaimable": "100000",
          "signature": "0x...last deposit-signed aggregate voucher signature"
        }
      }
    }
  ],
  "extensions": {
    "voucher-gateway": {
      "info": {
        "gateway": "0xGatewayContractAddress",
        "gatewayState": {
          "gatewayId": "0x...GatewayConfig digest",
          "distributedCumulative": "1500",
          "voucherState": {
            "maxClaimableAmount": "2000",
            "signature": "0x...client signature"
          },
          "claimAuthorization": {
            "totalClaimed": "1700",
            "signature": "0x...receiverAuthorizer signature"
          }
        }
      }
    }
  }
}
```

The client MUST verify all signatures before re-synchronizing.

---



## Error codes

In addition to base `invalid_batch_settlement_evm_*` codes:


| Error code                                                      | Description                                                                                                   |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `invalid_voucher_gateway_address_mismatch`                      | `info.gateway`, `ChannelConfig.receiver`, and `ChannelConfig.receiverAuthorizer` are not all equal            |
| `invalid_voucher_gateway_unknown_gateway`                       | Gateway address is not operated by this facilitator                                                           |
| `invalid_voucher_gateway_receiver_mismatch`                     | `gatewayConfig.receiver` ≠ `payTo`                                                                            |
| `invalid_voucher_gateway_receiver_authorizer_mismatch`          | `gatewayConfig.receiverAuthorizer` ≠ wire `extra.receiverAuthorizer`                                          |
| `invalid_voucher_gateway_voucher_payload`                       | `gatewayConfig` or `gatewayVoucher` missing or malformed                                                      |
| `invalid_voucher_gateway_voucher_channel_mismatch`              | `gatewayConfig.channelId` or `gatewayVoucher.gatewayId` binding failed                                        |
| `invalid_voucher_gateway_voucher_signature`                     | `GatewayVoucher` signature invalid for client authorization identity                                          |
| `invalid_voucher_gateway_server_settlement_payload`             | Settlement missing, malformed, or not bound to the gateway voucher                                            |
| `invalid_voucher_gateway_claim_authorization_signature`         | `claimAuthorization` signature invalid for `gatewayConfig.receiverAuthorizer`                                 |
| `invalid_voucher_gateway_cumulative_mismatch`                   | Corrective 402: per-server ceiling ≠ tracked actual + `amount`                                                |
| `invalid_voucher_gateway_aggregate_mismatch`                    | Aggregate voucher does not match stored deposit-signed aggregate, or deposit aggregate ≠ post-deposit balance |
| `invalid_voucher_gateway_receiver_cumulative_below_distributed` | Ceiling not greater than onchain `distributedCumulative`                                                      |
| `invalid_voucher_gateway_accounting_mismatch`                   | Base `totalClaimed` ≠ gateway `distributedByChannel`                                                          |
| `invalid_voucher_gateway_distribute_simulation_failed`          | `claimAndDistribute` simulation failed                                                                        |
| `invalid_voucher_gateway_distribute_transaction_failed`         | Onchain `claimAndDistribute` failed                                                                           |
| `invalid_voucher_gateway_withdraw_transaction_failed`           | Onchain `withdraw` failed                                                                                     |
| `invalid_voucher_gateway_settle_target_missing`                 | `settle`-typed call missing `info.receiver`                                                                   |


---



## Version history


| Version | Date       | Changes       | Authors   |
| ------- | ---------- | ------------- | --------- |
| v0.1    | 2026-06-26 | Initial draft | @phdargen |


