package main

import (
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/joho/godotenv"
	x402 "github.com/x402-foundation/x402/go"
	"github.com/x402-foundation/x402/go/extensions/buildercode"
	x402http "github.com/x402-foundation/x402/go/http"
	ginmw "github.com/x402-foundation/x402/go/http/gin"
	evm "github.com/x402-foundation/x402/go/mechanisms/evm/exact/server"
)

const port = "4021"

func main() {
	_ = godotenv.Load()

	facURL := os.Getenv("FACILITATOR_URL")
	payee := os.Getenv("EVM_ADDRESS_PAYEE")
	appCode := os.Getenv("BUILDER_CODE_A")
	if facURL == "" || payee == "" || appCode == "" {
		fmt.Println("FACILITATOR_URL, EVM_ADDRESS_PAYEE, BUILDER_CODE_A required")
		os.Exit(1)
	}

	var services []string
	if s := os.Getenv("BUILDER_CODE_S"); s != "" {
		services = strings.Split(s, ",")
	}

	bcData, err := buildercode.DeclareBuilderCodeExtension(appCode, services...)
	if err != nil {
		fmt.Printf("invalid builder codes: %v\n", err)
		os.Exit(1)
	}

	evmNet := x402.Network("eip155:84532")
	facClient := x402http.NewHTTPFacilitatorClient(&x402http.FacilitatorConfig{URL: facURL})

	paymentOption := x402http.PaymentOption{
		Scheme:  "exact",
		PayTo:   payee,
		Network: evmNet,
		Price: map[string]interface{}{
			"amount": "1000",
			"asset":  "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
		},
	}

	routeCfg := x402http.RouteConfig{
		Accepts: x402http.PaymentOptions{paymentOption},
		Extensions: map[string]interface{}{
			buildercode.Key: bcData,
		},
	}

	routes := x402http.RoutesConfig{
		"GET /premium-data": routeCfg,
	}

	r := gin.Default()
	r.Use(ginmw.X402Payment(ginmw.Config{
		Routes:                 routes,
		Facilitator:            facClient,
		Schemes:                []ginmw.SchemeConfig{{Network: evmNet, Server: evm.NewExactEvmScheme()}},
		SyncFacilitatorOnStart: true,
		Timeout:                30 * time.Second,
	}))

	r.GET("/premium-data", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{
			"data":      "premium market data",
			"timestamp": time.Now().Format(time.RFC3339),
		})
	})

	fmt.Printf("server on :%s  (a=%s s=%v)\n", port, appCode, services)
	_ = r.Run(":" + port)
}
