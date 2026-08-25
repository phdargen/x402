/**
 * Named error reason constants for the exact SVM facilitator.
 *
 * These strings must be character-for-character identical to the Go
 * constants in go/mechanisms/svm/exact/facilitator/errors.go to maintain
 * cross-SDK parity.
 */

export const INVALID_FEE_PAYER_MISMATCH = "invalid_exact_svm_payload_fee_payer_mismatch";
export const INVALID_SIGNATURE = "invalid_exact_svm_payload_signature_invalid";

/**
 * Non-terminal settle error reason used when a transaction was broadcast but
 * `confirmTransaction` couldn't observe its confirmation in time. Always
 * carries the broadcast signature (as `SettleResponse.transaction`) so a
 * caller can reconcile onchain, and mirrors `x402.ErrSettlementPending` /
 * `evm.ErrSettlementPending` so `x402ResourceServer`'s generic
 * single-retry-on-settlement_pending logic recognizes it uniformly across
 * schemes/networks. Replaces the former `transaction_failed`/
 * `settlement_confirmation_timeout`-style reasons on the confirm-timeout
 * path, which were terminal and gave callers no reconciliation path.
 */
export const ErrSettlementPending = "settlement_pending";
