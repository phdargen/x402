package buildercode

import (
	evm "github.com/x402-foundation/x402/go/v2/mechanisms/evm"
)

// BuilderCodeFacilitatorExtension manages builder-code attribution at settlement
// time. When BuilderCode is set, it is encoded as the wallet code (`w`); the app
// code (`a`) and service code (`s`) are read from the client payment payload
// extensions. It implements evm.BuilderCodeFacilitatorExtension so the base evm
// settle paths can resolve and append the ERC-8021 calldata suffix.
type BuilderCodeFacilitatorExtension struct {
	// BuilderCode is the facilitator's own wallet code (`w`), optional.
	BuilderCode string
}

// Ensure the extension satisfies the base evm facilitator-extension interface.
var _ evm.BuilderCodeFacilitatorExtension = (*BuilderCodeFacilitatorExtension)(nil)

// Key returns the builder-code extension identifier.
func (e *BuilderCodeFacilitatorExtension) Key() string {
	return BUILDER_CODE
}

// BuildDataSuffix builds the ERC-8021 Schema 2 calldata suffix for a settlement.
// `a` and `s` come from the client payment payload extensions; `w` is the
// facilitator's own code when configured. Returns nil when no attribution is present.
func (e *BuilderCodeFacilitatorExtension) BuildDataSuffix(ctx evm.DataSuffixContext) ([]byte, error) {
	clientExt := extractClientExtension(ctx.Payload.Extensions)

	data := BuilderCodeExtensionData{}
	if validateCode(e.BuilderCode) {
		data.W = e.BuilderCode
	}
	if a, ok := clientExt["a"].(string); ok && validateCode(a) {
		data.A = a
	}
	data.S = resolveServiceCode(clientExt["s"])

	if data.A == "" && data.W == "" && data.S == "" {
		return nil, nil
	}

	return EncodeBuilderCodeSuffix(data)
}

// extractClientExtension returns the `info` object of the builder-code extension
// from payment-payload extensions, or nil if absent or malformed.
func extractClientExtension(extensions map[string]interface{}) map[string]interface{} {
	ext, ok := extensions[BUILDER_CODE].(map[string]interface{})
	if !ok {
		return nil
	}
	info, ok := ext["info"].(map[string]interface{})
	if !ok {
		return nil
	}
	return info
}

// resolveServiceCode normalizes the client-provided `s` value, accepting a valid
// string or the first valid entry of an array. Returns "" when missing or invalid.
func resolveServiceCode(raw interface{}) string {
	if s, ok := raw.(string); ok && validateCode(s) {
		return s
	}
	if arr, ok := raw.([]interface{}); ok {
		for _, v := range arr {
			if s, ok := v.(string); ok && validateCode(s) {
				return s
			}
		}
	}
	return ""
}
