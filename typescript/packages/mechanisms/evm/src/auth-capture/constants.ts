import { keccak256, toBytes } from "viem";

// Scheme identifier for the auth-capture payment scheme.
export const AUTH_CAPTURE_SCHEME = "auth-capture" as const;

// Canonical AuthCaptureEscrow + token collector deployments from
// base/commerce-payments (https://github.com/base/commerce-payments). These are
// the audited, live addresses listed in the upstream README and are the source
// of truth for this scheme. They are universal constants, not configurable per
// merchant.
export const AUTH_CAPTURE_ESCROW_ADDRESS =
  "0xBdEA0D1bcC5966192B070Fdf62aB4EF5b4420cff" as const satisfies `0x${string}`;
export const EIP3009_TOKEN_COLLECTOR_ADDRESS =
  "0x0E3dF9510de65469C4518D7843919c0b8C7A7757" as const satisfies `0x${string}`;
export const PERMIT2_TOKEN_COLLECTOR_ADDRESS =
  "0x992476B9Ee81d52a5BdA0622C333938D0Af0aB26" as const satisfies `0x${string}`;
export const OPERATOR_REFUND_COLLECTOR_ADDRESS =
  "0x934907bffd0901b6A21e398B9C53A4A38F02fa5d" as const satisfies `0x${string}`;

// Domain tag for the bound-salt derivation. Encoded as the first word of
// `abi.encode(SALT_BINDING_TYPEHASH, receiverAuthorizer, policy, saltNonce)`
// so a value produced as a salt commitment can never be read as a signature nonce.
export const SALT_BINDING_TYPEHASH = keccak256(
  toBytes(
    "x402AuthCaptureSaltBinding(address receiverAuthorizer,address policy,uint256 saltNonce)",
  ),
);

// Shared EIP-712 domain for every operator type. `verifyingContract` is the
// capture authorizer (PaymentInfo.operator), not a scheme-wide address.
export const OPERATOR_EIP712_DOMAIN = {
  name: "x402 Auth Capture Operator",
  version: "1",
} as const;

// ERC-3009 ReceiveWithAuthorization EIP-712 types
export const RECEIVE_AUTHORIZATION_TYPES = {
  ReceiveWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

// Uniswap Permit2 PermitTransferFrom EIP-712 types
export const PERMIT2_TRANSFER_FROM_TYPES = {
  PermitTransferFrom: [
    { name: "permitted", type: "TokenPermissions" },
    { name: "spender", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
  TokenPermissions: [
    { name: "token", type: "address" },
    { name: "amount", type: "uint256" },
  ],
} as const;

// Operator EIP-712 types for facilitator-relayed charge and lifecycle.
export const CHARGE_TYPES = {
  Charge: [
    { name: "paymentInfoHash", type: "bytes32" },
    { name: "amount", type: "uint256" },
    { name: "tokenCollector", type: "address" },
    { name: "collectorDataHash", type: "bytes32" },
    { name: "feeBps", type: "uint16" },
    { name: "feeReceiver", type: "address" },
  ],
} as const;

export const VOID_TYPES = {
  Void: [{ name: "paymentInfoHash", type: "bytes32" }],
} as const;

export const CAPTURE_TYPES = {
  Capture: [
    { name: "paymentInfoHash", type: "bytes32" },
    { name: "amount", type: "uint256" },
    { name: "feeBps", type: "uint16" },
    { name: "feeReceiver", type: "address" },
    { name: "expectedCapturableAmount", type: "uint256" },
    { name: "expectedRefundableAmount", type: "uint256" },
  ],
} as const;

export const REFUND_TYPES = {
  Refund: [
    { name: "paymentInfoHash", type: "bytes32" },
    { name: "amount", type: "uint256" },
    { name: "tokenCollector", type: "address" },
    { name: "expectedCapturableAmount", type: "uint256" },
    { name: "expectedRefundableAmount", type: "uint256" },
  ],
} as const;
