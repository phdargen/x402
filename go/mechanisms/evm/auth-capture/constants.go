package authcapture

import (
	"github.com/ethereum/go-ethereum/crypto"

	"github.com/x402-foundation/x402/go/v2/mechanisms/evm"
)

const (
	// SchemeAuthCapture is the scheme identifier for auth-capture payments.
	SchemeAuthCapture = "auth-capture"

	// AuthCaptureEscrowAddress is the canonical AuthCaptureEscrow deployment
	// (base/commerce-payments). Universal constant, not configurable per merchant.
	AuthCaptureEscrowAddress = "0xBdEA0D1bcC5966192B070Fdf62aB4EF5b4420cff"

	// EIP3009TokenCollectorAddress is the canonical EIP-3009 token collector.
	EIP3009TokenCollectorAddress = "0x0E3dF9510de65469C4518D7843919c0b8C7A7757"

	// Permit2TokenCollectorAddress is the canonical Permit2 token collector.
	Permit2TokenCollectorAddress = "0x992476B9Ee81d52a5BdA0622C333938D0Af0aB26"

	saltBindingTypeString = "x402AuthCaptureSaltBinding(address receiverAuthorizer,address policy,uint256 saltNonce)"

	paymentInfoTypeString = "PaymentInfo(address operator,address payer,address receiver,address token,uint120 maxAmount,uint48 preApprovalExpiry,uint48 authorizationExpiry,uint48 refundExpiry,uint16 minFeeBps,uint16 maxFeeBps,address feeReceiver,uint256 salt)"
)

// SaltBindingTypeHash is keccak256(SALT_BINDING_TYPEHASH string).
var SaltBindingTypeHash = crypto.Keccak256Hash([]byte(saltBindingTypeString))

// PaymentInfoTypeHash is keccak256(PaymentInfo type string); must match AuthCaptureEscrow.PAYMENT_INFO_TYPEHASH.
var PaymentInfoTypeHash = crypto.Keccak256Hash([]byte(paymentInfoTypeString))

// ReceiveAuthorizationTypes defines EIP-712 types for ERC-3009 ReceiveWithAuthorization.
var ReceiveAuthorizationTypes = map[string][]evm.TypedDataField{
	"ReceiveWithAuthorization": {
		{Name: "from", Type: "address"},
		{Name: "to", Type: "address"},
		{Name: "value", Type: "uint256"},
		{Name: "validAfter", Type: "uint256"},
		{Name: "validBefore", Type: "uint256"},
		{Name: "nonce", Type: "bytes32"},
	},
}

// Permit2TransferFromTypes defines EIP-712 types for Permit2 PermitTransferFrom (no witness).
var Permit2TransferFromTypes = map[string][]evm.TypedDataField{
	"PermitTransferFrom": {
		{Name: "permitted", Type: "TokenPermissions"},
		{Name: "spender", Type: "address"},
		{Name: "nonce", Type: "uint256"},
		{Name: "deadline", Type: "uint256"},
	},
	"TokenPermissions": {
		{Name: "token", Type: "address"},
		{Name: "amount", Type: "uint256"},
	},
}

// GetReceiveAuthorizationEIP712Types returns the complete EIP-712 types map for ERC-3009 signing.
func GetReceiveAuthorizationEIP712Types() map[string][]evm.TypedDataField {
	return map[string][]evm.TypedDataField{
		"EIP712Domain": {
			{Name: "name", Type: "string"},
			{Name: "version", Type: "string"},
			{Name: "chainId", Type: "uint256"},
			{Name: "verifyingContract", Type: "address"},
		},
		"ReceiveWithAuthorization": ReceiveAuthorizationTypes["ReceiveWithAuthorization"],
	}
}

// GetPermit2TransferFromEIP712Types returns the complete EIP-712 types map for Permit2 PermitTransferFrom.
func GetPermit2TransferFromEIP712Types() map[string][]evm.TypedDataField {
	return map[string][]evm.TypedDataField{
		"EIP712Domain":       evm.EIP712DomainTypes,
		"PermitTransferFrom": Permit2TransferFromTypes["PermitTransferFrom"],
		"TokenPermissions":   Permit2TransferFromTypes["TokenPermissions"],
	}
}
