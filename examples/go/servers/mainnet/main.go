package main

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"

	x402 "github.com/coinbase/x402/go"
	x402http "github.com/coinbase/x402/go/http"
	ginmw "github.com/coinbase/x402/go/http/gin"
	evm "github.com/coinbase/x402/go/mechanisms/evm/exact/server"
	"github.com/coinbase/cdp-sdk/go/auth"
	ginfw "github.com/gin-gonic/gin"
	"github.com/joho/godotenv"
)

const DefaultPort = "4021"

// CDPAuthProvider provides CDP JWT authentication for the facilitator client
type CDPAuthProvider struct {
	apiKeyID     string
	apiKeySecret string
}

func (p *CDPAuthProvider) GetAuthHeaders(ctx context.Context) (x402http.AuthHeaders, error) {
	host := "api.cdp.coinbase.com"
	basePath := "/platform/v2/x402"

	verifyToken, err := p.createToken("POST", host, basePath+"/verify")
	if err != nil {
		return x402http.AuthHeaders{}, err
	}

	settleToken, err := p.createToken("POST", host, basePath+"/settle")
	if err != nil {
		return x402http.AuthHeaders{}, err
	}

	supportedToken, err := p.createToken("GET", host, basePath+"/supported")
	if err != nil {
		return x402http.AuthHeaders{}, err
	}

	return x402http.AuthHeaders{
		Verify:    map[string]string{"Authorization": "Bearer " + verifyToken},
		Settle:    map[string]string{"Authorization": "Bearer " + settleToken},
		Supported: map[string]string{"Authorization": "Bearer " + supportedToken},
	}, nil
}

func (p *CDPAuthProvider) createToken(method, host, path string) (string, error) {
	return auth.GenerateJWT(auth.JwtOptions{
		KeyID:         p.apiKeyID,
		KeySecret:     p.apiKeySecret,
		RequestMethod: method,
		RequestHost:   strings.TrimPrefix(host, "https://"),
		RequestPath:   path,
	})
}

func main() {
	godotenv.Load()

	payTo := os.Getenv("EVM_PAYEE_ADDRESS")
	if payTo == "" {
		fmt.Println("❌ EVM_PAYEE_ADDRESS environment variable is required")
		os.Exit(1)
	}

	apiKeyID := os.Getenv("CDP_API_KEY_ID")
	apiKeySecret := os.Getenv("CDP_API_KEY_SECRET")
	if apiKeyID == "" || apiKeySecret == "" {
		fmt.Println("❌ CDP_API_KEY_ID and CDP_API_KEY_SECRET environment variables are required")
		os.Exit(1)
	}

	// Base mainnet (CAIP-2)
	network := x402.Network("eip155:8453")

	fmt.Printf("🚀 Starting x402 mainnet server...\n")
	fmt.Printf("   Payee address: %s\n", payTo)
	fmt.Printf("   Network: %s\n", network)

	r := ginfw.Default()

	// Create facilitator client with CDP auth
	facilitatorClient := x402http.NewHTTPFacilitatorClient(&x402http.FacilitatorConfig{
		URL:          "https://api.cdp.coinbase.com/platform/v2/x402",
		AuthProvider: &CDPAuthProvider{apiKeyID: apiKeyID, apiKeySecret: apiKeySecret},
	})

	// Configure routes
	routes := x402http.RoutesConfig{
		"GET /weather": {
			Accepts: x402http.PaymentOptions{{
				Scheme:  "exact",
				Price:   "$0.001",
				Network: network,
				PayTo:   payTo,
			}},
			Description: "Get weather data",
			MimeType:    "application/json",
		},
	}

	// Apply x402 payment middleware
	r.Use(ginmw.X402Payment(ginmw.Config{
		Routes:      routes,
		Facilitator: facilitatorClient,
		Schemes: []ginmw.SchemeConfig{
			{Network: network, Server: evm.NewExactEvmScheme()},
		},
		Timeout: 30 * time.Second,
	}))

	// Protected endpoint - requires $0.001 USDC payment
	r.GET("/weather", func(c *ginfw.Context) {
		city := c.DefaultQuery("city", "San Francisco")
		c.JSON(http.StatusOK, ginfw.H{
			"city":        city,
			"weather":     "sunny",
			"temperature": 70,
			"timestamp":   time.Now().Format(time.RFC3339),
		})
	})

	// Health check endpoint - no payment required
	r.GET("/health", func(c *ginfw.Context) {
		c.JSON(http.StatusOK, ginfw.H{"status": "ok"})
	})

	fmt.Printf("   Server listening on http://localhost:%s\n\n", DefaultPort)

	if err := r.Run(":" + DefaultPort); err != nil {
		fmt.Printf("Error starting server: %v\n", err)
		os.Exit(1)
	}
}
