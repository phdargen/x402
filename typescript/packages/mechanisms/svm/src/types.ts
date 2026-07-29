/**
 * Exact SVM payload structure containing a base64 encoded Solana transaction
 */
export type ExactSvmPayloadV1 = {
  /**
   * Base64 encoded Solana transaction
   */
  transaction: string;
};

/**
 * Exact SVM payload V2 structure (currently same as V1, reserved for future extensions)
 */
export type ExactSvmPayloadV2 = ExactSvmPayloadV1;

/**
 * Client authorization for the `upto` SVM scheme.
 *
 * The client opens a payment channel whose `deposit` is the authorized ceiling,
 * with `authorizedSigner` set to the receiver authorizer so the server can
 * settle the actual metered amount with a single voucher. The client signs only
 * the `open` transaction; the fee payer broadcasts it. The `from`, `maxAmount`,
 * `validAfter`, and `expiresAt` fields mirror the network-agnostic
 * `UptoPayload`; the channel fields are the SVM specialization.
 */
export type UptoSvmPayloadV2 = {
  /** Payer wallet (base58). */
  from: string;
  /** Signed ceiling (base units). MUST equal verification-phase `amount`. */
  maxAmount: string;
  /** Deadline (Unix seconds); signed into the on-chain voucher. */
  expiresAt: number;
  /** Activation time (Unix seconds). */
  validAfter: number;
  /** Unique per-authorization identifier. */
  nonce: string;
  /** Slot encoded in the open instruction and used as a channel PDA seed. */
  openSlot: string;
  /** Channel PDA (base58). */
  channelId: string;
  /** On-chain escrow ceiling (base units); MUST equal `maxAmount`. */
  deposit: string;
  /** Voucher signer; MUST equal `extra.receiverAuthorizer` (base58). */
  authorizedSigner: string;
  /** Base64 client-signed `open` transaction for the fee payer to broadcast. */
  openTransaction: string;
};

/**
 * Type guard for {@link UptoSvmPayloadV2}.
 *
 * @param payload - The candidate payload (the scheme-specific `PaymentPayload.payload`)
 * @returns Whether `payload` has the `upto` payment-channel shape
 */
export function isUptoSvmPayload(payload: Record<string, unknown>): payload is UptoSvmPayloadV2 {
  return (
    typeof payload.from === "string" &&
    typeof payload.maxAmount === "string" &&
    typeof payload.deposit === "string" &&
    typeof payload.channelId === "string" &&
    typeof payload.authorizedSigner === "string" &&
    typeof payload.openTransaction === "string" &&
    typeof payload.openSlot === "string" &&
    typeof payload.expiresAt === "number" &&
    typeof payload.validAfter === "number" &&
    typeof payload.nonce === "string"
  );
}
