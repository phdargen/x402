package goshared

// Mechanisms catalog loader for the Go e2e resource servers.
//
// SSOT is e2e/config/mechanisms.json. Route paths, payment requirements, and
// declared extensions all come from there, so adding a mechanism does not
// require editing gin/echo/nethttp entrypoints.

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

const catalogSDK = "go"

type catalogNetworkMode struct {
	Name             string `json:"name"`
	Caip2            string `json:"caip2"`
	Permit2Asset     string `json:"permit2Asset"`
	Permit2AssetName string `json:"permit2AssetName"`
}

type catalogExtraEnv struct {
	Env                 string `json:"env"`
	WhenAssetOverridden bool   `json:"whenAssetOverridden"`
}

type catalogPrice struct {
	USD                        string                     `json:"usd"`
	DeclareAssetTransferMethod bool                       `json:"declareAssetTransferMethod"`
	Amount                     string                     `json:"amount"`
	AmountEnv                  string                     `json:"amountEnv"`
	Asset                      string                     `json:"asset"`
	AssetEnv                   string                     `json:"assetEnv"`
	AssetRef                   string                     `json:"assetRef"`
	Permit2Domain              bool                       `json:"permit2Domain"`
	ExtraEnv                   map[string]catalogExtraEnv `json:"extraEnv"`
}

type catalogNetwork struct {
	DisplayName  string       `json:"displayName"`
	DefaultPrice catalogPrice `json:"defaultPrice"`
	Env          struct {
		Server []string `json:"server"`
	} `json:"env"`
	NetworkEnv struct {
		NetworkKey string `json:"networkKey"`
	} `json:"networkEnv"`
	Networks map[string]catalogNetworkMode `json:"networks"`
}

type catalogRouteDefinition struct {
	Scheme              string            `json:"scheme"`
	Network             string            `json:"network"`
	AssetTransferMethod string            `json:"assetTransferMethod"`
	Sdks                []string          `json:"sdks"`
	Price               *catalogPrice     `json:"price"`
	Extensions          []string          `json:"extensions"`
	SettlementOverride  *SettlementAmount `json:"settlementOverride"`
}

// SettlementAmount is the partial amount an upto route settles.
type SettlementAmount struct {
	Amount string `json:"amount"`
}

// ProtectedRouteMessage is the fixed success message every paid route returns.
const ProtectedRouteMessage = "Protected endpoint accessed successfully"

type mechanismsCatalog struct {
	Networks   map[string]catalogNetwork         `json:"networks"`
	Routes     map[string]catalogRouteDefinition `json:"-"`
	RouteOrder []string                          `json:"-"`
	RawRoutes  json.RawMessage                   `json:"routes"`
}

// CatalogRoute is one paid HTTP route as declared in the catalog.
type CatalogRoute struct {
	Path                string
	Scheme              string
	Network             string
	AssetTransferMethod string
	Price               catalogPrice
	Extensions          []string
	SettlementOverride  *SettlementAmount
}

// ResolvedRoute is a catalog route with env-dependent requirements resolved.
type ResolvedRoute struct {
	Path               string
	NetworkID          string
	Scheme             string
	Network            string
	PayTo              string
	Price              interface{}
	Extra              map[string]interface{}
	Extensions         []string
	SettlementOverride *SettlementAmount
}

var (
	catalogOnce sync.Once
	catalogData mechanismsCatalog
	catalogErr  error
)

// findCatalog prefers the path the harness injects and otherwise walks up from
// the working directory, so servers also run standalone from their own dir.
func findCatalog() (string, error) {
	if injected := os.Getenv("E2E_MECHANISMS_CATALOG"); injected != "" {
		if info, err := os.Stat(injected); err == nil && !info.IsDir() {
			return injected, nil
		}
		return "", fmt.Errorf("E2E_MECHANISMS_CATALOG does not point at a file: %s", injected)
	}

	dir, err := os.Getwd()
	if err != nil {
		return "", err
	}
	for {
		candidate := filepath.Join(dir, "config", "mechanisms.json")
		if info, statErr := os.Stat(candidate); statErr == nil && !info.IsDir() {
			return candidate, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", fmt.Errorf("could not locate e2e/config/mechanisms.json from %s", dir)
		}
		dir = parent
	}
}

