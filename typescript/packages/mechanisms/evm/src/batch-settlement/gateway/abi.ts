const gatewayConfigComponents = [
  { name: "channelId", type: "bytes32" },
  { name: "receiver", type: "address" },
  { name: "receiverAuthorizer", type: "address" },
] as const;

const channelConfigComponents = [
  { name: "payer", type: "address" },
  { name: "payerAuthorizer", type: "address" },
  { name: "receiver", type: "address" },
  { name: "receiverAuthorizer", type: "address" },
  { name: "token", type: "address" },
  { name: "withdrawDelay", type: "uint40" },
  { name: "salt", type: "bytes32" },
] as const;

const gatewayVoucherClaimComponents = [
  {
    name: "voucher",
    type: "tuple",
    components: [
      {
        name: "config",
        type: "tuple",
        components: gatewayConfigComponents,
      },
      { name: "maxClaimableAmount", type: "uint128" },
    ],
  },
  { name: "gatewaySignature", type: "bytes" },
  {
    name: "claim",
    type: "tuple",
    components: [
      { name: "gatewayVoucherDigest", type: "bytes32" },
      { name: "totalClaimed", type: "uint128" },
    ],
  },
  { name: "receiverAuthorizerSignature", type: "bytes" },
] as const;

const channelDistributionComponents = [
  {
    name: "voucher",
    type: "tuple",
    components: [
      {
        name: "channel",
        type: "tuple",
        components: channelConfigComponents,
      },
      { name: "maxClaimableAmount", type: "uint128" },
    ],
  },
  { name: "signature", type: "bytes" },
  {
    name: "claims",
    type: "tuple[]",
    components: gatewayVoucherClaimComponents,
  },
] as const;

/** Minimal ABI for x402BatchSettlementGateway. */
export const batchSettlementGatewayABI = [
  {
    type: "function",
    name: "claimAndDistribute",
    inputs: [
      {
        name: "distributions",
        type: "tuple[]",
        components: channelDistributionComponents,
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "withdraw",
    inputs: [
      { name: "receiver", type: "address" },
      { name: "token", type: "address" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "distributedCumulative",
    inputs: [
      { name: "channelId", type: "bytes32" },
      { name: "receiver", type: "address" },
    ],
    outputs: [{ name: "", type: "uint128" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "distributedByChannel",
    inputs: [{ name: "channelId", type: "bytes32" }],
    outputs: [{ name: "", type: "uint128" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "withdrawable",
    inputs: [
      { name: "receiver", type: "address" },
      { name: "token", type: "address" },
    ],
    outputs: [{ name: "", type: "uint128" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "SETTLEMENT",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
] as const;
