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

export type BatchSettlementPermit2Authorization = {
  from: `0x${string}`;
  permitted: {
    token: `0x${string}`;
    amount: string;
  };
  spender: `0x${string}`;
  nonce: string;
  deadline: string;
  witness: {
    channelId: `0x${string}`;
  };
  signature: `0x${string}`;
};

export type BatchSettlementAssetTransferMethod = "eip3009" | "permit2";

export type BatchSettlementDepositAuthorization =
  | {
      erc3009Authorization: BatchSettlementErc3009Authorization;
      permit2Authorization?: never;
    }
  | {
      erc3009Authorization?: never;
      permit2Authorization: BatchSettlementPermit2Authorization;
    };

export type BatchSettlementDepositPayload = {
  type: "deposit";
  channelConfig: ChannelConfig;
  voucher: BatchSettlementVoucherFields;
  deposit: {
    amount: string;
    authorization: BatchSettlementDepositAuthorization;
  };
};

export type BatchSettlementVoucherPayload = {
  type: "voucher";
  channelConfig: ChannelConfig;
  voucher: BatchSettlementVoucherFields;
};

export type BatchSettlementRefundPayload = {
  type: "refund";
  channelConfig: ChannelConfig;
  voucher: BatchSettlementVoucherFields;
  amount?: string;
};

export type BatchSettlementVoucherFields = {
  channelId: `0x${string}`;
  maxClaimableAmount: string;
  signature: `0x${string}`;
};

export type BatchSettlementVoucherClaim = {
  voucher: {
    channel: ChannelConfig;
    maxClaimableAmount: string;
  };
  signature: `0x${string}`;
  totalClaimed: string;
};

/** Onchain channel snapshot the custodian mirrors back to clients. */
export type BatchSettlementChannelSnapshot = {
  channelId: `0x${string}`;
  balance: string;
  totalClaimed: string;
  withdrawRequestedAt: number;
  refundNonce: string;
};

/** Snapshot plus the custodian's offchain watermark. */
export type BatchSettlementChannelStateExtra = BatchSettlementChannelSnapshot & {
  chargedCumulativeAmount: string;
};

export type BatchSettlementVoucherStateExtra = {
  signedMaxClaimable: string;
  signature: `0x${string}`;
};

/**
 * Which side of the protocol owns the voucher store. `"self"` (the default) keeps the
 * resource server authoritative; `"delegated"` hands custody to the facilitator, which
 * is signalled on the wire by `extra.voucherStore === true`.
 */
export type BatchSettlementVoucherStoreMode = "self" | "delegated";

type BatchSettlementRequirementsExtraBase = {
  receiverAuthorizer: `0x${string}`;
  withdrawDelay: number;
  name: string;
  version: string;
  assetTransferMethod?: BatchSettlementAssetTransferMethod;
};

export type BatchSettlementSelfRequirementsExtra = BatchSettlementRequirementsExtraBase & {
  voucherStore?: false;
};

export type BatchSettlementDelegatedRequirementsExtra = BatchSettlementRequirementsExtraBase & {
  voucherStore: true;
};

export type BatchSettlementPaymentRequirementsExtra =
  | BatchSettlementSelfRequirementsExtra
  | BatchSettlementDelegatedRequirementsExtra;

/** Requirements extra carrying the corrective-only resynchronization fields. */
export type BatchSettlementCorrectiveRequirementsExtra = BatchSettlementPaymentRequirementsExtra &
  BatchSettlementCorrectiveState;

/** `/supported` extra: advertising a voucher store requires the pairing fields. */
export type BatchSettlementSupportedExtra =
  | { voucherStore?: false; receiverAuthorizer?: `0x${string}` }
  | { voucherStore: true; receiverAuthorizer: `0x${string}`; withdrawDelay: number };

/** Self-managed `/verify` extra: the onchain snapshot only. */
export type BatchSettlementSelfVerifyExtra = BatchSettlementChannelSnapshot;

/** Facilitator-managed `/verify` extra: snapshot plus the facilitator's watermark. */
export type BatchSettlementDelegatedVerifyExtra = BatchSettlementChannelStateExtra;

/**
 * What the custodian tells a client to resynchronize with after a cumulative-amount
 * mismatch: its channel state, plus the voucher it holds. The voucher is absent on a
 * channel the custodian has never settled, so there is nothing for the client to verify.
 */
export type BatchSettlementCorrectiveState = {
  channelState: BatchSettlementChannelStateExtra;
  voucherState?: BatchSettlementVoucherStateExtra;
};

/** `/verify` extra on a cumulative-amount mismatch, mirroring the corrective 402. */
export type BatchSettlementCorrectiveVerifyExtra = BatchSettlementCorrectiveState;