// decodeOrderedRoutes preserves JSON key order so CatalogRoutes matches the
// catalog file (Go maps alone do not).
func decodeOrderedRoutes(raw json.RawMessage) (map[string]catalogRouteDefinition, []string, error) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	tok, err := dec.Token()
	if err != nil {
		return nil, nil, err
	}
	delim, ok := tok.(json.Delim)
	if !ok || delim != '{' {
		return nil, nil, fmt.Errorf("routes: expected object")
	}

	routes := map[string]catalogRouteDefinition{}
	order := []string{}
	for dec.More() {
		keyTok, err := dec.Token()
		if err != nil {
			return nil, nil, err
		}
		path, ok := keyTok.(string)
		if !ok {
			return nil, nil, fmt.Errorf("routes: expected string key")
		}
		var def catalogRouteDefinition
		if err := dec.Decode(&def); err != nil {
			return nil, nil, fmt.Errorf("routes[%s]: %w", path, err)
		}
		routes[path] = def
		order = append(order, path)
	}
	if _, err := dec.Token(); err != nil {
		return nil, nil, err
	}
	return routes, order, nil
}

func loadCatalog() (mechanismsCatalog, error) {
	catalogOnce.Do(func() {
		path, err := findCatalog()
		if err != nil {
			catalogErr = err
			return
		}
		raw, err := os.ReadFile(path)
		if err != nil {
			catalogErr = err
			return
		}
		if err := json.Unmarshal(raw, &catalogData); err != nil {
			catalogErr = err
			return
		}
		routes, order, err := decodeOrderedRoutes(catalogData.RawRoutes)
		if err != nil {
			catalogErr = err
			return
		}
		catalogData.Routes = routes
		catalogData.RouteOrder = order
		catalogData.RawRoutes = nil
	})
	return catalogData, catalogErr
}

// mustLoadCatalog loads the catalog or exits — servers cannot run without it.
func mustLoadCatalog() mechanismsCatalog {
	catalog, err := loadCatalog()
	if err != nil {
		fmt.Printf("❌ Failed to load mechanisms catalog: %v\n", err)
		os.Exit(1)
	}
	return catalog
}

func excludedFromEnv(name string) map[string]bool {
	excluded := map[string]bool{}
	for _, part := range strings.Split(os.Getenv(name), ",") {
		if trimmed := strings.TrimSpace(part); trimmed != "" {
			excluded[trimmed] = true
		}
	}
	return excluded
}

func routeImplementsSDK(definition catalogRouteDefinition, sdk string) bool {
	for _, listed := range definition.Sdks {
		if listed == sdk {
			return true
		}
	}
	return false
}

// CatalogRoutes returns the routes this SDK implements, minus the exclusions the
// harness injects for surfaces that expose less than the full catalog.
func CatalogRoutes() []CatalogRoute {
	catalog := mustLoadCatalog()
	excludedSchemes := excludedFromEnv("E2E_EXCLUDE_SCHEMES")
	excludedNetworks := excludedFromEnv("E2E_EXCLUDE_NETWORKS")

	routes := make([]CatalogRoute, 0, len(catalog.RouteOrder))
	for _, path := range catalog.RouteOrder {
		definition := catalog.Routes[path]
		if !routeImplementsSDK(definition, catalogSDK) {
			continue
		}
		if excludedSchemes[definition.Scheme] || excludedNetworks[definition.Network] {
			continue
		}

		price := catalog.Networks[definition.Network].DefaultPrice
		if definition.Price != nil {
			price = *definition.Price
		}

		routes = append(routes, CatalogRoute{
			Path:                path,
			Scheme:              definition.Scheme,
			Network:             definition.Network,
			AssetTransferMethod: definition.AssetTransferMethod,
			Price:               price,
			Extensions:          definition.Extensions,
			SettlementOverride:  definition.SettlementOverride,
		})
	}
	return routes
}

