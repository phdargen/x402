import type { TypedData } from "viem";

export interface AuthorizerSigner {
  address: `0x${string}`;
  signTypedData(params: {
    domain: Record<string, unknown>;
    types: TypedData;
    primaryType: string;
    message: Record<string, unknown>;
  }): Promise<`0x${string}`>;
}

export type ChannelState = {
  balance: bigint;
  totalClaimed: bigint;
  withdrawRequestedAt: number;
  refundNonce: bigint;
};

export type ChannelConfig = {
  payer: `0x${string}`;
  payerAuthorizer: `0x${string}`;
  receiver: `0x${string}`;
  receiverAuthorizer: `0x${string}`;
  token: `0x${string}`;
  withdrawDelay: number;
  salt: `0x${string}`;
};

export type BatchSettlementErc3009Authorization = {
  validAfter: string;
  validBefore: string;
  salt: `0x${string}`;
  signature: `0x${string}`;
};

export type BatchSettlementDepositPayload = {
  type: "deposit";
  deposit: {
    channelConfig: ChannelConfig;
    amount: string;
    authorization: {
      erc3009Authorization?: BatchSettlementErc3009Authorization;
    };
  };
  voucher: BatchSettlementVoucherFields;
};

export type BatchSettlementVoucherPayload = {
  type: "voucher";
  channelConfig: ChannelConfig;
} & BatchSettlementVoucherFields;

export type BatchSettlementVoucherFields = {
  channelId: `0x${string}`;
  maxClaimableAmount: string;
  signature: `0x${string}`;
  refund?: boolean;
  refundAmount?: string;
};

export type BatchSettlementVoucherClaim = {
  voucher: {
    channel: ChannelConfig;
    maxClaimableAmount: string;
  };
  signature: `0x${string}`;
  totalClaimed: string;
};

export type BatchSettlementPaymentRequirementsExtra = {
  receiverAuthorizer: `0x${string}`;
  withdrawDelay: number;
  name: string;
  version: string;
  assetTransferMethod?: "eip3009";
};

export type FileChannelStorageOptions = {
  /** Root directory; channels are stored under `{directory}/{client|server}/{channelId}.json`. */
  directory: string;
};

export type BatchSettlementPaymentResponseExtra = {
  channelId: `0x${string}`;
  chargedCumulativeAmount: string;
  balance: string;
  totalClaimed: string;
  withdrawRequestedAt: number;
  refundNonce: string;
  refund?: true;
  refundedAmount?: string;
};

export type BatchSettlementClaimWithSignaturePayload = {
  settleAction: "claimWithSignature";
  claims: BatchSettlementVoucherClaim[];
  claimAuthorizerSignature?: `0x${string}`;
};

export type BatchSettlementSettleActionPayload = {
  settleAction: "settle";
  receiver: `0x${string}`;
  token: `0x${string}`;
};

export type BatchSettlementRefundWithSignaturePayload = {
  settleAction: "refundWithSignature";
  config: ChannelConfig;
  amount: string;
  nonce: string;
  claims: BatchSettlementVoucherClaim[];
  refundAuthorizerSignature?: `0x${string}`;
  claimAuthorizerSignature?: `0x${string}`;
  responseExtra?: BatchSettlementPaymentResponseExtra;
};

export type BatchSettlementPayload = BatchSettlementDepositPayload | BatchSettlementVoucherPayload;

export type BatchSettlementSettlePayload =
  | BatchSettlementClaimWithSignaturePayload
  | BatchSettlementSettleActionPayload
  | BatchSettlementRefundWithSignaturePayload;

/**
 * Returns true when the value is a non-null object (a usable record).
 *
 * @param payload - Value of unknown shape.
 * @returns True if `payload` is an object that can be indexed by string keys.
 */
function isObject(payload: unknown): payload is Record<string, unknown> {
  return typeof payload === "object" && payload !== null;
}

/**
 * Type guard for {@link BatchSettlementDepositPayload}.
 *
 * @param payload - Unknown payload to check.
 * @returns True if `payload` is a deposit payload (carries `deposit` and `voucher`).
 */
export function isBatchSettlementDepositPayload(
  payload: unknown,
): payload is BatchSettlementDepositPayload {
  return (
    isObject(payload) && payload.type === "deposit" && "deposit" in payload && "voucher" in payload
  );
}

/**
 * Type guard for {@link BatchSettlementVoucherPayload}.
 *
 * @param payload - Unknown payload to check.
 * @returns True if `payload` is a voucher payload with channel and signature fields.
 */
export function isBatchSettlementVoucherPayload(
  payload: unknown,
): payload is BatchSettlementVoucherPayload {
  return (
    isObject(payload) &&
    payload.type === "voucher" &&
    "channelConfig" in payload &&
    "channelId" in payload &&
    "maxClaimableAmount" in payload &&
    "signature" in payload
  );
}

/**
 * Type guard for {@link BatchSettlementClaimWithSignaturePayload}.
 *
 * @param payload - Unknown payload to check.
 * @returns True if `payload` is a settle-action `claimWithSignature` payload.
 */
export function isBatchSettlementClaimWithSignaturePayload(
  payload: unknown,
): payload is BatchSettlementClaimWithSignaturePayload {
  return isObject(payload) && payload.settleAction === "claimWithSignature" && "claims" in payload;
}

/**
 * Type guard for {@link BatchSettlementSettleActionPayload}.
 *
 * @param payload - Unknown payload to check.
 * @returns True if `payload` is a settle-action `settle` payload.
 */
export function isBatchSettlementSettleActionPayload(
  payload: unknown,
): payload is BatchSettlementSettleActionPayload {
  return (
    isObject(payload) &&
    payload.settleAction === "settle" &&
    "receiver" in payload &&
    "token" in payload
  );
}

/**
 * Type guard for {@link BatchSettlementRefundWithSignaturePayload}.
 *
 * @param payload - Unknown payload to check.
 * @returns True if `payload` is a settle-action `refundWithSignature` payload.
 */
export function isBatchSettlementRefundWithSignaturePayload(
  payload: unknown,
): payload is BatchSettlementRefundWithSignaturePayload {
  return isObject(payload) && payload.settleAction === "refundWithSignature" && "config" in payload;
}
