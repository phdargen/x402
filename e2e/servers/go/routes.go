package server

import (
	"fmt"
	"os"

	"github.com/x402-foundation/x402/go/v2/extensions/bazaar"
	"github.com/x402-foundation/x402/go/v2/extensions/eip2612gassponsor"
	"github.com/x402-foundation/x402/go/v2/extensions/erc20approvalgassponsor"
	"github.com/x402-foundation/x402/go/v2/extensions/types"
	x402http "github.com/x402-foundation/x402/go/v2/http"
)

// declareExtension maps a catalog extension id to the SDK call that declares it.
func declareExtension(extensionID string, route ResolvedRoute) (map[string]interface{}, error) {
	switch extensionID {
	case "bazaar":
		example, properties, required := RouteDiscoveryOutput()
		discovery, err := bazaar.DeclareDiscoveryExtension(
			bazaar.MethodGET,
			nil,
			nil,
			"",
			&types.OutputConfig{
				Example: example,
				Schema: types.JSONSchema{
					"properties": properties,
					"required":   required,
				},
			},
		)
		if err != nil {
			return nil, fmt.Errorf("route %s: %w", route.Path, err)
		}
		return map[string]interface{}{types.BAZAAR.Key(): discovery}, nil
	case "eip2612GasSponsoring":
		return eip2612gassponsor.DeclareEip2612GasSponsoringExtension(), nil
	case "erc20ApprovalGasSponsoring":
		return erc20approvalgassponsor.DeclareExtension(), nil
	default:
		return nil, fmt.Errorf("route %s declares unknown extension %q", route.Path, extensionID)
	}
}

// BuildRoutes returns the payment RoutesConfig for Go e2e servers, derived from
// the mechanisms catalog. Routes whose network has no payee address configured
// are omitted by the resolver.
func BuildRoutes() x402http.RoutesConfig {
	routes := x402http.RoutesConfig{}

	for _, route := range ResolvedRoutes() {
		extensions := map[string]interface{}{}
		for _, extensionID := range route.Extensions {
			declared, err := declareExtension(extensionID, route)
			if err != nil {
				fmt.Printf("❌ %v\n", err)
				os.Exit(1)
			}
			for key, value := range declared {
				extensions[key] = value
			}
		}

		config := x402http.RouteConfig{
			Accepts: x402http.PaymentOptions{
				{
					Scheme:  route.Scheme,
					PayTo:   route.PayTo,
					Price:   route.Price,
					Network: networkFor(route.Network),
					Extra:   route.Extra,
				},
			},
		}
		if len(extensions) > 0 {
			config.Extensions = extensions
		}

		routes[fmt.Sprintf("GET %s", route.Path)] = config
	}

	return routes
}