// NetworkCaip2 returns a network's CAIP-2 id: the harness env override when set,
// otherwise the catalog's testnet value.
func NetworkCaip2(networkID string) string {
	network, ok := mustLoadCatalog().Networks[networkID]
	if !ok {
		fmt.Printf("❌ Unknown network in catalog: %s\n", networkID)
		os.Exit(1)
	}
	if caip2 := os.Getenv(network.NetworkEnv.NetworkKey); caip2 != "" {
		return caip2
	}
	return network.Networks["testnet"].Caip2
}

func networkMode(network catalogNetwork, caip2 string) catalogNetworkMode {
	if mainnet, ok := network.Networks["mainnet"]; ok && mainnet.Caip2 == caip2 {
		return mainnet
	}
	return network.Networks["testnet"]
}

func resolvePrice(route CatalogRoute, network catalogNetwork, caip2 string) (interface{}, map[string]interface{}, error) {
	spec := route.Price

	if spec.USD != "" {
		if spec.DeclareAssetTransferMethod && route.AssetTransferMethod != "" {
			return spec.USD, map[string]interface{}{"assetTransferMethod": route.AssetTransferMethod}, nil
		}
		return spec.USD, nil, nil
	}

	mode := networkMode(network, caip2)

	amount := spec.Amount
	if spec.AmountEnv != "" {
		if fromEnv := os.Getenv(spec.AmountEnv); fromEnv != "" {
			amount = fromEnv
		}
	}
	if amount == "" {
		return nil, nil, fmt.Errorf("route %s: price has no amount", route.Path)
	}

	assetDefault := spec.Asset
	if spec.AssetRef == "permit2" {
		assetDefault = mode.Permit2Asset
	}
	asset := assetDefault
	if spec.AssetEnv != "" {
		if fromEnv := os.Getenv(spec.AssetEnv); fromEnv != "" {
			asset = fromEnv
		}
	}
	if asset == "" {
		return nil, nil, fmt.Errorf("route %s: price has no asset", route.Path)
	}
	assetOverridden := assetDefault != "" && asset != assetDefault

	extra := map[string]interface{}{}
	if route.AssetTransferMethod != "" {
		extra["assetTransferMethod"] = route.AssetTransferMethod
	}
	if spec.Permit2Domain && mode.Permit2AssetName != "" {
		extra["name"] = mode.Permit2AssetName
		extra["version"] = "2"
	}
	for key, envSpec := range spec.ExtraEnv {
		if envSpec.WhenAssetOverridden && !assetOverridden {
			continue
		}
		if value := os.Getenv(envSpec.Env); value != "" {
			extra[key] = value
		}
	}

	price := map[string]interface{}{"amount": amount, "asset": asset}
	if len(extra) > 0 {
		price["extra"] = extra
	}
	return price, nil, nil
}

// ResolvedRoutes resolves every catalog route against this process's env.
// Routes whose network has no configured payee address are dropped, so the
// server only advertises what it can settle.
func ResolvedRoutes() []ResolvedRoute {
	catalog := mustLoadCatalog()
	resolved := make([]ResolvedRoute, 0, len(catalog.RouteOrder))

	for _, route := range CatalogRoutes() {
		network := catalog.Networks[route.Network]
		payTo := os.Getenv(network.Env.Server[0])
		if payTo == "" {
			continue
		}

		caip2 := NetworkCaip2(route.Network)

		price, extra, err := resolvePrice(route, network, caip2)
		if err != nil {
			fmt.Printf("❌ %v\n", err)
			os.Exit(1)
		}

		resolved = append(resolved, ResolvedRoute{
			Path:               route.Path,
			NetworkID:          route.Network,
			Scheme:             route.Scheme,
			Network:            caip2,
			PayTo:              payTo,
			Price:              price,
			Extra:              extra,
			Extensions:         route.Extensions,
			SettlementOverride: route.SettlementOverride,
		})
	}

	return resolved
}

// RouteDiscoveryOutput returns bazaar metadata matching the fixed paid-route body.
func RouteDiscoveryOutput() (map[string]interface{}, map[string]interface{}, []string) {
	example := map[string]interface{}{
		"message":   ProtectedRouteMessage,
		"timestamp": "2024-01-01T00:00:00Z",
	}
	keys := []string{"message", "timestamp"}
	properties := map[string]interface{}{}
	for _, key := range keys {
		properties[key] = map[string]interface{}{"type": "string"}
	}
	return example, properties, keys
}
