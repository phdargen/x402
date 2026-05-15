// Package buildercode implements the ERC-8021 Schema 2 Builder Code attribution
// extension for x402 payments.
//
// Two parties contribute their builder codes, which are CBOR-encoded and appended
// as a suffix to the EIP-3009 settlement transaction calldata:
//   - Service (resource server): declares its app code in the 402 response
//     extensions under field "a", and optionally related on-chain services as "s".
//   - Facilitator: at settlement, reads the payload extensions, adds its own code
//     as field "w", and the EIP-3009 mechanism appends the encoded suffix to the
//     transferWithAuthorization calldata.
package buildercode

import (
	"fmt"
	"regexp"

	x402 "github.com/x402-foundation/x402/go"
)

// Key is the extension identifier used in PaymentRequired/PaymentPayload extensions
// and the FacilitatorContext.
const Key = "builder-code"

// SchemaID is the ERC-8021 Schema 2 identifier byte.
const SchemaID byte = 0x02

// Marker is the 16-byte ERC-8021 marker appended at the end of every suffix.
var Marker = []byte{
	0x80, 0x21, 0x80, 0x21, 0x80, 0x21, 0x80, 0x21,
	0x80, 0x21, 0x80, 0x21, 0x80, 0x21, 0x80, 0x21,
}

// builderCodePattern restricts builder codes to 1-32 lowercase alphanumeric
// characters or underscores.
var builderCodePattern = regexp.MustCompile(`^[a-z0-9_]{1,32}$`)

// BuilderCode is the FacilitatorExtension identifier for registration with x402Facilitator.
var BuilderCode = x402.NewFacilitatorExtension(Key)

// ExtensionData is the builder-code payload as it appears in
// PaymentRequired.Extensions and PaymentPayload.Extensions.
//
// Maps to ERC-8021 Schema 2 fields:
//   - A: app code (the x402 service that exposed the endpoint)
//   - W: wallet code (the facilitator that settled the payment on-chain)
//   - S: service codes (related on-chain services the app depends on)
type ExtensionData struct {
	A string   `json:"a,omitempty"`
	W string   `json:"w,omitempty"`
	S []string `json:"s,omitempty"`
}

// FacilitatorConfig configures the facilitator-side builder-code extension.
type FacilitatorConfig struct {
	// BuilderCode is the facilitator's own code, written to the "w" field at settlement.
	BuilderCode string
}

// validateCode returns an error if code does not match the builder-code pattern.
func validateCode(code string) error {
	if !builderCodePattern.MatchString(code) {
		return fmt.Errorf("invalid builder code %q: must be 1-32 characters, lowercase alphanumeric and underscores only", code)
	}
	return nil
}
