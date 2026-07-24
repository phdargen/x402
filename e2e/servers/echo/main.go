package main

import (
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/labstack/echo/v4"
	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/e2e/servers/goshared"
	echomw "github.com/x402-foundation/x402/go/v2/http/echo"
)

var shutdownRequested bool

// Echo E2E Test Server with x402 v2 Payment Middleware

func main() {
	cfg := goshared.LoadConfig()
	schemes := goshared.BuildSchemes(cfg)
	routes := goshared.BuildRoutes(cfg)
	facilitatorClient := goshared.NewFacilitatorClient(cfg)

// Create Echo instance
	e := echo.New()
	e.HideBanner = true

	
	e.Use(echomw.X402Payment(echomw.Config{
		Routes:      routes,
		Facilitator: facilitatorClient,
		Schemes: []echomw.SchemeConfig{
			{Network: cfg.EVMNetwork, Server: schemes.ExactEVM},
			{Network: cfg.EVMNetwork, Server: schemes.UptoEVM},
			{Network: cfg.SVMNetwork, Server: schemes.ExactSVM},
		},
		SyncFacilitatorOnStart: true,
		Timeout:                30 * time.Second,
		ErrorHandler: func(c echo.Context, err error) {
			fmt.Printf("❌ [E2E SERVER ERROR] Payment error occurred\n")
			fmt.Printf("   Path: %s\n", c.Request().URL.Path)
			fmt.Printf("   Method: %s\n", c.Request().Method)
			fmt.Printf("   Error: %v\n", err)
			fmt.Printf("   Headers: %v\n", c.Request().Header)
			c.JSON(http.StatusPaymentRequired, map[string]interface{}{"error": err.Error()})
		},
		SettlementHandler: func(c echo.Context, settleResp *x402.SettleResponse) {
			fmt.Printf("✅ [E2E SERVER SUCCESS] Payment settled\n")
			fmt.Printf("   Path: %s\n", c.Request().URL.Path)
			fmt.Printf("   Transaction: %s\n", settleResp.Transaction)
			fmt.Printf("   Network: %s\n", settleResp.Network)
			fmt.Printf("   Payer: %s\n", settleResp.Payer)
		},
	}))

	// Protected endpoint - requires payment to access
	e.GET("/exact/evm/eip3009", func(c echo.Context) error {
		if shutdownRequested {
			return c.JSON(http.StatusServiceUnavailable, map[string]interface{}{
				"error": "Server shutting down",
			})
		}

		return c.JSON(http.StatusOK, map[string]interface{}{
			"message":   "Protected endpoint accessed successfully (EVM)",
			"timestamp": time.Now().Format(time.RFC3339),
			"network":   "eip155:84532",
		})
	})

	// Protected SVM endpoint - requires payment to access
	e.GET("/exact/svm", func(c echo.Context) error {
		if shutdownRequested {
			return c.JSON(http.StatusServiceUnavailable, map[string]interface{}{
				"error": "Server shutting down",
			})
		}

		return c.JSON(http.StatusOK, map[string]interface{}{
			"message":   "Protected endpoint accessed successfully (SVM)",
			"timestamp": time.Now().Format(time.RFC3339),
			"network":   "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
		})
	})

	// Protected Permit2 direct endpoint - standard settle (no gas sponsoring)
	e.GET("/exact/evm/permit2", func(c echo.Context) error {
		if shutdownRequested {
			return c.JSON(http.StatusServiceUnavailable, map[string]interface{}{
				"error": "Server shutting down",
			})
		}

		return c.JSON(http.StatusOK, map[string]interface{}{
			"message":   "Permit2 endpoint accessed successfully",
			"timestamp": time.Now().Format(time.RFC3339),
			"method":    "permit2",
		})
	})

	// Protected Permit2 EIP-2612 endpoint - Permit2 with gas sponsoring
	e.GET("/exact/evm/permit2-eip2612GasSponsoring", func(c echo.Context) error {
		if shutdownRequested {
			return c.JSON(http.StatusServiceUnavailable, map[string]interface{}{
				"error": "Server shutting down",
			})
		}

		return c.JSON(http.StatusOK, map[string]interface{}{
			"message":   "Permit2 EIP-2612 endpoint accessed successfully",
			"timestamp": time.Now().Format(time.RFC3339),
			"method":    "permit2-eip2612",
		})
	})

	// Protected Permit2 ERC-20 approval endpoint
	e.GET("/exact/evm/permit2-erc20ApprovalGasSponsoring", func(c echo.Context) error {
		if shutdownRequested {
			return c.JSON(http.StatusServiceUnavailable, map[string]interface{}{
				"error": "Server shutting down",
			})
		}

		return c.JSON(http.StatusOK, map[string]interface{}{
			"message":   "Permit2 ERC-20 approval endpoint accessed successfully",
			"timestamp": time.Now().Format(time.RFC3339),
			"method":    "permit2-erc20-approval",
		})
	})

	e.GET("/upto/evm/permit2", func(c echo.Context) error {
		if shutdownRequested {
			return c.JSON(http.StatusServiceUnavailable, map[string]interface{}{
				"error": "Server shutting down",
			})
		}

		echomw.SetSettlementOverrides(c, &x402.SettlementOverrides{Amount: "1000"})

		return c.JSON(http.StatusOK, map[string]interface{}{
			"message":   "Upto Permit2 endpoint accessed successfully",
			"timestamp": time.Now().Format(time.RFC3339),
			"method":    "upto-permit2",
		})
	})

	// Health check endpoint - no payment required
	e.GET("/health", func(c echo.Context) error {
		return c.JSON(http.StatusOK, map[string]interface{}{
			"status":      "ok",
			"version":     "2.0.0",
			"evm_network": string(cfg.EVMNetwork),
			"evm_payee":   cfg.EVMPayeeAddress,
			"svm_network": string(cfg.SVMNetwork),
			"svm_payee":   cfg.SVMPayeeAddress,
		})
	})

	// Shutdown endpoint - used by e2e tests
	e.POST("/close", func(c echo.Context) error {
		shutdownRequested = true

		fmt.Println("Received shutdown request")

		// Schedule server shutdown after response
		go func() {
			time.Sleep(100 * time.Millisecond)
			os.Exit(0)
		}()

		return c.JSON(http.StatusOK, map[string]interface{}{
			"message": "Server shutting down gracefully",
		})
	})

	// Set up graceful shutdown
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)

	go func() {
		<-quit
		fmt.Println("Received shutdown signal, exiting...")
		os.Exit(0)
	}()

	// Print startup banner
	fmt.Printf(`
╔════════════════════════════════════════════════════════╗
║           x402 Echo E2E Test Server                    ║
╠════════════════════════════════════════════════════════╣
║  Server:     http://localhost:%-29s ║
║  EVM Network: %-40s ║
║  EVM Payee:   %-40s ║
║  SVM Network: %-40s ║
║  SVM Payee:   %-40s ║
║                                                        ║
║  Endpoints:                                            ║
║  • GET  /exact/evm/eip3009                    (EVM EIP-3009)  ║
║  • GET  /exact/evm/permit2                    (Permit2)       ║
║  • GET  /exact/evm/permit2-eip2612GasSponsoring               ║
║  • GET  /exact/evm/permit2-erc20ApprovalGasSponsoring         ║
║  • GET  /exact/svm                            (SVM)           ║
║  • GET  /upto/evm/permit2                     (Upto Permit2)  ║
║  • GET  /health                 (no payment required)  ║
║  • POST /close                  (shutdown server)      ║
╚════════════════════════════════════════════════════════╝
`, cfg.Port, cfg.EVMNetwork, cfg.EVMPayeeAddress, cfg.SVMNetwork, cfg.SVMPayeeAddress)

	if err := e.Start(":" + cfg.Port); err != nil && err != http.ErrServerClosed {
		fmt.Printf("Error starting server: %v\n", err)
		os.Exit(1)
	}
}
