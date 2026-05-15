package buildercode

// FacilitatorExtension is registered with x402Facilitator to enable builder-code
// attribution at settlement time. The EIP-3009 settlement mechanism looks it up
// via FacilitatorContext and calls BuildCalldataSuffix to obtain the suffix bytes
// to append to the transferWithAuthorization calldata.
type FacilitatorExtension struct {
	config FacilitatorConfig
}

// NewFacilitatorExtension validates cfg.BuilderCode and constructs a
// FacilitatorExtension ready to be registered with x402Facilitator.
func NewFacilitatorExtension(cfg FacilitatorConfig) (*FacilitatorExtension, error) {
	if err := validateCode(cfg.BuilderCode); err != nil {
		return nil, err
	}
	return &FacilitatorExtension{config: cfg}, nil
}

// Key satisfies x402.FacilitatorExtension.
func (e *FacilitatorExtension) Key() string {
	return Key
}

// BuildCalldataSuffix reads the payment payload's builder-code extension data
// (fields "a" and "s"), sets "w" to the facilitator's configured code, and
// returns the encoded ERC-8021 Schema 2 suffix.
//
// Accepts payloadExtensions either as ExtensionData or as a map[string]interface{}
// (the shape produced by JSON unmarshaling into PaymentPayload.Extensions).
func (e *FacilitatorExtension) BuildCalldataSuffix(payloadExtensions map[string]interface{}) ([]byte, error) {
	data := ExtensionData{W: e.config.BuilderCode}

	if payloadExtensions != nil {
		if raw, ok := payloadExtensions[Key]; ok {
			extractInto(raw, &data)
		}
	}

	return EncodeBuilderCodeSuffix(data)
}

// extractInto copies "a" and "s" from raw into data. raw may be ExtensionData,
// *ExtensionData, or a map[string]interface{}.
func extractInto(raw interface{}, data *ExtensionData) {
	switch v := raw.(type) {
	case ExtensionData:
		data.A = v.A
		if len(v.S) > 0 {
			data.S = append([]string(nil), v.S...)
		}
	case *ExtensionData:
		if v != nil {
			data.A = v.A
			if len(v.S) > 0 {
				data.S = append([]string(nil), v.S...)
			}
		}
	case map[string]interface{}:
		if a, ok := v["a"].(string); ok {
			data.A = a
		}
		if s, ok := v["s"].([]interface{}); ok {
			out := make([]string, 0, len(s))
			for _, item := range s {
				if str, ok := item.(string); ok {
					out = append(out, str)
				}
			}
			if len(out) > 0 {
				data.S = out
			}
		} else if s, ok := v["s"].([]string); ok && len(s) > 0 {
			data.S = append([]string(nil), s...)
		}
	}
}
