/** Extension key for the voucher-gateway batch-settlement extension. */
export const VOUCHER_GATEWAY = "voucher-gateway" as const;

/** EIP-712 domain fields for the x402BatchSettlementGateway contract. */
export const GATEWAY_DOMAIN = {
  name: "x402 Batch Settlement Gateway",
  version: "1",
} as const;

/** EIP-712 type definition for GatewayConfig. */
export const gatewayConfigTypes = {
  GatewayConfig: [
    { name: "channelId", type: "bytes32" },
    { name: "receiver", type: "address" },
    { name: "receiverAuthorizer", type: "address" },
  ],
} as const;

/** EIP-712 type definition for GatewayVoucher. */
export const gatewayVoucherTypes = {
  GatewayVoucher: [
    { name: "gatewayId", type: "bytes32" },
    { name: "maxClaimableAmount", type: "uint128" },
  ],
} as const;

/** EIP-712 type definition for GatewayClaimAuthorization. */
export const gatewayClaimAuthorizationTypes = {
  GatewayClaimAuthorization: [
    { name: "gatewayVoucherDigest", type: "bytes32" },
    { name: "totalClaimed", type: "uint128" },
  ],
} as const;
