package buildercode

import (
	"context"
	"fmt"

	"github.com/x402-foundation/x402/go/v2/types"
)

// BuilderCodeClientExtension adds builder-code attribution to payment payloads
// by attaching the client's service code (`s`). The core client merge preserves
// the server-declared app code (`a`) and schema after enrichment.
type BuilderCodeClientExtension struct {
	serviceCode string
}

// NewBuilderCodeClientExtension creates a client extension that attaches the
// given service code to payments.
//
// It panics when serviceCode is not a valid builder code (1-32 lowercase
// alphanumeric and underscore characters)
func NewBuilderCodeClientExtension(serviceCode string) *BuilderCodeClientExtension {
	if !validateCode(serviceCode) {
		panic(fmt.Sprintf("invalid builder code: %q. Must be 1-32 characters, lowercase alphanumeric and underscores only.", serviceCode))
	}
	return &BuilderCodeClientExtension{serviceCode: serviceCode}
}

// Key returns the builder-code extension identifier.
func (e *BuilderCodeClientExtension) Key() string {
	return BUILDER_CODE
}

// EnrichPaymentPayload attaches this client's service code (`s`). Core extension
// merging re-applies the server's advertised `a`/`schema` afterwards.
func (e *BuilderCodeClientExtension) EnrichPaymentPayload(
	_ context.Context,
	payload types.PaymentPayload,
	_ types.PaymentRequired,
) (types.PaymentPayload, error) {
	extensions := make(map[string]interface{}, len(payload.Extensions)+1)
	for k, v := range payload.Extensions {
		extensions[k] = v
	}
	extensions[BUILDER_CODE] = map[string]interface{}{
		"info": map[string]interface{}{"s": e.serviceCode},
	}
	payload.Extensions = extensions
	return payload, nil
}
