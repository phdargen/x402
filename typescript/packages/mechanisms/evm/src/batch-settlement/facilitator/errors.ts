/** Facilitator error codes for the batch-settlement EVM scheme. */

export const ErrChannelNotFound = "batch_settlement_evm_channel_not_found";
export const ErrTokenMismatch = "batch_settlement_evm_token_mismatch";
export const ErrInvalidVoucherSignature = "batch_settlement_evm_invalid_voucher_signature";
export const ErrCumulativeExceedsBalance = "batch_settlement_evm_cumulative_exceeds_balance";
export const ErrCumulativeAmountBelowClaimed = "batch_settlement_evm_cumulative_below_claimed";
export const ErrInsufficientBalance = "batch_settlement_evm_insufficient_balance";
export const ErrDepositTransactionFailed = "batch_settlement_evm_deposit_transaction_failed";
export const ErrClaimTransactionFailed = "batch_settlement_evm_claim_transaction_failed";
export const ErrSettleTransactionFailed = "batch_settlement_evm_settle_transaction_failed";
export const ErrInvalidScheme = "batch_settlement_evm_invalid_scheme";
export const ErrNetworkMismatch = "batch_settlement_evm_network_mismatch";
export const ErrMissingEip712Domain = "batch_settlement_evm_missing_eip712_domain";
export const ErrValidBeforeExpired = "batch_settlement_evm_payload_authorization_valid_before";
export const ErrValidAfterInFuture = "batch_settlement_evm_payload_authorization_valid_after";
export const ErrInvalidReceiveAuthorizationSignature =
  "batch_settlement_evm_invalid_receive_authorization_signature";
export const ErrErc3009AuthorizationRequired =
  "batch_settlement_evm_erc3009_authorization_required";
export const ErrRefundTransactionFailed = "batch_settlement_evm_refund_transaction_failed";
export const ErrInvalidPayloadType = "batch_settlement_evm_invalid_payload_type";
export const ErrWithdrawDelayOutOfRange = "batch_settlement_evm_withdraw_delay_out_of_range";
export const ErrChannelIdMismatch = "batch_settlement_evm_channel_id_mismatch";
export const ErrReceiverMismatch = "batch_settlement_evm_receiver_mismatch";
export const ErrReceiverAuthorizerMismatch = "batch_settlement_evm_receiver_authorizer_mismatch";
export const ErrWithdrawDelayMismatch = "batch_settlement_evm_withdraw_delay_mismatch";
export const ErrAuthorizerAddressMismatch = "batch_settlement_evm_authorizer_address_mismatch";
export const ErrDepositSimulationFailed = "batch_settlement_evm_deposit_simulation_failed";
export const ErrClaimSimulationFailed = "batch_settlement_evm_claim_simulation_failed";
export const ErrSettleSimulationFailed = "batch_settlement_evm_settle_simulation_failed";
export const ErrRefundSimulationFailed = "batch_settlement_evm_refund_simulation_failed";
export const ErrRpcReadFailed = "batch_settlement_evm_rpc_read_failed";
export const ErrPermit2AuthorizationRequired =
  "batch_settlement_evm_permit2_authorization_required";
export const ErrPermit2InvalidSpender = "batch_settlement_evm_permit2_invalid_spender";
export const ErrPermit2AmountMismatch = "batch_settlement_evm_permit2_amount_mismatch";
export const ErrPermit2DeadlineExpired = "batch_settlement_evm_permit2_deadline_expired";
export const ErrPermit2InvalidSignature = "batch_settlement_evm_permit2_invalid_signature";
export const ErrPermit2AllowanceRequired = "batch_settlement_evm_permit2_allowance_required";
export const ErrEip2612AmountMismatch = "batch_settlement_evm_eip2612_amount_mismatch";
export const ErrEip2612OwnerMismatch = "batch_settlement_evm_eip2612_owner_mismatch";
export const ErrEip2612AssetMismatch = "batch_settlement_evm_eip2612_asset_mismatch";
export const ErrEip2612SpenderMismatch = "batch_settlement_evm_eip2612_spender_mismatch";
export const ErrEip2612DeadlineExpired = "batch_settlement_evm_eip2612_deadline_expired";
export const ErrErc20ApprovalUnavailable = "batch_settlement_evm_erc20_approval_unavailable";
