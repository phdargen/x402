package buildercode

// DeclareBuilderCodeExtension validates the supplied codes and returns an
// ExtensionData value suitable for inclusion in PaymentRequired.Extensions
// under the "builder-code" key.
//
// appCode is written to the "a" field. Optional serviceCodes populate the "s"
// array — use these to attribute related on-chain protocols the app depends on
// (e.g., "bc_morpho", "bc_aerodrome").
func DeclareBuilderCodeExtension(appCode string, serviceCodes ...string) (ExtensionData, error) {
	if err := validateCode(appCode); err != nil {
		return ExtensionData{}, err
	}
	for _, c := range serviceCodes {
		if err := validateCode(c); err != nil {
			return ExtensionData{}, err
		}
	}
	data := ExtensionData{A: appCode}
	if len(serviceCodes) > 0 {
		data.S = append([]string(nil), serviceCodes...)
	}
	return data, nil
}

// resourceServerExtension is a no-op ResourceServerExtension that simply
// advertises support for the "builder-code" key. It satisfies
// types.ResourceServerExtension (Key + EnrichDeclaration).
type resourceServerExtension struct{}

func (e *resourceServerExtension) Key() string { return Key }

func (e *resourceServerExtension) EnrichDeclaration(declaration interface{}, _ interface{}) interface{} {
	return declaration
}

// ResourceServerExtension declares builder-code support on a resource server.
// Register via httpServer.RegisterExtension(buildercode.ResourceServerExtension).
var ResourceServerExtension = &resourceServerExtension{}
