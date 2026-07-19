import type { BatchSettlementVoucherFields, ChannelConfig } from "../types";

/** Wire-level GatewayConfig under extensions["voucher-gateway"].info. */
export type GatewayConfig = {
  channelId: `0x${string}`;
  receiver: `0x${string}`;
  receiverAuthorizer: `0x${string}`;
};

/** Client-signed GatewayVoucher fields on the wire. */
export type GatewayVoucherFields = {
  gatewayId: `0x${string}`;
  maxClaimableAmount: string;
  signature: `0x${string}`;
};

/** Receiver-authorizer-signed claim authorization on the wire. */
export type GatewayClaimAuthorization = {
  totalClaimed: string;
  signature: `0x${string}`;
};

/** Facilitator /supported extensionInfo for voucher-gateway. */
export type VoucherGatewaySupportedInfo = {
  gateway: `0x${string}`;
  withdrawDelay: number;
};

/** PaymentRequired / payload extension info. */
export type VoucherGatewayExtensionInfo = {
  gateway: `0x${string}`;
  gatewayConfig?: GatewayConfig;
  gatewayVoucher?: GatewayVoucherFields;
  claimAuthorization?: GatewayClaimAuthorization;
  /** Server withdraw settle target (payload.type === "settle"). */
  receiver?: `0x${string}`;
  aggregateChargedCumulativeAmount?: string;
  gatewayState?: GatewayStateInfo;
};

export type GatewayStateInfo = {
  gatewayId: `0x${string}`;
  distributedCumulative: string;
  claimAuthorization?: GatewayClaimAuthorization;
  voucherState?: {
    maxClaimableAmount: string;
    signature: `0x${string}`;
  };
};

export type VoucherGatewayExtension = {
  info: VoucherGatewayExtensionInfo;
  schema?: Record<string, unknown>;
};

/** Stored aggregate voucher for redemption (deposit-signed). */
export type StoredAggregateVoucher = {
  channel: ChannelConfig;
  voucher: BatchSettlementVoucherFields;
};

/** Per-server commitment stored by the facilitator. */
export type StoredServerCommitment = {
  gatewayConfig: GatewayConfig;
  gatewayVoucher: GatewayVoucherFields;
  claimAuthorization: GatewayClaimAuthorization;
  chargedCumulativeAmount: string;
};

/** Onchain claimAndDistribute row shape (matches contract GatewayVoucherClaim). */
export type GatewayVoucherClaim = {
  voucher: {
    config: GatewayConfig;
    maxClaimableAmount: string;
  };
  gatewaySignature: `0x${string}`;
  claim: {
    gatewayVoucherDigest: `0x${string}`;
    totalClaimed: string;
  };
  receiverAuthorizerSignature: `0x${string}`;
};
