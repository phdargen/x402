package goshared

import (
	"fmt"

	"github.com/x402-foundation/x402/go/v2/extensions/bazaar"
	"github.com/x402-foundation/x402/go/v2/extensions/eip2612gassponsor"
	"github.com/x402-foundation/x402/go/v2/extensions/erc20approvalgassponsor"
	"github.com/x402-foundation/x402/go/v2/extensions/types"
	x402http "github.com/x402-foundation/x402/go/v2/http"
)

// BuildRoutes returns the shared payment RoutesConfig for Go e2e servers.
func BuildRoutes(cfg Config) x402http.RoutesConfig {
	discoveryExtension, err := bazaar.DeclareDiscoveryExtension(
		bazaar.MethodGET,
		nil,
		nil,
		"",
		&types.OutputConfig{
			Example: map[string]interface{}{
				"message":   "Protected endpoint accessed successfully",
				"timestamp": "2024-01-01T00:00:00Z",
			},
			Schema: types.JSONSchema{
				"properties": map[string]interface{}{
					"message":   map[string]interface{}{"type": "string"},
					"timestamp": map[string]interface{}{"type": "string"},
				},
				"required": []string{"message", "timestamp"},
			},
		},
	)
	if err != nil {
		fmt.Printf("Warning: Failed to create bazaar extension: %v\n", err)
	}

	return x402http.RoutesConfig{

		"GET /exact/evm/eip3009": {
			Accepts: x402http.PaymentOptions{
				{
					Scheme:  "exact",
					PayTo:   cfg.EVMPayeeAddress,
					Price:   "$0.001",
					Network: cfg.EVMNetwork,
				},
			},
			Extensions: map[string]interface{}{
				types.BAZAAR.Key(): discoveryExtension,
			},
		},
		// Batch-settlement endpoints. Mirror nethttp's batch-settlement routes:
		// the harness drives deposit + voucher + recovery + refund inline via
		// BATCH_SETTLEMENT_PHASE; the server only needs to register the scheme
		// and respond once payment is verified.
		"GET /batch-settlement/evm/eip3009": {
			Accepts: x402http.PaymentOptions{
				{
					Scheme:  SchemeBatched,
					PayTo:   cfg.EVMPayeeAddress,
					Price:   "$0.001",
					Network: cfg.EVMNetwork,
				},
			},
		},
		"GET /batch-settlement/evm/permit2": {
			Accepts: x402http.PaymentOptions{
				{
					Scheme:  SchemeBatched,
					PayTo:   cfg.EVMPayeeAddress,
					Network: cfg.EVMNetwork,
					Price: map[string]interface{}{
						"amount": "1000",
						"asset":  cfg.EVMPermit2Asset,
						"extra": map[string]interface{}{
							"assetTransferMethod": "permit2",
							"name":                "USDC",
							"version":             "2",
						},
					},
				},
			},
		},
		"GET /batch-settlement/evm/permit2-eip2612GasSponsoring": {
			Accepts: x402http.PaymentOptions{
				{
					Scheme:  SchemeBatched,
					PayTo:   cfg.EVMPayeeAddress,
					Network: cfg.EVMNetwork,
					Price:   "$0.001",
					Extra: map[string]interface{}{
						"assetTransferMethod": "permit2",
					},
				},
			},
			Extensions: eip2612gassponsor.DeclareEip2612GasSponsoringExtension(),
		},
		"GET /batch-settlement/evm/permit2-erc20ApprovalGasSponsoring": {
			Accepts: x402http.PaymentOptions{
				{
					Scheme:  SchemeBatched,
					PayTo:   cfg.EVMPayeeAddress,
					Network: cfg.EVMNetwork,
					Price: map[string]interface{}{
						"amount": "1000",
						"asset":  cfg.EVMPermit2Asset,
						"extra": map[string]interface{}{
							"assetTransferMethod": "permit2",
						},
					},
				},
			},
			Extensions: erc20approvalgassponsor.DeclareExtension(),
		},
		"GET /exact/svm": {
			Accepts: x402http.PaymentOptions{
				{
					Scheme:  "exact",
					PayTo:   cfg.SVMPayeeAddress,
					Price:   "$0.001",
					Network: cfg.SVMNetwork,
				},
			},
			Extensions: map[string]interface{}{
				types.BAZAAR.Key(): discoveryExtension,
			},
		},
		// Permit2 direct endpoint - standard settle, no gas sponsoring (client must pre-approve Permit2)
		"GET /exact/evm/permit2": {
			Accepts: x402http.PaymentOptions{
				{
					Scheme:  "exact",
					PayTo:   cfg.EVMPayeeAddress,
					Network: cfg.EVMNetwork,
					Price: map[string]interface{}{
						"amount": "1000",
						"asset":  "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
						"extra": map[string]interface{}{
							"assetTransferMethod": "permit2",
						},
					},
				},
			},
			Extensions: map[string]interface{}{
				types.BAZAAR.Key(): discoveryExtension,
			},
		},
		// Permit2 endpoint - explicitly requires Permit2 flow instead of EIP-3009
		"GET /exact/evm/permit2-eip2612GasSponsoring": {
			Accepts: x402http.PaymentOptions{
				{
					Scheme:  "exact",
					PayTo:   cfg.EVMPayeeAddress,
					Network: cfg.EVMNetwork,
					Price: map[string]interface{}{
						"amount": "1000",
						"asset":  cfg.EVMPermit2Asset,
						"extra": func() map[string]interface{} {
							name := "USD Coin"
							if cfg.EVMNetworkStr == "eip155:84532" {
								name = "USDC"
							}
							return map[string]interface{}{
								"assetTransferMethod": "permit2",
								"name":                name,
								"version":             "2",
							}
						}(),
					},
				},
			},
			Extensions: func() map[string]interface{} {
				ext := map[string]interface{}{
					types.BAZAAR.Key(): discoveryExtension,
				}
				// Add EIP-2612 gas sponsoring extension
				for k, v := range eip2612gassponsor.DeclareEip2612GasSponsoringExtension() {
					ext[k] = v
				}
				return ext
			}(),
		},
		"GET /upto/evm/permit2": {
			Accepts: x402http.PaymentOptions{
				{
					Scheme:  "upto",
					PayTo:   cfg.EVMPayeeAddress,
					Network: cfg.EVMNetwork,
					Price: map[string]interface{}{
						"amount": "2000",
						"asset":  cfg.EVMPermit2Asset,
						"extra": map[string]interface{}{
							"assetTransferMethod": "permit2",
							"name":                "USDC",
							"version":             "2",
						},
					},
				},
			},
			Extensions: func() map[string]interface{} {
				ext := map[string]interface{}{
					types.BAZAAR.Key(): discoveryExtension,
				}
				for k, v := range eip2612gassponsor.DeclareEip2612GasSponsoringExtension() {
					ext[k] = v
				}
				return ext
			}(),
		},
		// Permit2 ERC-20 approval endpoint - requires Permit2 flow with a generic ERC-20 token (no EIP-2612)
		"GET /exact/evm/permit2-erc20ApprovalGasSponsoring": {
			Accepts: x402http.PaymentOptions{
				{
					Scheme:  "exact",
					PayTo:   cfg.EVMPayeeAddress,
					Network: cfg.EVMNetwork,
					Price: map[string]interface{}{
						"amount": "1000",
						"asset":  cfg.EVMPermit2Asset,
						"extra": map[string]interface{}{
							"assetTransferMethod": "permit2",
						},
					},
				},
			},
			Extensions: func() map[string]interface{} {
				ext := map[string]interface{}{
					types.BAZAAR.Key(): discoveryExtension,
				}
				// Advertise ERC-20 approval gas sponsoring (for tokens without EIP-2612)
				for k, v := range erc20approvalgassponsor.DeclareExtension() {
					ext[k] = v
				}
				return ext
			}(),
		},
	
	}
}