export type FileChannelStorageOptions = {
  /** Root directory; channels are stored under `{directory}/{scope}/{channelId}.json`. */
  directory: string;
  /** Sub-directory that isolates one role's records. Defaults to `"server"`. */
  scope?: string;
};

export type BatchSettlementPaymentResponseExtra = {
  chargedAmount?: string;
  /** Snapshot; the watermark is present only when the responder owns the voucher store. */
  channelState?: BatchSettlementChannelSnapshot & { chargedCumulativeAmount?: string };
  voucherState?: BatchSettlementVoucherStateExtra;
};

export type BatchSettlementClaimPayload = {
  type: "claim";
  claims: BatchSettlementVoucherClaim[];
  claimAuthorizerSignature?: `0x${string}`;
};

export type BatchSettlementSettlePayload = {
  type: "settle";
  receiver: `0x${string}`;
  token: `0x${string}`;
};

export type BatchSettlementEnrichedRefundPayload = BatchSettlementRefundPayload & {
  amount: string;
  refundNonce: string;
  claims: BatchSettlementVoucherClaim[];
  refundAuthorizerSignature?: `0x${string}`;
  claimAuthorizerSignature?: `0x${string}`;
};

export type BatchSettlementPayload =
  | BatchSettlementDepositPayload
  | BatchSettlementVoucherPayload
  | BatchSettlementRefundPayload;

export type BatchSettlementFacilitatorSettlePayload =
  | BatchSettlementDepositPayload
  | BatchSettlementVoucherPayload
  | BatchSettlementClaimPayload
  | BatchSettlementSettlePayload
  | BatchSettlementEnrichedRefundPayload;

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
 * Resolves the voucher-custody mode from a requirements or `/supported` extra object.
 *
 * The wire discriminant is `extra.voucherStore`: `true` selects facilitator-managed
 * custody, anything else (including absence) keeps the self-managed default. This is
 * the single narrowing point shared by the server and the facilitator; the client
 * echoes the flag without interpreting it.
 *
 * @param extra - Extra fields from payment requirements or an advertised kind.
 * @returns The custody mode the two sides agreed on.
 */
export function voucherStoreMode(extra: unknown): BatchSettlementVoucherStoreMode {
  return isObject(extra) && extra.voucherStore === true ? "delegated" : "self";
}

/**
 * Type guard for internal voucher field shape (channel, amount, signature).
 *
 * @param payload - Unknown value to check.
 * @returns True if `payload` is an object with `channelId`, `maxClaimableAmount`, and `signature`.
 */
function isVoucherFields(payload: unknown): payload is BatchSettlementVoucherFields {
  return (
    isObject(payload) &&
    "channelId" in payload &&
    "maxClaimableAmount" in payload &&
    "signature" in payload
  );
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
    isObject(payload) &&
    payload.type === "deposit" &&
    "channelConfig" in payload &&
    isVoucherFields(payload.voucher) &&
    isObject(payload.deposit) &&
    typeof payload.deposit.amount === "string" &&
    isObject(payload.deposit.authorization)
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
    isVoucherFields(payload.voucher)
  );
}

/**
 * Type guard for {@link BatchSettlementRefundPayload}.
 *
 * @param payload - Unknown payload to check.
 * @returns True if `payload` is a refund payload with channel config and voucher fields.
 */
export function isBatchSettlementRefundPayload(
  payload: unknown,
): payload is BatchSettlementRefundPayload {
  return (
    isObject(payload) &&
    payload.type === "refund" &&
    "channelConfig" in payload &&
    isVoucherFields(payload.voucher)
  );
}

/**
 * Type guard for {@link BatchSettlementClaimPayload}.
 *
 * @param payload - Unknown payload to check.
 * @returns True if `payload` is a settle-action `claimWithSignature` payload.
 */
export function isBatchSettlementClaimPayload(
  payload: unknown,
): payload is BatchSettlementClaimPayload {
  return isObject(payload) && payload.type === "claim" && "claims" in payload;
}

/**
 * Type guard for {@link BatchSettlementSettlePayload}.
 *
 * @param payload - Unknown payload to check.
 * @returns True if `payload` is a settle-action `settle` payload.
 */
export function isBatchSettlementSettlePayload(
  payload: unknown,
): payload is BatchSettlementSettlePayload {
  return (
    isObject(payload) && payload.type === "settle" && "receiver" in payload && "token" in payload
  );
}

/**
 * Type guard for {@link BatchSettlementEnrichedRefundPayload}.
 *
 * @param payload - Unknown payload to check.
 * @returns True if `payload` is a settle-action `refundWithSignature` payload.
 */
export function isBatchSettlementEnrichedRefundPayload(
  payload: unknown,
): payload is BatchSettlementEnrichedRefundPayload {
  return (
    isBatchSettlementRefundPayload(payload) &&
    "amount" in payload &&
    "refundNonce" in payload &&
    "claims" in payload
  );
}
