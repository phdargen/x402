package server

import (
	"fmt"
	"os"

	x402 "github.com/x402-foundation/x402/go/v2"
	x402http "github.com/x402-foundation/x402/go/v2/http"
	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement"
	batchedserver "github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement/server"
	exactevm "github.com/x402-foundation/x402/go/v2/mechanisms/evm/exact/server"
	uptoevm "github.com/x402-foundation/x402/go/v2/mechanisms/evm/upto/server"
	svm "github.com/x402-foundation/x402/go/v2/mechanisms/svm/exact/server"
)

// Config holds shared env for Go e2e resource servers (gin/nethttp/echo).
type Config struct {
	Port            string
	EVMPayeeAddress string
	SVMPayeeAddress string
	FacilitatorURL  string
	EVMNetworkStr   string
	SVMNetworkStr   string
	EVMNetwork      x402.Network
	SVMNetwork      x402.Network
	EVMPermit2Asset string
}

// LoadConfig reads and validates role-prefixed server env vars.
func LoadConfig() Config {
	port := os.Getenv("PORT")
	if port == "" {
		port = "4021"
	}

	evmPayeeAddress := os.Getenv("SERVER_EVM_ADDRESS")
	if evmPayeeAddress == "" {
		fmt.Println("❌ SERVER_EVM_ADDRESS environment variable is required")
		os.Exit(1)
	}

	svmPayeeAddress := os.Getenv("SERVER_SVM_ADDRESS")
	if svmPayeeAddress == "" {
		fmt.Println("❌ SERVER_SVM_ADDRESS environment variable is required")
		os.Exit(1)
	}

	facilitatorURL := os.Getenv("FACILITATOR_URL")
	if facilitatorURL == "" {
		fmt.Println("❌ FACILITATOR_URL environment variable is required")
		os.Exit(1)
	}

	evmNetworkStr := NetworkCaip2("evm")
	svmNetworkStr := NetworkCaip2("svm")

	evmPermit2Asset := os.Getenv("EVM_PERMIT2_ASSET")
	if evmPermit2Asset == "" {
		evmPermit2Asset = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"
	}

	fmt.Printf("EVM Payee address: %s\n", evmPayeeAddress)
	fmt.Printf("SVM Payee address: %s\n", svmPayeeAddress)
	fmt.Printf("Using remote facilitator at: %s\n", facilitatorURL)

	return Config{
		Port:            port,
		EVMPayeeAddress: evmPayeeAddress,
		SVMPayeeAddress: svmPayeeAddress,
		FacilitatorURL:  facilitatorURL,
		EVMNetworkStr:   evmNetworkStr,
		SVMNetworkStr:   svmNetworkStr,
		EVMNetwork:      x402.Network(evmNetworkStr),
		SVMNetwork:      x402.Network(svmNetworkStr),
		EVMPermit2Asset: evmPermit2Asset,
	}
}

// NewFacilitatorClient builds an HTTP facilitator client from config.
func NewFacilitatorClient(cfg Config) *x402http.HTTPFacilitatorClient {
	return x402http.NewHTTPFacilitatorClient(&x402http.FacilitatorConfig{
		URL: cfg.FacilitatorURL,
	})
}

// Schemes holds the shared scheme instances for middleware registration.
type Schemes struct {
	ExactEVM        *exactevm.ExactEvmScheme
	UptoEVM         *uptoevm.UptoEvmScheme
	BatchSettlement *batchedserver.BatchSettlementEvmScheme
	ExactSVM        *svm.ExactSvmScheme
}

// BuildSchemes constructs exact/upto/batch-settlement/svm schemes for cfg.
func BuildSchemes(cfg Config) *Schemes {
	batchedCfg := &batchedserver.BatchSettlementEvmSchemeServerConfig{}
	if authKey := os.Getenv("SERVER_EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY"); authKey != "" {
		auth, err := NewBatchedAuthorizerSigner(authKey)
		if err != nil {
			fmt.Printf("Failed to parse SERVER_EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY: %v\n", err)
			os.Exit(1)
		}
		batchedCfg.ReceiverAuthorizerSigner = auth
		fmt.Printf("Batch-settlement receiver authorizer (self-managed): %s\n", auth.Address())
	} else {
		fmt.Println("Batch-settlement receiver authorizer: facilitator-delegated")
	}

	return &Schemes{
		ExactEVM:        exactevm.NewExactEvmScheme(),
		UptoEVM:         uptoevm.NewUptoEvmScheme(),
		BatchSettlement: batchedserver.NewBatchSettlementEvmScheme(cfg.EVMPayeeAddress, batchedCfg),
		ExactSVM:        svm.NewExactSvmScheme(),
	}
}

// SchemeBatched is re-exported for route builders that need the scheme name.
const SchemeBatched = batchsettlement.SchemeBatched

// networkFor converts a CAIP-2 identifier from the catalog to an SDK network.
func networkFor(caip2 string) x402.Network {
	return x402.Network(caip2)
}

// SchemeBinding pairs a network with the scheme server that handles it. Each
// framework maps these to its own middleware SchemeConfig type.
type SchemeBinding struct {
	Network x402.Network
	Server  x402.SchemeNetworkServer
}

// SchemeBindings derives the scheme registrations from the resolved route set,
// so a server exposing a narrower set of routes registers fewer schemes without
// any per-framework bookkeeping.
func SchemeBindings(cfg Config) []SchemeBinding {
	schemes := BuildSchemes(cfg)

	servers := map[string]map[string]x402.SchemeNetworkServer{
		"evm": {
			"exact":       schemes.ExactEVM,
			"upto":        schemes.UptoEVM,
			SchemeBatched: schemes.BatchSettlement,
		},
		"svm": {
			"exact": schemes.ExactSVM,
		},
	}

	bindings := []SchemeBinding{}
	seen := map[string]bool{}
	for _, route := range ResolvedRoutes() {
		key := route.Network + "|" + route.Scheme
		if seen[key] {
			continue
		}
		server, ok := servers[route.NetworkID][route.Scheme]
		if !ok {
			fmt.Printf("❌ No Go scheme server registered for %s on %s\n", route.Scheme, route.NetworkID)
			os.Exit(1)
		}
		seen[key] = true
		bindings = append(bindings, SchemeBinding{Network: networkFor(route.Network), Server: server})
	}

	return bindings
}
