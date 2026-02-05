package types

import "context"

// SettleResponse contains the settlement result for extension hooks.
// This mirrors x402.SettleResponse to avoid import cycles.
type SettleResponse struct {
	Success      bool                   `json:"success"`
	ErrorReason  string                 `json:"errorReason,omitempty"`
	ErrorMessage string                 `json:"errorMessage,omitempty"`
	Payer        string                 `json:"payer,omitempty"`
	Transaction  string                 `json:"transaction"`
	Network      string                 `json:"network"`
	Extensions   map[string]interface{} `json:"extensions,omitempty"`
}

// PaymentRequiredContext contains information passed to enrichPaymentRequiredResponse hooks
type PaymentRequiredContext struct {
	Requirements            []PaymentRequirements
	ResourceInfo            *ResourceInfo
	Error                   string
	PaymentRequiredResponse PaymentRequired
}

// ExtensionSettleResultContext contains information passed to enrichSettlementResponse hooks
// Note: Uses separate struct from server hooks to avoid import cycles
type ExtensionSettleResultContext struct {
	Ctx          context.Context
	Payload      PaymentPayload
	Requirements PaymentRequirements
	Result       *SettleResponse
}

// ResourceServerExtension defines the interface for server-side extensions
type ResourceServerExtension interface {
	// Key returns the unique identifier for this extension
	Key() string

	// EnrichDeclaration enriches extension declaration with extension-specific data.
	// This is called when building payment requirements.
	EnrichDeclaration(declaration interface{}, transportContext interface{}) interface{}

	// EnrichPaymentRequiredResponse is called when generating a 402 PaymentRequired response.
	// Return extension data to add to extensions[key], or nil to skip.
	// This method is optional - extensions that don't need it can return nil.
	EnrichPaymentRequiredResponse(ctx context.Context, declaration interface{}, prCtx PaymentRequiredContext) (interface{}, error)

	// EnrichSettlementResponse is called after successful payment settlement.
	// Return extension data to add to response.extensions[key], or nil to skip.
	// This method is optional - extensions that don't need it can return nil.
	EnrichSettlementResponse(ctx context.Context, declaration interface{}, settleCtx ExtensionSettleResultContext) (interface{}, error)
}

// BaseExtension provides a default implementation of ResourceServerExtension
// that can be embedded in custom extensions. All methods return nil/passthrough by default.
type BaseExtension struct {
	ExtKey string
}

func (e *BaseExtension) Key() string {
	return e.ExtKey
}

func (e *BaseExtension) EnrichDeclaration(declaration interface{}, transportContext interface{}) interface{} {
	return declaration
}

func (e *BaseExtension) EnrichPaymentRequiredResponse(ctx context.Context, declaration interface{}, prCtx PaymentRequiredContext) (interface{}, error) {
	return nil, nil
}

func (e *BaseExtension) EnrichSettlementResponse(ctx context.Context, declaration interface{}, settleCtx ExtensionSettleResultContext) (interface{}, error) {
	return nil, nil
}
