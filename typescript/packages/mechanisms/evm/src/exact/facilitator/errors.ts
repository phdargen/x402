/**
 * Named error reason constants for the exact EVM facilitator.
 *
 * These strings must be character-for-character identical to the Go constants in
 * go/mechanisms/evm/exact/facilitator/errors.go to maintain cross-SDK parity.
 *
 * Spec alignment: Section 9 of x402-specification-v2.md defines protocol-level
 * error codes (e.g., insufficient_funds, invalid_scheme). This file contains
 * the facilitator-specific granular errors that map to those protocol codes.
 */

// Protocol-level errors (from spec section 9)
export const ErrInsufficientFunds = "insufficient_funds";
export const ErrInvalidSchemeFallback = "invalid_scheme";
export const ErrUnsupportedScheme = "unsupported_scheme";
export const ErrInvalidNetwork = "invalid_network";
export const ErrInvalidTransactionState = "invalid_transaction_state";
export const ErrTransactionFailed = "transaction_failed";

// EIP-3009 verify errors
export const ErrInvalidScheme = "invalid_exact_evm_scheme";
export const ErrNetworkMismatch = "invalid_exact_evm_network_mismatch";
export const ErrInvalidPayload = "invalid_exact_evm_payload";
export const ErrMissingSignature = "invalid_exact_evm_payload_missing_signature";
export const ErrFailedToGetNetworkConfig = "invalid_exact_evm_failed_to_get_network_config";
export const ErrMissingEip712Domain = "invalid_exact_evm_missing_eip712_domain";
export const ErrRecipientMismatch = "invalid_exact_evm_recipient_mismatch";
export const ErrInvalidAuthorizationValue = "invalid_exact_evm_authorization_value";
export const ErrInvalidRequiredAmount = "invalid_exact_evm_required_amount";
export const ErrInsufficientAmount = "invalid_exact_evm_insufficient_amount";
export const ErrFailedToCheckNonce = "invalid_exact_evm_failed_to_check_nonce";
export const ErrNonceAlreadyUsed = "invalid_exact_evm_nonce_already_used";
export const ErrFailedToGetBalance = "invalid_exact_evm_failed_to_get_balance";
export const ErrInsufficientBalance = "invalid_exact_evm_insufficient_balance";
export const ErrInvalidSignatureFormat = "invalid_exact_evm_signature_format";
export const ErrFailedToVerifySignature = "invalid_exact_evm_failed_to_verify_signature";
export const ErrInvalidSignature = "invalid_exact_evm_signature";
/** Spec section 9: invalid_exact_evm_payload_signature */
export const ErrInvalidPayloadSignature = "invalid_exact_evm_payload_signature";
export const ErrValidBeforeExpired = "invalid_exact_evm_payload_authorization_valid_before";
export const ErrValidAfterInFuture = "invalid_exact_evm_payload_authorization_valid_after";
/** Spec section 9: invalid_exact_evm_payload_recipient_mismatch */
export const ErrPayloadRecipientMismatch = "invalid_exact_evm_payload_recipient_mismatch";
/** Spec section 9: invalid_exact_evm_payload_authorization_value_mismatch */
export const ErrPayloadAuthorizationValueMismatch =
  "invalid_exact_evm_payload_authorization_value_mismatch";

// EIP-3009 settle errors
export const ErrVerificationFailed = "invalid_exact_evm_verification_failed";
export const ErrFailedToParseSignature = "invalid_exact_evm_failed_to_parse_signature";
export const ErrFailedToCheckDeployment = "invalid_exact_evm_failed_to_check_deployment";
export const ErrFailedToExecuteTransfer = "invalid_exact_evm_failed_to_execute_transfer";
export const ErrFailedToGetReceipt = "invalid_exact_evm_failed_to_get_receipt";
export const ErrTransactionFailedEVM = "invalid_exact_evm_transaction_failed";

// Smart wallet errors (shared by EIP-3009 and Permit2)
export const ErrUndeployedSmartWallet = "invalid_exact_evm_payload_undeployed_smart_wallet";
export const ErrSmartWalletDeploymentFailed = "smart_wallet_deployment_failed";
export const ErrUnsupportedPayloadType = "unsupported_payload_type";

// Permit2 verify errors
export const ErrPermit2InvalidSpender = "invalid_permit2_spender";
export const ErrPermit2RecipientMismatch = "invalid_permit2_recipient_mismatch";
export const ErrPermit2DeadlineExpired = "permit2_deadline_expired";
export const ErrPermit2NotYetValid = "permit2_not_yet_valid";
export const ErrPermit2InsufficientAmount = "permit2_insufficient_amount";
export const ErrPermit2TokenMismatch = "permit2_token_mismatch";
export const ErrPermit2InvalidSignature = "invalid_permit2_signature";
export const ErrPermit2AllowanceRequired = "permit2_allowance_required";

// Permit2 settle errors (from contract reverts)
export const ErrPermit2InvalidAmount = "permit2_invalid_amount";
export const ErrPermit2InvalidDestination = "permit2_invalid_destination";
export const ErrPermit2InvalidOwner = "permit2_invalid_owner";
export const ErrPermit2PaymentTooEarly = "permit2_payment_too_early";
export const ErrPermit2InvalidNonce = "permit2_invalid_nonce";
export const ErrPermit2612AmountMismatch = "permit2_2612_amount_mismatch";

// ERC-20 approval gas sponsoring verify errors
export const ErrErc20ApprovalInvalidFormat = "invalid_erc20_approval_extension_format";
export const ErrErc20ApprovalFromMismatch = "erc20_approval_from_mismatch";
export const ErrErc20ApprovalAssetMismatch = "erc20_approval_asset_mismatch";
export const ErrErc20ApprovalSpenderNotPermit2 = "erc20_approval_spender_not_permit2";
export const ErrErc20ApprovalTxParseFailed = "erc20_approval_tx_parse_failed";
export const ErrErc20ApprovalTxWrongTarget = "erc20_approval_tx_wrong_target";
export const ErrErc20ApprovalTxWrongSelector = "erc20_approval_tx_wrong_selector";
export const ErrErc20ApprovalWrongCalldata = "erc20_approval_tx_wrong_spender";
export const ErrErc20ApprovalTxSignerMismatch = "erc20_approval_tx_signer_mismatch";
export const ErrErc20ApprovalTxInvalidSignature = "erc20_approval_tx_invalid_signature";
export const ErrErc20ApprovalBroadcastFailed = "erc20_approval_broadcast_failed";

// EIP-2612 gas sponsoring verify errors (Permit2 extension)
export const ErrInvalidEip2612ExtensionFormat = "invalid_eip2612_extension_format";
export const ErrEip2612FromMismatch = "eip2612_from_mismatch";
export const ErrEip2612AssetMismatch = "eip2612_asset_mismatch";
export const ErrEip2612SpenderNotPermit2 = "eip2612_spender_not_permit2";
export const ErrEip2612DeadlineExpired = "eip2612_deadline_expired";
