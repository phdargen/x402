/** Error codes for the voucher-gateway extension (see voucher-gateway.md). */

export const ErrAddressMismatch = "invalid_voucher_gateway_address_mismatch";
export const ErrUnknownGateway = "invalid_voucher_gateway_unknown_gateway";
export const ErrReceiverMismatch = "invalid_voucher_gateway_receiver_mismatch";
export const ErrReceiverAuthorizerMismatch = "invalid_voucher_gateway_receiver_authorizer_mismatch";
export const ErrVoucherPayload = "invalid_voucher_gateway_voucher_payload";
export const ErrVoucherChannelMismatch = "invalid_voucher_gateway_voucher_channel_mismatch";
export const ErrVoucherSignature = "invalid_voucher_gateway_voucher_signature";
export const ErrServerSettlementPayload = "invalid_voucher_gateway_server_settlement_payload";
export const ErrClaimAuthorizationSignature =
  "invalid_voucher_gateway_claim_authorization_signature";
export const ErrCumulativeMismatch = "invalid_voucher_gateway_cumulative_mismatch";
export const ErrAggregateMismatch = "invalid_voucher_gateway_aggregate_mismatch";
export const ErrReceiverCumulativeBelowDistributed =
  "invalid_voucher_gateway_receiver_cumulative_below_distributed";
export const ErrAccountingMismatch = "invalid_voucher_gateway_accounting_mismatch";
export const ErrDistributeSimulationFailed = "invalid_voucher_gateway_distribute_simulation_failed";
export const ErrDistributeTransactionFailed =
  "invalid_voucher_gateway_distribute_transaction_failed";
export const ErrWithdrawTransactionFailed = "invalid_voucher_gateway_withdraw_transaction_failed";
export const ErrSettleTargetMissing = "invalid_voucher_gateway_settle_target_missing";
export const ErrExtensionMissing = "invalid_voucher_gateway_extension_missing";
